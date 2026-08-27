/**
 * Deterministic tick planner (WI-295, SPEC §10).
 *
 * A PURE function of (DB state, TickContext) → ActionPlan. NO LLM, no I/O
 * side-effects, no random values. Called once per controller cycle; the
 * executor acts on the returned plan.
 *
 * Key invariants:
 *
 *   - A card is dispatchable iff status='ready' (deps→ready resolved upstream),
 *     the target station is under its WIP cap, and its slot is free.
 *   - WIP cap is enforced with projection: activeWorkerCount(station) from
 *     active_workers PLUS the number of dispatch actions already added for
 *     that station THIS tick must stay ≤ wipCaps[station].
 *   - Action IDs are generation-keyed AND station-scoped:
 *     `flow:card:dispatch:<station>:g<attempt>:worker:0` so that (a) a re-dispatch
 *     after a rework bounce (new generation) produces a distinct ID not
 *     suppressed by the old-generation ledger entry, and (b) including the
 *     station/lane prevents a cross-lane collision if `attempt` ever resets on a
 *     lane change.
 *   - Fail-closed (Principle 9): a contradictory state (card status='claimed'
 *     with no matching active_workers row) emits ZERO actions and a
 *     needsJudgment escalation — never a guess.
 */

import type { ConduitDB } from '../persistence/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single planned action for one card.
 *
 *   dispatch — schedule the card for execution at its station.
 *   reclaim  — release a stale slot whose worker never started (lease expired).
 */
export type TickAction =
  | { kind: 'dispatch'; id: string; cardId: string; station: string; generation: number }
  | { kind: 'reclaim'; id: string; cardId: string; station: string };

/** An escalation payload for contradictory or unresolvable state. */
export interface Escalation {
  cardId: string;
  reason: 'needsJudgment';
  detail: string;
}

/** The output of one tick: a bounded, deterministic action plan. */
export interface ActionPlan {
  actions: TickAction[];
  escalations: Escalation[];
  /**
   * How long the executor should sleep before the next tick.
   * Short (busyWakeSeconds) when work is flowing; long (idleWakeSeconds)
   * when there is nothing actionable.
   */
  nextWakeSeconds: number;
}

