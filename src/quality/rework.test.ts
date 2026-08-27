/**
 * Tests for the rework engine + four bounding guards (WI-299).
 *
 * SPEC §6, FR-10, risk R "bounded rework leaks a runaway". The rework engine is
 * the POLICY layer above the WI-293 FSM: it decides reject-vs-scrap by applying
 * FOUR INDEPENDENT guards, each independently enforced and independently tested:
 *
 *   1. Per-card rework cap → scrap (cap_policy=scrap) or proceed_with_findings.
 *   2. Per-execution-attempt cap for integrity/parse retries — scraps on
 *      exhaustion INDEPENDENTLY of the rework counter.
 *   3. Progress-monotonicity on the critic FINDINGS HASH (not the artifact): two
 *      consecutive rejections with identical findings hashes exhaust the cap
 *      immediately (SPEC §6 rev-1 H2). Cosmetic churn that changes the artifact
 *      but not the findings hash = no progress.
 *   4. Budgets at card / wave(parent_id subtree) / run scope: the per-wave
 *      budget keys on parent_id; exceeding it scraps that subtree WITHOUT
 *      halting other subtrees or the run. Run-scope exhaustion blocks new claims
 *      while in-flight work drains.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/quality/rework.ts
 * ---------------------------------------------------------------------------
 *
 *   // Guard 1 + Guard 3 — QC reject decision (consumes the WI-289 verdict
 *   // envelope; findings_hash + return_to are authoritative — no parallel shape).
 *   export interface QcRejectInput {
 *     verdict: StationOutput<unknown>;     // current QC verdict
 *     previousFindingsHash: string | null; // prior attempt's findings_hash (persistence)
 *     reworkCount: number;
 *     reworkCap: number;
 *     capPolicy: 'scrap' | 'proceed_with_findings';
 *   }
 *   export type QcRejectDecision =
 *     | { action: 'rework'; returnTo: Lane }
 *     | { action: 'scrap'; reason: 'rework_cap' | 'no_progress' }
 *     | { action: 'proceed_with_findings'; reason: 'rework_cap' | 'no_progress' };
 *   export function decideQcReject(input: QcRejectInput): QcRejectDecision;
 *
 *   // Guard 2 — execution-attempt cap (integrity/parse retries). NO rework input
 *   // by construction → provably independent of the rework counter.
 *   export interface ExecutionRetryInput { executionAttempt: number; maxExecutionAttempts: number }
 *   export type ExecutionRetryDecision =
 *     | { action: 'retry' }
 *     | { action: 'scrap'; reason: 'execution_attempt_cap' };
 *   export function decideExecutionRetry(input: ExecutionRetryInput): ExecutionRetryDecision;
 *
 *   // Guard 4 — budgets. Pure functions; the tick aggregates usage from
 *   // persistence (WI-290) and partitions per parent_id before calling.
 *   export interface BudgetUsage { tokens: number; dispatches: number }
 *   export interface BudgetCaps { maxTokens?: number; maxDispatches?: number }
 *   export interface CardUsage { cardId: string; parentId: string; tokens: number; dispatches: number }
 *   export function aggregateByWave(usages: CardUsage[]): Map<string, BudgetUsage>;
 *   export type WaveBudgetDecision =
 *     | { action: 'proceed' }
 *     | { action: 'scrap_subtree'; reason: 'wave_budget'; parentId: string };
 *   export function checkWaveBudget(parentId: string, usage: BudgetUsage, caps: BudgetCaps): WaveBudgetDecision;
 *   export type RunBudgetDecision =
 *     | { action: 'proceed' }
 *     | { action: 'block_claims'; reason: 'run_budget' };
 *   export function checkRunBudget(usage: BudgetUsage, caps: BudgetCaps): RunBudgetDecision;
 *
 * FLAGGED INTEGRATION SEAM (for B.A. + the tick item): WI-293's FSM has no event
 * to scrap a card for no_progress or execution-attempt-cap while it is still
 * under the rework cap. The engine DECIDES those scraps; the tick APPLIES them
 * (e.g. fire QC_REJECT with reworkCap forced to reworkCount to reuse the FSM's
 * at-cap scrap path, or add a SCRAP event to WI-293). The FSM-consistency block
 * below pins only the guard-1 cap path, which both already agree on.
 */
