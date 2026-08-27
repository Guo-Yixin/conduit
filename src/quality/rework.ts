/**
 * Rework engine — four independent bounding guards (WI-299, SPEC §6, FR-10).
 *
 * Pure functions: no DB, no LLM.  The tick planner calls these to decide
 * whether to rework, scrap, or proceed_with_findings, then applies the
 * decision via the WI-293 FSM.
 *
 * Four independent guards, each on its own counter:
 *   1. Per-card rework cap (reworkCount) + no_progress detection on findings_hash.
 *   2. Per-execution-attempt cap (executionAttempt) — completely independent of
 *      the rework counter by construction.
 *   3. Progress-monotonicity: identical consecutive findings_hash → immediate
 *      scrap, even when the artifact payload changed (SPEC §6 rev-1 H2).
 *   4. Wave (parent_id subtree) + run budgets: token/dispatch caps that scrap a
 *      subtree or block new claims without halting in-flight work.
 *
 * Guard 1 and Guard 3 are implemented together in `decideQcReject` because they
 * share the same verdict input and the same scrap/proceed output path.
 */

import type { Lane, StationOutput } from '../types/kernel';

// ---------------------------------------------------------------------------
// Guard 1 + Guard 3 — QC reject decision
// ---------------------------------------------------------------------------

/**
 * Input to the QC reject decision.  Consumes the WI-289 StationOutput verdict
 * directly — findings_hash and return_to are the authoritative fields.
 */
export interface QcRejectInput {
  /** The current QC verdict from the critic station. */
  verdict: StationOutput<unknown>;
  /**
   * The findings_hash of the PREVIOUS rejection attempt, or null if this is
   * the first rejection for this card.  Null → no no-progress check.
   */
  previousFindingsHash: string | null;
  reworkCount: number;
  reworkCap: number;
  capPolicy: 'scrap' | 'proceed_with_findings';
}

export type QcRejectDecision =
  | { action: 'rework'; returnTo: Lane }
  | { action: 'scrap'; reason: 'rework_cap' | 'no_progress' | 'malformed_verdict' }
  | { action: 'proceed_with_findings'; reason: 'rework_cap' | 'no_progress' };

/**
 * Decide what to do after a QC critic rejects a station's output.
 *
 * Guards applied (in priority order):
 *   1. No-progress detection: if previousFindingsHash is non-null and equals
 *      the current verdict.findings_hash, the worker is looping → immediate
 *      scrap/proceed regardless of remaining rework budget.
 *   2. Rework cap: if reworkCount >= reworkCap, the cap is exhausted.
 *   3. Both fire → reason = 'no_progress' (takes precedence over 'rework_cap').
 *   4. Neither → rework: route the card to verdict.return_to.
 *
 * Keys on findings_hash ONLY, never the artifact payload — cosmetic churn
 * that changes the artifact but not the critic's findings is treated as
 * no progress (SPEC §6 rev-1 H2).
 */
export function decideQcReject(input: QcRejectInput): QcRejectDecision {
  const { verdict, previousFindingsHash, reworkCount, reworkCap, capPolicy } = input;

  // Guard 3 — progress monotonicity on the findings hash (not the artifact).
  const noProgress =
    previousFindingsHash !== null &&
    verdict.findings_hash === previousFindingsHash;

  // Guard 1 — per-card rework cap.
  const atCap = reworkCount >= reworkCap;

  if (noProgress || atCap) {
    // no_progress takes precedence when both fire simultaneously.
    const reason: 'no_progress' | 'rework_cap' = noProgress ? 'no_progress' : 'rework_cap';

    if (capPolicy === 'scrap') {
      return { action: 'scrap', reason };
    }
    return { action: 'proceed_with_findings', reason };
  }

  // Under cap with real progress — rework: route to the critic's back-edge.
  // verdict.return_to is the authoritative target from the WI-289 envelope.
  //
  // ESCALATE, DON'T GUESS (Principle 9): a 'reject' verdict whose return_to is
  // null is a MALFORMED verdict (a reject must name where to route). Emitting a
  // null-lane rework decision would be structurally invalid downstream; instead
  // we fail closed and scrap with a distinct reason so the malformed-critic
  // signal is visible. The `as Lane` cast that masked this is removed.
  if (verdict.return_to === null) {
    return { action: 'scrap', reason: 'malformed_verdict' };
  }
  return { action: 'rework', returnTo: verdict.return_to };
}

// ---------------------------------------------------------------------------
// Guard 2 — execution-attempt cap (integrity / parse retries)
// ---------------------------------------------------------------------------

/**
 * Input for the execution-attempt retry decision.
 *
 * Deliberately contains NO rework-related fields — the independence is
 * structural.  Guard 2 is enforced on executionAttempt alone; it cannot
 * interact with the rework counter.
 */
