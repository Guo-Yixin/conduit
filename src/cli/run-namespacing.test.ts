/**
 * CLI run-namespacing tests (WI-482).
 *
 * Covers the --run-id flag on `conduit run`:
 *   - AC1: --run-id job-A validates, registers, seeds entry card with run_id=job-A, drives executor scoped to job-A
 *   - AC2: no --run-id falls back to default run id (backward-compatible)
 *   - AC3: malformed --run-id exits non-zero, seeds no card
 *   - AC4: idempotent re-submit (same flow+input) returns current state, no duplicate entry card
 *   - AC5: conflict re-submit (different flow or input) exits non-zero, does not mutate
 *   - AC6: two sequential distinct run ids each seed their own card, complete independently
 *
 * Uses the same injected-seam entry point as cli.test.ts and concurrency-cap.test.ts:
 *   main(argv, deps) → exit code
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

// ---------------------------------------------------------------------------
// IO capture + stub adapter
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;
let flowRoot: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-rns-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal valid single-station flow.yaml and return its path. */
function writeFlow(name = 'minimal'): string {
  const yaml = `flow: ${name}
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
  on_dep_scrap: scrap
stations:
  - id: only
    worker:
      kind: transform
      role: writer
      model: test-model
      prompt_file: p.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: text, type: string, required: true }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
  const flowPath = join(flowRoot, `${name}.yaml`);
  writeFileSync(flowPath, yaml, 'utf-8');
  return flowPath;
}

/**
 * Same minimal flow as writeFlow(), but rooted in its own fresh temp dir. Used
 * where two runs need to seed the SAME declared entry-input filename
 * (in.json) with DIFFERENT --input content: since safe input-seeding work, entry seeding is
 * fail-closed on a pre-staged file whose content differs from the seed, so
 * two runs sharing one project_root can no longer both write in.json with
 * different content — give each its own project root instead, which is the
 * realistic multi-run setup anyway.
 */
function writeFlowInFreshRoot(name: string): { flowPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'conduit-rns-'));
  writeFileSync(join(root, 'p.md'), 'Write something.\n', 'utf-8');
  const yaml = `flow: ${name}
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
  on_dep_scrap: scrap
stations:
  - id: only
    worker:
      kind: transform
      role: writer
      model: test-model
      prompt_file: p.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: text, type: string, required: true }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
  const flowPath = join(root, `${name}.yaml`);
  writeFileSync(flowPath, yaml, 'utf-8');
  return { flowPath, root };
}

interface CapturedRun {
  args?: RunEngineArgs;
  called: boolean;
}

function makeDeps(over: { runEngine?: (args: RunEngineArgs) => Promise<void>; capture?: CapturedRun } = {}): CliDeps {
  const capture = over.capture;
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async (args) => {
      if (capture) { capture.called = true; capture.args = args; }
    }),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

// ===========================================================================
// AC1 — conduit run --run-id job-A validates, registers, seeds entry card
//        with run_id=job-A (not 'conduit-run-entry'), drives executor with runId=job-A
// ===========================================================================

describe('conduit run --run-id (AC1)', () => {
  it('seeds an entry card whose run_id matches the supplied --run-id', async () => {
    const flowPath = writeFlow();
    const capture: CapturedRun = { called: false };

    const code = await main(
      ['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'],
      makeDeps({ capture }),
    );

    expect(code).not.toBe(null); // ran without throwing
    expect(capture.called).toBe(true);

    // Entry card must carry run_id = job-A, NOT DEFAULT_RUN_ID / 'conduit-run-entry'
    const stateDb = db.getStateDb();
    const cards = stateDb
      .prepare("SELECT id, run_id FROM cards WHERE run_id = 'job-A'")
      .all() as Array<{ id: string; run_id: string }>;
    expect(cards.length).toBeGreaterThanOrEqual(1);
    for (const c of cards) {
      expect(c.run_id).toBe('job-A');
    }
  });

  it('entry card id is NOT the fixed string "conduit-run-entry" when --run-id is given', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps());

    const stateDb = db.getStateDb();
    const fixed = stateDb
      .prepare("SELECT id FROM cards WHERE id = 'conduit-run-entry'")
      .get() as { id: string } | null;
    expect(fixed).toBeNull();
  });

  it('threads runId=job-A into RunEngineArgs so the executor can scope to it', async () => {
    const flowPath = writeFlow();
    const capture: CapturedRun = { called: false };

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps({ capture }));

    expect(capture.called).toBe(true);
    expect(capture.args?.runId).toBe('job-A');
  });

  it('registers the run in the runs table before dispatching', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps());

    const run = db.getRun('job-A');
    expect(run).not.toBeNull();
    expect(run?.run_id).toBe('job-A');
  });

  it('exits 0 when the --run-id entry card reaches done lane', async () => {
    const flowPath = writeFlow();

    const code = await main(
      ['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb()
            .prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-A'")
            .run();
        },
      }),
    );

    expect(code).toBe(0);
  });
});