import { describe, it, expect } from 'bun:test';
import type { Lane, StationOutput } from '../types/kernel';
import {
  transition,
  type FsmState,
  type TransitionContext,
} from '../statemachine/transitions';
import {
  decideQcReject,
  decideExecutionRetry,
  aggregateByWave,
  checkWaveBudget,
  checkRunBudget,
} from './rework';
import type { QcRejectInput } from './rework';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdict(
  findingsHash: string,
  opts: { payload?: unknown; returnTo?: Lane } = {},
): StationOutput<unknown> {
  return {
    payload: opts.payload ?? { artifact: 'baseline' },
    findings_hash: findingsHash,
    return_to: opts.returnTo ?? 'draft',
    usage: { tokens: 10, cost: 0.001 },
  };
}

function qcInput(over: Partial<QcRejectInput> = {}): QcRejectInput {
  return {
    verdict: verdict('fh-1'),
    previousFindingsHash: null,
    reworkCount: 0,
    reworkCap: 3,
    capPolicy: 'scrap',
    ...over,
  };
}

// ===========================================================================
// GUARD 1 — per-card rework cap (AC1)
// ===========================================================================

describe('Guard 1 — per-card rework cap (AC1)', () => {
  it('routes to the verdict back-edge while under the cap with progress', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 1, reworkCap: 3, previousFindingsHash: 'fh-0', verdict: verdict('fh-1', { returnTo: 'draft' }) }),
    );
    expect(decision).toEqual({ action: 'rework', returnTo: 'draft' });
  });

  it('scraps at the rework cap when cap_policy=scrap', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 3, reworkCap: 3, previousFindingsHash: 'fh-0', verdict: verdict('fh-1'), capPolicy: 'scrap' }),
    );
    expect(decision).toEqual({ action: 'scrap', reason: 'rework_cap' });
  });

  it('forwards with findings at the rework cap when cap_policy=proceed_with_findings', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 3, reworkCap: 3, previousFindingsHash: 'fh-0', verdict: verdict('fh-1'), capPolicy: 'proceed_with_findings' }),
    );
    expect(decision).toEqual({ action: 'proceed_with_findings', reason: 'rework_cap' });
  });
});

// ===========================================================================
// GUARD 2 — per-execution-attempt cap, independent of rework (AC2)
// ===========================================================================

describe('Guard 2 — execution-attempt cap (AC2)', () => {
  // The predicate mirrors the FSM's INTEGRITY_FAIL boundary EXACTLY (finding #6):
  // scrap iff the NEXT attempt would reach the cap (executionAttempt + 1 >= max).
  it('retries while the next attempt would stay under the execution-attempt cap', () => {
    // executionAttempt=1, max=3 → next attempt (→2) is still under 3 → retry.
    expect(decideExecutionRetry({ executionAttempt: 1, maxExecutionAttempts: 3 })).toEqual({
      action: 'retry',
    });
  });

  it('scraps when the next execution attempt would reach the cap', () => {
    // executionAttempt=2, max=3 → next attempt (→3) reaches cap → scrap.
    expect(decideExecutionRetry({ executionAttempt: 2, maxExecutionAttempts: 3 })).toEqual({
      action: 'scrap',
      reason: 'execution_attempt_cap',
    });
  });

  it('scraps when execution attempts are already exhausted', () => {
    expect(decideExecutionRetry({ executionAttempt: 3, maxExecutionAttempts: 3 })).toEqual({
      action: 'scrap',
      reason: 'execution_attempt_cap',
    });
  });

  it('is orthogonal to the rework counter: execution cap scraps even when rework is far under cap', () => {
    // Execution guard fires on its own counter...
    expect(decideExecutionRetry({ executionAttempt: 5, maxExecutionAttempts: 5 }).action).toBe('scrap');
    // ...while the rework guard, given a low reworkCount, would still rework —
    // proving the two counters are enforced independently.
    expect(
      decideQcReject(qcInput({ reworkCount: 0, reworkCap: 5, previousFindingsHash: 'fh-0', verdict: verdict('fh-1') })).action,
    ).toBe('rework');
  });

  it('is orthogonal to the rework counter: rework cap scraps even when execution attempts are fresh', () => {
    expect(
      decideQcReject(qcInput({ reworkCount: 3, reworkCap: 3, previousFindingsHash: 'fh-0', verdict: verdict('fh-1') })).action,
    ).toBe('scrap');
    expect(decideExecutionRetry({ executionAttempt: 0, maxExecutionAttempts: 3 }).action).toBe('retry');
  });
});

