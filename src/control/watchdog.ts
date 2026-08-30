/**
 * Liveness watchdog + consumption andon — the two distinct andons (WI-301, SPEC §8, FR-11).
 *
 * SPEC §8 mandates TWO independent andon mechanisms, not one:
 *
 *   1. CONSUMPTION andon — catches a BUSY runaway (wall-clock or token budget
 *      exceeded).  Blocks new claims while in-flight workers complete-and-checkpoint
 *      (soft ceiling).  A worker past its heartbeat lease is hard-killed — the sole
 *      exception to drain.
 *
 *   2. LIVENESS watchdog — catches a SILENT stall (no card changed lane within the
 *      no-progress window AND no worker is active).  Raises an immediate deadlock
 *      alert with the blocking reason.  A busy-but-cheap stall that the consumption
 *      andon (which only sees spend) would miss entirely.
 *
 * All three functions are PURE analyzers over injected state + `now`.  The tick
 * (WI-295) builds the snapshot from persistence and calls these.  No DB access
 * inside this module.  Liveness is by heartbeat lease, not PID.
 */

// ---------------------------------------------------------------------------
// Consumption andon
// ---------------------------------------------------------------------------

export interface RunBudget {
  /** Maximum wall-clock seconds for this run (from flow config budgets.run). */
  wallClockSeconds: number;
  /** Maximum token spend for this run. */
  maxTokens: number;
}

export interface ConsumptionState {
  /** Epoch-seconds when the run started. */
  runStartedAt: number;
  /** Current epoch-seconds (injected — deterministic). */
  now: number;
  /** Total tokens spent so far in this run. */
  tokensSpent: number;
}

export interface ConsumptionAndon {
  tripped: boolean;
  /**
   * When tripped, block new claims.  In-flight workers are allowed to drain
   * (complete-and-checkpoint) — hard-kill is only for past-lease workers.
   */
  blockNewClaims: boolean;
  reason?: 'wall_clock' | 'tokens';
  overshoot?: {
    wallClockSeconds?: number;
    tokens?: number;
  };
}

/**
 * Evaluate the consumption andon against the current run state.
 *
 * Wall-clock is checked first; if exceeded, the wall-clock overshoot is
 * returned without checking tokens.  If wall-clock is within budget, tokens
 * are checked independently.
 *
 * Boundary: both checks use `>=` so hitting the budget EXACTLY trips the andon.
 * This mirrors the liveness watchdog's `>=` no-progress boundary (below) so the
 * two andons treat "exactly at the limit" identically — a budget is a ceiling
 * that is reached, not merely a value that must be surpassed.
 */
export function checkConsumptionAndon(
  state: ConsumptionState,
  budget: RunBudget,
): ConsumptionAndon {
  const elapsed = state.now - state.runStartedAt;

  if (elapsed >= budget.wallClockSeconds) {
    return {
      tripped: true,
      blockNewClaims: true,
      reason: 'wall_clock',
      overshoot: { wallClockSeconds: elapsed - budget.wallClockSeconds },
    };
  }

  if (state.tokensSpent >= budget.maxTokens) {
    return {
      tripped: true,
      blockNewClaims: true,
      reason: 'tokens',
      overshoot: { tokens: state.tokensSpent - budget.maxTokens },
    };
  }

  return { tripped: false, blockNewClaims: false };
}

// ---------------------------------------------------------------------------
// Drain planner
// ---------------------------------------------------------------------------

export interface WorkerSlot {
  cardId: string;
  station: string;
  /** Epoch-seconds of the heartbeat lease expiry (from active_workers.lease_until). */
  leaseUntil: number;
}

export type DrainAction = {
  cardId: string;
  station: string;
  /**
   * drain     — let the worker complete-and-checkpoint (default; soft shutdown).
   * hard_kill — worker is past its heartbeat lease; forcibly terminate.
   */
  action: 'drain' | 'hard_kill';
};

/**
 * Plan the drain action for each active worker slot.
 *
 * Rule: a worker whose lease is still valid (leaseUntil > now) gets 'drain' —
 * it is allowed to reach a checkpoint naturally.  A worker past its lease
 * (leaseUntil <= now) gets 'hard_kill' — this is the ONE exception to drain
 * (SPEC §8 rev-1 M4).
 */
export function planDrain(workers: WorkerSlot[], now: number): DrainAction[] {
  return workers.map((w) => ({
    cardId: w.cardId,
    station: w.station,
    action: w.leaseUntil > now ? 'drain' : 'hard_kill',
  }));
}

// ---------------------------------------------------------------------------
// Liveness watchdog
// ---------------------------------------------------------------------------

export type BlockingReason =
  | 'dependency_scrapped'
  | 'hold_awaiting_human'
  | 'no_idle_worker'
  | 'unknown';

