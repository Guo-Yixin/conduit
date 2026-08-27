/**
 * WI-485 — Run-scope the atomic claim (`attemptClaim` in src/dispatch/claim.ts).
 *
 * After WI-474 gave `cards`, `active_workers`, etc. a composite PK on
 * (run_id, ...), a card id is no longer globally unique: two independent runs
 * in the same DB can both own a card 'p01' and both have a worker at station
 * 'work'. WI-479 scoped the executor's aggregate/sweep/by-PK queries; THIS item
 * scopes the dispatch linearization point itself.
 *
 * `attemptClaim` today runs three guards and two writes with NO run_id
 * predicate (src/dispatch/claim.ts:90-153):
 *
 *   Guard 1 (slot_occupied): SELECT … active_workers WHERE card_id=$ AND station=$
 *   Guard 2 (not_ready):     SELECT status FROM cards WHERE id=$
 *   Guard 3 (wip_cap):       SELECT COUNT(*) … active_workers WHERE station=$
 *   INSERT INTO active_workers (… no run_id …)
 *   UPDATE cards SET status='claimed' WHERE id=$
 *
 * Each one cross-contaminates with another run sharing the same card id /
 * station. Guard 3 is the confirmed FUNCTIONAL BUG: it counts EVERY run's
 * workers at a station, so a second run holding one worker at a wip=1 station
 * starves the active run (every claim returns 'wip_cap'; the executor spins).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/dispatch/claim.ts
 * ---------------------------------------------------------------------------
 *
 *   // ClaimRequest gains an OPTIONAL run id. Omitted ⇒ DEFAULT_RUN_ID, so the
 *   // existing claim.test.ts suite and both executor call sites (which do not
 *   // yet pass runId) keep working unchanged.
 *   export interface ClaimRequest { …; runId?: string }
 *
 *   // Every guard, the INSERT, and the cards UPDATE inside attemptClaim gain a
 *   // `run_id = <req.runId ?? DEFAULT_RUN_ID>` predicate / column. Another run's
 *   // cards and active_workers are INVISIBLE to this claim.
 *
 * Cross-run rows are read with raw SQL against the state DB (not the unscoped
 * getActiveWorker/activeWorkerCount helpers — their run-scoping is out of scope
 * for this item, so the assertions must not depend on it).
 *
 * Harness mirrors claim.test.ts: temp on-disk ConduitDB, injected epoch-seconds
 * `now`, fixed lease.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { attemptClaim, type ClaimRequest, type ClaimResult } from './claim';

/**
 * The contract WI-485 adds to ClaimRequest: an optional `runId`. We express it
 * here as the intersection B.A. must fold into ClaimRequest itself, so the test
 * compiles against today's type while still passing `runId` through to the real
 * attemptClaim at runtime (driving the run-scoped behavior these tests pin).
 * When B.A. adds `runId?: string` to ClaimRequest, this alias collapses to it.
 */
type RunScopedClaimRequest = ClaimRequest & { runId?: string };

/** Forward a run-scoped request to the real attemptClaim under test. */
function claim(database: ConduitDB, req: RunScopedClaimRequest): ClaimResult {
  return attemptClaim(database, req as ClaimRequest);
}

const NOW = 1_000_000; // fixed epoch-seconds base for deterministic leases
const LEASE = 30;

const RUN_A = DEFAULT_RUN_ID; // the ACTIVE run under test
const RUN_B = 'other-run'; // a second, independent run sharing the same DB

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-claim-runscope-'));
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

/**
 * Count active_workers rows for a (run_id, station) pair via raw SQL, so the
 * assertions never depend on the (separately-scoped) activeWorkerCount helper.
 */
function rawWorkerCount(database: ConduitDB, runId: string, station: string): number {
  const { n } = database
    .getStateDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM active_workers WHERE run_id = $run_id AND station = $station',
    )
    .get({ $run_id: runId, $station: station }) as { n: number };
  return n;
}

/** Read the run_id stamped on a specific active_workers slot, or null if absent. */
function rawSlotRunId(
  database: ConduitDB,
  cardId: string,
  station: string,
): string | null {
  const row = database
    .getStateDb()
    .prepare(
      'SELECT run_id FROM active_workers WHERE card_id = $card_id AND station = $station',
    )
    .all({ $card_id: cardId, $station: station }) as { run_id: string }[];
  // There may be one row per run sharing (card_id, station); this helper is only
  // used where a single run owns the slot.
  return row.length === 1 ? row[0].run_id : null;
}

