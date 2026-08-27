/**
 * Thin shared helper for the mandatory Law-lite Hook test suite (WI-305,
 * SPEC §14, NFR-3).
 *
 * Exports two utilities consumed by src/law/contract.test.ts:
 *
 *   flowToTransitionContext — derive the kernel's TransitionContext from a
 *     loaded FlowConfig so the config-contract test can run the same
 *     transition() calls that the real controller would execute.
 *
 *   checkFlowKernelContract — cross-check the validator's lane graph against
 *     the kernel's transition understanding. Fails (agrees=false) when:
 *       (a) a back-edge target is a lane the kernel cannot advance a card out
 *           of (neither a work station nor a terminal), OR
 *       (b) the kernel's transition() returns illegal or routes to a different
 *           lane than the declared on_reject target.
 *     Also verifies that every work station's INTEGRITY_PASS advance is legal.
 *
 * This module never executes side-effects — it is pure config analysis.
 */

import type { FlowConfig } from '../types/kernel';
import { transition } from '../statemachine/transitions';
import type { TransitionContext, FsmState } from '../statemachine/transitions';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single disagreement between the flow validator and the kernel FSM. */
export interface ContractDisagreement {
  /** Stable machine-readable identifier for the disagreement class. */
  code: string;
  /** Human-readable description naming the offending lane or station. */
  detail: string;
}

/** The result of the config-contract cross-check. */
export interface ContractResult {
  /** True when the validator and the kernel agree on every transition. */
  agrees: boolean;
  /** Empty when agrees=true; non-empty when there are disagreements. */
  disagreements: ContractDisagreement[];
}

// ---------------------------------------------------------------------------
// flowToTransitionContext
// ---------------------------------------------------------------------------

/**
 * Derive the kernel's TransitionContext from a loaded FlowConfig.
 *
 * When `flow.happyPathNext` is populated by the loader (WI-351), it is used
 * directly — the routing topology comes from each station's declared `next`
 * field, NEVER from station insertion order (FR-2).
 *
 * When `flow.happyPathNext` is absent (pre-WI-351 flows without `next`
 * declarations, e.g. the reference fixture), falls back to building
 * happyPathNext from Object.keys(flow.stations) order for backward
 * compatibility with existing contract tests.
 *
 * reworkCap is set to a probe value (999) so QC_REJECT always routes
 * (never triggers the cap policy) during contract verification.
 */
export function flowToTransitionContext(flow: FlowConfig): TransitionContext {
  const happyPathNext: Record<string, string | null> = {};

  if (flow.happyPathNext !== undefined) {
    // WI-351: use the loader-built surface derived from declared `next` fields.
    for (const [id, next] of Object.entries(flow.happyPathNext)) {
      happyPathNext[id] = next;
    }
  } else {
    // Backward-compatible fallback for pre-WI-351 flows with no `next` declarations.
    const stationIds = Object.keys(flow.stations);
    for (let i = 0; i < stationIds.length; i++) {
      const id = stationIds[i]!;
      happyPathNext[id] = i + 1 < stationIds.length ? stationIds[i + 1]! : null;
    }
  }

  return {
    happyPathNext,
    validBackEdges: flow.back_edges ?? [],
    terminalLanes: flow.terminal_lanes ?? ['done', 'scrap', 'hold'],
    reworkCap: 999,
    maxExecutionAttempts: 999,
    capPolicy: 'scrap',
    onDepScrap: 'hold',
  };
}

// ---------------------------------------------------------------------------
// checkFlowKernelContract
// ---------------------------------------------------------------------------

/**
 * Cross-check every lane reference in the loaded FlowConfig against the
 * kernel's transition() function.
 *
 * For each back-edge {from, to}:
 *   1. Flag `to` as unknown when it is neither a work station (key in
 *      happyPathNext) nor a terminal lane — the validator approved a route
 *      the kernel could never advance a card out of.
 *   2. Run transition(done_pending_ack@from, QC_REJECT(to)) and verify the
 *      kernel lands on `to`.
 *
 * For each work station:
 *   3. Run transition(done_pending_ack@station, INTEGRITY_PASS) and verify
 *      it is legal.
 *
 * Returns {agrees:true, disagreements:[]} when everything matches.
 */
export function checkFlowKernelContract(flow: FlowConfig): ContractResult {
  const ctx = flowToTransitionContext(flow);
  const terminalLanesSet = new Set<string>(ctx.terminalLanes);
  const disagreements: ContractDisagreement[] = [];

  // ── Check each declared back-edge ────────────────────────────────────────
  for (const edge of flow.back_edges ?? []) {
    const { from, to } = edge;

    // Check (source): is `from` a known work station?
    // A back-edge whose source is not in happyPathNext is a phantom lane that
    // the kernel has never heard of — the validator approved an untransitionable route.
    if (!(from in ctx.happyPathNext)) {
      disagreements.push({
        code: 'back_edge_unknown_source',
        detail:
          `back-edge source '${from}' is unknown to the kernel — ` +
          `it is not a station in the flow`,
      });
    }

    // Check (a): is `to` a lane the kernel can ever make progress from?
    // A lane must be either a registered work station or an explicit terminal.
    if (!(to in ctx.happyPathNext) && !terminalLanesSet.has(to)) {
      disagreements.push({
        code: 'back_edge_unknown_target',
        detail:
          `back-edge target '${to}' is unknown to the kernel — ` +
          `it is neither a station in the flow nor a terminal lane`,
      });
    }

    // Check (b): the kernel must be able to QC_REJECT from `from` → `to`.
    const state: FsmState = {
      lane: from,
      status: 'done_pending_ack',
      executionAttempt: 0,
      reworkCount: 0,
    };
    const result = transition(state, { type: 'QC_REJECT', returnTo: to }, ctx);
    if (!result.ok) {
      disagreements.push({
        code: 'back_edge_illegal_transition',
        detail:
          `back-edge from '${from}' to '${to}': kernel reports QC_REJECT as illegal`,
      });
    } else if (result.next.lane !== to) {
      disagreements.push({
        code: 'back_edge_lane_mismatch',
        detail:
          `back-edge from '${from}' to '${to}': kernel routed to '${result.next.lane}' instead`,
      });
    }
  }

  // ── Check each work station's INTEGRITY_PASS advance ─────────────────────
  for (const stationId of Object.keys(ctx.happyPathNext)) {
    const state: FsmState = {
      lane: stationId,
      status: 'done_pending_ack',
      executionAttempt: 0,
      reworkCount: 0,
    };
    const result = transition(state, { type: 'INTEGRITY_PASS' }, ctx);
    if (!result.ok) {
      disagreements.push({
        code: 'integrity_pass_illegal_transition',
        detail:
          `station '${stationId}': INTEGRITY_PASS is an illegal transition for the kernel`,
      });
    }
  }

  return {
    agrees: disagreements.length === 0,
    disagreements,
  };
}
