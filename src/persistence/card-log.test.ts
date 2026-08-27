/**
 * Tests for the per-card, append-only `card_log` transition table (WI-378).
 *
 * This is the PERSISTENCE slice of the Card Transition Log PRD
 * (prd/done/card-transition-log.md). It adds ONE new durable surface and two
 * methods on the existing ConduitDB handle — nothing about prompt rendering,
 * feedback wiring, or binding stamps (those are later executor work items):
 *
 *   ConduitDB.appendCardLog(entry: CardLogEntryInput): void
 *   ConduitDB.getCardLog(cardId: string): StoredCardLogEntry[]
 *
 * Contract this file pins (B.A. implements db.ts to satisfy it):
 *
 *  - card_log is created on the JOURNAL DB (alongside journal/work_summaries),
 *    NEVER on the STATE DB, so the atomic-claim dispatch transaction never reads
 *    or writes it (NFR-1, FR-1). It is created via CREATE TABLE IF NOT EXISTS.
 *  - appendCardLog inserts one row carrying card_id, station, attempt, and a
 *    `kind` discriminator; getCardLog returns a card's rows ordered by insertion
 *    (id ASC), filtered to that card (FR-2).
 *  - kind='entered_lane' stores exactly sourceLane, destLane, reasonClass
 *    ('forward' | 'rework' | 'scrap' | 'hold') (FR-2).
 *  - kind='gate_verdict' stores exactly verdict ('pass' | 'reject'), findings
 *    (string[] or empty), returnTo (lane id or null), and attempt (FR-3).
 *  - kind='terminal' stores exactly reason (the scrap/hold reason string) (FR-4).
 *  - Appends are idempotent under replay: a second append with the same
 *    (card_id, station, attempt, kind) does NOT add a row (FR-7, NFR-3).
 *  - getCardLog returns [] (no throw) for a card with no entries.
 *  - Stored findings text is truncated to a defined maximum length constant
 *    before insert, so a verbose critic cannot grow an entry without bound
 *    (NFR-4). The exact constant is an impl detail; these tests pin the
 *    *behaviour* (a single shared cap, short text untouched) not the number.
 *  - A structured payload is run through the existing sensitive-key filter
 *    (filterAttributes/isSensitiveKey) before storage, so credentials never land
 *    in the log (NFR-5). Findings TEXT is model output and is permitted; the
 *    screen is over structured payload KEYS, not free-text values.
 *
 * Where it matters, assertions introspect the ON-DISK schema/content with a raw
 * bun:sqlite connection — testing what is actually persisted, not just the
 * wrapper's getters (mirroring db.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DEFAULT_RUN_ID } from './db';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from './db';

// ---------------------------------------------------------------------------
// The contract under test. These types live in db.ts once B.A. implements the
// feature; declaring them locally lets this RED-phase file typecheck while the
// production symbols are still missing. At runtime the methods are absent until
// implemented, so every test below fails with "not a function" — a correct RED.
// ---------------------------------------------------------------------------

type ReasonClass = 'forward' | 'rework' | 'scrap' | 'hold';
type GateVerdict = 'pass' | 'reject';

interface CardLogBase {
  runId: string;
  cardId: string;
  station: string;
  attempt: number;
}

type CardLogEntryInput =
  | (CardLogBase & {
      kind: 'entered_lane';
      sourceLane: string;
      destLane: string;
      reasonClass: ReasonClass;
    })
  | (CardLogBase & {
      kind: 'gate_verdict';
      verdict: GateVerdict;
      findings: string[];
      returnTo: string | null;
    })
  | (CardLogBase & { kind: 'terminal'; reason: string });

type StoredCardLogEntry =
  | (CardLogBase & {
      kind: 'entered_lane';
      sourceLane: string;
      destLane: string;
      reasonClass: ReasonClass;
    })
  | (CardLogBase & {
      kind: 'gate_verdict';
      verdict: GateVerdict;
      findings: string[];
      returnTo: string | null;
    })
  | (CardLogBase & { kind: 'terminal'; reason: string });

interface CardLogDB extends ConduitDB {
  appendCardLog(entry: CardLogEntryInput): void;
  getCardLog(cardId: string): StoredCardLogEntry[];
}

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: CardLogDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-cardlog-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = openConduitDB({ stateDbPath, journalDbPath }) as CardLogDB;
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

function tableNames(database: Database): string[] {
  return database
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
}

/** Append helper that keeps the literal kinds narrow without repeating `as const`. */
function enteredLane(
  o: Omit<CardLogBase, 'runId'> & { runId?: string; sourceLane: string; destLane: string; reasonClass: ReasonClass },
): CardLogEntryInput {
  return { runId: DEFAULT_RUN_ID, ...o, kind: 'entered_lane' };
}