// ---------------------------------------------------------------------------
// Guard 1 — slot_occupied must be scoped: another run's worker on the SAME
// (card_id, station) must NOT make this run's claim report 'slot_occupied'.
// ---------------------------------------------------------------------------

describe('attemptClaim — Guard 1 (slot_occupied) is run-scoped', () => {
  it("does not see another run's active_worker for the same (card_id, station)", () => {
    // Run B already holds the slot for card 'p01' @ 'work'.
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'p01' }));
    const claimedByB = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wB',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_B,
    });
    expect(claimedByB.ok).toBe(true);

    // Run A's OWN card 'p01' @ 'work' is ready and its slot is free.
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'p01', status: 'ready' }));

    const claimedByA = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wA',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });

    // With an unscoped Guard 1 this returns { ok:false, reason:'slot_occupied' }
    // because run B's row matches WHERE card_id='p01' AND station='work'.
    expect(claimedByA.ok).toBe(true);
    expect(db!.getCard(RUN_A, 'p01')!.status).toBe('claimed');
    // Each run now holds exactly its own slot.
    expect(rawWorkerCount(db!, RUN_A, 'work')).toBe(1);
    expect(rawWorkerCount(db!, RUN_B, 'work')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — not_ready must be scoped: this run's claim must read ITS OWN card's
// status, not another run's card that happens to share the id.
// ---------------------------------------------------------------------------

describe('attemptClaim — Guard 2 (card status) is run-scoped', () => {
  it("reads this run's card status, ignoring another run's same-id card (claim succeeds)", () => {
    // Run B owns a card 'p01' that is NOT ready (would fail the guard if seen).
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'p01', status: 'waiting' }));
    // Run A owns its own 'p01', ready.
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'p01', status: 'ready' }));

    const result = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wA',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });

    // An unscoped Guard 2 (SELECT status FROM cards WHERE id='p01') reads an
    // ambiguous row and may see run B's 'waiting' card → wrong 'not_ready'.
    expect(result.ok).toBe(true);
    expect(db!.getCard(RUN_A, 'p01')!.status).toBe('claimed');
    // Run B's card is untouched.
    expect(db!.getCard(RUN_B, 'p01')!.status).toBe('waiting');
  });

  it("does not claim on another run's ready card when THIS run's card is not ready", () => {
    // Run B owns a READY 'p01'; run A owns a NOT-ready 'p01'.
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'p01', status: 'ready' }));
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'p01', status: 'waiting' }));

    const result = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wA',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });

    // Run A's own card is 'waiting' → must be 'not_ready'. An unscoped guard
    // could see run B's ready card and wrongly admit the claim.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_ready');
    expect(db!.getCard(RUN_A, 'p01')!.status).toBe('waiting'); // unchanged
    expect(db!.getCard(RUN_B, 'p01')!.status).toBe('ready'); // unchanged
    expect(rawWorkerCount(db!, RUN_A, 'work')).toBe(0); // wrote nothing
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — wip_cap MUST be run-scoped. THE confirmed functional bug:
// another run's worker at the same station currently counts against THIS run's
// WIP cap, so the active run can never claim (executor spins). This is the
// must-fail-red test the team specified.
// ---------------------------------------------------------------------------

