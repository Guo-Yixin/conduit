/**
 * Tests for the event-driven kernel worker pool — the SPAWN/CLAIM half
 * (WI-470a, SPEC §10A, FR-2/FR-2a).
 *
 * runExecutor today drives stations with a synchronous `for (const action of
 * plan.actions) await executeStation(...)` loop (executor.ts:388/415). This item
 * makes the loop event-driven WHEN concurrency > 1:
 *
 *   - concurrency = 1  → the EXISTING synchronous path, UNCHANGED. Cards must
 *     reach the same terminal lane/status as before (byte-identical, AC1). The
 *     injected spawn seam is NEVER used on this path.
 *   - concurrency = K>1 → each tick the kernel claims up to min(K, station.wip)
 *     dispatchable lanes via the EXISTING atomic attemptClaim (the sole
 *     linearization point), spawns a worker harness per claim through an INJECTED
 *     spawn seam, and sends START_WORK over the worker's IPC send. The real OS
 *     pid of the spawned worker is written into active_workers.pid (via the
 *     WI-467 pid-on-claim) so dead-PID reclaim can fire.
 *
 * NOT in scope here (WI-470b): the MARK_DONE reaction — post-work
 * transition/checkpoint/journal/fan-in/re-plan. These tests therefore drive the
 * SPAWN/CLAIM contract: who is spawned, how many are in flight, what START_WORK
 * carries, and that pid is recorded. The fake spawn seam stands in for the
 * worker+kernel-reaction so the loop can make progress without WI-470b.
 *
 * Contract this file pins for src/controller/executor.ts + RunEngineArgs:
 *
 *   // RunEngineArgs gains an optional spawn seam (production wires Bun.spawn;
 *   // tests inject a fake so no real OS process is created).
 *   import type { StartWorkMessage, WorkerMessage } from '../worker/ipc-protocol';
 *
 *   export interface SpawnedWorker {
 *     // The real OS pid of the spawned harness — written to active_workers.pid.
 *     pid: number;
 *     // IPC send seam to the worker; the kernel pushes START_WORK here.
 *     send: (msg: WorkerMessage) => void;
 *   }
 *   export interface SpawnWorkerArgs {
 *     cardId: string;
 *     station: string;
 *   }
 *   export type SpawnWorker = (args: SpawnWorkerArgs) => SpawnedWorker;
 *
 *   // Added to RunEngineArgs:
 *   //   concurrency: number;          // already present (WI-466)
 *   //   spawn?: SpawnWorker;          // NEW — injected pool spawn seam
 *
 * The START_WORK the kernel sends MUST carry cardId/station/resolved input
 * references (paths/names) and NO artifact bytes (NFR-4); reuse the WI-465
 * StartWorkMessage shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import type { WorkerMessage, StartWorkMessage } from '../worker/ipc-protocol';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

/** A no-op adapter — these flows are deterministic (command: true), no LLM. */
const noopAdapter: ModelAdapter = {
  async call() {
    throw new Error('adapter must not be called by a deterministic pool flow');
  },
};

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
    lines,
  };
}

/**
 * A single deterministic station `work` → done, with a configurable WIP cap.
 * Every seeded card lands on `work` and is independently dispatchable, so K and
 * station.wip jointly bound how many can be in flight at once.
 */