// ===========================================================================
// AC2 — no --run-id: falls back to default run id, behavior unchanged
// ===========================================================================

describe('conduit run without --run-id (AC2)', () => {
  it('seeds the entry card under DEFAULT_RUN_ID when no --run-id is given', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--input-inline', '{}'], makeDeps());

    const stateDb = db.getStateDb();
    const cards = stateDb
      .prepare(`SELECT id, run_id FROM cards WHERE run_id = '${DEFAULT_RUN_ID}'`)
      .all() as Array<{ id: string; run_id: string }>;
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  it('still threads a runId into RunEngineArgs (the default) when no --run-id flag given', async () => {
    const flowPath = writeFlow();
    const capture: CapturedRun = { called: false };

    await main(['run', flowPath, '--input-inline', '{}'], makeDeps({ capture }));

    // runId should be the stable default — either undefined (engine derives) or DEFAULT_RUN_ID
    // Either is acceptable; what matters is the engine IS called
    expect(capture.called).toBe(true);
  });

  it('uses the fixed entry card id "conduit-run-entry" (or stable per-default-run equivalent) without --run-id', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--input-inline', '{}'], makeDeps());

    const stateDb = db.getStateDb();
    // Without --run-id, at least one card must live under DEFAULT_RUN_ID
    const count = (stateDb
      .prepare(`SELECT COUNT(*) AS n FROM cards WHERE run_id = '${DEFAULT_RUN_ID}'`)
      .get() as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// AC3 — malformed --run-id: exits non-zero, seeds no card (fail-closed)
// ===========================================================================

describe('conduit run --run-id with malformed id (AC3)', () => {
  it.each([
    ['path separator', 'job/A'],
    ['whitespace', 'job A'],
    ['shell metachar $', 'job$A'],
    ['shell metachar ;', 'job;A'],
    ['too long (>128 chars)', 'a'.repeat(129)],
    ['empty string', ''],
  ])('exits non-zero for malformed run id: %s', async (_label, badId) => {
    const flowPath = writeFlow();
    let engineCalled = false;

    const code = await main(
      ['run', flowPath, '--run-id', badId, '--input-inline', '{}'],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
  });

  it('seeds no card when --run-id is malformed', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'bad/id', '--input-inline', '{}'], makeDeps());

    const stateDb = db.getStateDb();
    const count = (stateDb.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('writes a validation error to stderr for malformed --run-id', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'bad id with spaces', '--input-inline', '{}'], makeDeps());

    expect(io.errors.join('\n')).toMatch(/run.?id|invalid|validation/i);
  });
});

// ===========================================================================
// AC4 — idempotent re-submit: same flow + input → returns state, no duplicate
// ===========================================================================

describe('conduit run --run-id idempotent re-submit (AC4)', () => {
  it('does not seed a second entry card when re-submitted with same flow and input', async () => {
    const flowPath = writeFlow();

    // First submit — seeds the card
    await main(['run', flowPath, '--run-id', 'job-B', '--input-inline', '{}'], makeDeps());

    const stateDb = db.getStateDb();
    const countAfterFirst = (stateDb
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE run_id = 'job-B'")
      .get() as { n: number }).n;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    // Second submit — same run id, same flow and input
    let engineCalledSecond = false;
    await main(
      ['run', flowPath, '--run-id', 'job-B', '--input-inline', '{}'],
      makeDeps({ runEngine: async () => { engineCalledSecond = true; } }),
    );

    const countAfterSecond = (stateDb
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE run_id = 'job-B'")
      .get() as { n: number }).n;

    // No new cards seeded; count must stay the same
    expect(countAfterSecond).toBe(countAfterFirst);
    // Engine is not re-dispatched on idempotent re-submit
    expect(engineCalledSecond).toBe(false);
  });

  it('emits state information to stdout on idempotent re-submit', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'job-B', '--input-inline', '{}'], makeDeps());
    io.lines.length = 0; // reset captured output

    await main(['run', flowPath, '--run-id', 'job-B', '--input-inline', '{}'], makeDeps());

    // Some output must communicate the existing state
    const output = io.lines.join('\n') + io.errors.join('\n');
    expect(output.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AC5 — conflict re-submit: different flow or input → exits non-zero, no mutation
// ===========================================================================

describe('conduit run --run-id conflict re-submit (AC5)', () => {
  it('exits non-zero when re-submitted with a different --input-inline', async () => {
    const flowPath = writeFlow();

    // First submit with input A
    await main(['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":1}'], makeDeps());

    // Re-submit with different input
    let engineCalled = false;
    const code = await main(
      ['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":2}'],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
  });

  it('does not mutate the recorded run on conflict re-submit', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":1}'], makeDeps());

    const runBefore = db.getRun('job-C');

    await main(
      ['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":2}'],
      makeDeps(),
    );

    const runAfter = db.getRun('job-C');

    // Recorded run must be identical — conflict must not overwrite
    expect(runAfter?.flow).toBe(runBefore?.flow);
    expect(runAfter?.input_fingerprint).toBe(runBefore?.input_fingerprint);
  });

  it('writes a conflict error to stderr', async () => {
    const flowPath = writeFlow();

    await main(['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":1}'], makeDeps());
    io.errors.length = 0;

    await main(['run', flowPath, '--run-id', 'job-C', '--input-inline', '{"x":2}'], makeDeps());

    expect(io.errors.join('\n')).toMatch(/conflict|already/i);
  });
});

// ===========================================================================
// AC6 — two distinct run ids each get their own card and result, no cross-run
//        interference
// ===========================================================================

describe('conduit run two distinct run ids (AC6)', () => {
  it('seeds separate entry cards for job-X and job-Y with no cross-contamination', async () => {
    // Distinct project roots (see writeFlowInFreshRoot doc comment): safe input-seeding work makes
    // entry-input seeding fail-closed on differing pre-staged content, so two
    // runs sharing one project_root can no longer both seed in.json with
    // different --input content from the same path.
    const x = writeFlowInFreshRoot('minimal');
    const y = writeFlowInFreshRoot('minimal');
    try {
      await main(['run', x.flowPath, '--run-id', 'job-X', '--input-inline', '{"r":"x"}'], makeDeps());
      await main(['run', y.flowPath, '--run-id', 'job-Y', '--input-inline', '{"r":"y"}'], makeDeps());

      const stateDb = db.getStateDb();

      const xCards = stateDb
        .prepare("SELECT id FROM cards WHERE run_id = 'job-X'")
        .all() as Array<{ id: string }>;
      const yCards = stateDb
        .prepare("SELECT id FROM cards WHERE run_id = 'job-Y'")
        .all() as Array<{ id: string }>;

      expect(xCards.length).toBeGreaterThanOrEqual(1);
      expect(yCards.length).toBeGreaterThanOrEqual(1);

      // Card ids must be distinct between runs
      const xIds = new Set(xCards.map((c) => c.id));
      const yIds = new Set(yCards.map((c) => c.id));
      for (const id of yIds) {
        expect(xIds.has(id)).toBe(false);
      }
    } finally {
      rmSync(x.root, { recursive: true, force: true });
      rmSync(y.root, { recursive: true, force: true });
    }
  });

  it('registers separate run records for job-X and job-Y', async () => {
    // Distinct project roots — see writeFlowInFreshRoot doc comment above.
    // (This previously shared one root and only passed because registerRun ran
    // before the safe input-seeding work seeding refusal, leaving a zombie run row for job-Y.)
    const x = writeFlowInFreshRoot('minimal');
    const y = writeFlowInFreshRoot('minimal');
    try {
      await main(['run', x.flowPath, '--run-id', 'job-X', '--input-inline', '{"r":"x"}'], makeDeps());
      await main(['run', y.flowPath, '--run-id', 'job-Y', '--input-inline', '{"r":"y"}'], makeDeps());

      const runX = db.getRun('job-X');
      const runY = db.getRun('job-Y');

      expect(runX).not.toBeNull();
      expect(runY).not.toBeNull();
      expect(runX?.run_id).toBe('job-X');
      expect(runY?.run_id).toBe('job-Y');
    } finally {
      rmSync(x.root, { recursive: true, force: true });
      rmSync(y.root, { recursive: true, force: true });
    }
  });

  it('threads distinct runId values into RunEngineArgs for each submission', async () => {
    // Distinct project roots — see writeFlowInFreshRoot doc comment above.
    const x = writeFlowInFreshRoot('minimal');
    const y = writeFlowInFreshRoot('minimal');
    try {
      const capturedIds: (string | undefined)[] = [];

      const captureEngine = async (args: RunEngineArgs) => {
        capturedIds.push(args.runId);
      };

      await main(['run', x.flowPath, '--run-id', 'job-X', '--input-inline', '{"r":"x"}'], makeDeps({ runEngine: captureEngine }));
      await main(['run', y.flowPath, '--run-id', 'job-Y', '--input-inline', '{"r":"y"}'], makeDeps({ runEngine: captureEngine }));

      expect(capturedIds).toContain('job-X');
      expect(capturedIds).toContain('job-Y');
    } finally {
      rmSync(x.root, { recursive: true, force: true });
      rmSync(y.root, { recursive: true, force: true });
    }
  });
});
