/**
 * Tests for the two andons (WI-301, SPEC §8, FR-11 "two andons, not one").
 *
 * TWO DISTINCT mechanisms:
 *   1. CONSUMPTION andon — wall-clock + tokens at run scope. Trips on a *busy*
 *      runaway → blocks new claims, reports the overshoot. On trip, in-flight
 *      workers DRAIN (complete-and-checkpoint), they are NOT hard-killed — the
 *      sole exception being a worker past its heartbeat lease (rev-1 M4).
 *   2. LIVENESS watchdog — "no card changed lane within no_progress AND no
 *      worker active" → an *immediate* deadlock alert WITH the blocking reason.
 *      Catches a *stalled* flow that the consumption andon (which only sees
 *      spend) would miss.
 *
 * All functions are PURE analyzers over injected state + `now` (deterministic;
 * the tick builds the snapshot from persistence). Liveness is by lease, not PID.
 *
 * Contract this file pins for src/control/watchdog.ts:
 *
 *   interface RunBudget { wallClockSeconds: number; maxTokens: number }
 *   interface ConsumptionState { runStartedAt: number; now: number; tokensSpent: number }
 *   interface ConsumptionAndon {
 *     tripped: boolean; blockNewClaims: boolean;
 *     reason?: 'wall_clock' | 'tokens';
 *     overshoot?: { wallClockSeconds?: number; tokens?: number };
 *   }
 *   function checkConsumptionAndon(state, budget): ConsumptionAndon
 *
 *   interface WorkerSlot { cardId: string; station: string; leaseUntil: number }
 *   type DrainAction = { cardId; station; action: 'drain' | 'hard_kill' }
 *   function planDrain(workers: WorkerSlot[], now: number): DrainAction[]
 *
 *   type BlockingReason = 'dependency_scrapped' | 'hold_awaiting_human' | 'no_idle_worker' | 'unknown'
 *   interface LivenessState {
 *     now: number; lastLaneChangeAt: number; activeWorkerCount: number;
 *     hasScrappedDep: boolean; hasHoldAwaitingHuman: boolean; hasReadyButNoIdleWorker: boolean;
 *   }
 *   interface LivenessConfig { noProgressSeconds: number }
 *   interface LivenessAlert { tripped: boolean; blockingReason?: BlockingReason; detail?: string }
 *   function checkLiveness(state, config): LivenessAlert
 */
import { describe, it, expect } from 'bun:test';
import {
  checkConsumptionAndon,
  planDrain,
  checkLiveness,
  type ConsumptionState,
  type RunBudget,
  type LivenessState,
} from './watchdog';

const NOW = 1_000_000;