function setupPoolFlow(dir: string, wip: number, maxTokens = 100000): FlowConfig {
  const flowYaml = `
flow: executor-pool
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: work
    worker: { kind: deterministic, command: "true" }
    wip: ${wip}
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`pool fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, id: string, lane: string): void {
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

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function activeWorkerCount(db: ConduitDB): number {
  const { n } = db
    .getStateDb()
    .prepare('SELECT COUNT(*) AS n FROM active_workers')
    .get() as { n: number };
  return n;
}

/**
 * A fake spawn seam. Records every spawn and the START_WORK each worker receives.
 * To let the run make progress WITHOUT WI-470b's MARK_DONE reaction, it stands in
 * for the worker + kernel reaction: on receiving START_WORK it advances the card
 * to `done` and releases its active_workers slot — exactly what the real
 * MARK_DONE path will do. A `peakInFlight` tracker observes the max simultaneous
 * occupancy of active_workers so the min(K, wip) bound is checkable.
 */
function makeFakeSpawn(db: ConduitDB) {
  const spawns: Array<{ cardId: string; station: string; pid: number }> = [];
  const startWorks: StartWorkMessage[] = [];
  let nextPid = 9000;
  let peakInFlight = 0;

  const spawn = (args: { cardId: string; station: string }) => {
    const pid = nextPid++;
    spawns.push({ cardId: args.cardId, station: args.station, pid });

    // Sample occupancy at the moment of spawn — workers occupy active_workers
    // from claim until this fake completes them below.
    const inFlight = activeWorkerCount(db);
    if (inFlight > peakInFlight) peakInFlight = inFlight;

    const send = (msg: WorkerMessage) => {
      if (msg.type === 'START_WORK') {
        startWorks.push(msg);
        // Stand in for WI-470b: complete the card and free its slot so the loop
        // can dispatch the next batch (no busy-spin, no hang).
        db.getStateDb()
          .transaction(() => {
            db.getStateDb()
              .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = $id")
              .run({ $id: msg.cardId });
            db.getStateDb()
              .prepare('DELETE FROM active_workers WHERE card_id = $id AND station = $station')
              .run({ $id: msg.cardId, $station: msg.station });
          })
          .immediate();
      }
    };

    return { pid, send };
  };

  return {
    spawn,
    spawns,
    startWorks,
    get peakInFlight() {
      return peakInFlight;
    },
  };
}

/**
 * A DEFERRED-completion pool fake (the real concurrency test). Unlike makeFakeSpawn
 * — which completes each card synchronously inside send(), so only ONE worker is
 * ever in flight and a peak assertion is tautological — this fake BUFFERS each
 * START_WORK and delivers its MARK_DONE on a later macrotask via the captured
 * onMessage handler. That keeps multiple workers simultaneously in flight, so
 * `peakInFlight` observes the TRUE maximum occupancy. If the run-level concurrency
 * cap guard were removed, the controller would dispatch every dispatchable lane in
 * one tick (completions are deferred) and peakInFlight would blow past min(K, wip)
 * — i.e. this fake makes the cap falsifiable.
 */
function makeDeferredPool(db: ConduitDB) {
  let handler: ((msg: WorkerMessage) => void) | null = null;
  const onMessage = (h: (msg: WorkerMessage) => void) => {
    handler = h;
  };
  let nextPid = 7000;
  let peakInFlight = 0;
  let spawnCount = 0;

  const spawn = (args: { cardId: string; station: string }) => {
    const pid = nextPid++;
    spawnCount++;
    // The claim already inserted this card's active_workers row, so this sample
    // includes the card now being spawned plus every still-in-flight predecessor.
    const inFlight = activeWorkerCount(db);
    if (inFlight > peakInFlight) peakInFlight = inFlight;

    const send = (msg: WorkerMessage) => {
      if (msg.type === 'START_WORK') {
        // Defer completion to a macrotask: the controller stays in flight until it
        // yields at its worker-event wait, which is exactly what lets >1 worker be
        // simultaneously live and makes the peak meaningful.
        setTimeout(() => {
          handler?.({
            type: 'MARK_DONE',
            cardId: msg.cardId,
            station: msg.station,
            attempt: msg.attempt,
            outcome: 'success',
          });
        }, 0);
      }
    };
    return { pid, send };
  };

  return {
    spawn,
    onMessage,
    get peakInFlight() {
      return peakInFlight;
    },
    get spawnCount() {
      return spawnCount;
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
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-pool-'));
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
// AC1 — concurrency=1 keeps the synchronous path, spawn seam never used
// ---------------------------------------------------------------------------

describe('runExecutor pool — concurrency=1 keeps the synchronous path (AC1)', () => {
  it('routes every card to done via the synchronous path', async () => {
    const flow = setupPoolFlow(projectDir, 1);
    db = openDb();
    seedCard(db, 'c1', 'work');
    seedCard(db, 'c2', 'work');
    seedCard(db, 'c3', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 1,
      spawn: fake.spawn,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c3')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('complete');
  });

  it('never calls the injected spawn seam at concurrency=1', async () => {
    const flow = setupPoolFlow(projectDir, 1);
    db = openDb();
    seedCard(db, 'c1', 'work');
    seedCard(db, 'c2', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 1,
      spawn: fake.spawn,
    } as RunEngineArgs);

    // The synchronous path runs stations in-process — no worker is spawned.
    expect(fake.spawns).toHaveLength(0);
    expect(fake.startWorks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — concurrency=K>1, N>K lanes → at most min(K, wip) workers in flight
// ---------------------------------------------------------------------------

describe('runExecutor pool — bounded in-flight workers (AC2)', () => {
  it('runs genuinely concurrent workers but never more than min(K, wip) when K < wip', async () => {
    const K = 2;
    const wip = 5;
    const flow = setupPoolFlow(projectDir, wip);
    db = openDb();
    for (let i = 0; i < 6; i++) seedCard(db, `c${i}`, 'work');
    const { io } = makeIO();
    // Deferred-completion fake: workers stay in flight until the loop yields, so
    // the cap is genuinely exercised. With completions deferred, removing the
    // `currentInFlight >= concurrency` guard would let peakInFlight reach wip(5).
    const pool = makeDeferredPool(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: K,
      spawn: pool.spawn,
      onMessage: pool.onMessage,
    } as RunEngineArgs);

    // min(2, 5) = 2 — concurrency is binding. EXACTLY 2: the pool both bounds the
    // peak AND achieves real parallelism (a serialized impl would peak at 1).
    expect(pool.peakInFlight).toBe(Math.min(K, wip));
    expect(pool.spawnCount).toBe(6);
    for (let i = 0; i < 6; i++) expect(db.getCard(DEFAULT_RUN_ID, `c${i}`)?.lane).toBe('done');
  });

  it('caps in flight at min(K, wip) when wip < K (station WIP is binding)', async () => {
    const K = 5;
    const wip = 2;
    const flow = setupPoolFlow(projectDir, wip);
    db = openDb();
    for (let i = 0; i < 6; i++) seedCard(db, `c${i}`, 'work');
    const { io } = makeIO();
    const pool = makeDeferredPool(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: K,
      spawn: pool.spawn,
      onMessage: pool.onMessage,
    } as RunEngineArgs);

    // min(5, 2) = 2 — the station WIP cap (atomic attemptClaim) is binding.
    expect(pool.peakInFlight).toBe(Math.min(K, wip));
    expect(pool.spawnCount).toBe(6);
    for (let i = 0; i < 6; i++) expect(db.getCard(DEFAULT_RUN_ID, `c${i}`)?.lane).toBe('done');
  });

  it('regression guard: peakInFlight tracks true simultaneous occupancy, not 1', async () => {
    // This pins the property that makes AC2 meaningful: with deferred completions
    // the peak is strictly > 1 (proving workers really overlap). If a future change
    // re-serialized the loop, peak would collapse to 1 and this fails.
    const flow = setupPoolFlow(projectDir, 4);
    db = openDb();
    for (let i = 0; i < 4; i++) seedCard(db, `c${i}`, 'work');
    const { io } = makeIO();
    const pool = makeDeferredPool(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: pool.spawn,
      onMessage: pool.onMessage,
    } as RunEngineArgs);

    expect(pool.peakInFlight).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC3 — fewer ready cards than K → dispatch only what's dispatchable, no spin
// ---------------------------------------------------------------------------

describe('runExecutor pool — idle-wait, not hot-loop (AC3)', () => {
  it('dispatches exactly the dispatchable cards when fewer ready than K', async () => {
    const flow = setupPoolFlow(projectDir, 10);
    db = openDb();
    // Only 2 ready cards, but K=8.
    seedCard(db, 'c1', 'work');
    seedCard(db, 'c2', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 8,
      spawn: fake.spawn,
    } as RunEngineArgs);

    // Spawns exactly the 2 dispatchable cards — never K.
    expect(fake.spawns).toHaveLength(2);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
  });

  it('does not busy-spin: now() is polled a bounded number of times', async () => {
    const flow = setupPoolFlow(projectDir, 10);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    // A counting clock. A hot-loop would call now() an unbounded number of times
    // while waiting; an idle-wait polls it a small bounded number.
    let nowCalls = 0;
    const countingNow = () => {
      nowCalls++;
      return 1000;
    };

    await runExecutor({
      db,
      flow,
      now: countingNow,
      adapter: noopAdapter,
      io,
      concurrency: 4,
      spawn: fake.spawn,
    } as RunEngineArgs);

    // One ready card → at most a couple of planning ticks. Generously bounded to
    // catch a runaway hot-loop (would be thousands+) without being brittle.
    expect(nowCalls).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// AC4 — START_WORK carries cardId/station/input refs, no artifact bytes
// ---------------------------------------------------------------------------

describe('runExecutor pool — START_WORK is references-only (AC4, NFR-4)', () => {
  it('sends a START_WORK per claimed lane carrying cardId/station', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    seedCard(db, 'c2', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: fake.spawn,
    } as RunEngineArgs);

    expect(fake.startWorks).toHaveLength(2);
    const byCard = new Map(fake.startWorks.map((m) => [m.cardId, m]));
    expect(byCard.get('c1')?.station).toBe('work');
    expect(byCard.get('c2')?.station).toBe('work');
    for (const msg of fake.startWorks) {
      expect(msg.type).toBe('START_WORK');
    }
  });

  it('START_WORK carries inputRefs as path references, never artifact bytes', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const fake = makeFakeSpawn(db);

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: fake.spawn,
    } as RunEngineArgs);

    expect(fake.startWorks).toHaveLength(1);
    const msg = fake.startWorks[0]!;
    // inputRefs is the references channel — an array of strings, no inline bytes.
    expect(Array.isArray(msg.inputRefs)).toBe(true);
    for (const ref of msg.inputRefs) {
      expect(typeof ref).toBe('string');
      expect(ref.toLowerCase().startsWith('data:')).toBe(false);
      expect(ref.toLowerCase().startsWith('blob:')).toBe(false);
    }
    // Nothing on the wire smuggles an artifact-bytes field.
    expect(JSON.stringify(msg)).not.toContain('artifactBytes');
  });
});

// ---------------------------------------------------------------------------
// AC5 — the worker's real OS pid is written into active_workers.pid
// ---------------------------------------------------------------------------

describe('runExecutor pool — real OS pid written into active_workers.pid (AC5, WI-467)', () => {
  it("persists each spawned worker's pid in active_workers.pid for its slot", async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    // The pid is observed once the kernel has finished claim+spawn+pid-write and
    // hands the worker its START_WORK (the kernel calls send AFTER the slot is
    // fully populated). Reading active_workers.pid here pins the END-STATE
    // invariant without constraining the claim/spawn ordering B.A. chooses.
    const spawns: Array<{ cardId: string; pid: number }> = [];
    const observedPidForCard = new Map<string, number | null>();
    let nextPid = 4242;

    const spawn = (args: { cardId: string; station: string }) => {
      const pid = nextPid++;
      spawns.push({ cardId: args.cardId, pid });

      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          const row = db!
            .getStateDb()
            .prepare('SELECT pid FROM active_workers WHERE card_id = $id AND station = $station')
            .get({ $id: msg.cardId, $station: msg.station }) as
            | { pid: number | null }
            | undefined;
          observedPidForCard.set(msg.cardId, row ? row.pid : null);

          // Stand in for WI-470b so the loop can finish.
          db!
            .getStateDb()
            .transaction(() => {
              db!
                .getStateDb()
                .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = $id")
                .run({ $id: msg.cardId });
              db!
                .getStateDb()
                .prepare('DELETE FROM active_workers WHERE card_id = $id AND station = $station')
                .run({ $id: msg.cardId, $station: msg.station });
            })
            .immediate();
        }
      };
      return { pid, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
    } as RunEngineArgs);

    expect(spawns).toHaveLength(1);
    // The pid persisted for c1's slot must equal the spawned worker's real pid.
    expect(observedPidForCard.get('c1')).toBe(spawns[0]!.pid);
  });
});

// ---------------------------------------------------------------------------
// AC6 — dispatch-time failure is FAIL-CLOSED. A throw from spawn() or
//        worker.send() must NOT leak the claimed active_workers slot, strand the
//        card at 'claimed', OR abort the whole run (one transient EMFILE killing
//        every other in-flight lane is the wrong failure mode for a pool). Nor may
//        it re-dispatch forever (a permanently-failing spawn would spin
//        ready→claim→throw→ready). The kernel releases the slot and ESCALATES the
//        card to 'hold' for a human (the cause is an environment/infra problem),
//        then keeps running other lanes.
// ---------------------------------------------------------------------------

describe('runExecutor pool — dispatch failure escalates the card to hold (AC6)', () => {
  it('spawn() throws → slot released, card held (not stranded, not re-spun), run does not abort', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io, lines } = makeIO();

    // spawn() fails the way OS process-table exhaustion would: after the slot is
    // atomically claimed but before any pid is written or START_WORK is sent.
    const throwingSpawn = () => {
      throw new Error('OS limit');
    };

    // The run completes (does NOT throw, does NOT hang) — fail-closed, not fatal.
    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: throwingSpawn,
    } as RunEngineArgs);

    // The claimed slot must be released — not leaked into active_workers.
    expect(activeWorkerCount(db)).toBe(0);
    // The card is HELD (not stranded at 'claimed', not re-spun on 'ready').
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('work');
    // The failure was surfaced to a human.
    expect(lines.some((l) => l.includes('held') && l.includes('OS limit'))).toBe(true);
  });

  it('worker.send() throws → slot released (even with pid written), card held', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    // spawn() succeeds (a real pid is returned and written) but the IPC send
    // fails — e.g. the child died between fork and the first message. The slot
    // (now carrying pid:1) must still be released and the card escalated to hold.
    const sendThrowingSpawn = (_args: { cardId: string; station: string }) => ({
      pid: 1,
      send: () => {
        throw new Error('IPC error');
      },
    });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: sendThrowingSpawn,
    } as RunEngineArgs);

    expect(activeWorkerCount(db)).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('work');
  });

  it('a spawn failure on one card does not block a healthy card from completing', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'bad', 'work');
    seedCard(db, 'good', 'work');
    const { io } = makeIO();

    // Throws only for 'bad'; 'good' spawns and completes synchronously.
    const selectiveSpawn = (args: { cardId: string; station: string }) => {
      if (args.cardId === 'bad') throw new Error('OS limit');
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          db!
            .getStateDb()
            .transaction(() => {
              db!.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = $id").run({ $id: msg.cardId });
              db!.getStateDb().prepare('DELETE FROM active_workers WHERE card_id = $id AND station = $station').run({ $id: msg.cardId, $station: msg.station });
            })
            .immediate();
        }
      };
      return { pid: 222, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: selectiveSpawn,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'bad')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'good')?.lane).toBe('done'); // healthy lane proceeded
  });
});

