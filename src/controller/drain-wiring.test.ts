/**
 * Tests for wiring watchdog.planDrain into the event-driven pool (WI-471,
 * SPEC §8, FR-3).
 *
 * The consumption andon (control/watchdog.ts checkConsumptionAndon) trips on a
 * BUSY runaway — wall-clock or token budget exceeded. Today runExecutor only
 * halts the run when the andon trips AND there are NO active workers
 * (executor.ts:332 `consumptionAndon.tripped && activeCount === 0`). When
 * workers ARE in flight at the moment of the trip, their in-flight work is
 * silently abandoned: nothing drains the lease-valid ones to a checkpoint, and
 * nothing hard-kills the past-lease ones.
 *
 * WI-471 wires the built-but-unwired drain planner (control/watchdog.ts:123
 * `planDrain`) into that trip site. The contract this file pins:
 *
 *   1. When the consumption andon trips with N workers in flight, the kernel
 *      builds a WorkerSlot[] (cardId, station, leaseUntil) from active_workers
 *      and feeds it to planDrain, then:
 *        - blocks NEW claims (no further dispatch / spawn after the trip), and
 *        - lets lease-valid workers (leaseUntil > now) reach a checkpoint via
 *          their natural MARK_DONE (passive drain — work is NOT discarded), and
 *        - hard-kills past-lease workers (leaseUntil <= now): the spawned
 *          harness subprocess is terminated and its active_workers slot released.
 *   2. After every in-flight worker has drained or been killed, the run halts
 *      cleanly with the andon reason surfaced via the executor's error-output
 *      seam (`io.err`) and no new work is dispatched.
 *
 * EXECUTOR TIMING MODEL (after WI-471):
 * The andon check fires AFTER dispatch on the same tick. Scenarios:
 *
 *   tick0: dispatch workers → andon check trips → planDrain → kill/drain → yield → break
 *
 * This means the test's token budget (maxTokens: 0) is the cleanest andon trigger:
 * it fires on tick0, exactly when the in-flight workers are present.
 *
 * PASSIVE DRAIN (design ruling A):
 * The kernel does NOT call drain() on the worker handle. For lease-valid workers,
 * the kernel calls `await new Promise<void>((r) => queueMicrotask(r))` to yield the
 * event loop, then any queueMicrotask(MARK_DONE) callbacks from the fake fire,
 * and the onMessage handler checkpoints them before the loop exits.
 *
 * In tests, the fake simulates this by queuing MARK_DONE via queueMicrotask() in
 * send(START_WORK) for lease-valid workers. The executor's yield point (already
 * implemented) fires the microtask synchronously before breaking.
 *
 * Contract this file pins for src/cli/main.ts SpawnedWorker + executor.ts:
 *
 *   export interface SpawnedWorker {
 *     pid: number;
 *     send: (msg: WorkerMessage) => void;
 *     kill?: () => void;    // NEW — terminate the harness subprocess on hard_kill
 *     // NOTE: drain?:()=>void is NOT present — passive drain means the kernel
 *     // never calls drain(); it just yields and accepts natural MARK_DONE arrival.
 *   }
 *
 * These tests drive the REAL runExecutor pool path (concurrency > 1 + injected
 * spawn + the executor's own onMessage MARK_DONE handler). Only the spawn seam
 * and the clock are faked; planDrain, the andon, the FSM transition, and the
 * checkpoint write are all real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import type { WorkerMessage, StartWorkMessage } from '../worker/ipc-protocol';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, readCheckpoint } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noopAdapter: ModelAdapter = {
  async call() {
    throw new Error('adapter must not be called by a deterministic pool flow');
  },
};

function makeIO(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/**
 * A clock that returns each scripted value once and then sticks on the last.
 * runExecutor calls now() once per tick iteration (and once inside MARK_DONE handler
 * and at andon yield). CRITICAL: now() is called ONCE for runStartedAt before the
 * main loop. Design scripts as [runStartedAt, tick0, tick1, ...].
 */
function makeClock(script: number[]): () => number {
  let i = 0;
  return () => {
    const v = script[Math.min(i, script.length - 1)]!;
    i++;
    return v;
  };
}

/**
 * Single-station flow (one `work` station → done). Configurable wip and budgets.
 */
