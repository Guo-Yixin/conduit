/**
 * Tests for the append-only ingress_log observability table (WI-404, D5, FR-11).
 *
 * ingress_log is a dedicated append-only audit store on the JOURNAL connection
 * recording every ingress event OUTCOME, secret-filtered and independently
 * queryable. It is strictly distinct from:
 *   - ingress_events (the PK'd state/correctness ledger, on the STATE DB, WI-401)
 *   - the per-run journal / work_summaries / card_log tables
 *
 * SCOPE — this file pins the NEW ingress_log surface only. It mirrors the
 * card_log append/read pattern (appendCardLog/getCardLog) and reuses the
 * already-exported sensitive-key filter (filterAttributes, WI-411) — the impl
 * must NOT reimplement the regex.
 *
 * Contract this file pins for src/persistence/db.ts (extends ConduitDB):
 *
 *   export type IngressOutcome =
 *     | 'accepted' | 'duplicate' | 'rejected_auth' | 'rejected_unknown_flow'
 *     | 'rejected_malformed' | 'spawn_failed' | 'redriven';
 *
 *   export interface IngressLogInput {
 *     source: string;
 *     eventId?: string | null;          // absent/null when rejected before id derivation
 *     outcome: IngressOutcome;          // any other value is rejected at runtime
 *     reason?: string;
 *     attributes?: Record<string, unknown>;   // filtered through filterAttributes before storage
 *   }
 *
 *   export interface StoredIngressLogEntry {
 *     source: string;
 *     eventId: string | null;
 *     outcome: IngressOutcome;
 *     reason: string | null;
 *     attributes: Record<string, unknown>;     // already secret-filtered
 *   }
 *
 *   export interface IngressLogFilter { outcome?: IngressOutcome }
 *
 *   // ConduitDB gains (both on the JOURNAL connection, mirroring card_log):
 *   appendIngressLog(entry: IngressLogInput): void;          // one row; throws on bad outcome
 *   getIngressLog(filter?: IngressLogFilter): StoredIngressLogEntry[]; // insertion order
 *
 * ingress_log is created via CREATE TABLE IF NOT EXISTS in JOURNAL_DDL (self-heals
 * on existing journals); it must NOT appear on the state DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DEFAULT_RUN_ID } from './db';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB, type IngressOutcome } from './db';

const ALL_OUTCOMES: IngressOutcome[] = [
  'accepted',
  'duplicate',
  'rejected_auth',
  'rejected_unknown_flow',
  'rejected_malformed',
  'spawn_failed',
  'redriven',
];

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let opened: ConduitDB[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-ingresslog-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  opened = [];
});

afterEach(() => {
  for (const d of opened) {
    try {
      d.close();
    } catch {
      /* already closed in-test */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function open(): ConduitDB {
  const d = openConduitDB({ stateDbPath, journalDbPath });
  opened.push(d);
  return d;
}

function tableNames(database: Database): string[] {
  return database
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
}

// ===========================================================================
// AC1 / AC4 — ingress_log lives on the JOURNAL DB, never the STATE DB.
// ===========================================================================

describe('ingress_log placement on the journal DB (AC1, AC4)', () => {
  it('creates ingress_log in the journal file and NOT in the state file', () => {
    const db = open();
    db.close();

    const rawState = new Database(stateDbPath, { readonly: true });
    const rawJournal = new Database(journalDbPath, { readonly: true });
    try {
      expect(tableNames(rawJournal)).toContain('ingress_log');
      // It must NEVER appear on the hot state DB the dispatch txn scans.
      expect(tableNames(rawState)).not.toContain('ingress_log');
    } finally {
      rawState.close();
      rawJournal.close();
    }
  });

  it('appends to ingress_log while the STATE DB write lock is held (journal connection, NFR-1)', () => {
    const db = open();
    // An external connection grabs and holds the state-DB write lock.
    const rawState = new Database(stateDbPath);
    rawState.exec('PRAGMA busy_timeout = 150');
    rawState.exec('BEGIN IMMEDIATE'); // exclusive writer on the STATE file only
    try {
      // ingress_log lives in the journal file on its own connection — appending
      // must succeed, not block on the state lock. If the impl wrongly routes the
      // write through the state connection, this throws SQLITE_BUSY.
      expect(() =>
        db.appendIngressLog({ source: 'github', eventId: 'evt-1', outcome: 'accepted' }),
      ).not.toThrow();
      expect(db.getIngressLog()).toHaveLength(1);
    } finally {
      rawState.exec('ROLLBACK');
      rawState.close();
    }
  });
});

// ===========================================================================
// AC1 — outcome is a closed set; every member inserts, anything else is rejected.
// ===========================================================================

describe('appendIngressLog outcome validation (AC1)', () => {
  it.each(ALL_OUTCOMES)('accepts and stores the %s outcome as a single row', (outcome) => {
    const db = open();
    db.appendIngressLog({ source: 'github', eventId: 'evt-1', outcome });

    const rows = db.getIngressLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe(outcome);
    expect(rows[0]!.source).toBe('github');
  });

  it('rejects an outcome outside the closed set and writes no row', () => {
    const db = open();
    expect(() =>
      db.appendIngressLog({
        source: 'github',
        eventId: 'evt-1',
        outcome: 'totally_invalid' as unknown as IngressOutcome,
      }),
    ).toThrow();
    // The validation must fire BEFORE the insert — a rejected outcome leaves no row.
    expect(db.getIngressLog()).toHaveLength(0);
  });

  it('writes exactly one row per append call', () => {
    const db = open();
    db.appendIngressLog({ source: 'github', eventId: 'evt-1', outcome: 'accepted' });
    db.appendIngressLog({ source: 'github', eventId: 'evt-2', outcome: 'duplicate' });
    expect(db.getIngressLog()).toHaveLength(2);
  });
});

