/**
 * CLI lifecycle tests: conduit run / resume / doctor + journal inspect/tail (WI-306).
 *
 * SPEC §10A/§15, FR-1a/15/17. This is the integration entrypoint — it WIRES the
 * real modules (loadFlow WI-292, planTick WI-295, attemptClaim/beginWork/reconcile
 * WI-294, checkpoint/outbox WI-298, journal WI-290) into a runnable binary.
 *
 * The CLI is exercised through `main(argv, deps): Promise<exitCode>` with injected
 * seams so the lifecycle (arg routing, fail-closed validation gating, exit codes,
 * journal streaming, resume reconciliation, doctor) is unit-testable WITHOUT a
 * full-engine e2e (the real terminal-drive of the reference flow is WI-307):
 *   - io          — captured stdout/stderr
 *   - now         — injected clock (deterministic lease expiry)
 *   - db          — an already-open ConduitDB (binary: mounted volume; tests: in-memory)
 *   - adapter     — kernel ModelAdapter (stub in tests)
 *   - runEngine   — the engine loop; DEFAULT in the binary is the real
 *                   planTick/claim/execute/checkpoint loop. Tests inject a fake
 *                   that drives terminal state + streams journal events.
 *   - prereqs     — doctor probes; DEFAULT checks project_root / DB volume / adapter.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/cli/main.ts
 * ---------------------------------------------------------------------------
 *
 *   export interface CliIO { out(line: string): void; err(line: string): void }
 *   export interface PrereqProbe { name: string; check(): { ok: boolean; detail?: string } }
 *   export interface RunEngineArgs { db: ConduitDB; flow: FlowConfig; now: () => number; adapter: ModelAdapter; io: CliIO }
 *   export interface CliDeps {
 *     io: CliIO;
 *     now: () => number;
 *     db: ConduitDB;
 *     adapter: ModelAdapter;
 *     runEngine: (args: RunEngineArgs) => Promise<void>;
 *     prereqs: PrereqProbe[];
 *   }
 *   export function main(argv: string[], deps: CliDeps): Promise<number>;  // resolves to the exit code
 *   export function setPinnedFlowVersion(db: ConduitDB, version: number): void;  // CLI-managed run_meta
 *   export function getPinnedFlowVersion(db: ConduitDB): number | null;
 *
 * Command routing (argv[0]):
 *   run <flow.yaml>        — loadFlow (fail-closed); pin flow_version; runEngine; stream journal; exit 0
 *   resume [--rebind] <flow.yaml> — reconcile dead leases; skip checkpointed stations; never blind-retry
 *                            pending outbox; a flow_version != pinned requires --rebind (exit non-zero otherwise)
 *   doctor                 — run each prereq probe; exit non-zero if any fails
 *   journal inspect <cardId> | journal tail <cardId> — print journal rows; NEVER write the state DB
 *
 * NOTE (flagged): package.json needs a `bin` field pointing at the built entry
 * (B.A. wires that). Also `journal inspect/tail` take a cardId because WI-290's
 * ConduitDB exposes getJournalSpans(cardId) (no get-all accessor).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { runExecutor } from '../controller/executor';
import { attemptClaim, beginWork } from '../dispatch/claim';
import {
  ensureCheckpointSchema,
  writeCheckpoint,
  decideResume,
  writePendingIntent,
  getIntentStatus,
  computeBindingStamp,
  type CheckpointKey,
} from '../checkpoint/checkpoint';
import {
  main,
  setPinnedFlowVersion,
  buildProductionDeps,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from './main';

const FLOWS = join(import.meta.dir, '..', '..', 'fixtures', 'flows');
const REFERENCE_FLOW = join(FLOWS, 'reference.flow.yaml');
const INVALID_FLOW = join(FLOWS, 'invalid', 'cyclic-deps.flow.yaml');

// ---------------------------------------------------------------------------
// Captured IO + stub adapter + deps factory
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb()); // checkpoints + outbox tables for resume tests
  io = makeIO();
});

afterEach(() => {
  db.close();
});

interface DepsOverride {
  runEngine?: (args: RunEngineArgs) => Promise<void>;
  prereqs?: PrereqProbe[];
  now?: () => number;
}

function makeDeps(over: DepsOverride = {}): CliDeps {
  return {
    io,
    now: over.now ?? (() => 1_000),
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {}),
    prereqs: over.prereqs ?? [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

// ===========================================================================
// AC1 — conduit run <valid flow> drives to terminal, streams journal, exits 0
// ===========================================================================

describe('conduit run — valid flow (AC1)', () => {
  it('loads the reference flow, runs the engine, streams journal events, and exits 0', async () => {
    // The reference flow declares a Slack egress channel, so the boot gate
    // requires SLACK_BOT_TOKEN. Set it for this test (the gate is covered
    // in detail by the dedicated Slack-egress boot-gate suite below).
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-stub';
    try {
      let engineFlowVersion: number | undefined;
      const runEngine = async (args: RunEngineArgs) => {
        engineFlowVersion = args.flow.version;
        // Simulate the engine driving a card to a terminal lane + journaling.
        args.db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'p', parent_id: null, lane: 'done', status: 'complete', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
        args.db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'p', station: 'draft', attempt: 0, name: 'station.complete' });
        args.io.out('journal: p draft station.complete');
      };

      const code = await main(['run', REFERENCE_FLOW], makeDeps({ runEngine }));

      expect(code).toBe(0);
      expect(engineFlowVersion).toBe(1); // the REAL reference flow loaded (flow_version: 1)
      expect(io.lines.some((l) => l.includes('station.complete'))).toBe(true); // journal streamed
    } finally {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });
});

// ===========================================================================
// AC2 — conduit run refuses an invalid flow, fail-closed, non-zero exit
// ===========================================================================

describe('conduit run — invalid flow (AC2)', () => {
  it('refuses to start and exits non-zero when the flow fails validation, without running the engine', async () => {
    let engineCalled = false;
    const runEngine = async () => {
      engineCalled = true;
    };

    const code = await main(['run', INVALID_FLOW], makeDeps({ runEngine }));

    expect(code).not.toBe(0); // fail-closed (FR-1)
    expect(engineCalled).toBe(false); // never reached dispatch
    expect(io.errors.join('\n')).toMatch(/cycle|invalid|valid/i);
  });
});

// ===========================================================================
// AC3 — conduit resume reconciles soundly
// ===========================================================================

describe('conduit resume — reconcile (AC3)', () => {
  it('interrupts dead-leased workers (with no pending effect), skips checkpointed stations, and drives the engine', async () => {
    setPinnedFlowVersion(db, 1); // matches the reference flow (flow_version: 1) — no --rebind needed

    // A leased-but-dead worker with NO pending outbox intent.
    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'c1', parent_id: null, lane: 'render', status: 'ready', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
    attemptClaim(db, { cardId: 'c1', station: 'render', workerId: 'w1', wipCap: 10, now: 1_000, leaseSeconds: 30 });
    beginWork(db, 'c1', 'render', 1_000, 30); // lease_until = 1030

    // A completed, checkpointed station (matching stamp → should be reused, not re-billed).
    const ckptKey: CheckpointKey = { flow: 'reference-branch-coverage', card: 'c0', station: 'draft', attempt: 0 };
    const stamp = computeBindingStamp({ modelId: 'gpt-4o-mini', promptTemplateVersion: 'v1', inputArtifactHashes: ['h'], flowVersion: 1 });
    writeCheckpoint(db.getStateDb(), ckptKey, {
      output: { payload: { ok: 1 }, findings_hash: 'fh', return_to: null, usage: { tokens: 5, cost: 0.001 } },
      stamp,
    });

    // pending-outbox recovery work(b): resume must drive the engine forward (cmdRun does; cmdResume now does too).
    let engineRan = false;
    const runEngine = async () => {
      engineRan = true;
    };

    // Resume well after the lease expired.
    const code = await main(['resume', REFERENCE_FLOW], makeDeps({ now: () => 5_000, runEngine }));

    expect(code).toBe(0);
    // Dead worker, no pending effect → interrupted (re-hydrate on next tick).
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('interrupted');
    // Checkpointed station is skipped (reused), not invalidated.
    expect(decideResume(db.getStateDb(), ckptKey, stamp).action).toBe('reuse');
    // The engine was driven (not a silent success).
    expect(engineRan).toBe(true);
  });

  // pending-outbox recovery work(a): a pending outbox intent must be ESCALATED (operator-visible + card to
  // hold), NOT silently left stuck and NOT blind-retried.
  it('escalates a pending outbox intent to hold and never blind-retries it', async () => {
    setPinnedFlowVersion(db, 1);

    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'c1', parent_id: null, lane: 'render', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });

    // A pending effectful outbox intent — must NOT be fired/committed on resume.
    writePendingIntent(db.getStateDb(), {
      flow: 'reference-branch-coverage', card: 'c1', station: 'render', attempt: 0,
      idempotencyKey: 'reference:c1:render:0', intent: { kind: 'publish' },
    });

    const code = await main(['resume', REFERENCE_FLOW], makeDeps({ now: () => 5_000 }));

    expect(code).toBe(0);
    // Pending outbox effect was NOT blind-retried (still pending, never committed).
    expect(getIntentStatus(db.getStateDb(), 'reference:c1:render:0')).toBe('pending');
    // The affected card was escalated to the hold lane (operator must reconcile).
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('hold');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('held');
    // An operator-visible signal was emitted (not a silent success).
    expect(io.errors.join('\n')).toMatch(/pending outbox/i);
  });
});

// ===========================================================================
// AC6 — resume against a different flow requires --rebind
// ===========================================================================

describe('conduit resume — rebind gate (AC6)', () => {
  it('refuses (non-zero) when the flow_version differs from the pinned run and --rebind is absent', async () => {
    setPinnedFlowVersion(db, 99); // pinned run is version 99; reference flow is version 1 → mismatch

    const code = await main(['resume', REFERENCE_FLOW], makeDeps({ now: () => 5_000 }));

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/rebind/i);
  });

  it('proceeds when --rebind is supplied for a different flow_version', async () => {
    setPinnedFlowVersion(db, 99);

    const code = await main(['resume', '--rebind', REFERENCE_FLOW], makeDeps({ now: () => 5_000 }));

    expect(code).toBe(0);
  });
});

// ===========================================================================
// AC4 — conduit doctor reports per-prerequisite and exits non-zero on any fail
// ===========================================================================

describe('conduit doctor (AC4)', () => {
  it('exits 0 and reports each prerequisite when all pass', async () => {
    const prereqs: PrereqProbe[] = [
      { name: 'project_root', check: () => ({ ok: true }) },
      { name: 'db_volume_writable', check: () => ({ ok: true }) },
      { name: 'model_adapter', check: () => ({ ok: true }) },
    ];

    const code = await main(['doctor'], makeDeps({ prereqs }));

    expect(code).toBe(0);
    const printed = io.lines.join('\n');
    expect(printed).toContain('project_root');
    expect(printed).toContain('db_volume_writable');
    expect(printed).toContain('model_adapter');
  });

  it('exits non-zero and reports the failing prerequisite when any check fails', async () => {
    const prereqs: PrereqProbe[] = [
      { name: 'project_root', check: () => ({ ok: true }) },
      { name: 'db_volume_writable', check: () => ({ ok: false, detail: 'read-only volume' }) },
      { name: 'model_adapter', check: () => ({ ok: true }) },
    ];

    const code = await main(['doctor'], makeDeps({ prereqs }));

    expect(code).not.toBe(0);
    expect(io.lines.join('\n') + io.errors.join('\n')).toContain('db_volume_writable');
  });
});

// ===========================================================================
// AC5 — journal inspect / tail are READ-ONLY (never write the state DB)
// ===========================================================================

describe('conduit journal inspect / tail (AC5)', () => {
  it('inspect prints journal rows for a card without mutating the state DB', async () => {
    // Seed a card (state DB) + a journal row.
    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'jc', parent_id: null, lane: 'render', status: 'working', attempt: 0, wave: 0, owned_paths: ['x'], rework_count: 0 });
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'jc', station: 'render', attempt: 0, name: 'gen_ai.call', usage: { model: 'gpt-4o', inputTokens: 5, outputTokens: 2, costUsd: 0.01 } });
    const before = db.getCard(DEFAULT_RUN_ID, 'jc');

    const code = await main(['journal', 'inspect', 'jc'], makeDeps());

    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('gen_ai.call'); // journal row printed
    // State DB is unchanged by a read-only inspect.
    expect(db.getCard(DEFAULT_RUN_ID, 'jc')).toEqual(before);
  });

  it('tail prints journal rows for a card and exits 0', async () => {
    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'jc', parent_id: null, lane: 'render', status: 'working', attempt: 0, wave: 0, owned_paths: ['x'], rework_count: 0 });
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'jc', station: 'render', attempt: 0, name: 'station.start' });

    const code = await main(['journal', 'tail', 'jc'], makeDeps());

    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('station.start');
  });

  // journal subcommand-validation work — an unknown journal subcommand is rejected (nonzero exit), not silently
  // treated as a synonym for inspect.
  it('rejects an unknown journal subcommand with a nonzero exit', async () => {
    const code = await main(['journal', 'bogus', 'jc'], makeDeps());
    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/unknown journal subcommand/i);
  });

  // journal subcommand-validation work — `tail` prints only the last N spans (distinct from `inspect`'s full print).
  it('tail prints only the trailing spans while inspect prints all', async () => {
    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'many', parent_id: null, lane: 'render', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
    for (let i = 0; i < 25; i++) {
      db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'many', station: 'render', attempt: 0, name: `span.${i}` });
    }

    const tailIo = makeIO();
    await main(['journal', 'tail', 'many'], { ...makeDeps(), io: tailIo });
    // tail caps at 20 trailing spans; the earliest (span.0) is NOT printed.
    expect(tailIo.lines.length).toBe(20);
    expect(tailIo.lines.some((l) => l.endsWith(' span.0'))).toBe(false);
    expect(tailIo.lines.some((l) => l.endsWith(' span.24'))).toBe(true);

    const inspectIo = makeIO();
    await main(['journal', 'inspect', 'many'], { ...makeDeps(), io: inspectIo });
    expect(inspectIo.lines.length).toBe(25); // inspect prints the full journal
  });
});

// ===========================================================================
// #3 — the real binary entrypoint wires PRODUCTION deps (import.meta.main).
// ===========================================================================

describe('production wiring (#3)', () => {
  it('buildProductionDeps wires a real DB, lazy adapter, engine, and prereqs', () => {
    const prevState = process.env.CONDUIT_STATE_DB;
    const prevJournal = process.env.CONDUIT_JOURNAL_DB;
    process.env.CONDUIT_STATE_DB = ':memory:';
    process.env.CONDUIT_JOURNAL_DB = ':memory:';
    try {
      const deps = buildProductionDeps();
      try {
        expect(typeof deps.runEngine).toBe('function');
        expect(deps.prereqs.length).toBeGreaterThan(0);
        // The adapter is constructed lazily — it exists, but throws only on call
        // (so --help / validation / doctor work without an API key).
        expect(typeof deps.adapter.call).toBe('function');
        // doctor + validation paths run WITHOUT a model API key.
        expect(deps.prereqs.some((p) => p.name === 'state_db_volume')).toBe(true);
      } finally {
        deps.db.close();
      }
    } finally {
      if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
      else process.env.CONDUIT_STATE_DB = prevState;
      if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
      else process.env.CONDUIT_JOURNAL_DB = prevJournal;
    }
  });

  it('the lazily-constructed production adapter throws when called without an API key', async () => {
    const prevState = process.env.CONDUIT_STATE_DB;
    const prevJournal = process.env.CONDUIT_JOURNAL_DB;
    const prevKey1 = process.env.CONDUIT_API_KEY;
    const prevKey2 = process.env.OPENAI_API_KEY;
    process.env.CONDUIT_STATE_DB = ':memory:';
    process.env.CONDUIT_JOURNAL_DB = ':memory:';
    delete process.env.CONDUIT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const deps = buildProductionDeps();
      try {
        await expect(
          deps.adapter.call({ model: 'm', prompt: 'p', params: {} }),
        ).rejects.toThrow(/API key/i);
      } finally {
        deps.db.close();
      }
    } finally {
      if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
      else process.env.CONDUIT_STATE_DB = prevState;
      if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
      else process.env.CONDUIT_JOURNAL_DB = prevJournal;
      if (prevKey1 !== undefined) process.env.CONDUIT_API_KEY = prevKey1;
      if (prevKey2 !== undefined) process.env.OPENAI_API_KEY = prevKey2;
    }
  });
});

// ===========================================================================
// WI-357 — CLI card seeding (--input / --input-inline) + real executor/adapter
//   wiring + distinct exit codes (completed vs halted). FR-9, FR-12; NFR-1.
// ===========================================================================

/**
 * Build a temp project dir with a valid single-station entry flow and chdir into
 * it (so project_root '.' resolves to the temp dir). The entry station 'ideate'
 * has no predecessor in happyPathNext and declares request.json as its input —
 * the artifact `conduit run --input` must seed. Returns a restore() for cleanup.
 */
