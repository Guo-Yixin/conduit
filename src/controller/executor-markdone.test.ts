/**
 * Tests for the kernel MARK_DONE reaction — the REACTION half of the
 * event-driven pool (WI-473 / WI-470b, SPEC §10A, FR-2/FR-4, NFR-3).
 *
 * WI-470a fills the pool: it claims a lane, spawns a worker harness, and sends
 * START_WORK. This item DRAINS it: on each inbound worker IPC the kernel —
 * and ONLY the kernel — performs every state-DB write:
 *
 *   - MARK_DONE(success) → post-work transition (advanceCard / the FSM), writes
 *     the checkpoint + journal entry, frees the worker's active_workers slot,
 *     evaluates fan-in (pollAwaitingChildren), then re-plans so the freed slot
 *     takes the next dispatchable lane.
 *   - MARK_DONE(failure: rework/scrap) → routed by the FSM exactly as a
 *     synchronous station failure would be (per cap_policy), never dropped.
 *   - HEARTBEAT → renewLease for that worker's slot, so an in-flight worker is
 *     not falsely reclaimed. The atomic claim stays the sole linearization point.
 *
 * Single-writer invariant (NFR-3): the worker NEVER writes the state DB. The
 * test fakes a worker via injected seams (spawn + onMessage) and asserts that
 * the DB only changes in REACTION to IPC the kernel processes.
 *
 * Contract this file pins for src/controller/executor.ts + RunEngineArgs:
 *
 *   import type { WorkerMessage } from '../worker/ipc-protocol';
 *
 *   // Added to RunEngineArgs (next to the WI-470a `spawn` seam):
 *   //   // Register the kernel's inbound-IPC handler. Production wires this to
 *   //   // each spawned worker's process IPC; tests invoke the captured handler
 *   //   // directly to drive MARK_DONE / HEARTBEAT without a real subprocess.
 *   //   onMessage?: (handler: (msg: WorkerMessage) => void) => void;
 *
 * The kernel registers exactly one handler via onMessage and reacts to every
 * MARK_DONE / HEARTBEAT pushed through it.
 *
 * NOTE for B.A. (impl): reuse advanceCard / buildTransitionContext (executor.ts
 * ~1470), writeCheckpoint, the card_log journal, pollAwaitingChildren
 * (executor.ts ~2135) and renewLease (dispatch/claim.ts:213). Do NOT let the
 * worker write the DB. concurrency=1 keeps the synchronous path — this handler
 * only drives concurrency>1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import type { WorkerMessage, MarkDoneMessage, HeartbeatMessage } from '../worker/ipc-protocol';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

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

/** Single deterministic station `work` → done with a configurable WIP cap. */
function setupPoolFlow(dir: string, wip: number): FlowConfig {
  const flowYaml = `
flow: executor-markdone
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
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
  if (!loaded.ok) throw new Error(`markdone fixture invalid: ${JSON.stringify(loaded.errors)}`);
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

function activeWorkerRows(db: ConduitDB): Array<{ card_id: string; station: string; lease_until: number; pid: number | null }> {
  return db
    .getStateDb()
    .prepare('SELECT card_id, station, lease_until, pid FROM active_workers')
    .all() as Array<{ card_id: string; station: string; lease_until: number; pid: number | null }>;
}

function checkpointCount(db: ConduitDB, cardId: string, station: string): number {
  const { n } = db
    .getStateDb()
    .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE card = $c AND station = $s')
    .get({ $c: cardId, $s: station }) as { n: number };
  return n;
}

/**
 * A controllable pool driver. It captures the kernel's inbound-IPC handler
 * (registered via the onMessage seam) and records every START_WORK the kernel
 * sends. The test then pushes MARK_DONE / HEARTBEAT through `deliver(...)` to
 * exercise the reaction, WITHOUT writing the DB itself (single-writer: only the
 * kernel touches the state DB).
 *
 * `auto` mode: if true, every START_WORK is immediately answered with a
 * MARK_DONE(success) so the run drains and terminates (used by re-plan tests).
 */
function makePoolDriver(opts: { auto?: boolean } = {}) {
  let handler: ((msg: WorkerMessage) => void) | null = null;
  const startWorks: Array<{ cardId: string; station: string }> = [];
  let nextPid = 7000;
  const pidByCard = new Map<string, number>();

  const onMessage = (h: (msg: WorkerMessage) => void) => {
    handler = h;
  };

  const spawn = (args: { cardId: string; station: string }) => {
    const pid = nextPid++;
    pidByCard.set(args.cardId, pid);
    const send = (msg: WorkerMessage) => {
      if (msg.type === 'START_WORK') {
        startWorks.push({ cardId: msg.cardId, station: msg.station });
        if (opts.auto) {
          // Worker finished the body on disk; report success back to the kernel.
          deliver({ type: 'MARK_DONE', cardId: msg.cardId, station: msg.station, attempt: 0, outcome: 'success' });
        }
      }
    };
    return { pid, send };
  };

  function deliver(msg: WorkerMessage): void {
    if (!handler) throw new Error('kernel did not register an onMessage handler');
    handler(msg);
  }

  return {
    spawn,
    onMessage,
    deliver,
    startWorks,
    pidByCard,
    get handlerRegistered() {
      return handler !== null;
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
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-markdone-'));
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
// AC1 — MARK_DONE(success) runs the post-work transition + checkpoint + journal
// ---------------------------------------------------------------------------

describe('MARK_DONE(success) → post-work transition, checkpoint, journal (AC1)', () => {
  it('advances the card to its next lane per the FSM on MARK_DONE(success)', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // work → done is the declared next; the FSM resolves the terminal status.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('complete');
  });

  it('writes a checkpoint for the completed station on MARK_DONE(success)', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    expect(checkpointCount(db, 'c1', 'work')).toBe(1);
  });

  it('appends a forward card_log entry for the completed station', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    const entered = db
      .getCardLog('c1')
      .filter((e): e is Extract<typeof e, { kind: 'entered_lane' }> => e.kind === 'entered_lane');
    // The work→done advance is journaled with destLane 'done'.
    expect(entered.some((e) => e.station === 'work' && e.destLane === 'done')).toBe(true);
  });

  it('frees the active_workers slot after handling MARK_DONE', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // No worker should remain holding a slot once the card reached done.
    expect(activeWorkerRows(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — kernel is the sole DB writer; reaction comes only via IPC (NFR-3)
// ---------------------------------------------------------------------------

describe('MARK_DONE — kernel is the sole DB writer (NFR-3, AC2)', () => {
  it('does not advance the card until a MARK_DONE is delivered', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    // NON-auto driver: START_WORK is recorded but NO MARK_DONE is sent back yet,
    // so the kernel has nothing to react to. In the event-driven pool the loop
    // dispatches synchronously and then BLOCKS at its worker-event wait — so we
    // start the run WITHOUT awaiting it, assert the card has not advanced (the
    // worker reported nothing), THEN deliver MARK_DONE so the run can finish.
    const driver = makePoolDriver({ auto: false });

    // runExecutor runs synchronously up to its first await (the worker-event wait),
    // by which point the single card has been dispatched but not completed.
    const runP = runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // With no MARK_DONE, the kernel must NOT advance the card — still on 'work',
    // no checkpoint, and its slot is still held (the worker, not the kernel, owns
    // the result; NFR-3 — the kernel writes nothing on its own).
    expect(driver.startWorks).toHaveLength(1);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('work');
    expect(checkpointCount(db, 'c1', 'work')).toBe(0);
    expect(activeWorkerRows(db)).toHaveLength(1);

    // Now deliver the completion: the kernel reacts, advances the card, and the
    // run drains. (Also avoids leaking a forever-pending runExecutor promise.)
    driver.deliver({ type: 'MARK_DONE', cardId: 'c1', station: 'work', attempt: 0, outcome: 'success' });
    await runP;

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(activeWorkerRows(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — HEARTBEAT renews the worker's lease via renewLease
// ---------------------------------------------------------------------------

describe('HEARTBEAT → renewLease for the worker slot (AC3)', () => {
  it("extends the worker's lease_until when a HEARTBEAT is delivered", async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    // Advancing clock: claim happens at t=1000 (lease = 1000 + LEASE_SECONDS).
    // The HEARTBEAT is delivered from inside START_WORK at a later now() so the
    // renewed lease_until is strictly greater than the original.
    let t = 1000;
    const driver = makePoolDriver({ auto: false });

    // Capture lease at claim, then deliver a HEARTBEAT and capture the new lease.
    let leaseAtClaim = 0;
    let leaseAfterHeartbeat = 0;
    const spawn = (args: { cardId: string; station: string }) => {
      const pid = 5555;
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          leaseAtClaim = activeWorkerRows(db!)[0]!.lease_until;
          t += 100; // wall-clock advances before the heartbeat
          const hb: HeartbeatMessage = { type: 'HEARTBEAT', cardId: msg.cardId, station: msg.station };
          driver.deliver(hb);
          leaseAfterHeartbeat = activeWorkerRows(db!)[0]!.lease_until;
          // Now finish so the run terminates.
          driver.deliver({ type: 'MARK_DONE', cardId: msg.cardId, station: msg.station, attempt: 0, outcome: 'success' });
        }
      };
      return { pid, send };
    };

    await runExecutor({
      db,
      flow,
      now: () => t,
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    expect(leaseAtClaim).toBeGreaterThan(0);
    // renewLease pushed lease_until forward by the elapsed wall-clock.
    expect(leaseAfterHeartbeat).toBeGreaterThan(leaseAtClaim);
  });
});

// ---------------------------------------------------------------------------
// AC4 — MARK_DONE failure outcome is routed by the FSM, not dropped
// ---------------------------------------------------------------------------

describe('MARK_DONE(failure) → routed by the FSM, not dropped (AC4)', () => {
  it('routes a scrap outcome to the scrap terminal lane', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    const driver = makePoolDriver({ auto: false });
    const spawn = (args: { cardId: string; station: string }) => {
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          const fail: MarkDoneMessage = {
            type: 'MARK_DONE',
            cardId: msg.cardId,
            station: msg.station,
            attempt: 0,
            outcome: 'scrap',
          };
          driver.deliver(fail);
        }
      };
      return { pid: 6001, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // A scrap failure must terminate the card at scrap — not leave it stuck on
    // 'work' (dropped) and not advance it to 'done'.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('scrap');
    expect(activeWorkerRows(db)).toHaveLength(0);
  });

  it('does not advance a failed card to the success lane', async () => {
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    const driver = makePoolDriver({ auto: false });
    const spawn = (args: { cardId: string; station: string }) => {
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          driver.deliver({ type: 'MARK_DONE', cardId: msg.cardId, station: msg.station, attempt: 0, outcome: 'scrap' });
        }
      };
      return { pid: 6002, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).not.toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC5 — after MARK_DONE the kernel re-plans and refills the freed slot
// ---------------------------------------------------------------------------

describe('MARK_DONE → re-plan refills the freed slot (AC5)', () => {
  it('dispatches all N cards through a WIP-1 station by draining + refilling', async () => {
    // wip=1 and K=4: only one slot ever exists, so all three cards can only be
    // dispatched if each MARK_DONE frees the slot AND the kernel re-plans to
    // claim the next. If re-plan did not run, only the first card would ship.
    const flow = setupPoolFlow(projectDir, 1);
    db = openDb();
    seedCard(db, 'c1', 'work');
    seedCard(db, 'c2', 'work');
    seedCard(db, 'c3', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 4,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // Every card reached done — proves the freed slot was refilled via re-plan.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c3')?.lane).toBe('done');
    // Each card got exactly one START_WORK.
    expect(driver.startWorks).toHaveLength(3);
  });

  it('registers exactly one inbound-IPC handler via onMessage', async () => {
    const flow = setupPoolFlow(projectDir, 2);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();
    const driver = makePoolDriver({ auto: true });

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    expect(driver.handlerRegistered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 (duplicate) — a redelivered MARK_DONE for an already-terminal card is
// idempotent: the second delivery is silently ignored, the card stays terminal
// ---------------------------------------------------------------------------

describe('duplicate MARK_DONE → idempotent, card stays terminal (AC1)', () => {
  it('ignores a second MARK_DONE(success) for an already-done card instead of escalating it to held', async () => {
    // A worker may report MARK_DONE twice (IPC retry / redelivery after a blip).
    // The first advances the card to its terminal lane via the FSM. The second
    // arrives for a card already at lane='done'; the kernel must treat it as a
    // no-op. Without a terminal-lane guard the duplicate re-enters the FSM from
    // done_pending_ack in a terminal lane → illegal_transition → escalateToHold,
    // corrupting the terminal card to {lane:'done', status:'held'}.
    const flow = setupPoolFlow(projectDir, 5);
    db = openDb();
    seedCard(db, 'c1', 'work');
    const { io } = makeIO();

    const driver = makePoolDriver({ auto: false });
    const spawn = (args: { cardId: string; station: string }) => {
      const send = (msg: WorkerMessage) => {
        if (msg.type === 'START_WORK') {
          const done: MarkDoneMessage = {
            type: 'MARK_DONE',
            cardId: msg.cardId,
            station: msg.station,
            attempt: 0,
            outcome: 'success',
          };
          driver.deliver(done); // first: advances c1 → done/complete
          driver.deliver(done); // duplicate: must be a no-op, not an escalation
        }
      };
      return { pid: 6100, send };
    };

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter,
      io,
      concurrency: 2,
      spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // The duplicate must not corrupt the terminal state.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('complete');
  });
});