// ===========================================================================
// AC2 — attributes are secret-filtered before storage (NFR-5).
// ===========================================================================

describe('ingress_log secret hygiene (AC2, NFR-5)', () => {
  const SECRET = 'sk-live-INGRESSLOG-SECRET-0f1e2d3c4b5a';

  it('never persists a secret embedded under headers.authorization or a *_token key', () => {
    const db = open();
    db.appendIngressLog({
      source: 'github',
      eventId: 'evt-1',
      outcome: 'accepted',
      attributes: {
        delivery_id: 'd-123', // legitimate, non-sensitive — must survive
        headers: { authorization: `Bearer ${SECRET}` }, // nested sensitive — must be dropped
        slack_token: SECRET, // *_token — must be dropped
      },
    });

    db.close();

    // Scan everything actually persisted in ingress_log for the raw secret.
    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT * FROM ingress_log').all();
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    } finally {
      raw.close();
    }
  });

  it('keeps the legitimate attributes while dropping the secret (via the accessor)', () => {
    const db = open();
    db.appendIngressLog({
      source: 'github',
      eventId: 'evt-1',
      outcome: 'accepted',
      attributes: {
        delivery_id: 'd-123',
        openai_api_key: SECRET, // sensitive — dropped
      },
    });

    const entry = db.getIngressLog()[0]!;
    expect(entry.attributes.delivery_id).toBe('d-123');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });
});

// ===========================================================================
// AC3 — getIngressLog: insertion order + outcome filter (FR-11).
// ===========================================================================

describe('getIngressLog ordering and filtering (AC3, FR-11)', () => {
  it('returns rows ordered by insertion', () => {
    const db = open();
    db.appendIngressLog({ source: 'github', eventId: 'e1', outcome: 'accepted', reason: 'first' });
    db.appendIngressLog({ source: 'github', eventId: 'e2', outcome: 'duplicate', reason: 'second' });
    db.appendIngressLog({ source: 'github', eventId: 'e3', outcome: 'spawn_failed', reason: 'third' });

    expect(db.getIngressLog().map((e) => e.reason)).toEqual(['first', 'second', 'third']);
  });

  it('returns only rows matching an outcome filter, leaving accepted/rejected/duplicate all queryable', () => {
    const db = open();
    db.appendIngressLog({ source: 'github', eventId: 'e1', outcome: 'accepted' });
    db.appendIngressLog({ source: 'github', eventId: 'e1', outcome: 'duplicate' });
    db.appendIngressLog({ source: 'slack', eventId: null, outcome: 'rejected_auth' });
    db.appendIngressLog({ source: 'github', eventId: 'e2', outcome: 'accepted' });

    expect(db.getIngressLog({ outcome: 'accepted' }).map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'rejected_auth' })).toHaveLength(1);
    // An outcome that was never logged returns nothing — not an error.
    expect(db.getIngressLog({ outcome: 'redriven' })).toHaveLength(0);
    // No filter returns the full set.
    expect(db.getIngressLog()).toHaveLength(4);
  });
});

// ===========================================================================
// AC4 — ingress_log self-heals on existing journals without touching siblings.
// ===========================================================================

describe('ingress_log self-heal and journal-table isolation (AC4)', () => {
  it('recreates ingress_log on a journal that predates it, preserving existing card_log data', () => {
    // Seed a journal that has card_log data, then simulate a pre-WI-404 journal by
    // dropping ingress_log. Reopening must recreate ingress_log (CREATE TABLE IF
    // NOT EXISTS in JOURNAL_DDL) while leaving card_log and its row untouched.
    const db1 = open();
    db1.appendCardLog({
      runId: DEFAULT_RUN_ID, cardId: 'c1', station: 's', attempt: 0, kind: 'terminal', reason: 'done' });
    db1.close();

    const rawJournal = new Database(journalDbPath);
    rawJournal.exec('DROP TABLE ingress_log');
    rawJournal.close();

    const db2 = open(); // reopen → JOURNAL_DDL self-heals ingress_log

    // ingress_log is back and usable...
    expect(() =>
      db2.appendIngressLog({ source: 'github', eventId: 'evt-1', outcome: 'accepted' }),
    ).not.toThrow();
    expect(db2.getIngressLog()).toHaveLength(1);
    // ...and the pre-existing card_log row survived the reopen untouched.
    expect(db2.getCardLog('c1')).toHaveLength(1);
  });

  it('does not write ingress_log rows into the card_log table', () => {
    const db = open();
    db.appendIngressLog({ source: 'github', eventId: 'evt-1', outcome: 'accepted' });
    // The append targets ingress_log only — card_log for an unrelated card stays empty.
    expect(db.getCardLog('c1')).toHaveLength(0);
  });
});

// ===========================================================================
// AC5 — an event with no event_id yet (rejected before id derivation) is allowed.
// ===========================================================================

describe('absent event_id (AC5)', () => {
  it.each([
    ['omitted', undefined],
    ['explicit null', null],
  ])('stores a row with an %s event_id without error', (_label, eventId) => {
    const db = open();
    expect(() =>
      db.appendIngressLog({
        source: 'webhook',
        eventId: eventId as string | null | undefined,
        outcome: 'rejected_malformed',
        reason: 'no parseable id',
      }),
    ).not.toThrow();

    const entry = db.getIngressLog()[0]!;
    expect(entry.eventId).toBeNull();
    expect(entry.outcome).toBe('rejected_malformed');
  });
});
