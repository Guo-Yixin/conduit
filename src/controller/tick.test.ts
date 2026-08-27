/**
 * Tests for the deterministic tick planner (WI-295, SPEC §10) — the runaway-killer.
 *
 * A PURE planner: each tick reads board + pool state from SQLite and emits a
 * bounded ACTION PLAN. NO LLM anywhere; the plan is a deterministic function of
 * DB state + context. Generation-keyed action IDs make a re-dispatch after a
 * legitimate rework bounce (new generation) distinct from a duplicate of the
 * same generation (suppressed). On unreadable/contradictory state the planner is
 * fail-closed: zero actions + a needsJudgment escalation (Principle 9).
 *
 * Contract this file pins for src/controller/tick.ts:
 *
 *   type TickAction =
 *     | { kind: 'dispatch'; id: string; cardId: string; station: string; generation: number }
 *     | { kind: 'reclaim';  id: string; cardId: string; station: string }
 *   interface Escalation { cardId: string; reason: 'needsJudgment'; detail: string }
 *   interface ActionPlan { actions: TickAction[]; escalations: Escalation[]; nextWakeSeconds: number }
 *   interface TickContext {
 *     flow: string;
 *     now: number;                            // epoch seconds (deterministic)
 *     issuedActionIds: ReadonlySet<string>;   // dedup ledger of already-issued actions
 *     wipCaps: Record<string, number>;        // station → WIP cap
 *     busyWakeSeconds: number;                // cadence when work is flowing
 *     idleWakeSeconds: number;                // cadence when idle
 *   }
 *   function planTick(db: ConduitDB, ctx: TickContext): ActionPlan
 *
 * Dispatch action id format (SPEC §10): `flow:card:dispatch:g<attempt>:worker:seq`
 * (generation-keyed; STABLE for a given (flow, card, generation) so dedup works).
 * A card is dispatchable iff status='ready' (deps→ready is resolved upstream),
 * the station is under its WIP cap (counted from active_workers), and the slot is free.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DEFAULT_RUN_ID } from '../persistence/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { attemptClaim } from '../dispatch/claim';
import { planTick, type ActionPlan, type TickAction, type TickContext } from './tick';

type DispatchAction = Extract<TickAction, { kind: 'dispatch' }>;

const NOW = 1_000_000;
const LEASE = 30;

let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-tick-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
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

function mkCtx(overrides: Partial<TickContext> = {}): TickContext {
  return {
    flow: 'F',
    now: NOW,
    issuedActionIds: new Set<string>(),
    wipCaps: { work: 5 },
    busyWakeSeconds: 1,
    idleWakeSeconds: 60,
    ...overrides,
  };
}

function dispatches(plan: ActionPlan): DispatchAction[] {
  return plan.actions.filter((a): a is DispatchAction => a.kind === 'dispatch');
}
function reclaims(plan: ActionPlan): TickAction[] {
  return plan.actions.filter((a) => a.kind === 'reclaim');
}

// ---------------------------------------------------------------------------
// AC1 — ready + deps met + free slot + WIP room → exactly one dispatch.
// ---------------------------------------------------------------------------

describe('dispatch planning (AC1)', () => {
  it('emits exactly one dispatch for a single ready card', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));

    const plan = planTick(db!, mkCtx());
    const d = dispatches(plan);

    expect(d).toHaveLength(1);
    expect(d[0]!.cardId).toBe('c1');
    expect(d[0]!.station).toBe('work');
    expect(d[0]!.generation).toBe(0);
    expect(d[0]!.id).toMatch(/^F:c1:dispatch:work:g0:/); // station-scoped + generation-keyed
  });

  it('does NOT dispatch a card whose deps are unmet (status=waiting)', () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'waiting' }));
    expect(dispatches(planTick(db!, mkCtx()))).toHaveLength(0);
  });

  it('respects the WIP cap across multiple ready candidates', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    db!.insertCard(makeCard({ id: 'c2', lane: 'work' }));
    db!.insertCard(makeCard({ id: 'c3', lane: 'work' }));

    // wipCap=1, zero active → only ONE may be dispatched this tick.
    const plan = planTick(db!, mkCtx({ wipCaps: { work: 1 } }));
    expect(dispatches(plan)).toHaveLength(1);
  });

  it('does not dispatch when the station is already at its WIP cap', () => {
    db!.insertCard(makeCard({ id: 'busy', lane: 'work' }));
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    // Fill the only slot with a real claim.
    attemptClaim(db!, { cardId: 'busy', station: 'work', workerId: 'w0', wipCap: 1, now: NOW, leaseSeconds: LEASE });

    const plan = planTick(db!, mkCtx({ wipCaps: { work: 1 } }));
    expect(dispatches(plan).find((d) => d.cardId === 'c1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — determinism + same-generation duplicate suppression.
// ---------------------------------------------------------------------------

describe('determinism and idempotency (AC2)', () => {
  it('produces an identical plan when re-run on identical state', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    const ctx = mkCtx();
    expect(planTick(db!, ctx)).toEqual(planTick(db!, ctx));
  });

  it('suppresses a dispatch whose generation-keyed id was already issued', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    const first = planTick(db!, mkCtx());
    const issuedId = dispatches(first)[0]!.id;

    // Same DB state, but the action id is now in the issued ledger → suppressed.
    const second = planTick(db!, mkCtx({ issuedActionIds: new Set([issuedId]) }));
    expect(dispatches(second).find((d) => d.cardId === 'c1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — a new generation is NOT suppressed by the prior generation's id.
// ---------------------------------------------------------------------------

describe('generation-keyed re-dispatch after rework (AC3)', () => {
  it('emits a new-generation dispatch even when the old-gen id is already issued', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work', attempt: 0 }));
    const g0Id = dispatches(planTick(db!, mkCtx()))[0]!.id;

    // Rework bounce: the card advances to a new generation (attempt++).
    db!.getStateDb().prepare('UPDATE cards SET attempt = 1 WHERE id = $id').run({ $id: 'c1' });

    // The OLD-gen id is in the ledger, but the new generation must still dispatch.
    const plan = planTick(db!, mkCtx({ issuedActionIds: new Set([g0Id]) }));
    const d = dispatches(plan).find((a) => a.cardId === 'c1');

    expect(d).toBeDefined();
    expect(d!.generation).toBe(1);
    expect(d!.id).not.toBe(g0Id); // distinct generation-keyed id
    expect(d!.id).toMatch(/:dispatch:work:g1:/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — stale claimed slot (worker never started) → reclaim.
// ---------------------------------------------------------------------------

describe('reclaim compensation (AC4)', () => {
  beforeEach(() => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    // Claim the slot but never beginWork → card stays 'claimed' (unstarted).
    attemptClaim(db!, { cardId: 'c1', station: 'work', workerId: 'w1', wipCap: 5, now: NOW, leaseSeconds: LEASE });
  });

  it('emits a reclaim when a claimed slot is past the reclaim threshold (lease expired)', () => {
    const plan = planTick(db!, mkCtx({ now: NOW + LEASE + 1 })); // past lease_until
    const r = reclaims(plan);
    expect(r.find((a) => a.cardId === 'c1')).toBeDefined();
  });

  it('does NOT reclaim a freshly-claimed slot whose lease is still valid', () => {
    const plan = planTick(db!, mkCtx({ now: NOW + 1 })); // well within lease
    expect(reclaims(plan).find((a) => a.cardId === 'c1')).toBeUndefined();
    // It is claimed (not ready), so it must not be dispatched either.
    expect(dispatches(plan).find((a) => a.cardId === 'c1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC5 — contradictory state → zero actions + needsJudgment (fail-closed).
// ---------------------------------------------------------------------------

describe('fail-closed on contradictory state (AC5)', () => {
  it('emits zero actions and a needsJudgment escalation for a claimed card with no active_workers row', () => {
    // Claimed status but NO matching active_workers row — an impossible state.
    db!.insertCard(makeCard({ id: 'c1', status: 'claimed', lane: 'work' }));

    const plan = planTick(db!, mkCtx());

    // Never guess: no dispatch, no reclaim.
    expect(plan.actions).toHaveLength(0);
    // Escalate to a human instead.
    const esc = plan.escalations.find((e) => e.cardId === 'c1');
    expect(esc).toBeDefined();
    expect(esc!.reason).toBe('needsJudgment');
    expect(esc!.detail.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC6 — adaptive cadence: short wake when flowing, long wake when idle.
// ---------------------------------------------------------------------------

describe('adaptive cadence (AC6)', () => {
  it('returns the short (busy) interval when work is flowing', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    const plan = planTick(db!, mkCtx({ busyWakeSeconds: 2, idleWakeSeconds: 90 }));
    expect(plan.actions.length).toBeGreaterThan(0); // flowing
    expect(plan.nextWakeSeconds).toBe(2);
  });

  it('returns the long (idle) interval when there is nothing to do', () => {
    // No cards at all → nothing actionable.
    const plan = planTick(db!, mkCtx({ busyWakeSeconds: 2, idleWakeSeconds: 90 }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.nextWakeSeconds).toBe(90);
  });
});

// ── v10: fan-out cache-warming stagger (release_at dispatch gate) ────────────
describe('planTick — release_at dispatch gate (fan-out stagger)', () => {
  /** Set a card's not-before gate directly (the executor stamps this at fan-out). */
  function setReleaseAt(id: string, releaseAt: number | null): void {
    db!.getStateDb()
      .prepare('UPDATE cards SET release_at = $r WHERE run_id = $run AND id = $id')
      .run({ $r: releaseAt, $run: DEFAULT_RUN_ID, $id: id });
  }

  it('holds a ready card whose release_at is in the future (no dispatch)', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    setReleaseAt('c1', NOW + 10);
    const plan = planTick(db!, mkCtx());
    expect(dispatches(plan)).toHaveLength(0);
  });

  it('dispatches a gated card once now has reached release_at', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    setReleaseAt('c1', NOW); // release_at == now → the gate (> now) is not tripped
    const plan = planTick(db!, mkCtx());
    expect(dispatches(plan).map((a) => a.cardId)).toEqual(['c1']);
  });

  it('a past release_at dispatches normally', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    setReleaseAt('c1', NOW - 5);
    expect(dispatches(planTick(db!, mkCtx())).map((a) => a.cardId)).toEqual(['c1']);
  });

  it('null release_at (the default / un-staggered case) dispatches normally', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' })); // insertCard leaves release_at NULL
    expect(dispatches(planTick(db!, mkCtx())).map((a) => a.cardId)).toEqual(['c1']);
  });

  it('models the stagger: the first sibling fires while gated siblings wait', () => {
    // The executor leaves the lowest-id child un-gated and stamps the rest.
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' })); // first child — release_at NULL
    db!.insertCard(makeCard({ id: 'c2', lane: 'work' }));
    db!.insertCard(makeCard({ id: 'c3', lane: 'work' }));
    setReleaseAt('c2', NOW + 10);
    setReleaseAt('c3', NOW + 10);
    const plan = planTick(db!, mkCtx());
    expect(dispatches(plan).map((a) => a.cardId)).toEqual(['c1']);
    // ...and the loop is told to wake by the time the gate elapses, not sit idle.
    expect(plan.nextWakeSeconds).toBeLessThanOrEqual(10);
  });

  it('wakes at the EARLIEST future gate when only gated cards remain', () => {
    db!.insertCard(makeCard({ id: 'c1', lane: 'work' }));
    db!.insertCard(makeCard({ id: 'c2', lane: 'work' }));
    setReleaseAt('c1', NOW + 30);
    setReleaseAt('c2', NOW + 5);
    const plan = planTick(db!, mkCtx({ idleWakeSeconds: 60 }));
    expect(dispatches(plan)).toHaveLength(0);
    expect(plan.nextWakeSeconds).toBe(5); // min(idle=60, earliest gate 5)
  });
});
