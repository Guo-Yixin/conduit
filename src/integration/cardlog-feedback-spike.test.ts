/**
 * WI-386 — Dogfood acceptance spike: the cooler flow carries its transition log
 * and feeds back on rework. THE acceptance gate for the whole card-transition-log
 * feature (PRD prd/done/card-transition-log.md).
 *
 * Drives the REAL cooler flow config (examples/tiktok-shoppable-ideas/flow.yaml —
 * the WI-385 ideate.md that declares a {{feedback}} block) through a forced
 * reject-then-pass cycle with a deterministic stub adapter (no live model). The
 * card is seeded directly at `ideate`: the upstream `fetch_context` station runs
 * the DuckDB CLI against an environment-specific database file, which is not
 * available under test, so we exercise the PRD-critical maker→gate→rework loop
 * directly. Both `ideate` and the gate critic use the same model id, so the stub
 * branches on the rendered prompt (the critic prompt asks for a "verdict").
 *
 * Asserts the full PRD thesis on the real flow config:
 *   AC1  the card_log carries the coherent reject-then-pass history (gate reject
 *        WITH findings, rework back-edge, gate pass, forward to done) in order.
 *   AC2  on the rework re-run, the ideate maker prompt handed to the adapter
 *        contains the prior gate findings (the {{feedback}} block was populated).
 *   AC3  the binding stamp recorded for the ideate rework attempt differs from
 *        the first-attempt stamp (feedback folded into the stamp).
 *   AC4  re-invoking the executor over the same checkpointed run does not
 *        duplicate any card_log entries (idempotent end-to-end).
 *   AC5  `conduit journal inspect <cardId>` prints the coherent history.
 *
 * KNOWN REQUIREMENT this gate surfaces: for AC1 and AC3 to hold, successive gate
 * checks / advances at the same station must be DISTINCT executions — i.e. the
 * card's execution attempt must advance across a rework. If `card.attempt` stays
 * 0 across reworks, the pass gate_verdict and the forward-to-done entered_lane
 * collide with the earlier reject/rework entries on the WI-378
 * (card_id, station, attempt, kind) UNIQUE key and are deduped away (and the
 * rework checkpoint overwrites the first-attempt stamp). The acceptance gate
 * deliberately demands the full history, so it stays RED until the executor
 * advances the attempt per rework execution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import {  StoredCardLogEntry, DEFAULT_RUN_ID  } from '../persistence/db';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import { main, type CliDeps, type CliIO, type RunEngineArgs, type PrereqProbe } from '../cli/main';

const COOLER_FLOW = join(import.meta.dir, '..', '..', 'examples', 'tiktok-shoppable-ideas', 'flow.yaml');
const CARD_ID = 'cooler';

/** The critic's rejection reason — must be visible in the rework maker prompt (AC2). */
const REJECT_FINDING =
  'The hook manufactures false freshness: the last video was only 8 days ago, not a 30+ day gap.';

// ---------------------------------------------------------------------------
// Deterministic adapter. Both maker + critic share a model id, so we branch on
// the rendered prompt: the critic prompt (verify.md) asks for a JSON "verdict";
// the maker prompt (ideate.md) never mentions one.
// ---------------------------------------------------------------------------

function isCriticPrompt(prompt: string): boolean {
  return prompt.includes('verdict');
}