// ===========================================================================
// GUARD 2 — counter AUTHORITY: the predicate predicts the FSM exactly and
// owns NO durable counter, so there is no double-count (finding #6).
// ===========================================================================

describe('Guard 2 — predicate predicts the FSM, never double-counts (finding #6)', () => {
  const ctx: TransitionContext = {
    happyPathNext: { draft: 'review', review: null },
    terminalLanes: ['done', 'scrap', 'hold'],
    reworkCap: 2,
    maxExecutionAttempts: 4,
    capPolicy: 'scrap',
    onDepScrap: 'hold',
    validBackEdges: [],
  };

  it('the predicate is PURE — it returns a decision and mutates no input', () => {
    const input = { executionAttempt: 1, maxExecutionAttempts: 4 };
    const snapshot = { ...input };
    decideExecutionRetry(input);
    expect(input).toEqual(snapshot); // no counter incremented here
  });

  it('predicate and FSM agree on retry-vs-scrap at every boundary (no double-count)', () => {
    for (let executionAttempt = 0; executionAttempt < ctx.maxExecutionAttempts + 1; executionAttempt++) {
      const predicted = decideExecutionRetry({
        executionAttempt,
        maxExecutionAttempts: ctx.maxExecutionAttempts,
      });

      const fsm = transition(
        {
          lane: 'draft',
          status: 'done_pending_ack',
          executionAttempt,
          reworkCount: 0,
        },
        { type: 'INTEGRITY_FAIL' },
        ctx,
      );
      expect(fsm.ok).toBe(true);
      if (!fsm.ok) throw new Error('unreachable');

      if (predicted.action === 'scrap') {
        // The FSM is the SOLE authority: it scraps...
        expect(fsm.next.status).toBe('scrapped');
        expect(fsm.next.lane).toBe('scrap');
      } else {
        // ...or it performs the ONE durable increment and returns to working.
        expect(fsm.next.status).toBe('working');
        expect(fsm.next.executionAttempt).toBe(executionAttempt + 1); // exactly +1, never +2
      }
    }
  });
});

// ===========================================================================
// GUARD 3 — progress monotonicity on findings hash, NOT artifact (AC3, AC4)
// ===========================================================================