// ---------------------------------------------------------------------------
// AC1 / FR-1 / NFR-1 — card_log lives on the JOURNAL DB, never the STATE DB.
// ---------------------------------------------------------------------------

describe('card_log placement on the journal DB (AC1, FR-1, NFR-1)', () => {
  it('creates card_log in the journal file and NOT in the state file', () => {
    closeConduit();
    const rawState = new Database(stateDbPath, { readonly: true });
    const rawJournal = new Database(journalDbPath, { readonly: true });
    try {
      // card_log is a journal-DB citizen, beside journal + work_summaries.
      expect(tableNames(rawJournal)).toContain('card_log');
      // It must NEVER appear on the hot state DB the dispatch txn scans.
      expect(tableNames(rawState)).not.toContain('card_log');
    } finally {
      rawState.close();
      rawJournal.close();
    }
  });

  it('appends to card_log while the STATE DB write lock is held (hot-path isolation, NFR-1)', () => {
    // An external connection grabs and holds the state-DB write lock.
    const rawState = new Database(stateDbPath);
    rawState.exec('PRAGMA busy_timeout = 150');
    rawState.exec('BEGIN IMMEDIATE'); // exclusive writer on the STATE file only
    try {
      // card_log lives in the journal file on its own connection — appending must
      // succeed, not block on / contend with the state lock. If the impl wrongly
      // routes card_log through the state connection, this throws SQLITE_BUSY.
      expect(() =>
        db!.appendCardLog(enteredLane({
          cardId: 'card_1',
          station: 'ideate',
          attempt: 0,
          sourceLane: 'fetch_context',
          destLane: 'ideate',
          reasonClass: 'forward',
        })),
      ).not.toThrow();
      expect(db!.getCardLog('card_1')).toHaveLength(1);
    } finally {
      rawState.exec('ROLLBACK');
      rawState.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 / FR-2 — append/read identity, insertion ordering, per-card filtering.
// ---------------------------------------------------------------------------

describe('append / read identity and ordering (AC2, FR-2)', () => {
  it('returns a row carrying card_id, station, attempt and kind', () => {
    db!.appendCardLog(enteredLane({
      cardId: 'card_id1',
      station: 'verify',
      attempt: 2,
      sourceLane: 'ideate',
      destLane: 'verify',
      reasonClass: 'forward',
    }));

    const log = db!.getCardLog('card_id1');
    expect(log).toHaveLength(1);
    expect(log[0]!.cardId).toBe('card_id1');
    expect(log[0]!.station).toBe('verify');
    expect(log[0]!.attempt).toBe(2);
    expect(log[0]!.kind).toBe('entered_lane');
  });

  it('returns rows in insertion order (id ASC), not sorted by attempt', () => {
    // Append three DISTINCT-keyed entries whose attempts are out of order. If the
    // impl ordered by attempt (or anything but insertion id) the result would be
    // [0, 1, 2] — the test pins the append order [2, 0, 1].
    db!.appendCardLog(enteredLane({
      cardId: 'card_order',
      station: 's',
      attempt: 2,
      sourceLane: 'a',
      destLane: 'b',
      reasonClass: 'forward',
    }));
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_order',
      station: 's',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['f'],
      returnTo: 'a',
    });
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_order',
      station: 's',
      attempt: 1,
      kind: 'terminal',
      reason: 'rework_cap',
    });

    expect(db!.getCardLog('card_order').map((e) => e.attempt)).toEqual([2, 0, 1]);
  });

  it('returns only the requested card’s entries (per-card keying)', () => {
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_A',
      station: 's',
      attempt: 0,
      kind: 'terminal',
      reason: 'hold:escalation',
    });
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_B',
      station: 's',
      attempt: 0,
      kind: 'terminal',
      reason: 'scrap:no_progress',
    });

    const a = db!.getCardLog('card_A');
    expect(a).toHaveLength(1);
    expect(a[0]!.cardId).toBe('card_A');
    expect(db!.getCardLog('card_B')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 / FR-2 — entered_lane stores exactly sourceLane, destLane, reasonClass.
// ---------------------------------------------------------------------------

describe('entered_lane entries (AC3, FR-2)', () => {
  it('round-trips sourceLane, destLane and reasonClass intact', () => {
    db!.appendCardLog(enteredLane({
      cardId: 'card_el',
      station: 'ideate',
      attempt: 1,
      sourceLane: 'verify',
      destLane: 'ideate',
      reasonClass: 'rework',
    }));

    const entry = db!.getCardLog('card_el')[0]!;
    expect(entry.kind).toBe('entered_lane');
    // Narrow the union before reading kind-specific fields.
    if (entry.kind !== 'entered_lane') throw new Error('expected entered_lane');
    expect(entry.sourceLane).toBe('verify');
    expect(entry.destLane).toBe('ideate');
    expect(entry.reasonClass).toBe('rework');
  });

  it.each<ReasonClass>(['forward', 'rework', 'scrap', 'hold'])(
    'preserves reasonClass=%s exactly',
    (reasonClass) => {
      db!.appendCardLog(enteredLane({
        cardId: `card_${reasonClass}`,
        station: 's',
        attempt: 0,
        sourceLane: 'x',
        destLane: 'y',
        reasonClass,
      }));

      const entry = db!.getCardLog(`card_${reasonClass}`)[0]!;
      if (entry.kind !== 'entered_lane') throw new Error('expected entered_lane');
      expect(entry.reasonClass).toBe(reasonClass);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4 / FR-3 — gate_verdict stores exactly verdict, findings, returnTo, attempt.
// ---------------------------------------------------------------------------

describe('gate_verdict entries (AC4, FR-3)', () => {
  it('round-trips a reject verdict with findings and a returnTo lane', () => {
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_gv',
      station: 'verify',
      attempt: 2,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['false-freshness hook', 'price claim unverified'],
      returnTo: 'ideate',
    });

    const entry = db!.getCardLog('card_gv')[0]!;
    expect(entry.kind).toBe('gate_verdict');
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.verdict).toBe('reject');
    expect(entry.findings).toEqual(['false-freshness hook', 'price claim unverified']);
    expect(entry.returnTo).toBe('ideate');
    expect(entry.attempt).toBe(2);
  });

  it('preserves an empty findings array and a null returnTo on a pass verdict', () => {
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_pass',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'pass',
      findings: [],
      returnTo: null,
    });

    const entry = db!.getCardLog('card_pass')[0]!;
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.verdict).toBe('pass');
    expect(entry.findings).toEqual([]);
    expect(entry.returnTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5 / FR-4 — terminal stores exactly the reason string.
// ---------------------------------------------------------------------------

describe('terminal entries (AC5, FR-4)', () => {
  it('round-trips the terminal reason string intact', () => {
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_term',
      station: 'verify',
      attempt: 2,
      kind: 'terminal',
      reason: 'rework_cap',
    });

    const entry = db!.getCardLog('card_term')[0]!;
    expect(entry.kind).toBe('terminal');
    if (entry.kind !== 'terminal') throw new Error('expected terminal');
    expect(entry.reason).toBe('rework_cap');
  });
});

// ---------------------------------------------------------------------------
// AC6 / FR-7 / NFR-3 — idempotent append under replay.
// ---------------------------------------------------------------------------

describe('idempotent append under replay (AC6, FR-7, NFR-3)', () => {
  it('does not duplicate a row when the same (card,station,attempt,kind) is appended twice', () => {
    const append = () =>
      db!.appendCardLog({
        runId: DEFAULT_RUN_ID,
        cardId: 'card_dup',
        station: 'verify',
        attempt: 1,
        kind: 'gate_verdict',
        verdict: 'reject',
        findings: ['identical findings'],
        returnTo: 'ideate',
      });

    append();
    // A crash/resume replays the checkpointed station — the second append must be
    // a no-op (no throw, no new row), not a duplicate.
    expect(() => append()).not.toThrow();

    const log = db!.getCardLog('card_dup');
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.findings).toEqual(['identical findings']);
  });

  it('keeps distinct kinds at the same (card,station,attempt) as separate rows', () => {
    // The idempotency key includes `kind`, so an entered_lane, a gate_verdict and
    // a terminal recorded for one (card,station,attempt) are three real entries.
    db!.appendCardLog(enteredLane({
      cardId: 'card_kinds',
      station: 'verify',
      attempt: 0,
      sourceLane: 'ideate',
      destLane: 'verify',
      reasonClass: 'forward',
    }));
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_kinds',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['f'],
      returnTo: 'ideate',
    });
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_kinds',
      station: 'verify',
      attempt: 0,
      kind: 'terminal',
      reason: 'rework_cap',
    });

    expect(db!.getCardLog('card_kinds').map((e) => e.kind)).toEqual([
      'entered_lane',
      'gate_verdict',
      'terminal',
    ]);
  });

  it('keeps distinct attempts of the same (card,station,kind) as separate rows', () => {
    // Rework re-enters the same station on a higher attempt — each gate verdict is
    // its own entry, so the card carries the full reject→reject→… chain.
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_attempts',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['first'],
      returnTo: 'ideate',
    });
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_attempts',
      station: 'verify',
      attempt: 1,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['second'],
      returnTo: 'ideate',
    });

    expect(db!.getCardLog('card_attempts').map((e) => e.attempt)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// AC7 — getCardLog returns an empty array (no throw) for a card with no entries.
// ---------------------------------------------------------------------------

describe('empty log lookup (AC7)', () => {
  it('returns an empty array for a card that has never been logged', () => {
    expect(db!.getCardLog('never-seen')).toEqual([]);
  });

  it('returns an empty array for a known card before any append', () => {
    // Appending for one card must not conjure entries for another.
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'other',
      station: 's',
      attempt: 0,
      kind: 'terminal',
      reason: 'scrap',
    });
    expect(db!.getCardLog('still-empty')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC8 / NFR-4 — findings text is truncated to a defined maximum length constant.
//
// We do NOT hardcode the constant; instead we pin the BEHAVIOUR it guarantees:
//   - two findings far longer than any sane cap clamp to the SAME length
//     (=> a single fixed maximum exists), and that length is well below input
//     (=> truncation actually happened);
//   - the stored text is a prefix of the input (truncation, not replacement);
//   - a short finding is stored verbatim (it is a MAX, not a fixed-width field).
// ---------------------------------------------------------------------------

describe('findings truncation (AC8, NFR-4)', () => {
  it('clamps over-long findings to a single shared maximum length', () => {
    const huge1 = 'x'.repeat(200_000);
    const huge2 = 'y'.repeat(300_000);

    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_trunc1',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: [huge1],
      returnTo: 'ideate',
    });
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_trunc2',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: [huge2],
      returnTo: 'ideate',
    });

    const e1 = db!.getCardLog('card_trunc1')[0]!;
    const e2 = db!.getCardLog('card_trunc2')[0]!;
    if (e1.kind !== 'gate_verdict' || e2.kind !== 'gate_verdict') {
      throw new Error('expected gate_verdict');
    }

    const stored1 = e1.findings[0]!;
    const stored2 = e2.findings[0]!;

    // Both clamp to the same bound => there is a single constant maximum.
    expect(stored1.length).toBe(stored2.length);
    // The bound is well below the (different) inputs => truncation happened.
    expect(stored1.length).toBeLessThan(200_000);
    expect(stored1.length).toBeGreaterThan(0);
    // Truncation keeps a prefix of the original text, not a replacement.
    expect(stored1).toBe(huge1.slice(0, stored1.length));
  });

  it('stores a short finding verbatim (the cap is a maximum, not a fixed width)', () => {
    db!.appendCardLog({
      runId: DEFAULT_RUN_ID,
      cardId: 'card_short',
      station: 'verify',
      attempt: 0,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['ok'],
      returnTo: 'ideate',
    });

    const entry = db!.getCardLog('card_short')[0]!;
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.findings).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// AC9 / NFR-5 — a structured payload is screened by the sensitive-key filter,
// so model credentials never land in the log.
//
// Findings TEXT is permitted model output; the screen is over structured payload
// KEYS. We inject a credential under sensitive keys (a careless/forward-compat
// caller) and assert it never reaches the persisted row, while the legitimate
// typed fields still round-trip.
// ---------------------------------------------------------------------------

describe('secret hygiene of the structured payload (AC9, NFR-5)', () => {
  const SECRET = 'sk-live-CARDLOG-SECRET-deadbeef99887766';

  it('never persists a credential supplied under sensitive payload keys', () => {
    const hostile = {
      cardId: 'card_secret',
      station: 'verify',
      attempt: 1,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['hook claims false freshness'],
      returnTo: 'ideate',
      // Unexpected/forward-compat structured payload carrying credentials. The
      // existing sensitive-key filter must drop these before storage.
      api_key: SECRET,
      headers: { Authorization: `Bearer ${SECRET}` },
    } as unknown as CardLogEntryInput;

    db!.appendCardLog(hostile);
    closeConduit();

    // Scan everything actually persisted in card_log for the raw secret.
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT * FROM card_log').all();
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    } finally {
      raw.close();
    }
  });

  it('keeps the legitimate typed fields while dropping the secret', () => {
    const hostile = {
      cardId: 'card_secret2',
      station: 'verify',
      attempt: 1,
      kind: 'gate_verdict',
      verdict: 'reject',
      findings: ['legit finding'],
      returnTo: 'ideate',
      openai_api_key: SECRET,
    } as unknown as CardLogEntryInput;

    db!.appendCardLog(hostile);

    const entry = db!.getCardLog('card_secret2')[0]!;
    if (entry.kind !== 'gate_verdict') throw new Error('expected gate_verdict');
    expect(entry.verdict).toBe('reject');
    expect(entry.findings).toEqual(['legit finding']);
    expect(entry.returnTo).toBe('ideate');
    // The secret is never exposed through the accessor either.
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });
});