function makeSpikeAdapter(opts: { gateRejectsBeforePass: number }): {
  adapter: ModelAdapter;
  workerPrompts: string[];
} {
  let rejectsLeft = opts.gateRejectsBeforePass;
  const workerPrompts: string[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (isCriticPrompt(req.prompt)) {
        if (rejectsLeft > 0) {
          rejectsLeft--;
          return {
            text: JSON.stringify({ verdict: 'reject', findings: [REJECT_FINDING], return_to: 'ideate' }),
            inputTokens: 8,
            outputTokens: 4,
            costUsd: 0.002,
          };
        }
        return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      workerPrompts.push(req.prompt);
      return {
        text: JSON.stringify({ featured_variant: 'Sunset Fade, 12 oz', hook: 'A 3-second pour-and-freeze reveal', filming_idea: 'Macro pour, hard cut to the chilled can, CTA to the product card.' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, workerPrompts };
}

// ---------------------------------------------------------------------------
// Lifecycle — one temp project dir per test; context.json pre-written (ideate's
// input artifact). The flow's prompt files resolve to the real example dir.
// ---------------------------------------------------------------------------

let projectDir: string;
let db: ConduitDB;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-spike-'));
  writeFileSync(
    join(projectDir, 'context.json'),
    JSON.stringify({
      sales: { best_colorways: [{ variant: 'Sunset Fade, 12 oz' }], rising_stars: [] },
      top_hooks: [{ hook: 'pour-and-freeze', format_style: 'macro', techniques: ['hard cut'] }],
      recent_videos: [],
      clock: { today: '2026-06-08', days_since_last_video: 8 },
    }),
  );
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function seedAtIdeate(): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: CARD_ID,
    parent_id: null,
    lane: 'ideate',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['context.json', 'idea.json'],
    rework_count: 0,
  });
}

/** Run the cooler flow from `ideate` with the given adapter to completion. */
async function runCoolerFlow(adapter: ModelAdapter): Promise<void> {
  const loaded = loadFlow(COOLER_FLOW);
  if (!loaded.ok) throw new Error(`cooler flow failed to load: ${JSON.stringify(loaded.errors)}`);
  await runExecutor({
    db,
    flow: loaded.flow,
    projectRoot: projectDir,
    now: () => 1000,
    adapter,
    io: { out: () => {}, err: () => {} },
  } as RunEngineArgs);
}

function entered(log: StoredCardLogEntry[]): Array<Extract<StoredCardLogEntry, { kind: 'entered_lane' }>> {
  return log.filter((e): e is Extract<StoredCardLogEntry, { kind: 'entered_lane' }> => e.kind === 'entered_lane');
}
function verdicts(log: StoredCardLogEntry[]): Array<Extract<StoredCardLogEntry, { kind: 'gate_verdict' }>> {
  return log.filter((e): e is Extract<StoredCardLogEntry, { kind: 'gate_verdict' }> => e.kind === 'gate_verdict');
}

function ideateStamps(): string[] {
  return (
    db.getStateDb().prepare("SELECT binding_stamp FROM checkpoints WHERE station = 'ideate'").all() as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

// ===========================================================================
// AC1 — the card carries the coherent reject-then-pass transition log.
// ===========================================================================

describe('cooler spike — card_log carries the coherent reject-then-pass history (WI-386 AC1)', () => {
  it('records gate reject (with findings) → rework back-edge → gate pass → forward to done, in order', async () => {
    seedAtIdeate();
    const { adapter } = makeSpikeAdapter({ gateRejectsBeforePass: 1 });
    await runCoolerFlow(adapter);

    // The reject-then-pass cycle converged to done.
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.lane).toBe('done');

    const log = db.getCardLog(CARD_ID);

    // Gate verdicts: a reject carrying the critic findings, then a pass.
    const reject = verdicts(log).find((v) => v.verdict === 'reject');
    expect(reject).toBeDefined();
    expect(reject!.findings).toContain(REJECT_FINDING);
    const pass = verdicts(log).find((v) => v.verdict === 'pass');
    expect(pass).toBeDefined();

    // Lane transitions: a rework back-edge to ideate, then a forward to done.
    const rework = entered(log).find((e) => e.reasonClass === 'rework');
    expect(rework).toBeDefined();
    expect(rework!.destLane).toBe('ideate');
    const forwardToDone = entered(log).find((e) => e.reasonClass === 'forward' && e.destLane === 'done');
    expect(forwardToDone).toBeDefined();

    // Chronological coherence: reject precedes pass; rework precedes forward-to-done.
    const idxOf = (pred: (e: StoredCardLogEntry) => boolean) => log.findIndex(pred);
    expect(idxOf((e) => e.kind === 'gate_verdict' && e.verdict === 'reject')).toBeLessThan(
      idxOf((e) => e.kind === 'gate_verdict' && e.verdict === 'pass'),
    );
    expect(idxOf((e) => e.kind === 'entered_lane' && e.reasonClass === 'rework')).toBeLessThan(
      idxOf((e) => e.kind === 'entered_lane' && e.reasonClass === 'forward' && e.destLane === 'done'),
    );
  });
});

// ===========================================================================
// AC2 — the rework maker prompt consumed the prior gate findings (feedback).
// ===========================================================================

describe('cooler spike — rework maker prompt carries the prior gate findings (WI-386 AC2, FR-5)', () => {
  it('renders the prior rejection findings into the second (rework) ideate prompt', async () => {
    seedAtIdeate();
    const { adapter, workerPrompts } = makeSpikeAdapter({ gateRejectsBeforePass: 1 });
    await runCoolerFlow(adapter);

    // Two maker calls: first attempt (no feedback) + rework (with feedback).
    expect(workerPrompts.length).toBeGreaterThanOrEqual(2);
    // First attempt has no prior findings to show.
    expect(workerPrompts[0]).not.toContain(REJECT_FINDING);
    // The rework attempt's prompt contains the critic's prior findings.
    expect(workerPrompts[1]).toContain(REJECT_FINDING);
  });
});

// ===========================================================================
// AC3 — the rework binding stamp differs from the first-attempt stamp.
// ===========================================================================

describe('cooler spike — feedback folds into the binding stamp across the rework boundary (WI-386 AC3, FR-6)', () => {
  it('records two distinct ideate binding stamps (first attempt vs rework with feedback)', async () => {
    seedAtIdeate();
    const { adapter } = makeSpikeAdapter({ gateRejectsBeforePass: 1 });
    await runCoolerFlow(adapter);

    // The first (no-feedback) and the rework (feedback-folded) executions each
    // checkpoint ideate with a DIFFERENT binding stamp — so a resume of the
    // rework cannot skip-replay the stale first-attempt output.
    const distinct = new Set(ideateStamps());
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// AC4 — re-running the same checkpointed run does not duplicate card_log entries.
// ===========================================================================

describe('cooler spike — logging is idempotent under a simulated resume (WI-386 AC4, FR-7)', () => {
  it('re-executing the final advance after a crash appends no duplicate card_log entries', async () => {
    seedAtIdeate();
    await runCoolerFlow(makeSpikeAdapter({ gateRejectsBeforePass: 1 }).adapter);
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.lane).toBe('done');

    const before = db.getCardLog(CARD_ID).length;
    expect(before).toBeGreaterThan(0);

    // Simulate a crash between the pre-commit card_log append and the state
    // commit of the final advance: roll the card back to its pre-advance state
    // (the card_log entries persist on the journal DB).
    db.getStateDb().prepare("UPDATE cards SET lane = 'ideate', status = 'ready' WHERE id = $id").run({ $id: CARD_ID });
    db.getStateDb().prepare('DELETE FROM active_workers WHERE card_id = $id').run({ $id: CARD_ID });

    // Resume: ideate re-runs and re-appends the SAME (card,station,attempt,kind)
    // entries — the UNIQUE constraint must dedup them.
    await runCoolerFlow(makeSpikeAdapter({ gateRejectsBeforePass: 0 }).adapter);
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.lane).toBe('done');
    expect(db.getCardLog(CARD_ID).length).toBe(before);
  });
});

// ===========================================================================
// AC5 — `conduit journal inspect <cardId>` prints the coherent history.
// ===========================================================================

describe('cooler spike — journal inspect prints the coherent history (WI-386 AC5, FR-9)', () => {
  function makeCliIO(): CliIO & { lines: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) } as CliIO & { lines: string[] };
  }

  it('renders the reject (with findings) before the pass for human triage', async () => {
    seedAtIdeate();
    await runCoolerFlow(makeSpikeAdapter({ gateRejectsBeforePass: 1 }).adapter);

    const io = makeCliIO();
    const deps: CliDeps = {
      io,
      now: () => 1000,
      db,
      adapter: makeSpikeAdapter({ gateRejectsBeforePass: 0 }).adapter,
      runEngine: async () => {},
      prereqs: [{ name: 'noop', check: () => ({ ok: true }) }] as PrereqProbe[],
    };

    const code = await main(['journal', 'inspect', CARD_ID], deps);
    expect(code).toBe(0);

    const output = io.lines.join('\n');
    // The history is human-readable and coherent: the rejection (with its
    // findings) and the eventual pass both appear, reject before pass.
    expect(output).toContain('reject');
    expect(output).toContain(REJECT_FINDING);
    expect(output).toContain('pass');
    expect(io.lines.findIndex((l) => l.includes('reject'))).toBeLessThan(
      io.lines.findIndex((l) => l.includes('pass')),
    );
  });
});