describe('Guard 3 — progress monotonicity on findings hash (AC3, AC4)', () => {
  it('exhausts the cap immediately when two consecutive findings hashes are identical (AC3)', () => {
    // reworkCap is high (4) and reworkCount low (1) — but identical findings
    // hashes mean no progress, so it must scrap NOW, not rework.
    const decision = decideQcReject(
      qcInput({ reworkCount: 1, reworkCap: 4, previousFindingsHash: 'fh-same', verdict: verdict('fh-same'), capPolicy: 'scrap' }),
    );
    expect(decision).toEqual({ action: 'scrap', reason: 'no_progress' });
  });

  it('forwards with findings on no-progress when cap_policy=proceed_with_findings', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 1, reworkCap: 4, previousFindingsHash: 'fh-same', verdict: verdict('fh-same'), capPolicy: 'proceed_with_findings' }),
    );
    expect(decision).toEqual({ action: 'proceed_with_findings', reason: 'no_progress' });
  });

  it('treats artifact churn with an unchanged findings hash as NO progress (AC4)', () => {
    // The artifact payload differs between the two attempts, but the findings
    // hash is identical — the engine keys on findings_hash, never the artifact.
    const previous = verdict('fh-stable', { payload: { artifact: 'v1-cosmetic' } });
    const current = verdict('fh-stable', { payload: { artifact: 'v2-cosmetic-different' } });
    expect(current.payload).not.toEqual(previous.payload); // artifact genuinely changed
    const decision = decideQcReject(
      qcInput({ reworkCount: 1, reworkCap: 4, previousFindingsHash: previous.findings_hash, verdict: current, capPolicy: 'scrap' }),
    );
    expect(decision).toEqual({ action: 'scrap', reason: 'no_progress' });
  });

  it('treats a changed findings hash as real progress and reworks (under cap)', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 1, reworkCap: 4, previousFindingsHash: 'fh-old', verdict: verdict('fh-new', { returnTo: 'draft' }), capPolicy: 'scrap' }),
    );
    expect(decision).toEqual({ action: 'rework', returnTo: 'draft' });
  });

  it('does not flag the first rejection (no prior hash) as no-progress', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 0, reworkCap: 4, previousFindingsHash: null, verdict: verdict('fh-1', { returnTo: 'draft' }) }),
    );
    expect(decision).toEqual({ action: 'rework', returnTo: 'draft' });
  });
});

// ===========================================================================
// Finding #17 — a malformed reject verdict (return_to=null) must ESCALATE,
// never emit a structurally-invalid null-lane rework decision.
// ===========================================================================

describe('malformed verdict — null return_to (finding #17)', () => {
  it('scraps with reason=malformed_verdict instead of a null-lane rework', () => {
    // Under cap, with real progress — the ONLY thing wrong is the null back-edge.
    const malformed: StationOutput<unknown> = {
      payload: { artifact: 'x' },
      findings_hash: 'fh-new',
      return_to: null, // a reject verdict with no route — malformed
      usage: { tokens: 1, cost: 0 },
    };
    const decision = decideQcReject(
      qcInput({ reworkCount: 0, reworkCap: 4, previousFindingsHash: 'fh-old', verdict: malformed }),
    );
    // Escalate / fail closed — never { action: 'rework', returnTo: null }.
    expect(decision).toEqual({ action: 'scrap', reason: 'malformed_verdict' });
  });
});

// ===========================================================================
// GUARD 4 — budgets at card / wave (parent_id) / run scope (AC5, AC6)
// ===========================================================================