describe('attemptClaim — Guard 3 (WIP cap) is run-scoped', () => {
  it("ignores another run's workers at the same station when measuring WIP (wip=1)", () => {
    // Run B fills its single slot at station 'work' (its own card 'pB').
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'pB' }));
    const filledByB = claim(db!, {
      cardId: 'pB',
      station: 'work',
      workerId: 'wB',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_B,
    });
    expect(filledByB.ok).toBe(true);
    expect(rawWorkerCount(db!, RUN_B, 'work')).toBe(1);

    // Run A's own station 'work' is EMPTY — it has zero workers there.
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'pA', status: 'ready' }));

    const claimedByA = claim(db!, {
      cardId: 'pA',
      station: 'work',
      workerId: 'wA',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });

    // BUG TODAY: Guard 3 counts COUNT(*) WHERE station='work' across ALL runs,
    // sees run B's 1 worker, and returns { ok:false, reason:'wip_cap' } even
    // though run A has zero of its own workers there. The executor then spins.
    expect(claimedByA.ok).toBe(true);
    expect(claimedByA.reason).toBeUndefined();
    expect(db!.getCard(RUN_A, 'pA')!.status).toBe('claimed');
    expect(rawWorkerCount(db!, RUN_A, 'work')).toBe(1); // run A's own slot
    expect(rawWorkerCount(db!, RUN_B, 'work')).toBe(1); // run B unchanged
  });

  it("still enforces the WIP cap WITHIN a run (other run's workers don't relax it)", () => {
    // Run A fills its own single slot.
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'pA1', status: 'ready' }));
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'pA2', status: 'ready' }));
    const first = claim(db!, {
      cardId: 'pA1',
      station: 'work',
      workerId: 'wA1',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });
    expect(first.ok).toBe(true);

    // A SECOND claim within run A at the same wip=1 station must still fail —
    // run-scoping must not weaken the in-run cap.
    const second = claim(db!, {
      cardId: 'pA2',
      station: 'work',
      workerId: 'wA2',
      wipCap: 1,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('wip_cap');
    expect(db!.getCard(RUN_A, 'pA2')!.status).toBe('ready'); // unchanged
    expect(rawWorkerCount(db!, RUN_A, 'work')).toBe(1); // still just pA1
  });
});

// ---------------------------------------------------------------------------
// INSERT — the active_workers slot must be stamped with the claiming run's id,
// not the DEFAULT. (A non-default run whose INSERT omits run_id silently lands
// under 'default', corrupting both runs' WIP accounting.)
// ---------------------------------------------------------------------------

describe('attemptClaim — INSERT stamps the claiming run_id', () => {
  it('writes the active_workers row under the request run id (non-default run)', () => {
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'p01', status: 'ready' }));

    const result = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wB',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_B,
    });
    expect(result.ok).toBe(true);

    // The slot must carry run B's id — not the DEFAULT the bare INSERT applies.
    expect(rawSlotRunId(db!, 'p01', 'work')).toBe(RUN_B);
    expect(rawWorkerCount(db!, RUN_B, 'work')).toBe(1);
    expect(rawWorkerCount(db!, DEFAULT_RUN_ID, 'work')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UPDATE — `UPDATE cards SET status='claimed'` must be scoped, so a claim in
// one run never flips a same-id card belonging to another run.
// ---------------------------------------------------------------------------

describe("attemptClaim — UPDATE cards SET status='claimed' is run-scoped", () => {
  it("flips only the claiming run's card, leaving another run's same-id card untouched", () => {
    // Both runs own a 'p01'. Run B's is ready too — proving the UPDATE must not
    // collaterally claim it.
    db!.insertCard(makeCard({ run_id: RUN_B, id: 'p01', status: 'ready' }));
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'p01', status: 'ready' }));

    const result = claim(db!, {
      cardId: 'p01',
      station: 'work',
      workerId: 'wA',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      runId: RUN_A,
    });
    expect(result.ok).toBe(true);

    // Only run A's card became 'claimed'. An unscoped UPDATE (WHERE id='p01')
    // would have flipped BOTH same-id rows.
    expect(db!.getCard(RUN_A, 'p01')!.status).toBe('claimed');
    expect(db!.getCard(RUN_B, 'p01')!.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// Back-compat — omitting runId must behave exactly as before (DEFAULT_RUN_ID).
// This is what keeps claim.test.ts and the two executor call sites green.
// ---------------------------------------------------------------------------

describe('attemptClaim — default-run back-compat (runId omitted)', () => {
  it('claims a default-run card when runId is omitted, stamping the default run id', () => {
    db!.insertCard(makeCard({ run_id: DEFAULT_RUN_ID, id: 'c1', status: 'ready' }));

    const result = claim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      // runId intentionally omitted ⇒ DEFAULT_RUN_ID
    });

    expect(result.ok).toBe(true);
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('claimed');
    expect(rawSlotRunId(db!, 'c1', 'work')).toBe(DEFAULT_RUN_ID);
    expect(rawWorkerCount(db!, DEFAULT_RUN_ID, 'work')).toBe(1);
  });
});
