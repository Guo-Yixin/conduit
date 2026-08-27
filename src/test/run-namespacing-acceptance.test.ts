/**
 * Run-namespacing acceptance: journal + card_log isolation across two runs that
 * SHARE a card_id.
 *
 * Background (Stockwell Final Mission Review test-gap closure):
 *
 * Both the journal and the card_log are JOURNAL-DB surfaces keyed primarily by
 * card_id. Before run namespacing, a card_id was globally unique within a single
 * conduit.sqlite, so card_id alone was a safe key. Once two independent runs can
 * coexist in the same DB (run namespacing), card_id collides across runs — e.g.
 * a fan-out flow and a re-run of the same flow both seed a card called
 * 'shared-card'. The fix:
 *
 *   - appendJournalSpan writes the span's run_id column (it no longer relies on
 *     the table DEFAULT, so two runs' spans for the same card_id are
 *     distinguishable on disk by run_id), and
 *   - run-scoped consumers read card_log via getCardLogForRun(runId, cardId)
 *     instead of the unscoped getCardLog(cardId).
 *
 * This suite pins cross-run isolation directly at the persistence boundary so a
 * regression (dropping the run_id write, or a consumer reverting to the unscoped
 * getter) turns red here rather than surfacing as silently-cross-contaminated
 * history in production.
 *
 * Why the journal half asserts on the persisted run_id column via a raw
 * connection: getJournalSpans(cardId) is intentionally unscoped (no runId param,
 * and StoredJournalSpan does not surface run_id), so the on-disk run_id column is
 * the only observable that distinguishes two runs' spans for one card_id. That
 * column is exactly what appendJournalSpan must populate; asserting it is what
 * makes this test fail if the run_id write is dropped. (db.test.ts /
 * card-log.test.ts use the same raw-introspection pattern for what is actually
 * persisted.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';

const RUN_A = 'run-A';
const RUN_B = 'run-B';
const SHARED_CARD = 'shared-card';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-run-ns-acceptance-'));
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

/** Close the conduit handle so a raw connection can introspect on-disk content. */
function closeConduit(): void {
  db?.close();
  db = null;
}

// ---------------------------------------------------------------------------
// card_log isolation across two runs sharing a card_id.
//
// getCardLogForRun(runId, cardId) is the run-scoped public API. With both runs
// holding a 'shared-card' entry, each scoped read must return ONLY its own run's
// entry — never the sibling run's. A consumer that reverts to the unscoped
// getCardLog('shared-card') would see BOTH entries; this test would fail for it.
// ---------------------------------------------------------------------------