describe('Guard 4 — per-wave (parent_id) budget (AC5)', () => {
  it('partitions token/dispatch consumption by parent_id', () => {
    const usages = [
      { cardId: 'c1', parentId: 'epicA', tokens: 100, dispatches: 2 },
      { cardId: 'c2', parentId: 'epicA', tokens: 150, dispatches: 3 },
      { cardId: 'c3', parentId: 'epicB', tokens: 40, dispatches: 1 },
    ];
    const byWave = aggregateByWave(usages);
    expect(byWave.get('epicA')).toEqual({ tokens: 250, dispatches: 5 });
    expect(byWave.get('epicB')).toEqual({ tokens: 40, dispatches: 1 });
  });

  it('proceeds when a subtree is under its budget', () => {
    expect(
      checkWaveBudget('epicA', { tokens: 100, dispatches: 2 }, { maxTokens: 400, maxDispatches: 100 }),
    ).toEqual({ action: 'proceed' });
  });

  it.each([
    ['tokens', { tokens: 500, dispatches: 2 }],
    ['dispatches', { tokens: 100, dispatches: 200 }],
  ])('scraps the offending subtree when it exceeds its %s budget', (_label, usage) => {
    expect(
      checkWaveBudget('epicA', usage, { maxTokens: 400, maxDispatches: 100 }),
    ).toEqual({ action: 'scrap_subtree', reason: 'wave_budget', parentId: 'epicA' });
  });

  it('scraps only the offending subtree, leaving sibling subtrees to proceed', () => {
    const caps = { maxTokens: 400, maxDispatches: 100 };
    const byWave = aggregateByWave([
      { cardId: 'a1', parentId: 'epicA', tokens: 500, dispatches: 2 }, // over
      { cardId: 'b1', parentId: 'epicB', tokens: 50, dispatches: 1 }, // under
    ]);
    expect(checkWaveBudget('epicA', byWave.get('epicA')!, caps).action).toBe('scrap_subtree');
    expect(checkWaveBudget('epicB', byWave.get('epicB')!, caps).action).toBe('proceed');
  });
});

describe('Guard 4 — run-scope budget (AC6)', () => {
  it('proceeds while under the run budget', () => {
    expect(
      checkRunBudget({ tokens: 1_000, dispatches: 10 }, { maxTokens: 2_000_000, maxDispatches: 10_000 }),
    ).toEqual({ action: 'proceed' });
  });

  it('blocks new claims when the run budget is exhausted (in-flight work drains)', () => {
    const decision = checkRunBudget(
      { tokens: 2_500_000, dispatches: 10 },
      { maxTokens: 2_000_000, maxDispatches: 10_000 },
    );
    // It gates CLAIMS only — it never scraps a card, so in-flight work is free to drain.
    expect(decision).toEqual({ action: 'block_claims', reason: 'run_budget' });
  });
});

// ===========================================================================
// FSM integration (WI-293) — the engine's guard-1 decisions are realizable by
// the FSM's reject/scrap transitions.
// ===========================================================================

describe('FSM consistency — engine decisions map onto WI-293 transitions', () => {
  const ctx: TransitionContext = {
    happyPathNext: { review: 'probing', probing: null, draft: 'review' },
    terminalLanes: ['done', 'scrap', 'hold'],
    reworkCap: 2,
    maxExecutionAttempts: 5,
    capPolicy: 'scrap',
    onDepScrap: 'hold',
    validBackEdges: [{ from: 'review', to: 'draft' }],
  };

  const atReview: FsmState = {
    lane: 'review',
    status: 'done_pending_ack',
    executionAttempt: 0,
    reworkCount: 0,
  };

  it('a "rework" decision corresponds to the FSM routing to the back-edge and incrementing reworkCount', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 0, reworkCap: 2, previousFindingsHash: 'fh-0', verdict: verdict('fh-1', { returnTo: 'draft' }) }),
    );
    expect(decision).toEqual({ action: 'rework', returnTo: 'draft' });

    const result = transition(atReview, { type: 'QC_REJECT', returnTo: 'draft' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected legal transition');
    expect(result.next.lane).toBe('draft');
    expect(result.next.reworkCount).toBe(1);
  });

  it('a "scrap" decision at the cap corresponds to the FSM routing to scrap', () => {
    const decision = decideQcReject(
      qcInput({ reworkCount: 2, reworkCap: 2, previousFindingsHash: 'fh-0', verdict: verdict('fh-1'), capPolicy: 'scrap' }),
    );
    expect(decision).toEqual({ action: 'scrap', reason: 'rework_cap' });

    const atCap: FsmState = { ...atReview, reworkCount: 2 };
    const result = transition(atCap, { type: 'QC_REJECT', returnTo: 'draft' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected legal transition');
    expect(result.next.lane).toBe('scrap');
    expect(result.next.status).toBe('scrapped');
  });
});