function setupDrainFlow(
  dir: string,
  opts: { wip: number; maxTokens: number; wallClockMinutes: number },
): FlowConfig {
  const flowYaml = `
flow: drain-wiring
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: ${opts.wallClockMinutes}, max_tokens: ${opts.maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 999 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: work
    worker: { kind: deterministic, command: "true" }
    wip: ${opts.wip}
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`drain fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * Two-station flow for the mixed hard_kill + drain scenario.
 * w1 and w2 are independent channels so cards can be in flight simultaneously.
 */
function setupTwoStationDrainFlow(
  dir: string,
  opts: { maxTokens: number; wallClockMinutes: number },
): FlowConfig {
  const flowYaml = `
flow: drain-wiring-two
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: ${opts.wallClockMinutes}, max_tokens: ${opts.maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 999 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: w1
    worker: { kind: deterministic, command: "true" }
    wip: 1
    next: done
  - id: w2
    worker: { kind: deterministic, command: "true" }
    wip: 1
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`two-station drain fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, id: string, lane: string = 'work'): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id,
    parent_id: null,
    lane,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

function activeWorkerCount(db: ConduitDB): number {
  const { n } = db.getStateDb().prepare('SELECT COUNT(*) AS n FROM active_workers').get() as { n: number };
  return n;
}

function hasActiveWorker(db: ConduitDB, cardId: string): boolean {
  const row = db
    .getStateDb()
    .prepare('SELECT 1 FROM active_workers WHERE card_id = $id')
    .get({ $id: cardId });
  return row !== undefined && row !== null;
}

// ---------------------------------------------------------------------------
// Spawn fakes
// ---------------------------------------------------------------------------

/**
 * makeParkingSpawn — a fake spawn seam that parks workers (never auto-delivers
 * MARK_DONE) unless configured to drain. Each handle exposes kill() and optionally
 * queues a MARK_DONE (passive drain).
 *
 * IMPORTANT: the andon check fires AFTER dispatch (same tick). This means the fake
 * must make workers "in flight" during the spawn, and the andon trip on that same
 * tick will feed them to planDrain. Use leaseOverride to force a worker into past-lease
 * territory (lease_until < now), and drainCardIds to simulate lease-valid workers that
 * deliver MARK_DONE naturally via the executor's queueMicrotask yield point.
 *
 * leaseOverride: { cardId → lease_until } — rewrite the active_workers row immediately
 *   after claim so planDrain classifies this worker as past-lease at the trip time.
 *
 * drainCardIds: cards for which send(START_WORK) queues MARK_DONE via queueMicrotask.
 *   The executor's yield point (`await new Promise<void>((r) => queueMicrotask(r))`)
 *   fires the microtask BEFORE breaking, so the onMessage handler writes the checkpoint.
 *   concurrency >= 2 is required for the onMessage handler to be registered.
 */
function makeParkingSpawn(
  db: ConduitDB,
  opts: {
    leaseOverride?: Record<string, number>;
    drainCardIds?: string[];
  } = {},
) {
  const spawns: Array<{ cardId: string; station: string; pid: number }> = [];
  const startWorks: StartWorkMessage[] = [];
  const killed: string[] = [];
  const live = new Map<string, string>(); // cardId → station
  let nextPid = 7000;
  let kernelHandler: ((msg: WorkerMessage) => void) | undefined;

  const { leaseOverride = {}, drainCardIds = [] } = opts;
  const drainSet = new Set(drainCardIds);

  const onMessage = (handler: (msg: WorkerMessage) => void): void => {
    kernelHandler = handler;
  };

  const spawn = (args: { cardId: string; station: string }) => {
    const pid = nextPid++;
    spawns.push({ cardId: args.cardId, station: args.station, pid });
    live.set(args.cardId, args.station);

    // Apply lease override AFTER attemptClaim writes the initial lease_until.
    // Forces the active_workers row to carry the overridden lease so planDrain
    // classifies it as past-lease (leaseUntil <= now) at the andon trip.
    if (leaseOverride[args.cardId] !== undefined) {
      db.getStateDb()
        .prepare('UPDATE active_workers SET lease_until = $lu WHERE card_id = $id')
        .run({ $lu: leaseOverride[args.cardId], $id: args.cardId });
    }

    const send = (msg: WorkerMessage) => {
      if (msg.type === 'START_WORK') {
        startWorks.push(msg);

        if (drainSet.has(args.cardId)) {
          // PASSIVE DRAIN: simulate a lease-valid worker that finishes naturally.
          // Queue MARK_DONE so it fires when the executor yields its sync control
          // flow via `await new Promise<void>((r) => queueMicrotask(r))` inside
          // the andon-trip handler. The executor's existing yield point fires this
          // microtask BEFORE breaking, so the real onMessage handler checkpoints it.
          const capturedStation = args.station;
          const capturedCardId = args.cardId;
          queueMicrotask(() => {
            if (kernelHandler) {
              kernelHandler({
                type: 'MARK_DONE',
                cardId: capturedCardId,
                station: capturedStation,
                attempt: 0,
                outcome: 'success',
              });
              live.delete(capturedCardId);
            }
          });
        }
        // else: PARK — worker never delivers MARK_DONE on its own.
        // Past-lease workers expect kill() to be called by the kernel.
      }
    };

    const kill = () => {
      killed.push(args.cardId);
      live.delete(args.cardId);
    };

    // kill is the planDrain seam. drain is NOT present (passive drain design).
    return { pid, send, kill };
  };

  return {
    spawn,
    onMessage,
    spawns,
    startWorks,
    killed,
    get liveCount() {
      return live.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-drain-'));
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
// AC1 — andon trips with workers in flight → planDrain classifies by lease,
//        new claims blocked, hard_kill for past-lease, drain for lease-valid
// ---------------------------------------------------------------------------

describe('drain wiring — consumption andon trips with workers in flight (AC1)', () => {
  it('feeds the in-flight slots to planDrain and blocks new dispatch on the trip', async () => {
    // wip=1 so only ONE worker is dispatched per tick. Three cards are ready.
    // maxTokens=0 trips the andon on tick0 AFTER c1 is dispatched (andon check fires
    // after dispatch). c1's lease_until is forced to 100 (past-lease at t=1000) so
    // planDrain returns hard_kill for it. kill() invocation discriminates planDrain
    // from the pre-existing lease-reclaim path (reclaim frees the slot but never kills).
    // c2/c3 must NOT be spawned — the andon blocks new claims.
    const flow = setupDrainFlow(projectDir, { wip: 1, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    seedCard(db, 'c2');
    seedCard(db, 'c3');
    const fake = makeParkingSpawn(db, {
      leaseOverride: { c1: 100 }, // force c1 past-lease: 100 < 1000 → hard_kill
    });
    const { io } = makeIO();

    const now = makeClock([1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    // planDrain classified c1 as past-lease and called kill() — discriminating signal.
    expect(fake.killed).toEqual(['c1']);
    // Exactly one worker was ever spawned — the andon blocked c2 and c3.
    expect(fake.spawns.map((s) => s.cardId)).toEqual(['c1']);
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('work'); // never dispatched
    expect(db.getCard(DEFAULT_RUN_ID, 'c3')?.lane).toBe('work');
  });

  it('honors a lease-valid worker that delivers MARK_DONE naturally after the trip (passive drain)', async () => {
    // Mixed scenario: c1 (w1, lease forced to 100 → past-lease) + c2 (w2, lease=1600 → drain).
    // Both dispatched on tick0. andon trips on tick0 (maxTokens=0) AFTER both are in flight.
    // planDrain: c1 → hard_kill (killed), c2 → drain (queueMicrotask MARK_DONE fires during yield).
    const flow = setupTwoStationDrainFlow(projectDir, { maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1', 'w1');
    seedCard(db, 'c2', 'w2');

    const fake = makeParkingSpawn(db, {
      leaseOverride: { c1: 100 }, // force c1 past-lease; c2 keeps real lease_until=1600
      drainCardIds: ['c2'],         // c2 queues MARK_DONE via queueMicrotask (passive drain)
    });
    const { io } = makeIO();

    const now = makeClock([1000, 1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    // past-lease c1 was hard-killed
    expect(fake.killed).toContain('c1');
    // lease-valid c2 was NOT killed
    expect(fake.killed).not.toContain('c2');
    // c2's passive drain produced a real checkpoint (work preserved, not discarded)
    const cp = readCheckpoint(db.getStateDb(), {
      flow: String(flow.version),
      card: 'c2',
      station: 'w2',
      attempt: 0,
    });
    expect(cp).not.toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    // Both slots released
    expect(hasActiveWorker(db, 'c1')).toBe(false);
    expect(hasActiveWorker(db, 'c2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — lease-valid worker's in-flight result is checkpointed, not discarded
// ---------------------------------------------------------------------------

describe('drain wiring — lease-valid worker checkpoints on MARK_DONE, not discarded (AC2)', () => {
  it('preserves a drained worker via the REAL MARK_DONE checkpoint path', async () => {
    // Single card. maxTokens=0 trips andon on tick0 after c1 is dispatched.
    // c1's lease_until = claimNow + 600 = 1600 > 1000 → lease-valid → passive drain.
    // The drain fake queues MARK_DONE via queueMicrotask. The executor's yield point
    // (await new Promise<void>((r) => queueMicrotask(r))) fires the microtask and the
    // onMessage handler writes a real checkpoint before the loop exits.
    // concurrency=2 required: onMessage handler is only registered when concurrency > 1.
    const flow = setupDrainFlow(projectDir, { wip: 2, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    const fake = makeParkingSpawn(db, { drainCardIds: ['c1'] });
    const { io } = makeIO();

    const now = makeClock([1000, 1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    // c1 was NOT killed (lease-valid → passive drain, not hard_kill)
    expect(fake.killed).not.toContain('c1');
    // Checkpoint exists — work was preserved via the real MARK_DONE → checkpoint path
    const cp = readCheckpoint(db.getStateDb(), {
      flow: String(flow.version),
      card: 'c1',
      station: 'work',
      attempt: 0,
    });
    expect(cp).not.toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC3 — past-lease worker is hard-killed: subprocess terminated, slot released
// ---------------------------------------------------------------------------

describe('drain wiring — past-lease worker is hard-killed (AC3)', () => {
  it('kills the harness subprocess and releases the slot for a past-lease worker', async () => {
    // c1 dispatched on tick0 (t=1000). lease_until forced to 100 (past-lease: 100 < 1000).
    // andon trips on tick0 (maxTokens=0) AFTER dispatch. planDrain: c1 → hard_kill.
    // kill() called, active_workers slot deleted.
    const flow = setupDrainFlow(projectDir, { wip: 1, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    const fake = makeParkingSpawn(db, { leaseOverride: { c1: 100 } });
    const { io } = makeIO();

    const now = makeClock([1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    // The kernel hard-killed c1's subprocess and released its slot.
    expect(fake.killed).toEqual(['c1']);
    expect(hasActiveWorker(db, 'c1')).toBe(false);
    expect(activeWorkerCount(db)).toBe(0);
  });

  it('does NOT kill a lease-valid worker (only past-lease workers are killed)', async () => {
    // Negative qualifier: a lease-valid worker at the andon trip must reach a checkpoint
    // via passive drain, NOT be kill()d. The positive checkpoint assertion prevents
    // vacuous pass via the existing stall path (which abandons the card with no checkpoint).
    // concurrency=2 required for onMessage registration.
    const flow = setupDrainFlow(projectDir, { wip: 2, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    const fake = makeParkingSpawn(db, { drainCardIds: ['c1'] });
    const { io } = makeIO();

    const now = makeClock([1000, 1000, 1000]); // claimNow=1000, lease=1600 > 1000 → lease-valid

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    expect(fake.killed).toEqual([]); // lease-valid → never killed
    // Positive half: lease-valid means drained-to-checkpoint, not abandoned.
    const cp = readCheckpoint(db.getStateDb(), {
      flow: String(flow.version),
      card: 'c1',
      station: 'work',
      attempt: 0,
    });
    expect(cp).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 — after every in-flight worker drains/kills, run halts cleanly with the
//        andon reason on io.err, no new dispatch
// ---------------------------------------------------------------------------

describe('drain wiring — clean halt with andon reason on io.err after drain (AC4)', () => {
  it('surfaces the andon reason via io.err and dispatches no new work after the trip', async () => {
    // Two cards, wip=1. c1 dispatched on tick0, andon trips (maxTokens=0) on same tick.
    // c1's lease forced to 100 → past-lease → hard_kill. c2 must NOT be spawned.
    const flow = setupDrainFlow(projectDir, { wip: 1, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    seedCard(db, 'c2');
    const fake = makeParkingSpawn(db, { leaseOverride: { c1: 100 } });
    const { io, err } = makeIO();

    const now = makeClock([1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    // planDrain hard-killed past-lease c1 — discriminates drain wiring from reclaim.
    expect(fake.killed).toEqual(['c1']);
    // The andon reason is surfaced on the error seam.
    expect(err.some((l) => /andon/i.test(l) && /tokens/i.test(l))).toBe(true);
    // No second card was ever spawned — new claims were blocked at the trip.
    expect(fake.spawns.map((s) => s.cardId)).toEqual(['c1']);
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('work');
    // The run halted: no worker left in flight.
    expect(activeWorkerCount(db)).toBe(0);
  });

  it('does not trip the andon a second time once one is already in effect', async () => {
    // The drain/kill path must not re-emit the andon message: exactly ONE
    // "run halted" line on io.err. Tied to kill() assertion so it exercises
    // planDrain wiring (not the pre-existing lease-reclaim path).
    const flow = setupDrainFlow(projectDir, { wip: 1, maxTokens: 0, wallClockMinutes: 999 });
    db = openDb();
    seedCard(db, 'c1');
    const fake = makeParkingSpawn(db, { leaseOverride: { c1: 100 } });
    const { io, err } = makeIO();

    const now = makeClock([1000, 1000, 1000]);

    await runExecutor({
      db,
      flow,
      now,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
      onMessage: fake.onMessage,
    } as RunEngineArgs);

    expect(fake.killed).toEqual(['c1']); // planDrain hard_kill, not lease-reclaim
    const andonLines = err.filter((l) => /andon: run halted/i.test(l));
    expect(andonLines.length).toBe(1);
  });
});
