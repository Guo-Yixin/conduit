/**
 * Tests for the atomic claim + heartbeat lease + lease-based reconcile (WI-294).
 *
 * This is the single-linearization-point dispatch primitive (SPEC §7 rev-1 C6,
 * SPEC §11 lease semantics). The claim transaction makes
 *   deps-satisfied(ready) ∧ station-under-WIP ∧ slot-free
 * true in ONE bun:sqlite transaction that reserves the active_workers slot and
 * flips cards.status → claimed. WIP is counted from active_workers, never
 * cards.status. Liveness is by lease (lease_until), not PID (rev-1 H8).
 *
 * Contract this file pins for src/dispatch/claim.ts:
 *
 *   attemptClaim(db, req): ClaimResult           // req carries injectable `now` + leaseSeconds
 *   beginWork(db, cardId, station, now, leaseSeconds): void   // claimed → working (sets lease)
 *   renewLease(db, cardId, station, now, leaseSeconds): boolean
 *   isWorkerAlive(db, cardId, station, now): boolean
 *   reconcile(db, now): { interrupted: string[] }
 *   activeWorkerCount(db, station): number       // WIP, measured from active_workers
 *   getActiveWorker(db, cardId, station): { workerId, leaseUntil } | null
 *
 * REQUIRED of B.A. (notes, not directly asserted here):
 *   - add `lease_until INTEGER NOT NULL` to the active_workers DDL (WI-290 lacks it),
 *   - expose the state Database to the dispatch layer so the claim can run the
 *     active_workers + cards writes in ONE transaction on ONE connection.
 *
 * `now` is epoch seconds and is INJECTED everywhere so lease expiry is
 * deterministic (no sleeping / wall-clock flakiness).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import {
  attemptClaim,
  beginWork,
  renewLease,
  isWorkerAlive,
  reconcile,
  reclaimOrphanedWorkers,
  activeWorkerCount,
  getActiveWorker,
} from './claim';

const NOW = 1_000_000; // fixed epoch-seconds base for deterministic leases
const LEASE = 30;

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-claim-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = openConduitDB({ stateDbPath, journalDbPath });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    run_id: DEFAULT_RUN_ID,
    id: 'c1',
    parent_id: null,
    lane: 'work',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — claim succeeds atomically (active_workers row + cards.status=claimed).
// ---------------------------------------------------------------------------

describe('attemptClaim — success (AC1)', () => {
  it('claims a ready card under WIP with a free slot', () => {
    db!.insertCard(makeCard({ id: 'c1' }));

    const result = attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });

    expect(result.ok).toBe(true);
    // cards.status flipped to claimed …
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('claimed');
    // … and the active_workers slot is reserved in the SAME commit.
    expect(activeWorkerCount(db!, 'work')).toBe(1);
    const worker = getActiveWorker(db!, 'c1', 'work');
    expect(worker).not.toBeNull();
    expect(worker!.workerId).toBe('w1');
    expect(worker!.leaseUntil).toBe(NOW + LEASE);
  });

  it('fails and writes nothing for a card that is not ready (deps unsatisfied)', () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'waiting' }));

    const result = attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_ready');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('waiting'); // unchanged
    expect(activeWorkerCount(db!, 'work')).toBe(0); // wrote nothing
  });
});

// ---------------------------------------------------------------------------
// AC2 — at WIP cap, claim fails and writes nothing (WIP from active_workers).
// ---------------------------------------------------------------------------

describe('attemptClaim — WIP cap (AC2)', () => {
  it('refuses a claim when the station is already at its WIP cap', () => {
    db!.insertCard(makeCard({ id: 'cA' }));
    db!.insertCard(makeCard({ id: 'cB' }));

    // Fill the single slot.
    const first = attemptClaim(db!, {
      cardId: 'cA',
      station: 'work',
      workerId: 'wA',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
    });
    expect(first.ok).toBe(true);

    // Second claim at the same station with wipCap=1 must fail, untouched.
    const second = attemptClaim(db!, {
      cardId: 'cB',
      station: 'work',
      workerId: 'wB',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('wip_cap');
    expect(db!.getCard(DEFAULT_RUN_ID, 'cB')!.status).toBe('ready'); // unchanged
    expect(activeWorkerCount(db!, 'work')).toBe(1); // still just cA's slot
    expect(getActiveWorker(db!, 'cB', 'work')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — when the slot is already occupied, claim fails and writes nothing.
// ---------------------------------------------------------------------------

describe('attemptClaim — slot occupied (AC3)', () => {
  it('refuses a second claim for an already-claimed (card, station) slot', () => {
    db!.insertCard(makeCard({ id: 'c1' }));

    const first = attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });
    expect(first.ok).toBe(true);

    const second = attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w2',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('slot_occupied');
    // The original slot is intact — the second worker never wrote.
    expect(activeWorkerCount(db!, 'work')).toBe(1);
    expect(getActiveWorker(db!, 'c1', 'work')!.workerId).toBe('w1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('claimed');
  });
});

// ---------------------------------------------------------------------------
// AC4 — THE property test: two REAL concurrent claims for the last slot →
//        exactly one success, one failure (no double-claim).
// ---------------------------------------------------------------------------

describe('attemptClaim — concurrent last-slot race (AC4)', () => {
  it(
    'admits exactly one of two processes racing for the last slot',
    async () => {
      // Seed two ready cards at the same station, then release all locks.
      db!.insertCard(makeCard({ id: 'cA' }));
      db!.insertCard(makeCard({ id: 'cB' }));
      db!.close();
      db = null;

      const dbAbs = join(import.meta.dir, '..', 'persistence', 'db.ts');
      const claimAbs = join(import.meta.dir, 'claim.ts');

      // A tiny racer program: open the SAME state DB, attempt one claim, print
      // OK/FAIL. Two of these run as separate OS processes → genuine contention
      // on the SQLite write lock. WIP cap = 1 means only one can win.
      const racerSrc = `
const { openConduitDB } = await import(${JSON.stringify(dbAbs)});
const { attemptClaim } = await import(${JSON.stringify(claimAbs)});
const db = openConduitDB({
  stateDbPath: process.env.STATE,
  journalDbPath: process.env.JOURNAL,
});
const res = attemptClaim(db, {
  cardId: process.env.CARD_ID,
  station: process.env.STATION,
  workerId: process.env.WORKER_ID,
  wipCap: Number(process.env.WIP),
  now: Number(process.env.NOW),
  leaseSeconds: Number(process.env.LEASE),
});
db.close();
process.stdout.write(res.ok ? 'OK' : 'FAIL:' + (res.reason ?? ''));
`;
      const racerPath = join(dir, 'racer.ts');
      writeFileSync(racerPath, racerSrc);

      const baseEnv = {
        ...process.env,
        STATE: stateDbPath,
        STATION: 'work',
        WIP: '1',
        NOW: String(NOW),
        LEASE: String(LEASE),
      };

      // Launch both as close together as possible, then collect.
      const procA = Bun.spawn(['bun', racerPath], {
        env: { ...baseEnv, CARD_ID: 'cA', WORKER_ID: 'wA', JOURNAL: join(dir, 'jA.sqlite') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const procB = Bun.spawn(['bun', racerPath], {
        env: { ...baseEnv, CARD_ID: 'cB', WORKER_ID: 'wB', JOURNAL: join(dir, 'jB.sqlite') },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [outA, outB] = await Promise.all([
        new Response(procA.stdout).text(),
        new Response(procB.stdout).text(),
        procA.exited,
        procB.exited,
      ]);

      const okCount = [outA, outB].filter((o) => o.startsWith('OK')).length;
      const failCount = [outA, outB].filter((o) => o.startsWith('FAIL')).length;
      expect(okCount).toBe(1);
      expect(failCount).toBe(1);

      // Persisted state confirms a single linearization point: one slot, one
      // claimed card.
      db = openConduitDB({ stateDbPath, journalDbPath });
      expect(activeWorkerCount(db, 'work')).toBe(1);
      const claimedCount = ['cA', 'cB'].filter(
        (id) => db!.getCard(DEFAULT_RUN_ID, id)!.status === 'claimed',
      ).length;
      expect(claimedCount).toBe(1);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// REWORK (Amy WI-294) — beginWork must guard the 'claimed' precondition. Without
// it, beginWork on an unclaimed card flips status→'working' but writes no
// active_workers row; reconcile's JOIN on active_workers then renders that card
// permanently invisible (stuck in 'working' forever).
// ---------------------------------------------------------------------------

describe('beginWork precondition guard (rework)', () => {
  it('throws on a card that is not claimed and leaves it uncorrupted', () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'ready' })); // ready, never claimed → no slot

    expect(() => beginWork(db!, 'c1', 'work', NOW, LEASE)).toThrow();

    // The guard must fire BEFORE any write — no half-applied state:
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('ready'); // NOT flipped to 'working'
    expect(activeWorkerCount(db!, 'work')).toBe(0); // no orphan slot
    expect(getActiveWorker(db!, 'c1', 'work')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5 — renewLease extends lease_until; an expired lease is not-alive.
// ---------------------------------------------------------------------------

describe('heartbeat lease (AC5)', () => {
  beforeEach(() => {
    db!.insertCard(makeCard({ id: 'c1' }));
    attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });
  });

  it('treats a worker as alive before lease expiry and dead after', () => {
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE - 1)).toBe(true);
    // At/after lease_until the worker is no longer alive.
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE + 1)).toBe(false);
  });

  it('treats the worker as dead at the EXACT lease expiry instant (lease_until === now)', () => {
    // Boundary: alive iff lease_until > now, so now === lease_until is dead.
    // Guards against a silent `>` → `>=` regression.
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE)).toBe(false);
  });

  it('renewLease pushes lease_until forward so the worker is alive again', () => {
    // Expired at NOW + LEASE + 5 …
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE + 5)).toBe(false);

    const renewed = renewLease(db!, 'c1', 'work', NOW + LEASE + 5, LEASE);
    expect(renewed).toBe(true);
    expect(getActiveWorker(db!, 'c1', 'work')!.leaseUntil).toBe(NOW + LEASE + 5 + LEASE);

    // … alive again after renewal.
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE + 10)).toBe(true);
  });

  it('renewLease returns false when there is no worker holding the slot', () => {
    expect(renewLease(db!, 'no-such-card', 'work', NOW, LEASE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC6 — reconcile: working + expired lease → interrupted + slot released.
// ---------------------------------------------------------------------------

describe('lease-based reconcile (AC6)', () => {
  beforeEach(() => {
    db!.insertCard(makeCard({ id: 'c1' }));
    attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
    });
    beginWork(db!, 'c1', 'work', NOW, LEASE); // claimed → working, lease = NOW + LEASE
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('working');
  });

  it('interrupts a working card whose lease has expired and releases its slot', () => {
    const result = reconcile(db!, NOW + LEASE + 1); // past lease_until

    expect(result.interrupted).toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
    // Slot released → WIP frees up.
    expect(activeWorkerCount(db!, 'work')).toBe(0);
    expect(getActiveWorker(db!, 'c1', 'work')).toBeNull();
  });

  it('does NOT interrupt a working card whose lease is still valid', () => {
    const result = reconcile(db!, NOW + LEASE - 1); // before lease_until

    expect(result.interrupted).not.toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('working'); // untouched
    expect(activeWorkerCount(db!, 'work')).toBe(1); // slot retained
  });

  it('interrupts a working card at the EXACT lease expiry instant (lease_until === now)', () => {
    // Boundary: reconcile fires when lease_until <= now, so now === lease_until is expired.
    // Guards against a silent `<=` → `<` regression.
    const result = reconcile(db!, NOW + LEASE);
    expect(result.interrupted).toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
    expect(activeWorkerCount(db!, 'work')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reclaimOrphanedWorkers — resume reclaims in-flight cards regardless of lease
// (finding #3): a fresh resume process means the worker's owner is dead even
// when the (long) lease has not yet expired, so lease-based reconcile is wrong
// for resume.
// ---------------------------------------------------------------------------

describe('reclaimOrphanedWorkers (resume / startup recovery)', () => {
  it('reclaims a WORKING card whose lease is STILL VALID — the resume-stall bug', () => {
    db!.insertCard(makeCard({ id: 'c1' }));
    attemptClaim(db!, { cardId: 'c1', station: 'work', workerId: 'w1', wipCap: 5, now: NOW, leaseSeconds: LEASE });
    beginWork(db!, 'c1', 'work', NOW, LEASE); // lease = NOW + LEASE (far in the future)
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('working');

    // now is WELL BEFORE lease expiry — lease-based reconcile would no-op here.
    const result = reclaimOrphanedWorkers(db!, NOW + 1);

    expect(result.reclaimed).toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
    expect(activeWorkerCount(db!, 'work')).toBe(0);
    expect(getActiveWorker(db!, 'c1', 'work')).toBeNull();
  });

  it('also reclaims a CLAIMED card (claimed before beginWork) whose lease is valid', () => {
    db!.insertCard(makeCard({ id: 'c2' }));
    attemptClaim(db!, { cardId: 'c2', station: 'work', workerId: 'w2', wipCap: 5, now: NOW, leaseSeconds: LEASE });
    expect(db!.getCard(DEFAULT_RUN_ID, 'c2')!.status).toBe('claimed');

    const result = reclaimOrphanedWorkers(db!, NOW + 1);

    expect(result.reclaimed).toContain('c2');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c2')!.status).toBe('interrupted');
    expect(activeWorkerCount(db!, 'work')).toBe(0);
  });

  it('leaves ready / waiting / terminal cards untouched', () => {
    db!.insertCard(makeCard({ id: 'r1', status: 'ready' }));
    db!.insertCard(makeCard({ id: 'w1', status: 'waiting' }));
    db!.insertCard(makeCard({ id: 'd1', status: 'complete', lane: 'done' }));

    const result = reclaimOrphanedWorkers(db!, NOW + 1);

    expect(result.reclaimed).toHaveLength(0);
    expect(db!.getCard(DEFAULT_RUN_ID, 'r1')!.status).toBe('ready');
    expect(db!.getCard(DEFAULT_RUN_ID, 'w1')!.status).toBe('waiting');
    expect(db!.getCard(DEFAULT_RUN_ID, 'd1')!.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// Run-scoping (#6): the inspection helpers must AND run_id into their WHERE
// clauses so a slot belonging to another run sharing the same (card, station)
// is never read. active_workers PK is (run_id, card_id, station).
// ---------------------------------------------------------------------------

const OTHER_RUN = 'run-2';

describe('claim inspection helpers — run scoping (#6)', () => {
  // Seed an active slot under OTHER_RUN for (c1, work) and one under the
  // default run for the same (c1, work) so cross-run leakage would be visible.
  function seedTwoRunsSameCardStation(): void {
    db!.insertCard(makeCard({ id: 'c1', run_id: DEFAULT_RUN_ID }));
    db!.insertCard(makeCard({ id: 'c1', run_id: OTHER_RUN }));

    attemptClaim(db!, {
      cardId: 'c1', station: 'work', workerId: 'w-default',
      wipCap: 5, now: NOW, leaseSeconds: LEASE,
    }); // default run
    attemptClaim(db!, {
      cardId: 'c1', station: 'work', workerId: 'w-other',
      wipCap: 5, now: NOW, leaseSeconds: LEASE, runId: OTHER_RUN,
    }); // other run
  }

  it('activeWorkerCount counts only the requested run', () => {
    seedTwoRunsSameCardStation();
    expect(activeWorkerCount(db!, 'work')).toBe(1); // default run only
    expect(activeWorkerCount(db!, 'work', OTHER_RUN)).toBe(1); // other run only
  });

  it('getActiveWorker returns the slot for the requested run, not a sibling run', () => {
    seedTwoRunsSameCardStation();
    expect(getActiveWorker(db!, 'c1', 'work')!.workerId).toBe('w-default');
    expect(getActiveWorker(db!, 'c1', 'work', OTHER_RUN)!.workerId).toBe('w-other');
  });

  it('getActiveWorker does not see a slot that exists only in another run', () => {
    db!.insertCard(makeCard({ id: 'c1', run_id: OTHER_RUN }));
    attemptClaim(db!, {
      cardId: 'c1', station: 'work', workerId: 'w-other',
      wipCap: 5, now: NOW, leaseSeconds: LEASE, runId: OTHER_RUN,
    });
    // Default run has no slot — must be null even though OTHER_RUN has one.
    expect(getActiveWorker(db!, 'c1', 'work')).toBeNull();
    expect(activeWorkerCount(db!, 'work')).toBe(0);
  });

  it('isWorkerAlive scopes the lease lookup to the requested run', () => {
    seedTwoRunsSameCardStation();
    // Both slots share lease_until = NOW + LEASE; scoping is about which row
    // is read, so renew only the OTHER_RUN slot and confirm the default is
    // unaffected.
    renewLease(db!, 'c1', 'work', NOW + 100, LEASE, OTHER_RUN);
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE + 1)).toBe(false); // default expired
    expect(isWorkerAlive(db!, 'c1', 'work', NOW + LEASE + 1, OTHER_RUN)).toBe(true); // other renewed
  });

  it('isWorkerAlive returns false when the slot exists only in another run', () => {
    db!.insertCard(makeCard({ id: 'c1', run_id: OTHER_RUN }));
    attemptClaim(db!, {
      cardId: 'c1', station: 'work', workerId: 'w-other',
      wipCap: 5, now: NOW, leaseSeconds: LEASE, runId: OTHER_RUN,
    });
    expect(isWorkerAlive(db!, 'c1', 'work', NOW)).toBe(false); // default run: no slot
  });
});
