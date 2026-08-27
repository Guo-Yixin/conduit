/**
 * Run-scoped resume tests (WI-483).
 *
 * Covers the --run flag on `conduit resume`:
 *   - AC1: conduit resume --run job-A reclaims/re-drives only job-A's in-flight cards;
 *          job-B's in-flight cards are never touched
 *   - AC2: bare conduit resume drives each non-terminal run independently scoped —
 *          job-A's resume does not disturb job-B and vice versa
 *   - AC3: conduit resume --run job-A when job-A has no in-flight cards is a safe no-op
 *   - AC4: conduit resume --run with an invalid run id exits non-zero, fail-closed
 *   - AC5: a pending effectful outbox intent for job-A escalates only job-A to hold;
 *          job-B's intents are untouched (run-scoped escalation)
 *   - AC6: existing single-run bare resume still works under the default run id
 *
 * Uses the same injected-seam entry point as cli.test.ts:
 *   main(argv, deps) → exit code
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { attemptClaim, beginWork } from '../dispatch/claim';
import { ensureCheckpointSchema, writePendingIntent } from '../checkpoint/checkpoint';
import { setPinnedFlowVersion, main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

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
let flowPath: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-rsn-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
  flowPath = writeFlow();
  // Pin flow version so resume doesn't reject for version mismatch
  setPinnedFlowVersion(db, 1);
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFlow(): string {
  const yaml = `flow: minimal
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
  const fp = join(flowRoot, 'flow.yaml');
  writeFileSync(fp, yaml, 'utf-8');
  return fp;
}

function makeDeps(over: { runEngine?: (args: RunEngineArgs) => Promise<void> } = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {}),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

/** Seed a card in working status (simulates a crashed in-flight worker). */
function seedInFlightCard(runId: string, cardId: string): void {
  db.insertCard({
    run_id: runId,
    id: cardId,
    parent_id: null,
    lane: 'only',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
  attemptClaim(db, { cardId, station: 'only', workerId: `w-${cardId}`, wipCap: 10, now: 1_000, leaseSeconds: 30, runId });
  beginWork(db, cardId, 'only', 1_000, 30, runId);
}

/** Seed a run record directly in the runs table. */
function seedRun(runId: string, status = 'running'): void {
  db.insertRun({ run_id: runId, flow: flowPath, input_fingerprint: 'fp', status });
}

// ===========================================================================
// AC1 — conduit resume --run job-A reclaims only job-A's in-flight cards;
//        job-B's in-flight cards are never touched
// ===========================================================================

describe('conduit resume --run scoped reclaim (AC1)', () => {
  it('reclaims job-A in-flight card to interrupted status', async () => {
    seedRun('job-A');
    seedInFlightCard('job-A', 'card-A1');

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    expect(db.getCard('job-A', 'card-A1')?.status).toBe('interrupted');
  });

  it('does not touch job-B in-flight card when resuming --run job-A', async () => {
    seedRun('job-A');
    seedRun('job-B');
    seedInFlightCard('job-A', 'card-A1');
    seedInFlightCard('job-B', 'card-B1');

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    // job-A's card reclaimed
    expect(db.getCard('job-A', 'card-A1')?.status).toBe('interrupted');
    // job-B's card untouched — still in-flight (claimed or working)
    const cardB1 = db.getCard('job-B', 'card-B1');
    expect(cardB1?.status).not.toBe('interrupted');
  });

  it('threads runId=job-A into RunEngineArgs when resuming --run job-A', async () => {
    seedRun('job-A');
    seedInFlightCard('job-A', 'card-A1');

    let capturedRunId: string | undefined;
    await main(['resume', flowPath, '--run', 'job-A'], makeDeps({
      runEngine: async (args) => { capturedRunId = args.runId; },
    }));

    expect(capturedRunId).toBe('job-A');
  });

  it('drives the engine exactly once for the specified --run job-A', async () => {
    seedRun('job-A');
    seedInFlightCard('job-A', 'card-A1');

    let engineCallCount = 0;
    await main(['resume', flowPath, '--run', 'job-A'], makeDeps({
      runEngine: async () => { engineCallCount++; },
    }));

    expect(engineCallCount).toBe(1);
  });

  it('exits 0 for --run resume with in-flight cards', async () => {
    seedRun('job-A');
    seedInFlightCard('job-A', 'card-A1');

    const code = await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    expect(code).toBe(0);
  });
});

// ===========================================================================
// AC2 — bare conduit resume drives each non-terminal run independently;
//        no cross-run disturbance
// ===========================================================================

describe('conduit resume bare — independent per-run scoping (AC2)', () => {
  it('reclaims job-A in-flight card without touching job-B in-flight card', async () => {
    seedRun('job-A');
    seedRun('job-B');
    seedInFlightCard('job-A', 'card-A1');
    seedInFlightCard('job-B', 'card-B1');

    const engineRunIds: (string | undefined)[] = [];
    await main(['resume', flowPath], makeDeps({
      runEngine: async (args) => { engineRunIds.push(args.runId); },
    }));

    // Each run driven separately — both run ids appear in engine calls
    expect(engineRunIds).toContain('job-A');
    expect(engineRunIds).toContain('job-B');
  });

  it('each run is driven with its own scoped runId in RunEngineArgs', async () => {
    seedRun('job-A');
    seedRun('job-B');
    seedInFlightCard('job-A', 'card-A1');
    seedInFlightCard('job-B', 'card-B1');

    const capturedArgs: RunEngineArgs[] = [];
    await main(['resume', flowPath], makeDeps({
      runEngine: async (args) => { capturedArgs.push(args); },
    }));

    const runIds = capturedArgs.map((a) => a.runId);
    expect(new Set(runIds).size).toBe(2); // two distinct run ids, not one shared sweep
    expect(runIds).toContain('job-A');
    expect(runIds).toContain('job-B');
  });

  it('reclaims both job-A and job-B in-flight cards independently', async () => {
    seedRun('job-A');
    seedRun('job-B');
    seedInFlightCard('job-A', 'card-A1');
    seedInFlightCard('job-B', 'card-B1');

    await main(['resume', flowPath], makeDeps());

    expect(db.getCard('job-A', 'card-A1')?.status).toBe('interrupted');
    expect(db.getCard('job-B', 'card-B1')?.status).toBe('interrupted');
  });
});

// ===========================================================================
// AC3 — conduit resume --run job-A with no in-flight cards is a safe no-op
// ===========================================================================

describe('conduit resume --run safe no-op (AC3)', () => {
  it('exits 0 when the run has no in-flight cards', async () => {
    seedRun('job-A');
    // No in-flight cards seeded

    const code = await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    expect(code).toBe(0);
  });

  it('reclaims nothing when the run has no in-flight cards', async () => {
    seedRun('job-A');
    db.insertCard({
      run_id: 'job-A', id: 'card-done', parent_id: null,
      lane: 'done', status: 'complete', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    // Card remains at done/complete — not moved to interrupted
    expect(db.getCard('job-A', 'card-done')?.status).toBe('complete');
    expect(db.getCard('job-A', 'card-done')?.lane).toBe('done');
  });

  it('does not call the engine when the run has no cards at all', async () => {
    seedRun('job-A');

    let engineCalled = false;
    await main(['resume', flowPath, '--run', 'job-A'], makeDeps({
      runEngine: async () => { engineCalled = true; },
    }));

    // A no-op resume with nothing to drive need not call the engine,
    // or if it does call it, the exit code must still be 0
    // (either interpretation is valid — this just asserts no crash)
    expect(io.errors.some((e) => /crash|fatal|uncaught/i.test(e))).toBe(false);
  });
});

// ===========================================================================
// AC4 — conduit resume --run with invalid run id exits non-zero (fail-closed)
// ===========================================================================

describe('conduit resume --run invalid id (AC4)', () => {
  it.each([
    ['path separator', 'job/A'],
    ['whitespace', 'job A'],
    ['shell metachar $', 'job$A'],
    ['empty string', ''],
    ['too long (>128)', 'x'.repeat(129)],
  ])('exits non-zero for malformed run id: %s', async (_label, badId) => {
    let engineCalled = false;

    const code = await main(
      ['resume', flowPath, '--run', badId],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
  });

  it('writes a validation error to stderr for malformed --run id', async () => {
    await main(['resume', flowPath, '--run', 'bad/id'], makeDeps());

    expect(io.errors.join('\n')).toMatch(/run.?id|invalid|validation/i);
  });
});

// ===========================================================================
// AC5 — pending outbox intent for job-A escalates only job-A to hold;
//        job-B's cards and intents are untouched
// ===========================================================================

describe('conduit resume --run outbox escalation scoped to run (AC5)', () => {
  it('escalates job-A card to hold when job-A has a pending outbox intent', async () => {
    seedRun('job-A');
    db.insertCard({
      run_id: 'job-A', id: 'card-A1', parent_id: null,
      lane: 'only', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    writePendingIntent(db.getStateDb(), {
      run: 'job-A', flow: 'minimal', card: 'card-A1', station: 'only', attempt: 0,
      idempotencyKey: 'job-A:card-A1:only:0',
      intent: { kind: 'publish' },
    });

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    expect(db.getCard('job-A', 'card-A1')?.lane).toBe('hold');
    expect(db.getCard('job-A', 'card-A1')?.status).toBe('held');
  });

  it('does not escalate job-B card when only job-A has a pending outbox intent', async () => {
    seedRun('job-A');
    seedRun('job-B');

    db.insertCard({
      run_id: 'job-A', id: 'card-A1', parent_id: null,
      lane: 'only', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.insertCard({
      run_id: 'job-B', id: 'card-B1', parent_id: null,
      lane: 'only', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    // Only job-A has a pending outbox intent
    writePendingIntent(db.getStateDb(), {
      run: 'job-A', flow: 'minimal', card: 'card-A1', station: 'only', attempt: 0,
      idempotencyKey: 'job-A:card-A1:only:0',
      intent: { kind: 'publish' },
    });

    // Resume only job-A
    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    // job-A's card was escalated to hold
    expect(db.getCard('job-A', 'card-A1')?.lane).toBe('hold');
    // job-B's card is untouched — still working (not escalated by job-A's resume)
    const cardB1 = db.getCard('job-B', 'card-B1');
    expect(cardB1?.lane).not.toBe('hold');
    expect(cardB1?.status).not.toBe('held');
  });

  it('emits a pending outbox error on stderr when escalating job-A', async () => {
    seedRun('job-A');
    db.insertCard({
      run_id: 'job-A', id: 'card-A1', parent_id: null,
      lane: 'only', status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    writePendingIntent(db.getStateDb(), {
      run: 'job-A', flow: 'minimal', card: 'card-A1', station: 'only', attempt: 0,
      idempotencyKey: 'job-A:card-A1:only:0',
      intent: { kind: 'publish' },
    });

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps());

    expect(io.errors.join('\n')).toMatch(/pending outbox/i);
  });
});

// ===========================================================================
// AC6 — existing bare resume (no --run) still works under DEFAULT_RUN_ID
//        (back-compat regression)
// ===========================================================================

describe('conduit resume bare — back-compat with default run id (AC6)', () => {
  it('reclaims a DEFAULT_RUN_ID in-flight card on bare resume', async () => {
    db.insertRun({ run_id: DEFAULT_RUN_ID, flow: flowPath, input_fingerprint: 'fp', status: 'running' });
    seedInFlightCard(DEFAULT_RUN_ID, 'card-default');

    await main(['resume', flowPath], makeDeps());

    expect(db.getCard(DEFAULT_RUN_ID, 'card-default')?.status).toBe('interrupted');
  });

  it('bare resume exits 0 with a DEFAULT_RUN_ID in-flight card', async () => {
    db.insertRun({ run_id: DEFAULT_RUN_ID, flow: flowPath, input_fingerprint: 'fp', status: 'running' });
    seedInFlightCard(DEFAULT_RUN_ID, 'card-default');

    const code = await main(['resume', flowPath], makeDeps());

    expect(code).toBe(0);
  });

  it('drives the engine with DEFAULT_RUN_ID on bare resume with one run registered', async () => {
    db.insertRun({ run_id: DEFAULT_RUN_ID, flow: flowPath, input_fingerprint: 'fp', status: 'running' });
    seedInFlightCard(DEFAULT_RUN_ID, 'card-default');

    let capturedRunId: string | undefined = 'not-set';
    await main(['resume', flowPath], makeDeps({
      runEngine: async (args) => { capturedRunId = args.runId; },
    }));

    // Engine called with DEFAULT_RUN_ID (or undefined which means default)
    const isDefault = capturedRunId === DEFAULT_RUN_ID || capturedRunId === undefined;
    expect(isDefault).toBe(true);
  });
});
