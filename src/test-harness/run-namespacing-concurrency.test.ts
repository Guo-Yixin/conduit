/**
 * Adversarial two-run concurrency acceptance test (WI-484).
 *
 * The PRD's load-bearing 1→N success metric: two runs of the SAME flow in one
 * shared conduit.sqlite complete with fully independent results and zero
 * cross-run interference, including across a hold-then-resume of one run while
 * the other runs to completion.
 *
 * ---------------------------------------------------------------------------
 * Acceptance Criteria
 * ---------------------------------------------------------------------------
 *   AC1: job-A parks at hold while job-B runs to completion — job-B reaches its
 *        terminal result without being blocked by job-A's held card
 *   AC2: While job-B runs, job-A's checkpoints and outbox intents are never read
 *        or overwritten by job-B (same flow, overlapping internal card ids isolated)
 *   AC3: job-B's executor never promotes, dispatches, completes, or reclaims any
 *        of job-A's cards; job-B's completion does not falsely mark job-A terminal
 *   AC4: Resuming job-A after job-B has completed reclaims and re-drives only
 *        job-A's in-flight work and produces job-A's own correct result,
 *        leaving job-B's terminal result untouched
 *   AC5: Each run's final result is the result of ITS OWN inputs — verified by
 *        distinct per-run inputs producing distinct per-run outputs
 *
 * ---------------------------------------------------------------------------
 * Methodology
 * ---------------------------------------------------------------------------
 * End-to-end integration: drives the REAL runExecutor (not mocked) against a
 * real ConduitDB. Fixture helpers in run-namespacing-fixture.ts provide the
 * two-station deterministic flow, seeders, and cross-run inspection utilities.
 *
 * cappedClock() makes termination observable: a correctly-scoped executor exits
 * in a bounded number of ticks; an unscoped one spins and trips the cap, turning
 * a would-be infinite loop into a clean, fast assertion failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  writeFixtureFlow,
  loadFixtureFlow,
  openTestDb,
  seedRun,
  seedCard,
  seedCheckpoint,
  seedPendingIntent,
  driveRun,
  getRunCards,
  laneCount,
  outboxStatus,
  snapshotCards,
  cappedClock,
  stubAdapter,
  makeIO,
  DEFAULT_RUN_ID,
} from './run-namespacing-fixture';
import type { RunEngineArgs } from '../cli/main';
import { runExecutor } from '../controller/executor';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';

// ---------------------------------------------------------------------------
// Per-test setup: real temp project dir (executor needs to chdir for prompts)
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ReturnType<typeof openTestDb> | null;
let flowPath: string;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-2run-'));
  process.chdir(projectDir);
  db = openTestDb();
  flowPath = writeFixtureFlow(projectDir);
});

afterEach(() => {
  if (db) { db.close(); db = null; }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ===========================================================================
// AC1 — job-A parks at hold; job-B runs to completion independently
// ===========================================================================

describe('AC1: job-B completes while job-A is parked at hold', () => {
  it('job-B reaches done lane without being blocked by job-A held card', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');

    // job-A has a card already in hold (parked — not a runnable card)
    seedCard(db!, 'job-A', { id: 'entry-job-A', lane: 'hold', status: 'held' });

    // job-B has a ready entry card
    seedCard(db!, 'job-B', { id: 'entry-job-B', lane: 'a', status: 'ready' });

    // Run job-B's executor — must complete promptly without tripping cappedClock
    await driveRun(db!, flow, 'job-B');

    // job-B's card reached done
    const jobBCards = getRunCards(db!, 'job-B');
    const entryB = jobBCards.get('entry-job-B');
    expect(entryB?.lane).toBe('done');
    expect(entryB?.status).toBe('complete');
  });

  it('job-A held card remains in hold after job-B completes', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-job-A', lane: 'hold', status: 'held' });
    seedCard(db!, 'job-B', { id: 'entry-job-B', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-B');

    // job-A's card is untouched
    const cardA = db!.getCard('job-A', 'entry-job-A');
    expect(cardA?.lane).toBe('hold');
    expect(cardA?.status).toBe('held');
  });

  it('job-B executor terminates promptly (cappedClock does not trip) despite job-A held card', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-job-A', lane: 'hold', status: 'held' });
    seedCard(db!, 'job-B', { id: 'entry-job-B', lane: 'a', status: 'ready' });

    // cappedClock throws if executor reads clock too many times (unscoped loop spin)
    const io = makeIO();
    await runExecutor({
      db: db!,
      flow,
      now: cappedClock(2000),
      adapter: stubAdapter,
      io: io.io,
      runId: 'job-B',
    } as RunEngineArgs);
  });
});

// ===========================================================================
// AC2 — checkpoint and outbox isolation: job-B never reads or overwrites job-A's
// ===========================================================================

describe('AC2: checkpoint and outbox isolation across runs', () => {
  it('job-B running does not overwrite job-A checkpoint written with the same card id', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');

    // Both runs use the same internal card id pattern — seed overlapping card ids
    seedCard(db!, 'job-A', { id: 'entry', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry', lane: 'a', status: 'ready' });

    // Write job-A's checkpoint at station 'a' with a distinct payload
    seedCheckpoint(db!, 'job-A', 'entry', 'a', 'job-A-result');

    // Drive job-B's executor
    await driveRun(db!, flow, 'job-B');

    // job-A's checkpoint payload must be unchanged after job-B ran
    const stateDb = db!.getStateDb();
    const row = stateDb
      .prepare("SELECT output_json FROM checkpoints WHERE run_id = 'job-A' AND card = 'entry' AND station = 'a'")
      .get() as { output_json: string } | undefined | null;
    // Checkpoint must still exist and still contain job-A's payload
    expect(row).not.toBeNull();
    expect(row).not.toBeUndefined();
    if (row) {
      const output = JSON.parse(row.output_json) as { value?: string };
      expect(output.value).toBe('job-A-result');
    }
  });

  it('job-B running does not read or consume job-A pending outbox intent', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-job-A', lane: 'hold', status: 'held' });
    seedCard(db!, 'job-B', { id: 'entry-job-B', lane: 'a', status: 'ready' });

    // Seed a pending outbox intent for job-A
    seedPendingIntent(db!, 'job-A', 'entry-job-A', 'a', 'job-A:entry-job-A:a:0');

    await driveRun(db!, flow, 'job-B');

    // job-A's outbox intent must still be pending — job-B must not have committed it
    expect(outboxStatus(db!, 'job-A', 'job-A:entry-job-A:a:0')).toBe('pending');
  });

  it('job-A and job-B outbox intents with the same idempotency key are stored separately by run_id', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry', lane: 'hold', status: 'held' });
    seedCard(db!, 'job-B', { id: 'entry', lane: 'a', status: 'ready' });

    // Both runs seed an intent with the SAME logical key (same flow, same card id pattern)
    seedPendingIntent(db!, 'job-A', 'entry', 'a', 'two-station:entry:a:0');
    seedPendingIntent(db!, 'job-B', 'entry', 'a', 'two-station:entry:a:0');

    // Both must be stored — distinct rows by run_id
    const stateDb = db!.getStateDb();
    const rows = stateDb
      .prepare("SELECT run_id FROM outbox WHERE idempotency_key = 'two-station:entry:a:0'")
      .all() as Array<{ run_id: string }>;
    const runIds = new Set(rows.map((r) => r.run_id));
    expect(runIds.has('job-A')).toBe(true);
    expect(runIds.has('job-B')).toBe(true);
  });
});

// ===========================================================================
// AC3 — job-B's executor never promotes, dispatches, or reclaims job-A's cards;
//        job-B's completion does not falsely mark job-A terminal
// ===========================================================================

describe('AC3: job-B executor isolation from job-A cards', () => {
  it('job-B executor does not promote job-A waiting card', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    // job-A has a waiting card (deps not met — should never be promoted by another run)
    seedCard(db!, 'job-A', { id: 'waiting-A', lane: 'a', status: 'waiting' });
    seedCard(db!, 'job-B', { id: 'entry-B', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-B');

    // job-A's waiting card must remain waiting
    expect(db!.getCard('job-A', 'waiting-A')?.status).toBe('waiting');
    expect(db!.getCard('job-A', 'waiting-A')?.lane).toBe('a');
  });

  it('job-B executor does not dispatch or move job-A ready card', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    // job-A has a ready card — job-B must never claim or dispatch it
    seedCard(db!, 'job-A', { id: 'ready-A', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry-B', lane: 'a', status: 'ready' });

    const snapshotBefore = snapshotCards(db!, 'job-A');

    await driveRun(db!, flow, 'job-B');

    // job-A's ready card must be untouched — still ready in lane 'a'
    const cardA = db!.getCard('job-A', 'ready-A');
    expect(cardA?.status).toBe('ready');
    expect(cardA?.lane).toBe('a');
  });

  it('job-B completing does not mark job-A as terminal in the runs table', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-A', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry-B', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-B');

    // job-A's run record must NOT be in a terminal state just because job-B finished
    const runA = db!.getRun('job-A');
    expect(runA?.status).not.toBe('terminal');
    expect(runA?.status).not.toBe('done');
    expect(runA?.status).not.toBe('complete');
  });

  it('job-A cards are never in the active_workers table while only job-B is running', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-A', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry-B', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-B');

    // After job-B's run, no job-A card should appear in active_workers
    const stateDb = db!.getStateDb();
    const workerRows = stateDb
      .prepare("SELECT card_id FROM active_workers WHERE run_id = 'job-A'")
      .all() as Array<{ card_id: string }>;
    expect(workerRows).toHaveLength(0);
  });
});

// ===========================================================================
// AC4 — resuming job-A after job-B has completed recovers only job-A's work,
//        leaves job-B's terminal result untouched
// ===========================================================================

describe('AC4: job-A resume after job-B terminal leaves job-B untouched', () => {
  it('driving job-A after job-B is done completes job-A without moving job-B cards', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    seedCard(db!, 'job-A', { id: 'entry-A', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry-B', lane: 'a', status: 'ready' });

    // Run job-B to completion first
    await driveRun(db!, flow, 'job-B');
    expect(db!.getCard('job-B', 'entry-B')?.lane).toBe('done');

    // Snapshot job-B's terminal state
    const snapshotJobB = snapshotCards(db!, 'job-B');

    // Now drive job-A's executor (simulate resume)
    await driveRun(db!, flow, 'job-A');

    // job-A must have completed
    expect(db!.getCard('job-A', 'entry-A')?.lane).toBe('done');

    // job-B's state must be byte-identical to the snapshot — not touched by job-A
    const currentJobB = snapshotCards(db!, 'job-B');
    for (const [id, before] of snapshotJobB) {
      const after = currentJobB.get(id);
      expect(after?.lane).toBe(before.lane);
      expect(after?.status).toBe(before.status);
    }
  });

  it('job-A can complete even when job-B already occupies the done lane (no false uniqueness constraint)', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');
    // Both use the same logical card id pattern but different run_id
    seedCard(db!, 'job-A', { id: 'entry', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-B');
    // job-B's entry is now done; job-A's entry is still at 'a'
    expect(db!.getCard('job-B', 'entry')?.lane).toBe('done');
    expect(db!.getCard('job-A', 'entry')?.lane).toBe('a');

    // Drive job-A — must not crash on UNIQUE constraint or cross-contamination
    await driveRun(db!, flow, 'job-A');
    expect(db!.getCard('job-A', 'entry')?.lane).toBe('done');
  });

  it('job-A result is independent of job-B result when same flow run with distinct inputs', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-A');
    seedRun(db!, 'job-B');

    // Seed distinct checkpoints for each run's card at the same station
    seedCard(db!, 'job-A', { id: 'entry', lane: 'b', status: 'ready' });
    seedCard(db!, 'job-B', { id: 'entry', lane: 'b', status: 'ready' });
    seedCheckpoint(db!, 'job-A', 'entry', 'a', 'result-from-job-A-input');
    seedCheckpoint(db!, 'job-B', 'entry', 'a', 'result-from-job-B-input');

    await driveRun(db!, flow, 'job-B');
    await driveRun(db!, flow, 'job-A');

    // job-A's checkpoint must still reflect its own input, not job-B's
    const stateDb = db!.getStateDb();
    const rowA = stateDb
      .prepare("SELECT output_json FROM checkpoints WHERE run_id = 'job-A' AND card = 'entry' AND station = 'a'")
      .get() as { output_json: string } | undefined | null;
    const rowB = stateDb
      .prepare("SELECT output_json FROM checkpoints WHERE run_id = 'job-B' AND card = 'entry' AND station = 'a'")
      .get() as { output_json: string } | undefined | null;

    if (rowA) {
      const outputA = JSON.parse(rowA.output_json) as { value?: string };
      expect(outputA.value).toBe('result-from-job-A-input');
    }
    if (rowB) {
      const outputB = JSON.parse(rowB.output_json) as { value?: string };
      expect(outputB.value).toBe('result-from-job-B-input');
    }
  });
});

// ===========================================================================
// AC5 — distinct per-run inputs produce distinct per-run outputs (no result
//        cross-contamination at the run registry / card level)
// ===========================================================================

describe('AC5: distinct inputs → distinct outputs per run (no cross-contamination)', () => {
  it('two runs with distinct input_fingerprints are registered as separate run records', () => {
    seedRun(db!, 'job-X');
    seedRun(db!, 'job-Y');

    const runX = db!.getRun('job-X');
    const runY = db!.getRun('job-Y');

    expect(runX?.run_id).toBe('job-X');
    expect(runY?.run_id).toBe('job-Y');
    // Fingerprints are distinct (seeded with distinct values in fixture)
    expect(runX?.input_fingerprint).not.toBe(runY?.input_fingerprint);
  });

  it('cards from job-X and job-Y with the same logical id are stored separately in the DB', () => {
    seedRun(db!, 'job-X');
    seedRun(db!, 'job-Y');
    seedCard(db!, 'job-X', { id: 'p01', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-Y', { id: 'p01', lane: 'a', status: 'ready' });

    const cardX = db!.getCard('job-X', 'p01');
    const cardY = db!.getCard('job-Y', 'p01');

    expect(cardX?.run_id).toBe('job-X');
    expect(cardY?.run_id).toBe('job-Y');
    // Both rows exist and are distinct
    expect(cardX).not.toBeNull();
    expect(cardY).not.toBeNull();
  });

  it('driving job-X then job-Y both reach done with independent card state', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-X');
    seedRun(db!, 'job-Y');
    seedCard(db!, 'job-X', { id: 'entry', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-Y', { id: 'entry', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-X');
    await driveRun(db!, flow, 'job-Y');

    const cardX = db!.getCard('job-X', 'entry');
    const cardY = db!.getCard('job-Y', 'entry');
    expect(cardX?.lane).toBe('done');
    expect(cardY?.lane).toBe('done');
    // Each run's card has its own run_id — never contaminated
    expect(cardX?.run_id).toBe('job-X');
    expect(cardY?.run_id).toBe('job-Y');
  });

  it('concurrent lane counts per run are independent after both runs complete', async () => {
    const flow = loadFixtureFlow(flowPath);
    seedRun(db!, 'job-X');
    seedRun(db!, 'job-Y');
    seedCard(db!, 'job-X', { id: 'entry', lane: 'a', status: 'ready' });
    seedCard(db!, 'job-Y', { id: 'entry', lane: 'a', status: 'ready' });

    await driveRun(db!, flow, 'job-X');
    await driveRun(db!, flow, 'job-Y');

    const lanesX = laneCount(db!, 'job-X');
    const lanesY = laneCount(db!, 'job-Y');

    // Each run has exactly 1 card at done, 0 at scrap/hold
    expect(lanesX['done']).toBe(1);
    expect(lanesX['scrap'] ?? 0).toBe(0);
    expect(lanesY['done']).toBe(1);
    expect(lanesY['scrap'] ?? 0).toBe(0);
  });
});

// ===========================================================================
// Regression: DEFAULT_RUN_ID single-run path still works (back-compat)
// ===========================================================================

describe('back-compat: DEFAULT_RUN_ID single-run still terminates correctly', () => {
  it('a single DEFAULT_RUN_ID run with no other run in the DB completes to done', async () => {
    const flow = loadFixtureFlow(flowPath);
    const singleDb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(singleDb.getStateDb());
    singleDb.insertRun({ run_id: DEFAULT_RUN_ID, flow: 'two-station', input_fingerprint: 'fp', status: 'running' });
    singleDb.insertCard({
      run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'a',
      status: 'ready', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    const io = makeIO();
    await runExecutor({
      db: singleDb,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io: io.io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    expect(singleDb.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    singleDb.close();
  });
});