function consumption(overrides: Partial<ConsumptionState> = {}): ConsumptionState {
  return { runStartedAt: NOW, now: NOW, tokensSpent: 0, ...overrides };
}
function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return { wallClockSeconds: 3600, maxTokens: 1_000_000, ...overrides };
}
function liveness(overrides: Partial<LivenessState> = {}): LivenessState {
  return {
    now: NOW,
    lastLaneChangeAt: NOW,
    activeWorkerCount: 0,
    hasScrappedDep: false,
    hasHoldAwaitingHuman: false,
    hasReadyButNoIdleWorker: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — consumption andon: over budget → block new claims + report overshoot.
// ---------------------------------------------------------------------------

describe('consumption andon (AC1)', () => {
  it('trips on wall-clock overage, blocks claims, and reports the wall-clock overshoot', () => {
    const a = checkConsumptionAndon(
      consumption({ runStartedAt: NOW, now: NOW + 4200 }), // 4200s elapsed
      budget({ wallClockSeconds: 3600 }),
    );
    expect(a.tripped).toBe(true);
    expect(a.blockNewClaims).toBe(true);
    expect(a.reason).toBe('wall_clock');
    expect(a.overshoot?.wallClockSeconds).toBe(600); // 4200 - 3600
  });

  it('trips on token overage and reports the token overshoot', () => {
    const a = checkConsumptionAndon(
      consumption({ tokensSpent: 1_200_000 }),
      budget({ maxTokens: 1_000_000 }),
    );
    expect(a.tripped).toBe(true);
    expect(a.blockNewClaims).toBe(true);
    expect(a.reason).toBe('tokens');
    expect(a.overshoot?.tokens).toBe(200_000);
  });

  it('does not trip and does not block claims while under budget', () => {
    const a = checkConsumptionAndon(
      consumption({ now: NOW + 60, tokensSpent: 500 }),
      budget(),
    );
    expect(a.tripped).toBe(false);
    expect(a.blockNewClaims).toBe(false);
  });

  // Boundary symmetry with the liveness watchdog (which trips at >=): hitting the
  // budget EXACTLY trips the consumption andon. The ceiling is reached, not surpassed.
  it('trips when wall-clock is EXACTLY at the budget (>= boundary)', () => {
    const a = checkConsumptionAndon(
      consumption({ runStartedAt: NOW, now: NOW + 3600 }), // exactly 3600s elapsed
      budget({ wallClockSeconds: 3600 }),
    );
    expect(a.tripped).toBe(true);
    expect(a.reason).toBe('wall_clock');
    expect(a.overshoot?.wallClockSeconds).toBe(0); // exactly at the limit → zero overshoot
  });

  it('trips when tokens are EXACTLY at the budget (>= boundary)', () => {
    const a = checkConsumptionAndon(
      consumption({ tokensSpent: 1_000_000 }), // exactly at maxTokens
      budget({ maxTokens: 1_000_000 }),
    );
    expect(a.tripped).toBe(true);
    expect(a.reason).toBe('tokens');
    expect(a.overshoot?.tokens).toBe(0);
  });

  it('does NOT trip one unit below the wall-clock budget', () => {
    const a = checkConsumptionAndon(
      consumption({ runStartedAt: NOW, now: NOW + 3599 }),
      budget({ wallClockSeconds: 3600 }),
    );
    expect(a.tripped).toBe(false);
  });

  it('does NOT trip one token below the token budget', () => {
    const a = checkConsumptionAndon(
      consumption({ tokensSpent: 999_999 }),
      budget({ maxTokens: 1_000_000 }),
    );
    expect(a.tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 / AC3 — drain in-flight workers; hard-kill ONLY past-lease workers.
// ---------------------------------------------------------------------------

describe('drain semantics (AC2/AC3)', () => {
  it('drains an in-flight worker whose lease is still valid (no hard-kill)', () => {
    const plan = planDrain([{ cardId: 'c1', station: 'work', leaseUntil: NOW + 100 }], NOW);
    expect(plan).toEqual([{ cardId: 'c1', station: 'work', action: 'drain' }]);
  });

  it('hard-kills a worker past its heartbeat lease (the one exception to drain)', () => {
    const plan = planDrain([{ cardId: 'c1', station: 'work', leaseUntil: NOW - 1 }], NOW);
    expect(plan).toEqual([{ cardId: 'c1', station: 'work', action: 'hard_kill' }]);
  });

  it('drains live workers and hard-kills only the expired one in a mixed pool', () => {
    const plan = planDrain(
      [
        { cardId: 'live', station: 'work', leaseUntil: NOW + 50 },
        { cardId: 'dead', station: 'work', leaseUntil: NOW - 50 },
      ],
      NOW,
    );
    expect(plan.find((p) => p.cardId === 'live')!.action).toBe('drain');
    expect(plan.find((p) => p.cardId === 'dead')!.action).toBe('hard_kill');
  });
});

// ---------------------------------------------------------------------------
// AC4 / AC5 — liveness watchdog: stall → deadlock alert with blocking reason.
// ---------------------------------------------------------------------------

describe('liveness watchdog (AC4/AC5)', () => {
  it('trips when no lane changed within the window and no worker is active', () => {
    const alert = checkLiveness(
      liveness({ lastLaneChangeAt: NOW, now: NOW + 400, activeWorkerCount: 0, hasReadyButNoIdleWorker: true }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(true);
    expect(alert.blockingReason).toBeDefined();
    expect(alert.blockingReason).not.toBe('unknown');
    expect(alert.detail ?? '').not.toBe('');
  });

  it('does NOT trip while a card is gated behind a future release_at', () => {
    // Scheduled waiting is not a deadlock. Without this, a rate-limit park
    // (issue #3) or a fan-out stagger longer than no_progress_minutes reads as
    // "no progress + no active worker" and halts a run that was about to
    // resume on its own.
    const alert = checkLiveness(
      liveness({
        lastLaneChangeAt: NOW,
        now: NOW + 400,
        activeWorkerCount: 0,
        hasReleaseGatedCard: true,
      }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(false);
  });

  it('still trips on the SAME state once nothing is gated any more', () => {
    // Pins that the suppression is the gate itself, not a blanket loosening of
    // the stall check.
    const base = {
      lastLaneChangeAt: NOW,
      now: NOW + 400,
      activeWorkerCount: 0,
      hasReadyButNoIdleWorker: true,
    };
    expect(checkLiveness(liveness({ ...base, hasReleaseGatedCard: true }), { noProgressSeconds: 300 }).tripped).toBe(false);
    expect(checkLiveness(liveness({ ...base, hasReleaseGatedCard: false }), { noProgressSeconds: 300 }).tripped).toBe(true);
  });

  it('reports hold_awaiting_human as the blocking reason', () => {
    const alert = checkLiveness(
      liveness({ lastLaneChangeAt: NOW, now: NOW + 400, hasHoldAwaitingHuman: true }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(true);
    expect(alert.blockingReason).toBe('hold_awaiting_human');
  });

  it('reports dependency_scrapped as the blocking reason', () => {
    const alert = checkLiveness(
      liveness({ lastLaneChangeAt: NOW, now: NOW + 400, hasScrappedDep: true }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(true);
    expect(alert.blockingReason).toBe('dependency_scrapped');
  });
});

// ---------------------------------------------------------------------------
// AC6 — a slow-but-progressing flow does NOT trip liveness.
// ---------------------------------------------------------------------------

describe('liveness does not false-trip on progress (AC6)', () => {
  it('does not trip when a lane changed within the no-progress window', () => {
    const alert = checkLiveness(
      // only 50s since the last lane change, window is 300s → still progressing
      liveness({ lastLaneChangeAt: NOW + 350, now: NOW + 400, activeWorkerCount: 0 }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(false);
  });

  it('does not trip while a worker is still active (work in flight)', () => {
    const alert = checkLiveness(
      liveness({ lastLaneChangeAt: NOW, now: NOW + 9999, activeWorkerCount: 1 }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two andons are DISTINCT — each catches what the other misses.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WI-33 — a completed synchronous adapter call counts as liveness progress,
// even without a lane change (a long draft↔gate rework cycle spends real
// wall-clock minutes inside a single tick's model call).
// ---------------------------------------------------------------------------

describe('liveness counts adapter activity as progress (WI-33)', () => {
  it('does NOT trip when the lane is stale but an adapter call completed recently', () => {
    const alert = checkLiveness(
      liveness({
        // Lane last changed 400s ago (past the 300s window on its own)...
        lastLaneChangeAt: NOW,
        now: NOW + 400,
        // ...but an adapter call completed only 50s ago — well within the window.
        lastAdapterActivityAt: NOW + 350,
        activeWorkerCount: 0,
      }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(false);
  });

  it('trips when neither the lane nor adapter activity has moved within the window (no active workers)', () => {
    const alert = checkLiveness(
      liveness({
        lastLaneChangeAt: NOW,
        now: NOW + 400,
        lastAdapterActivityAt: NOW, // also stale — no recent activity at all
        activeWorkerCount: 0,
        hasReadyButNoIdleWorker: true,
      }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(true);
    expect(alert.blockingReason).not.toBe('unknown');
  });

  it('preserves prior behavior when lastAdapterActivityAt is omitted (lane-change-only genuine stall still trips)', () => {
    const alert = checkLiveness(
      liveness({
        lastLaneChangeAt: NOW,
        now: NOW + 400,
        activeWorkerCount: 0,
        hasHoldAwaitingHuman: true,
        // lastAdapterActivityAt intentionally omitted
      }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(true);
  });

  it('does not trip on adapter activity alone if a worker is still active (belt-and-suspenders with AC6)', () => {
    const alert = checkLiveness(
      liveness({
        lastLaneChangeAt: NOW,
        now: NOW + 9999,
        lastAdapterActivityAt: NOW + 9990,
        activeWorkerCount: 1,
      }),
      { noProgressSeconds: 300 },
    );
    expect(alert.tripped).toBe(false);
  });
});

describe('two distinct andons', () => {
  it('consumption trips on a busy-but-progressing runaway while liveness stays quiet', () => {
    const cons = checkConsumptionAndon(consumption({ tokensSpent: 2_000_000 }), budget({ maxTokens: 1_000_000 }));
    const live = checkLiveness(
      liveness({ lastLaneChangeAt: NOW + 380, now: NOW + 400, activeWorkerCount: 2 }),
      { noProgressSeconds: 300 },
    );
    expect(cons.tripped).toBe(true); // busy runaway caught by consumption
    expect(live.tripped).toBe(false); // progressing → liveness silent
  });

  it('liveness trips on a cheap silent stall while consumption stays quiet', () => {
    const cons = checkConsumptionAndon(consumption({ now: NOW + 30, tokensSpent: 10 }), budget());
    const live = checkLiveness(
      liveness({ lastLaneChangeAt: NOW, now: NOW + 5000, activeWorkerCount: 0, hasHoldAwaitingHuman: true }),
      { noProgressSeconds: 300 },
    );
    expect(cons.tripped).toBe(false); // nothing consumed → consumption silent
    expect(live.tripped).toBe(true); // silent stall caught by liveness
  });
});