export interface ExecutionRetryInput {
  /** How many times the worker has been dispatched at this lane (Card.attempt). */
  executionAttempt: number;
  /** per_card.max_execution_attempts from the flow config. */
  maxExecutionAttempts: number;
}

export type ExecutionRetryDecision =
  | { action: 'retry' }
  | { action: 'scrap'; reason: 'execution_attempt_cap' };

/**
 * Decide whether to retry a failed execution attempt (parse/integrity failure).
 *
 * GUARD-2 AUTHORITY (SPEC §6.2): this is a PURE PREDICATE the tick consults
 * BEFORE firing the INTEGRITY_FAIL event. It owns NO durable counter and never
 * increments anything — the WI-293 FSM is the SOLE authority for the durable
 * `executionAttempt` counter and the scrap decision (see transitions.ts
 * INTEGRITY_FAIL). This function merely PREDICTS what the FSM will do so the
 * tick can route a card to scrap vs fire a retry without double-counting.
 *
 * Its boundary is intentionally identical to the FSM's: given `executionAttempt`
 * already-consumed attempts, the FSM scraps iff `executionAttempt + 1 >=
 * maxExecutionAttempts` (the next attempt would reach the cap). This predicate
 * mirrors that exactly, so prediction and authority can never disagree.
 *
 * Completely independent of the rework counter by construction — this guard
 * has no visibility into QC rework state.
 */
export function decideExecutionRetry(input: ExecutionRetryInput): ExecutionRetryDecision {
  // Mirror the FSM's INTEGRITY_FAIL boundary exactly: scrap iff the NEXT attempt
  // would reach the cap. (No double-count: the FSM, not this predicate, performs
  // the durable executionAttempt++.)
  if (input.executionAttempt + 1 >= input.maxExecutionAttempts) {
    return { action: 'scrap', reason: 'execution_attempt_cap' };
  }
  return { action: 'retry' };
}

// ---------------------------------------------------------------------------
// Guard 4 — budgets at wave (parent_id subtree) and run scope
// ---------------------------------------------------------------------------

/** Aggregated token and dispatch consumption for a budget window. */
export interface BudgetUsage {
  tokens: number;
  dispatches: number;
}

/** Optional budget caps — a missing cap means "unbounded". */
export interface BudgetCaps {
  maxTokens?: number;
  maxDispatches?: number;
}

/** Per-card usage record used to build the wave aggregates. */
export interface CardUsage {
  cardId: string;
  /** The parent epic's id — defines the wave partition. */
  parentId: string;
  tokens: number;
  dispatches: number;
}

/**
 * Partition per-card usage into wave (parent_id) buckets by summing token and
 * dispatch consumption across all cards sharing a parent_id.
 *
 * Pure aggregation — the tick calls this on data fetched from persistence,
 * then passes each bucket to checkWaveBudget.
 */
export function aggregateByWave(usages: CardUsage[]): Map<string, BudgetUsage> {
  const result = new Map<string, BudgetUsage>();
  for (const usage of usages) {
    const existing = result.get(usage.parentId) ?? { tokens: 0, dispatches: 0 };
    result.set(usage.parentId, {
      tokens: existing.tokens + usage.tokens,
      dispatches: existing.dispatches + usage.dispatches,
    });
  }
  return result;
}

export type WaveBudgetDecision =
  | { action: 'proceed' }
  | { action: 'scrap_subtree'; reason: 'wave_budget'; parentId: string };

/**
 * Check whether a wave (parent_id subtree) has exceeded its budget caps.
 *
 * A subtree that exceeds its budget is scrapped independently — sibling
 * subtrees under different parent_ids are unaffected.
 */
export function checkWaveBudget(
  parentId: string,
  usage: BudgetUsage,
  caps: BudgetCaps,
): WaveBudgetDecision {
  const tokensOver = caps.maxTokens !== undefined && usage.tokens > caps.maxTokens;
  const dispatchesOver =
    caps.maxDispatches !== undefined && usage.dispatches > caps.maxDispatches;

  if (tokensOver || dispatchesOver) {
    return { action: 'scrap_subtree', reason: 'wave_budget', parentId };
  }
  return { action: 'proceed' };
}

export type RunBudgetDecision =
  | { action: 'proceed' }
  | { action: 'block_claims'; reason: 'run_budget' };

/**
 * Check whether the run-scope budget has been exhausted.
 *
 * Run-budget exhaustion blocks new claims (the consumption andon) while
 * in-flight work is allowed to drain — it never directly scraps a card.
 */
export function checkRunBudget(usage: BudgetUsage, caps: BudgetCaps): RunBudgetDecision {
  const tokensOver = caps.maxTokens !== undefined && usage.tokens > caps.maxTokens;
  const dispatchesOver =
    caps.maxDispatches !== undefined && usage.dispatches > caps.maxDispatches;

  if (tokensOver || dispatchesOver) {
    return { action: 'block_claims', reason: 'run_budget' };
  }
  return { action: 'proceed' };
}