export interface LivenessState {
  /** Current epoch-seconds (injected). */
  now: number;
  /** Epoch-seconds when the last card changed lane (tracked by the tick). */
  lastLaneChangeAt: number;
  /**
   * Epoch-seconds of the most recent COMPLETED synchronous adapter call
   * (transform worker, gate critic, rank check — any in-process model call).
   *
   * WI-33 fix: on the synchronous single-worker path, an in-flight/just-completed
   * adapter call IS progress, even when it did not (yet) produce a lane change —
   * a long-running draft↔gate rework cycle can spend several minutes inside a
   * single tick's model call(s), and the per-tick `now` sampled BEFORE those
   * calls understates when the resulting lane change actually happened. Optional
   * so existing callers/tests that only track lane changes keep working
   * unchanged; when omitted, liveness is judged on `lastLaneChangeAt` alone
   * (unchanged prior behavior).
   */
  lastAdapterActivityAt?: number;
  /** Number of workers with an active (non-expired) lease. */
  activeWorkerCount: number;
  /**
   * True if any READY card is gated behind a future `cards.release_at`.
   *
   * A gated card is WAITING ON PURPOSE, at a known instant the run loop is
   * already sleeping toward — the opposite of a deadlock. Without this, a
   * rate-limit park (issue #3) or a fan-out stagger longer than
   * `no_progress_minutes` reads as "no progress + no active worker" and halts a
   * run that was about to resume on its own.
   *
   * The consumption andon remains the guard against waiting longer than the run
   * can afford: it is checked BEFORE the loop sleeps to a gate, so a park that
   * outlasts the wall-clock budget still halts.
   */
  hasReleaseGatedCard?: boolean;
  /** True if any card's dependency was scrapped and the card is stuck waiting. */
  hasScrappedDep: boolean;
  /** True if any card is in the hold lane awaiting a human HITL decision. */
  hasHoldAwaitingHuman: boolean;
  /** True if ready cards exist but all worker slots are occupied. */
  hasReadyButNoIdleWorker: boolean;
}

export interface LivenessConfig {
  /** Watchdog window in seconds — trip when no progress for this long. */
  noProgressSeconds: number;
}

export interface LivenessAlert {
  tripped: boolean;
  blockingReason?: BlockingReason;
  /** Human-readable explanation for the alert (non-empty when tripped). */
  detail?: string;
}

/** Determine the blocking reason from the liveness state flags (priority order). */
function resolveBlockingReason(state: LivenessState): BlockingReason {
  if (state.hasScrappedDep) return 'dependency_scrapped';
  if (state.hasHoldAwaitingHuman) return 'hold_awaiting_human';
  if (state.hasReadyButNoIdleWorker) return 'no_idle_worker';
  return 'unknown';
}

/**
 * Evaluate the liveness watchdog against the current flow snapshot.
 *
 * Trip condition (BOTH must be true):
 *   - No progress within the no-progress window, where "progress" is
 *     max(lastLaneChangeAt, lastAdapterActivityAt) — a completed synchronous
 *     adapter call counts as progress exactly like a lane change does (WI-33:
 *     an in-flight/just-completed model call on the synchronous path is
 *     evidence the run is alive, not stalled).
 *     (now - progressAt >= noProgressSeconds)
 *   - No worker is currently active (activeWorkerCount === 0)
 *
 * A slow-but-progressing flow (recent lane change OR recent adapter activity)
 * does NOT trip. A flow with active workers in-flight does NOT trip — work may
 * still complete.
 */
export function checkLiveness(
  state: LivenessState,
  config: LivenessConfig,
): LivenessAlert {
  const progressAt = Math.max(state.lastLaneChangeAt, state.lastAdapterActivityAt ?? -Infinity);
  const timeSinceProgress = state.now - progressAt;
  const noProgress = timeSinceProgress >= config.noProgressSeconds;
  const noActiveWorkers = state.activeWorkerCount === 0;

  if (!noProgress || !noActiveWorkers) {
    return { tripped: false };
  }

  // Scheduled waiting is not a stall. This check sits AFTER the two conditions
  // above so it only ever suppresses a would-be trip, and deliberately does NOT
  // get a blockingReason: the liveness watchdog answers "is this run wedged",
  // and a run counting down to a gate it will open itself is not.
  if (state.hasReleaseGatedCard === true) {
    return { tripped: false };
  }

  const blockingReason = resolveBlockingReason(state);

  const detailMap: Record<BlockingReason, string> = {
    dependency_scrapped: 'A scrapped dependency is blocking downstream cards from advancing.',
    hold_awaiting_human: 'A card is in the hold lane awaiting a human HITL decision.',
    no_idle_worker: 'Ready cards exist but all worker slots are currently occupied.',
    unknown: 'No cards changed lane and no workers are active; cause is unknown.',
  };

  return {
    tripped: true,
    blockingReason,
    detail: detailMap[blockingReason],
  };
}
