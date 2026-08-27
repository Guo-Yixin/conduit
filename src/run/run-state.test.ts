/**
 * Tests for getRunState (WI-480).
 *
 * getRunState(db, runId) is a read-only query that returns a run's current
 * state derived from its cards and run registry record:
 *
 *   { status: 'not_found' }
 *   { status: 'running' }
 *   { status: 'held', heldCards: Array<{ cardId: string; reason: string }> }
 *   { status: 'terminal', outcome: string }
 *
 * AC-1: run with at least one non-terminal, non-held card → 'running'
 * AC-2: run with a held card → 'held' + heldCards with reason from card_log
 * AC-3: run whose every card is terminal → 'terminal' with run registry outcome
 * AC-4: unknown run id → 'not_found' (not throw, not false 'terminal')
 * AC-5: cross-run isolation — run B's cards never affect run A's reported state
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import { getRunState, type RunStateResult } from './run-state';
import type { Card } from '../types/kernel';

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(runId: string, id: string, overrides: Partial<Card> = {}): Card {
  return {
    run_id: runId,
    id,
    parent_id: null,
    lane: 'brief',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
    ...overrides,
  };
}

function seedRun(runId: string, outcome?: string): void {
  db.insertRun({
    run_id: runId,
    flow: 'studio',
    input_fingerprint: `fp-${runId}`,
    status: outcome ? 'done' : 'running',
    outcome,
  });
}

function holdCard(card: Card, reason: string): void {
  // Write card in held status
  const stateDb = db.getStateDb();
  stateDb
    .prepare("UPDATE cards SET status = 'held' WHERE run_id = $r AND id = $id")
    .run({ $r: card.run_id, $id: card.id });

  // Append the two card_log entries the executor writes on hold:
  // 1. entered_lane with reasonClass='hold'
  db.appendCardLog({
    runId: card.run_id,
    cardId: card.id,
    station: card.lane,
    attempt: card.attempt,
    kind: 'entered_lane',
    sourceLane: card.lane,
    destLane: card.lane,
    reasonClass: 'hold',
  });
  // 2. terminal entry carrying the hold reason string
  db.appendCardLog({
    runId: card.run_id,
    cardId: card.id,
    station: card.lane,
    attempt: card.attempt,
    kind: 'terminal',
    reason,
  });
}

function terminalCard(card: Card, lane: 'done' | 'scrap'): void {
  const stateDb = db.getStateDb();
  stateDb
    .prepare("UPDATE cards SET status = 'complete', lane = $lane WHERE run_id = $r AND id = $id")
    .run({ $r: card.run_id, $id: card.id, $lane: lane });
}

// ---------------------------------------------------------------------------
// AC-4: unknown run id → 'not_found'
// ---------------------------------------------------------------------------

describe('getRunState — unknown run id (AC-4)', () => {
  it('returns not_found for a run id that was never registered', () => {
    const result = getRunState(db, 'no-such-run');
    expect(result.status).toBe('not_found');
  });

  it('does not throw for an unknown run id', () => {
    expect(() => getRunState(db, 'phantom-run')).not.toThrow();
  });

  it('returns not_found even when other runs exist', () => {
    seedRun('run-real');
    db.insertCard(makeCard('run-real', 'c1'));
    const result = getRunState(db, 'run-ghost');
    expect(result.status).toBe('not_found');
  });

  it('not_found result does not include heldCards or outcome fields', () => {
    const result = getRunState(db, 'no-such-run') as Extract<RunStateResult, { status: 'not_found' }>;
    expect('heldCards' in result).toBe(false);
    expect('outcome' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-1: run with at least one non-terminal, non-held card → 'running'
// ---------------------------------------------------------------------------

describe('getRunState — running (AC-1)', () => {
  it('returns running when a card is in a non-terminal status', () => {
    seedRun('run-go');
    db.insertCard(makeCard('run-go', 'c1', { status: 'ready' }));
    expect(getRunState(db, 'run-go').status).toBe('running');
  });

  it('returns running for status=working', () => {
    seedRun('run-w');
    db.insertCard(makeCard('run-w', 'c1', { status: 'working' }));
    expect(getRunState(db, 'run-w').status).toBe('running');
  });

  it('returns running for status=claimed', () => {
    seedRun('run-claimed');
    db.insertCard(makeCard('run-claimed', 'c1', { status: 'claimed' }));
    expect(getRunState(db, 'run-claimed').status).toBe('running');
  });

  it('returns running for status=waiting', () => {
    seedRun('run-wait');
    db.insertCard(makeCard('run-wait', 'c1', { status: 'waiting' }));
    expect(getRunState(db, 'run-wait').status).toBe('running');
  });

  it('returns running for status=awaiting_children', () => {
    seedRun('run-fan');
    db.insertCard(makeCard('run-fan', 'c1', { status: 'awaiting_children' }));
    expect(getRunState(db, 'run-fan').status).toBe('running');
  });

  it('returns running when at least one card is active even if others are terminal', () => {
    seedRun('run-mixed');
    const c1 = makeCard('run-mixed', 'c1', { status: 'ready' });
    const c2 = makeCard('run-mixed', 'c2', { lane: 'done', status: 'complete' });
    db.insertCard(c1);
    db.insertCard(c2);
    terminalCard(c2, 'done');
    expect(getRunState(db, 'run-mixed').status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// AC-2: run with a held card → 'held' with reason from card_log
// ---------------------------------------------------------------------------

describe('getRunState — held (AC-2)', () => {
  it('returns held when a card has status=held', () => {
    seedRun('run-held');
    const card = makeCard('run-held', 'ch1', { status: 'ready', lane: 'build' });
    db.insertCard(card);
    holdCard(card, 'needs human review');
    expect(getRunState(db, 'run-held').status).toBe('held');
  });

  it('includes the held card id in heldCards', () => {
    seedRun('run-hc');
    const card = makeCard('run-hc', 'card-held', { status: 'ready', lane: 'brief' });
    db.insertCard(card);
    holdCard(card, 'integrity check failed');
    const result = getRunState(db, 'run-hc') as Extract<RunStateResult, { status: 'held' }>;
    expect(result.heldCards.some((h) => h.cardId === 'card-held')).toBe(true);
  });

  it('includes the hold reason from the card_log terminal entry', () => {
    seedRun('run-reason');
    const card = makeCard('run-reason', 'c-reason', { status: 'ready', lane: 'build' });
    db.insertCard(card);
    holdCard(card, 'owned path violation detected');
    const result = getRunState(db, 'run-reason') as Extract<RunStateResult, { status: 'held' }>;
    const entry = result.heldCards.find((h) => h.cardId === 'c-reason');
    expect(entry).not.toBeUndefined();
    expect(entry!.reason).toBe('owned path violation detected');
  });

  it('reports all held cards when multiple cards are held', () => {
    seedRun('run-multi-held');
    const c1 = makeCard('run-multi-held', 'h1', { status: 'ready', lane: 'brief' });
    const c2 = makeCard('run-multi-held', 'h2', { status: 'ready', lane: 'build' });
    db.insertCard(c1);
    db.insertCard(c2);
    holdCard(c1, 'reason A');
    holdCard(c2, 'reason B');

    const result = getRunState(db, 'run-multi-held') as Extract<RunStateResult, { status: 'held' }>;
    expect(result.heldCards).toHaveLength(2);
    const ids = result.heldCards.map((h) => h.cardId);
    expect(ids).toContain('h1');
    expect(ids).toContain('h2');
  });

  it('held takes precedence over running when some cards are active and one is held', () => {
    seedRun('run-held-mix');
    const active = makeCard('run-held-mix', 'active', { status: 'ready' });
    const held = makeCard('run-held-mix', 'stuck', { status: 'ready', lane: 'build' });
    db.insertCard(active);
    db.insertCard(held);
    holdCard(held, 'budget exceeded');

    const result = getRunState(db, 'run-held-mix');
    expect(result.status).toBe('held');
  });
});

// ---------------------------------------------------------------------------
// AC-3: run whose every card is terminal → 'terminal' with outcome
// ---------------------------------------------------------------------------

describe('getRunState — terminal (AC-3)', () => {
  it('returns terminal when all cards are in done lane', () => {
    seedRun('run-done', 'success');
    const c1 = makeCard('run-done', 'c1');
    db.insertCard(c1);
    terminalCard(c1, 'done');
    expect(getRunState(db, 'run-done').status).toBe('terminal');
  });

  it('returns terminal when all cards are in scrap lane', () => {
    seedRun('run-scrap', 'scrapped');
    const c1 = makeCard('run-scrap', 'c1');
    db.insertCard(c1);
    terminalCard(c1, 'scrap');
    expect(getRunState(db, 'run-scrap').status).toBe('terminal');
  });

  it('includes the run outcome in the terminal result', () => {
    seedRun('run-outcome', 'success');
    const c1 = makeCard('run-outcome', 'c1');
    db.insertCard(c1);
    terminalCard(c1, 'done');
    const result = getRunState(db, 'run-outcome') as Extract<RunStateResult, { status: 'terminal' }>;
    expect(result.outcome).toBe('success');
  });

  it('includes a scrapped outcome for a fully scrapped run', () => {
    seedRun('run-scrapped', 'scrapped');
    const c1 = makeCard('run-scrapped', 'c1');
    db.insertCard(c1);
    terminalCard(c1, 'scrap');
    const result = getRunState(db, 'run-scrapped') as Extract<RunStateResult, { status: 'terminal' }>;
    expect(result.outcome).toBe('scrapped');
  });

  it('returns terminal only when ALL cards are terminal (not just some)', () => {
    seedRun('run-not-done-yet', 'success');
    const done = makeCard('run-not-done-yet', 'c-done');
    const active = makeCard('run-not-done-yet', 'c-active', { status: 'working' });
    db.insertCard(done);
    db.insertCard(active);
    terminalCard(done, 'done');
    // active is still working — not terminal
    expect(getRunState(db, 'run-not-done-yet').status).toBe('running');
  });

  it('returns terminal when a run has no cards (registry exists, no cards seeded)', () => {
    seedRun('run-no-cards', 'success');
    const result = getRunState(db, 'run-no-cards');
    expect(result.status).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// AC-5: cross-run isolation — run B never affects run A's state
// ---------------------------------------------------------------------------

describe('getRunState — cross-run isolation (AC-5)', () => {
  it("run B's held card does not make run A appear held", () => {
    seedRun('run-A');
    seedRun('run-B');

    const aCard = makeCard('run-A', 'a1', { status: 'ready' });
    const bCard = makeCard('run-B', 'b1', { status: 'ready', lane: 'build' });
    db.insertCard(aCard);
    db.insertCard(bCard);
    holdCard(bCard, 'run B issue');

    expect(getRunState(db, 'run-A').status).toBe('running');
  });

  it("run B's active card does not make run A appear running when A is terminal", () => {
    seedRun('run-A2', 'success');
    seedRun('run-B2');

    const aCard = makeCard('run-A2', 'a1');
    const bCard = makeCard('run-B2', 'b1', { status: 'working' });
    db.insertCard(aCard);
    db.insertCard(bCard);
    terminalCard(aCard, 'done');

    expect(getRunState(db, 'run-A2').status).toBe('terminal');
  });

  it("run B's non-terminal cards do not appear in run A's heldCards list", () => {
    seedRun('run-A3');
    seedRun('run-B3');

    const aHeld = makeCard('run-A3', 'ah1', { status: 'ready', lane: 'brief' });
    const bHeld = makeCard('run-B3', 'bh1', { status: 'ready', lane: 'brief' });
    db.insertCard(aHeld);
    db.insertCard(bHeld);
    holdCard(aHeld, 'A hold reason');
    holdCard(bHeld, 'B hold reason');

    const result = getRunState(db, 'run-A3') as Extract<RunStateResult, { status: 'held' }>;
    expect(result.heldCards.every((h) => h.cardId === 'ah1')).toBe(true);
    expect(result.heldCards.some((h) => h.cardId === 'bh1')).toBe(false);
  });

  it('DEFAULT_RUN_ID state is independent of a custom run id', () => {
    seedRun(DEFAULT_RUN_ID, 'success');
    seedRun('run-custom');

    const defaultCard = makeCard(DEFAULT_RUN_ID, 'dc1');
    const customCard = makeCard('run-custom', 'cc1', { status: 'working' });
    db.insertCard(defaultCard);
    db.insertCard(customCard);
    terminalCard(defaultCard, 'done');

    expect(getRunState(db, DEFAULT_RUN_ID).status).toBe('terminal');
    expect(getRunState(db, 'run-custom').status).toBe('running');
  });
});
