/**
 * Tests for card_log writes at the executor advance seam (WI-381).
 *
 * WI-381 wires the WI-378 card_log API into runExecutor so every card advance
 * records an `entered_lane` entry (and, on a terminal scrap/hold, a `terminal`
 * entry) — atomically-enough with the card-state transition that the log and the
 * card state can never diverge (FR-8). Cross-file single-transaction atomicity is
 * impossible (card_log = journal DB, cards = state DB, no ATTACH), so the
 * contract is: append the card_log entry BEFORE the state-db commit and rely on
 * the (card_id, station, attempt, kind) UNIQUE constraint from WI-378 to dedup on
 * resume/replay (FR-7).
 *
 * Contract this file pins for src/controller/executor.ts:
 *
 *  - Happy-path forward advance        → entered_lane { sourceLane, destLane, reasonClass:'forward' }
 *  - Back-edge rework (reworkDelta>0)  → entered_lane { source=worker/gate station, dest=returnTo, reasonClass:'rework' }
 *  - Advance to 'scrap'                → entered_lane reasonClass:'scrap' AND a terminal entry with the scrap reason
 *  - Escalation to 'hold' (status=held)→ entered_lane reasonClass:'hold'  AND a terminal entry with the hold  reason
 *  - Reaching a NON-scrap/hold terminal ('done') → NO terminal entry (FR-4 is scrap/hold only)
 *  - Replaying the same advance after a crash does NOT duplicate entries (FR-7/FR-8)
 *
 * These drive the REAL planTick / transition matrix / atomic-claim path with an
 * in-memory DB and a stub adapter (no network), and read card_log via the WI-378
 * accessor. The card_log API (appendCardLog/getCardLog) is declared locally here
 * (CardLogDB) so this file typechecks while WI-378 lands; at runtime the methods
 * exist once WI-378 is merged and return [] until WI-381 wires the appends —
 * either way these assertions are RED until the executor records entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// WI-378 card_log contract (declared locally — see file header).
// ---------------------------------------------------------------------------

type ReasonClass = 'forward' | 'rework' | 'scrap' | 'hold';

type StoredCardLogEntry =
  | {
      runId: string;
      cardId: string;
      station: string;
      attempt: number;
      kind: 'entered_lane';
      sourceLane: string;
      destLane: string;
      reasonClass: ReasonClass;
    }
  | {
      runId: string;
      cardId: string;
      station: string;
      attempt: number;
      kind: 'gate_verdict';
      verdict: 'pass' | 'reject';
      findings: string[];
      returnTo: string | null;
    }
  | { runId: string; cardId: string; station: string; attempt: number; kind: 'terminal'; reason: string };

interface CardLogDB extends ConduitDB {
  getCardLog(cardId: string): StoredCardLogEntry[];
}

type EnteredLane = Extract<StoredCardLogEntry, { kind: 'entered_lane' }>;
type Terminal = Extract<StoredCardLogEntry, { kind: 'terminal' }>;

function cardLog(db: ConduitDB, cardId: string): StoredCardLogEntry[] {
  return (db as CardLogDB).getCardLog(cardId);
}
function enteredLanes(db: ConduitDB, cardId: string): EnteredLane[] {
  return cardLog(db, cardId).filter((e): e is EnteredLane => e.kind === 'entered_lane');
}
function terminals(db: ConduitDB, cardId: string): Terminal[] {
  return cardLog(db, cardId).filter((e): e is Terminal => e.kind === 'terminal');
}

// ---------------------------------------------------------------------------
// Stub adapters — record calls; branch on req.model (worker vs gate critic).
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gpt-4o-mini';
const CRITIC_MODEL = 'gpt-4o';

/** Valid worker output; gate rejects `gateRejectsBeforePass` times then passes. */
function makeStubAdapter(opts: { gateRejectsBeforePass?: number } = {}): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  let gateRejectsLeft = opts.gateRejectsBeforePass ?? 0;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        if (gateRejectsLeft > 0) {
          gateRejectsLeft--;
          return {
            text: JSON.stringify({ verdict: 'reject', findings: ['needs work'], return_to: 'ideate' }),
            inputTokens: 8,
            outputTokens: 4,
            costUsd: 0.002,
          };
        }
        return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      return { text: JSON.stringify({ idea: 'a shoppable widget idea' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter, calls };
}

/** Worker output that NEVER satisfies the schema → transform scraps (model-incompatible). */
function makeBadWorkerAdapter(): { adapter: ModelAdapter } {
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (req.model === CRITIC_MODEL) {
        return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      // Missing the required `idea` field — schema validation fails every attempt.
      return { text: JSON.stringify({ not_idea: 'nope' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

// ---------------------------------------------------------------------------
// Flow fixtures.
// ---------------------------------------------------------------------------

/** ideate transform + gate self-loop (on_reject: ideate), rework_cap 2. */
function setupTransformFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: executor-cardlog
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: ideate
      rework_cap: 2
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** Deterministic 3-station flow: insertion [a,b,c], declared next a→c→b→done. */
function setupTopologyFlow(dir: string): FlowConfig {
  const flowYaml = `
flow: executor-cardlog-topo
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: a
    worker: { kind: deterministic, command: "true" }
    next: c
  - id: b
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: c
    worker: { kind: deterministic, command: "true" }
    next: b
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`topology fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** Single deterministic station `solo` → done (for the replay/idempotency test). */
function setupSoloFlow(dir: string): FlowConfig {
  const flowYaml = `
flow: executor-cardlog-solo
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: solo
    worker: { kind: deterministic, command: "true" }
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`solo fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? ['context.json', 'idea.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

/** Constant clock — avoids tripping the liveness watchdog (needed for hold). */
const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle — each test gets its own temp project dir (chdir for renderPrompt).
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-cardlog-exec-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — forward advance appends an entered_lane entry (reasonClass='forward').
// ---------------------------------------------------------------------------

describe('runExecutor — forward advance records an entered_lane entry (WI-381 AC1)', () => {
  it('records a forward entered_lane entry for every happy-path hop (a→c→b→done)', async () => {
    const flow = setupTopologyFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Sanity: the card actually reached the terminal.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');

    // Each declared hop produces a forward entry, in transition order.
    const hops = enteredLanes(db, 'entry').map((e) => ({
      source: e.sourceLane,
      dest: e.destLane,
      reason: e.reasonClass,
    }));
    expect(hops).toEqual([
      { source: 'a', dest: 'c', reason: 'forward' },
      { source: 'c', dest: 'b', reason: 'forward' },
      { source: 'b', dest: 'done', reason: 'forward' },
    ]);
  });

  it('records the gate-pass forward advance (ideate→done) as reasonClass=forward', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const forward = enteredLanes(db, 'entry').find((e) => e.destLane === 'done');
    expect(forward).toBeDefined();
    expect(forward!.reasonClass).toBe('forward');
    expect(forward!.sourceLane).toBe('ideate');
  });

  it('does NOT append a terminal entry when the card reaches a non-scrap/hold terminal (done)', async () => {
    // FR-4: terminal entries are for scrap/hold only — reaching `done` must not
    // create one.
    const flow = setupTopologyFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(terminals(db, 'entry')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — back-edge rework advance appends an entered_lane reasonClass='rework'.
// ---------------------------------------------------------------------------

describe('runExecutor — back-edge rework records reasonClass=rework (WI-381 AC2)', () => {
  it('records a rework entered_lane entry routing the worker station back to returnTo', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    // One reject then pass: the reject drives a rework advance (ideate→ideate).
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 1 });
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // The rework converged to done (sanity).
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');

    const rework = enteredLanes(db, 'entry').find((e) => e.reasonClass === 'rework');
    expect(rework).toBeDefined();
    // Source is the worker/gate station; dest is the on_reject (returnTo) lane.
    expect(rework!.sourceLane).toBe('ideate');
    expect(rework!.destLane).toBe('ideate');
  });
});

// ---------------------------------------------------------------------------
// AC3 — advancing to 'scrap' appends BOTH an entered_lane (scrap) and a terminal.
// ---------------------------------------------------------------------------

describe('runExecutor — scrap records entered_lane + terminal (WI-381 AC3, FR-4)', () => {
  it('appends a scrap entered_lane entry and a terminal entry capturing the reason', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    // Worker output never satisfies the schema → transform scraps (model-incompatible)
    // on the FIRST advance, so the scrap entries carry no prior-collision baggage.
    const { adapter } = makeBadWorkerAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('scrap');

    const scrapEntry = enteredLanes(db, 'entry').find((e) => e.reasonClass === 'scrap');
    expect(scrapEntry).toBeDefined();
    expect(scrapEntry!.destLane).toBe('scrap');

    const term = terminals(db, 'entry');
    expect(term).toHaveLength(1);
    expect(term[0]!.reason.length).toBeGreaterThan(0);
    // The scrap cause is the model-incompatible transform result.
    expect(term[0]!.reason).toMatch(/model/i);
  });
});

// ---------------------------------------------------------------------------
// AC4 — escalation to 'hold' appends an entered_lane (hold) + terminal.
// ---------------------------------------------------------------------------

describe('runExecutor — hold escalation records entered_lane + terminal (WI-381 AC4, FR-4)', () => {
  it('appends a hold entered_lane entry and a terminal entry with the hold reason', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    // Contradictory state: status='claimed' with no active_workers row → planTick
    // escalates (needsJudgment) and the executor freezes the card as 'held'. A
    // CONSTANT clock keeps the liveness watchdog from firing first.
    seedCard(db, { id: 'orphan', lane: 'ideate', status: 'claimed', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Sanity: the card was escalated to held (lane unchanged, status held).
    expect(db.getCard(DEFAULT_RUN_ID, 'orphan')?.status).toBe('held');

    const holdEntry = enteredLanes(db, 'orphan').find((e) => e.reasonClass === 'hold');
    expect(holdEntry).toBeDefined();
    expect(holdEntry!.sourceLane).toBe('ideate');

    const term = terminals(db, 'orphan');
    expect(term).toHaveLength(1);
    expect(term[0]!.reason.length).toBeGreaterThan(0);
    // The hold reason carries the escalation cause (the contradictory-state
    // detail string, or the needsJudgment reason class).
    expect(term[0]!.reason).toMatch(/contradict|manual|claimed|worker|judgment|escalat|hold/i);
  });
});

// ---------------------------------------------------------------------------
// AC5/AC6 — replay of the same advance after a crash does not duplicate entries.
// ---------------------------------------------------------------------------

describe('runExecutor — replay does not duplicate card_log entries (WI-381 AC5/AC6, FR-7/FR-8)', () => {
  it('re-running the same advance (resume) appends no duplicate entered_lane entry', async () => {
    const flow = setupSoloFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'rep', lane: 'solo', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    // First pass: solo → done. One forward entry recorded.
    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'rep')?.lane).toBe('done');
    expect(enteredLanes(db, 'rep')).toHaveLength(1);

    // Simulate a crash between the pre-commit card_log append and the state
    // commit: the card-state transition is rolled back to its pre-advance value
    // while the already-written card_log entry persists on the journal DB.
    db.getStateDb()
      .prepare("UPDATE cards SET lane = 'solo', status = 'ready' WHERE id = 'rep'")
      .run();
    db.getStateDb().prepare('DELETE FROM active_workers WHERE card_id = $id').run({ $id: 'rep' });

    // Resume: the station re-runs and re-appends the SAME (card,station,attempt,kind).
    // The UNIQUE constraint must dedup it — no second entered_lane entry.
    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'rep')?.lane).toBe('done');
    expect(enteredLanes(db, 'rep')).toHaveLength(1);
  });
});