describe('card_log isolation for a shared card_id across two runs', () => {
  beforeEach(() => {
    // runA writes one transition for 'shared-card'.
    db!.appendCardLog({
      runId: RUN_A,
      cardId: SHARED_CARD,
      station: 'ideate',
      attempt: 0,
      kind: 'entered_lane',
      sourceLane: 'fetch_context',
      destLane: 'ideate',
      reasonClass: 'forward',
    });
    // runB writes a DIFFERENT transition for the SAME card_id.
    db!.appendCardLog({
      runId: RUN_B,
      cardId: SHARED_CARD,
      station: 'verify',
      attempt: 0,
      kind: 'entered_lane',
      sourceLane: 'ideate',
      destLane: 'verify',
      reasonClass: 'forward',
    });
  });

  it('getCardLogForRun(runA) returns only runA’s entry, not runB’s', () => {
    const log = db!.getCardLogForRun(RUN_A, SHARED_CARD);
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.runId).toBe(RUN_A);
    expect(entry.station).toBe('ideate');
    expect(entry.kind).toBe('entered_lane');
    // Negative: runB's verify transition must NOT leak into runA's scoped read.
    expect(log.some((e) => e.station === 'verify')).toBe(false);
  });

  it('getCardLogForRun(runB) returns only runB’s entry, not runA’s', () => {
    const log = db!.getCardLogForRun(RUN_B, SHARED_CARD);
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.runId).toBe(RUN_B);
    expect(entry.station).toBe('verify');
    expect(entry.kind).toBe('entered_lane');
    // Negative: runA's ideate transition must NOT leak into runB's scoped read.
    expect(log.some((e) => e.station === 'ideate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// journal isolation across two runs sharing a card_id.
//
// appendJournalSpan must stamp each span's run_id so two runs' spans for the
// same card_id stay attributable to their own run. The persisted run_id column
// is the observable (getJournalSpans is unscoped and omits run_id), so we read
// it back through a raw connection — failing if the run_id write is dropped.
// ---------------------------------------------------------------------------

describe('journal run_id stamping for a shared card_id across two runs', () => {
  function spansByRun(): { runA: string[]; runB: string[] } {
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw
        .query(
          `SELECT run_id, name FROM journal WHERE card_id = $card_id ORDER BY id ASC`,
        )
        .all({ $card_id: SHARED_CARD }) as { run_id: string; name: string }[];
      return {
        runA: rows.filter((r) => r.run_id === RUN_A).map((r) => r.name),
        runB: rows.filter((r) => r.run_id === RUN_B).map((r) => r.name),
      };
    } finally {
      raw.close();
    }
  }

  it('stamps each span with its own run_id, keeping the two runs’ spans disjoint', () => {
    // runA records a span for 'shared-card'.
    db!.appendJournalSpan({
      runId: RUN_A,
      cardId: SHARED_CARD,
      station: 'ideate',
      attempt: 0,
      name: 'span.run-a',
    });
    // runB records a DIFFERENT span for the SAME card_id.
    db!.appendJournalSpan({
      runId: RUN_B,
      cardId: SHARED_CARD,
      station: 'ideate',
      attempt: 0,
      name: 'span.run-b',
    });

    closeConduit();

    const { runA, runB } = spansByRun();
    // runA's slice carries only runA's span; runB's span must NOT be stamped RUN_A.
    expect(runA).toEqual(['span.run-a']);
    // runB's slice carries only runB's span; runA's span must NOT be stamped RUN_B.
    expect(runB).toEqual(['span.run-b']);
  });
});

// ---------------------------------------------------------------------------
// HITL held-at journal isolation across two runs sharing a card_id.
//
// readHeldAt (executor.ts) and getRecordedHitlSelection (slack.ts) both read the
// HITL state for a card through getJournalSpansForRun(runId, cardId), keying on
// the durable 'hitl.held_at' span name. When two runs hold the SAME card_id, the
// only on-disk discriminator between their held_at spans is the persisted run_id
// column — appendJournalSpan must stamp it so run A's hold timestamp can never be
// read as run B's "held since". A regression that drops the run_id write (or
// reverts a consumer to an unscoped read) would let run B's later held_at mask
// run A's, mis-timing the hold-timeout window. We pin the discriminator at the
// persistence boundary: each run's 'hitl.held_at' span carries only its own
// run_id, so getJournalSpansForRun(RUN_A, 'shared-card') sees only run A's hold.
// ---------------------------------------------------------------------------

describe('hitl.held_at journal isolation for a shared card_id across two runs', () => {
  /** The persisted run_id of every 'hitl.held_at' span for SHARED_CARD, in insert order. */
  function heldAtRunIds(): string[] {
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw
        .query(
          `SELECT run_id FROM journal
             WHERE card_id = $card_id AND name = $name
             ORDER BY id ASC`,
        )
        .all({ $card_id: SHARED_CARD, $name: 'hitl.held_at' }) as {
          run_id: string;
        }[];
      return rows.map((r) => r.run_id);
    } finally {
      raw.close();
    }
  }

  it('stamps each run’s hitl.held_at span with its own run_id, never the sibling’s', () => {
    // runA parks 'shared-card' for a human and stamps its held-at timestamp.
    db!.appendJournalSpan({
      runId: RUN_A,
      cardId: SHARED_CARD,
      station: 'rank',
      attempt: 0,
      name: 'hitl.held_at',
      attributes: { held_at: 1000, correlation_id: 'corr-A' },
    });
    // runB parks the SAME card_id later, with a DIFFERENT held-at timestamp.
    db!.appendJournalSpan({
      runId: RUN_B,
      cardId: SHARED_CARD,
      station: 'rank',
      attempt: 0,
      name: 'hitl.held_at',
      attributes: { held_at: 2000, correlation_id: 'corr-B' },
    });

    closeConduit();

    // Exactly one held_at span per run, each carrying its own run_id — runB's hold
    // is NOT stamped RUN_A (which would let readHeldAt(RUN_A) read 2000 instead of
    // 1000) and runA's is NOT stamped RUN_B.
    expect(heldAtRunIds()).toEqual([RUN_A, RUN_B]);
  });
});

// ---------------------------------------------------------------------------
// gate_verdict card_log isolation across two runs sharing a card_id (Guard #3).
//
// runGateRework reads a card's prior gate verdicts via getCardLogForRun(runId,
// cardId) to enforce Guard #3 (progress-monotonicity): rework is allowed only
// while the critic's findings keep changing. The findings comparison is scoped
// to ONE run's gate_verdict entries. When two runs share a card_id, run B's
// gate_verdict must not enter run A's Guard-3 view — otherwise run B's findings
// could falsely satisfy "progress" (masking a stalled run A) or falsely collide
// (tripping no-progress scrap on run A that actually made progress). We pin that
// each run's scoped read returns ONLY its own gate_verdict entry.
// ---------------------------------------------------------------------------

describe('gate_verdict card_log isolation for a shared card_id across two runs (Guard #3)', () => {
  beforeEach(() => {
    // runA records a 'reject' verdict with its own findings for 'shared-card'.
    db!.appendCardLog({
      runId: RUN_A,
      cardId: SHARED_CARD,
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['run-A-finding'],
      returnTo: 'ideate',
    });
    // runB records a DIFFERENT 'reject' verdict for the SAME card_id.
    db!.appendCardLog({
      runId: RUN_B,
      cardId: SHARED_CARD,
      station: 'qc',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['run-B-finding'],
      returnTo: 'draft',
    });
  });

  it('getCardLogForRun(runA) returns only runA’s gate_verdict, not runB’s', () => {
    const log = db!.getCardLogForRun(RUN_A, SHARED_CARD);
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.runId).toBe(RUN_A);
    expect(entry.kind).toBe('gate_verdict');
    expect(entry.station).toBe('verify');
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.findings).toEqual(['run-A-finding']);
    expect(entry.returnTo).toBe('ideate');
    // Negative: runB's findings must NOT enter runA's Guard-3 view.
    expect(log.some((e) => e.kind === 'gate_verdict' && e.findings.includes('run-B-finding'))).toBe(
      false,
    );
  });

  it('getCardLogForRun(runB) returns only runB’s gate_verdict, not runA’s', () => {
    const log = db!.getCardLogForRun(RUN_B, SHARED_CARD);
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.runId).toBe(RUN_B);
    expect(entry.kind).toBe('gate_verdict');
    expect(entry.station).toBe('qc');
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.findings).toEqual(['run-B-finding']);
    expect(entry.returnTo).toBe('draft');
    // Negative: runA's findings must NOT enter runB's Guard-3 view.
    expect(log.some((e) => e.kind === 'gate_verdict' && e.findings.includes('run-A-finding'))).toBe(
      false,
    );
  });
});