/** Immutable inputs the controller passes into every tick invocation. */
export interface TickContext {
  /** Flow identifier — used as the namespace prefix in action IDs. */
  flow: string;
  /**
   * Current epoch seconds (injected so tests are deterministic — never
   * read Date.now() inside the planner).
   */
  now: number;
  /**
   * Ledger of action IDs already dispatched to the executor.
   * Same-generation duplicates are suppressed; new-generation IDs are not.
   */
  issuedActionIds: ReadonlySet<string>;
  /** Per-station WIP cap. A station absent from this map gets cap=0 (fail-closed). */
  wipCaps: Record<string, number>;
  /** nextWakeSeconds when at least one action is produced. */
  busyWakeSeconds: number;
  /** nextWakeSeconds when the plan is empty. */
  idleWakeSeconds: number;
  /** Run identifier — all sweep queries are scoped to this run. Defaults to 'default'. */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Internal SQL row shapes
// ---------------------------------------------------------------------------

interface CardRow {
  id: string;
  lane: string;
  status: string;
  attempt: number;
  /** v10: not-before dispatch gate (epoch seconds). NULL = dispatchable now. */
  release_at: number | null;
}

interface WipCountRow {
  station: string;
  count: number;
}

interface LeaseRow {
  lease_until: number;
}

// ---------------------------------------------------------------------------
// planTick — the deterministic controller tick (SPEC §10)
// ---------------------------------------------------------------------------

/**
 * Compute the action plan for one tick.
 *
 * Reads cards and active_workers from the state DB, then:
 *   - 'ready' cards  → dispatch (subject to WIP cap + dedup ledger)
 *   - 'claimed' cards → reclaim (expired lease) | escalate (no worker row)
 *
 * The result is a pure function of DB state + ctx: no side-effects, no
 * mutations, no external calls. The executor is responsible for applying
 * each action.
 */
export function planTick(db: ConduitDB, ctx: TickContext): ActionPlan {
  const stateDb = db.getStateDb();
  const actions: TickAction[] = [];
  const escalations: Escalation[] = [];
  const runId = ctx.runId ?? 'default';

  // Per-station dispatch count added this tick, used for WIP projection.
  const wipProjection: Record<string, number> = {};

  // ── Current WIP: COUNT(*) per station from active_workers ────────────────
  // Includes claimed, working, and done_pending_ack slots — every row that
  // is currently reserving capacity. Do NOT use cards.status for this.
  const wipRows = stateDb
    .prepare('SELECT station, COUNT(*) AS count FROM active_workers WHERE run_id = $runId GROUP BY station')
    .all({ $runId: runId }) as WipCountRow[];

  const currentWip: Record<string, number> = {};
  for (const row of wipRows) {
    currentWip[row.station] = row.count;
  }

  // ── Actionable cards: status in {ready, claimed}, ordered for determinism ─
  const cards = stateDb
    .prepare(
      `SELECT id, lane, status, attempt, release_at
       FROM cards
       WHERE run_id = $runId AND status IN ('ready', 'claimed')
       ORDER BY id ASC`,
    )
    .all({ $runId: runId }) as CardRow[];

  // Earliest future release_at among gated-but-otherwise-ready cards, so the
  // executor can wake exactly when the fan-out stagger elapses (see below).
  let earliestGatedRelease: number | null = null;

  for (const card of cards) {
    const station = card.lane;

    if (card.status === 'ready') {
      // ── Dispatch gate (v10 fan-out stagger) ─────────────────────────────
      // A card with release_at in the future is not yet dispatchable — the
      // fan-out stagger holds siblings until the first child has warmed the
      // shared prompt-prefix cache. Compared against the INJECTED now (never
      // Date.now()), so this is deterministic and crash/resume-safe: the gate
      // is DB state (cards.release_at) re-derived on resume, exactly like
      // active_workers.lease_until below.
      if (card.release_at !== null && card.release_at > ctx.now) {
        if (earliestGatedRelease === null || card.release_at < earliestGatedRelease) {
          earliestGatedRelease = card.release_at;
        }
        continue;
      }

      // ── Dispatch candidate ──────────────────────────────────────────────
      const wipCap = ctx.wipCaps[station] ?? 0; // absent station → cap=0 (fail-closed)
      const activeWip = currentWip[station] ?? 0;
      const projectedWip = activeWip + (wipProjection[station] ?? 0);

      // WIP cap check: both existing slots AND dispatches added this tick.
      if (projectedWip >= wipCap) continue;

      // Generation-keyed action ID — STABLE for a given (flow, card, station,
      // attempt) so the dedup ledger works; a new attempt produces a distinct
      // ID. The station/lane component is included so dedup keys on
      // (flow, card, station, generation): if `attempt` ever resets on a lane
      // change, two different lanes can no longer collide on the same ID and
      // suppress a legitimate dispatch.
      const actionId = `${ctx.flow}:${card.id}:dispatch:${station}:g${card.attempt}:worker:0`;

      // Idempotency: suppress if this exact generation was already issued.
      if (ctx.issuedActionIds.has(actionId)) continue;

      actions.push({
        kind: 'dispatch',
        id: actionId,
        cardId: card.id,
        station,
        generation: card.attempt,
      });

      // Project WIP forward so subsequent candidates in this tick see the
      // updated count and respect the cap.
      wipProjection[station] = (wipProjection[station] ?? 0) + 1;
    } else if (card.status === 'claimed') {
      // ── Claimed slot: reclaim or escalate ──────────────────────────────
      const workerRow = stateDb
        .prepare(
          'SELECT lease_until FROM active_workers WHERE card_id = $card_id AND station = $station',
        )
        .get({ $card_id: card.id, $station: station }) as LeaseRow | undefined;

      if (!workerRow) {
        // Contradictory state: claimed status with no active_workers entry.
        // Fail-closed (Principle 9): emit ZERO actions and escalate to hold.
        escalations.push({
          cardId: card.id,
          reason: 'needsJudgment',
          detail:
            `Card '${card.id}' has status='claimed' but no matching active_workers row — ` +
            `contradictory state, manual intervention required`,
        });
      } else if (workerRow.lease_until <= ctx.now) {
        // Lease expired: worker never started (or died before the first heartbeat).
        // Emit a reclaim so the executor can free the slot and re-dispatch.
        const reclaimId = `${ctx.flow}:${card.id}:reclaim:${station}:g${card.attempt}:0`;
        if (!ctx.issuedActionIds.has(reclaimId)) {
          actions.push({ kind: 'reclaim', id: reclaimId, cardId: card.id, station });
        }
      }
      // else: lease_until > now → worker is alive and executing, nothing to do.
    }
    // All other statuses (waiting, working, done_pending_ack, interrupted,
    // held, awaiting_children, complete, scrapped) → skip, no action needed.
  }

  // Base wake: busy when we produced work, idle otherwise. But if a card is
  // gated on a future release_at, wake no later than that instant so the staggered
  // siblings dispatch promptly instead of sleeping out the full idle interval.
  // NOTE: runExecutor drives planTick with busy/idleWakeSeconds=0 and derives its
  // own release-gate wait from a MIN(release_at) query, so it does NOT consume this
  // value today; the gate-bounding here is the correct planner contract for any
  // caller that passes real wake cadences.
  let nextWakeSeconds = actions.length > 0 ? ctx.busyWakeSeconds : ctx.idleWakeSeconds;
  if (earliestGatedRelease !== null) {
    const untilRelease = Math.max(1, earliestGatedRelease - ctx.now);
    nextWakeSeconds = Math.min(nextWakeSeconds, untilRelease);
  }

  return {
    actions,
    escalations,
    nextWakeSeconds,
  };
}