function setupRunProject(): { dir: string; flowPath: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-cli-run-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{request.json}}');
  const flowYaml = `
flow: cli-run-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [request.json]
    outputs: [idea.json]
    next: done
`;
  const flowPath = join(dir, 'flow.yaml');
  writeFileSync(flowPath, flowYaml);
  const prevCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    flowPath,
    restore: () => {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A stub runEngine that snapshots the cards present when the engine is invoked
 * (proving cmdRun seeded the entry card BEFORE dispatch), then either drives the
 * card to a terminal 'done' (complete) or leaves it in place (halt).
 */
function makeCapturingEngine(outcome: 'complete' | 'halt'): {
  runEngine: (args: RunEngineArgs) => Promise<void>;
  cap: { called: boolean; lanesAtStart: string[] };
} {
  const cap = { called: false, lanesAtStart: [] as string[] };
  const runEngine = async (args: RunEngineArgs) => {
    cap.called = true;
    cap.lanesAtStart = (
      args.db.getStateDb().prepare('SELECT lane FROM cards').all() as Array<{ lane: string }>
    ).map((r) => r.lane);
    if (outcome === 'complete') {
      args.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete'").run();
    }
    // halt: leave cards untouched — the entry card never reaches 'done'.
  };
  return { runEngine, cap };
}

describe('conduit run — card seeding from --input file (WI-357 AC1)', () => {
  it('seeds the entry card at the entry station, writes the input artifact under project root, runs the engine, exits 0', async () => {
    const proj = setupRunProject();
    try {
      const inputPath = join(proj.dir, 'my-input.json');
      writeFileSync(inputPath, '{"topic":"widgets"}');
      const { runEngine, cap } = makeCapturingEngine('complete');

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(0);
      expect(cap.called).toBe(true);
      // The entry card was seeded at the entry station ('ideate') before dispatch.
      expect(cap.lanesAtStart).toContain('ideate');
      // The input artifact was written under the project root with the file's content.
      expect(existsSync(join(proj.dir, 'request.json'))).toBe(true);
      expect(readFileSync(join(proj.dir, 'request.json'), 'utf-8')).toContain('widgets');
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — card seeding from --input-inline (WI-357 AC2)', () => {
  it('seeds the same entry-card artifact from an inline idea', async () => {
    const proj = setupRunProject();
    try {
      const { runEngine, cap } = makeCapturingEngine('complete');

      const code = await main(
        ['run', proj.flowPath, '--input-inline', 'a great shoppable idea'],
        makeDeps({ runEngine }),
      );

      expect(code).toBe(0);
      expect(cap.called).toBe(true);
      expect(cap.lanesAtStart).toContain('ideate');
      expect(existsSync(join(proj.dir, 'request.json'))).toBe(true);
      expect(readFileSync(join(proj.dir, 'request.json'), 'utf-8')).toContain('a great shoppable idea');
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — fail-closed seeding (WI-357 AC3/FR-9)', () => {
  it('fails closed with a non-zero exit and a clear message when neither --input nor a runnable card exists', async () => {
    const proj = setupRunProject();
    try {
      // The shared db is empty (no cards) and no --input is given.
      const { runEngine, cap } = makeCapturingEngine('complete');

      const code = await main(['run', proj.flowPath], makeDeps({ runEngine }));

      expect(code).not.toBe(0);
      // Fail-closed: the engine is NEVER reached when there is nothing to run.
      expect(cap.called).toBe(false);
      expect(io.errors.join('\n')).toMatch(/input|seed|no .*runnable|no .*card/i);
    } finally {
      proj.restore();
    }
  });

  it('proceeds (runs the engine) without --input when a runnable card already exists in the DB', async () => {
    const proj = setupRunProject();
    try {
      db.insertCard({
        run_id: DEFAULT_RUN_ID,
        id: 'pre',
        parent_id: null,
        lane: 'ideate',
        status: 'ready',
        attempt: 0,
        wave: 0,
        owned_paths: [],
        rework_count: 0,
      });
      const { runEngine, cap } = makeCapturingEngine('complete');

      const code = await main(['run', proj.flowPath], makeDeps({ runEngine }));

      expect(cap.called).toBe(true); // an existing runnable card is a valid run input
      expect(code).toBe(0);
    } finally {
      proj.restore();
    }
  });
});

describe('conduit run — distinct exit codes: completed vs halted (WI-357 AC4/FR-12)', () => {
  it('exits 0 when the seeded card reaches done (completed run)', async () => {
    const proj = setupRunProject();
    try {
      const inputPath = join(proj.dir, 'in.json');
      writeFileSync(inputPath, '{}');
      const { runEngine } = makeCapturingEngine('complete');

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      expect(code).toBe(0);
    } finally {
      proj.restore();
    }
  });

  it('exits with a distinct non-zero code (1) when the run halts before done (budget/deadlock/escalation)', async () => {
    const proj = setupRunProject();
    try {
      const inputPath = join(proj.dir, 'in.json');
      writeFileSync(inputPath, '{}');
      // The engine returns with the card still mid-flow (not 'done') — a halt.
      const { runEngine } = makeCapturingEngine('halt');

      const code = await main(['run', proj.flowPath, '--input', inputPath], makeDeps({ runEngine }));

      // Distinct from a completed run (0) so an operator can tell them apart (FR-12).
      expect(code).toBe(1);
    } finally {
      proj.restore();
    }
  });
});

describe('conduit — production wiring of the real executor + adapter (WI-357 AC5)', () => {
  it('buildProductionDeps wires runExecutor as runEngine and adds the gateway base-url doctor probe', () => {
    const prevState = process.env.CONDUIT_STATE_DB;
    const prevJournal = process.env.CONDUIT_JOURNAL_DB;
    process.env.CONDUIT_STATE_DB = ':memory:';
    process.env.CONDUIT_JOURNAL_DB = ':memory:';
    try {
      const deps = buildProductionDeps();
      try {
        // The print-stub productionRunEngine is replaced by the real executor (WI-356).
        expect(deps.runEngine).toBe(runExecutor);
        // The WI-354 gateway base-url probe is added alongside the existing probes.
        expect(deps.prereqs.some((p) => /gateway|base.?url/i.test(p.name))).toBe(true);
      } finally {
        deps.db.close();
      }
    } finally {
      if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
      else process.env.CONDUIT_STATE_DB = prevState;
      if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
      else process.env.CONDUIT_JOURNAL_DB = prevJournal;
    }
  });

  it('never prints CONDUIT_API_KEY in doctor output or errors (secret hygiene)', async () => {
    const SECRET = 'sk-cli-must-not-leak-123';
    const prevState = process.env.CONDUIT_STATE_DB;
    const prevJournal = process.env.CONDUIT_JOURNAL_DB;
    const prevKey = process.env.CONDUIT_API_KEY;
    process.env.CONDUIT_STATE_DB = ':memory:';
    process.env.CONDUIT_JOURNAL_DB = ':memory:';
    process.env.CONDUIT_API_KEY = SECRET;
    try {
      const deps = buildProductionDeps();
      const capIo = makeIO();
      try {
        // doctor reads the API key for the model_api_key probe — it must NEVER echo it.
        await main(['doctor'], { ...deps, io: capIo });
        const joined = capIo.lines.join(' ') + ' ' + capIo.errors.join(' ');
        expect(joined).not.toContain(SECRET);
      } finally {
        deps.db.close();
      }
    } finally {
      if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
      else process.env.CONDUIT_STATE_DB = prevState;
      if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
      else process.env.CONDUIT_JOURNAL_DB = prevJournal;
      if (prevKey === undefined) delete process.env.CONDUIT_API_KEY;
      else process.env.CONDUIT_API_KEY = prevKey;
    }
  });
});

// ===========================================================================
// PR-4 review: boot-time SLACK_BOT_TOKEN validation for flows with Slack egress
//
// executor.ts:1440 reads process.env.SLACK_BOT_TOKEN and defaults to '' when
// the token is absent, causing invalid_auth on every HITL/delivery post. The
// fix is a boot gate in cmdRun: if the loaded flow declares a Slack egress
// channel, SLACK_BOT_TOKEN must be non-empty before the engine is invoked.
//
// Cases:
//   1. Slack egress + missing token  → non-zero exit, actionable error, no engine
//   2. Slack egress + token present  → boots normally, engine invoked
//   3. No slack egress  + no token   → boots normally (no false positive)
// ===========================================================================

describe('cmdRun — boot-time SLACK_BOT_TOKEN gate for Slack egress flows', () => {
  // The reference fixture already declares channels.egress[0].type: slack.
  // The setupRunProject() helper produces a flow with NO channels block at all.

  it('exits non-zero with an actionable error when the flow has Slack egress and token is absent', async () => {
    const prevToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      let engineCalled = false;
      const runEngine = async () => {
        engineCalled = true;
      };

      const code = await main(['run', REFERENCE_FLOW], makeDeps({ runEngine }));

      expect(code).not.toBe(0);
      // Engine must NOT be invoked — fail-closed before any dispatch.
      expect(engineCalled).toBe(false);
      // The error message must name the variable and explain why it is needed.
      const errText = io.errors.join('\n');
      expect(errText).toMatch(/SLACK_BOT_TOKEN/);
      expect(errText).toMatch(/HITL|delivery|bot token/i);
    } finally {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it('exits non-zero with an actionable error when the flow has Slack egress and token is empty string', async () => {
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = '';
    try {
      let engineCalled = false;
      const runEngine = async () => {
        engineCalled = true;
      };

      const code = await main(['run', REFERENCE_FLOW], makeDeps({ runEngine }));

      expect(code).not.toBe(0);
      expect(engineCalled).toBe(false);
      expect(io.errors.join('\n')).toMatch(/SLACK_BOT_TOKEN/);
    } finally {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it('boots normally and invokes the engine when the flow has Slack egress and token is set', async () => {
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      let engineCalled = false;
      const runEngine = async (args: RunEngineArgs) => {
        engineCalled = true;
        // Drive the card to done so cmdRun exits 0.
        args.db.insertCard({
          run_id: DEFAULT_RUN_ID,
          id: 'c1',
          parent_id: null,
          lane: 'done',
          status: 'complete',
          attempt: 0,
          wave: 0,
          owned_paths: [],
          rework_count: 0,
        });
      };

      const code = await main(['run', REFERENCE_FLOW], makeDeps({ runEngine }));

      // Boot proceeds; engine is invoked.
      expect(engineCalled).toBe(true);
      // No SLACK_BOT_TOKEN error emitted.
      expect(io.errors.join('\n')).not.toMatch(/SLACK_BOT_TOKEN/);
      // Exit 0 (all cards at done).
      expect(code).toBe(0);
    } finally {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it('boots normally (no false positive) when the flow has NO Slack egress and token is absent', async () => {
    const prevToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      // Use the inline flow-builder to produce a flow with no channels block.
      const proj = setupRunProject();
      try {
        let engineCalled = false;
        const runEngine = async (args: RunEngineArgs) => {
          engineCalled = true;
          args.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete'").run();
        };

        const inputPath = join(proj.dir, 'req.json');
        writeFileSync(inputPath, '{}');
        const code = await main(
          ['run', proj.flowPath, '--input', inputPath],
          makeDeps({ runEngine }),
        );

        // No Slack egress → no token gate → engine runs normally.
        expect(engineCalled).toBe(true);
        expect(io.errors.join('\n')).not.toMatch(/SLACK_BOT_TOKEN/);
        expect(code).toBe(0);
      } finally {
        proj.restore();
      }
    } finally {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });
});