// ---------------------------------------------------------------------------
// AC7 — pooled-worker token spend is folded into the run budget so the
//        consumption andon actually applies to out-of-process work (#3).
// ---------------------------------------------------------------------------

describe('runExecutor pool — pooled worker tokens trip the consumption andon (AC7)', () => {
  it('counts MARK_DONE usage.tokens toward the run budget and halts when exceeded', async () => {
    // Tiny token budget; one worker reports spend far above it.
    const flow = setupPoolFlow(projectDir, 5, /* maxTokens */ 500);
    db = openDb();
    for (let i = 0; i < 3; i++) seedCard(db, `c${i}`, 'work');
    const { io, lines } = makeIO();

    // A pool fake that reports 1000 tokens of model spend per completion via the
    // MARK_DONE usage field — exactly how a future transform-capable worker bills.
    let handler: ((msg: WorkerMessage) => void) | null = null;
    const onMessage = (h: (msg: WorkerMessage) => void) => {
      handler = h;
    };
    let pid = 8000;
    // Track deferred-completion timers so any still-pending when the andon halts
    // the run (a dispatched card whose completion hasn't fired) can be cancelled —
    // otherwise it would invoke the handler against a closed DB after the test ends.
    const pendingTimers: Array<ReturnType<typeof setTimeout>> = [];
    const spawn = (_args: { cardId: string; station: string }) => {
      const myPid = pid++;
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          // Defer completion so the andon is evaluated BETWEEN completions and can
          // actually halt the batch once the budget is blown (a synchronous fake
          // would complete every card before the first andon check).
          pendingTimers.push(
            setTimeout(() => {
              handler?.({
                type: 'MARK_DONE',
                cardId: msg.cardId,
                station: msg.station,
                attempt: msg.attempt,
                outcome: 'success',
                usage: { tokens: 1000 },
              });
            }, 0),
          );
        }
      };
      return { pid: myPid, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
      onMessage,
    } as RunEngineArgs);
    // The run halted mid-batch: cancel any completion still queued for a worker
    // that was dispatched but never delivered (production's dispose() kills the
    // real subprocess; the fake must clear its timer).
    for (const t of pendingTimers) clearTimeout(t);

    // The first completion folds 1000 tokens > the 500 budget, so the consumption
    // andon halts the run — proving pooled tokens are counted (with usage ignored
    // they would be 0 and the run would finish all three cards cleanly).
    expect(lines.some((l) => l.includes('andon') && /token/i.test(l))).toBe(true);
    const doneCount = ['c0', 'c1', 'c2'].filter((id) => db!.getCard(DEFAULT_RUN_ID, id)?.lane === 'done').length;
    expect(doneCount).toBeLessThan(3); // halted before completing the batch
  });
});
