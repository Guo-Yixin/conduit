/**
 * Regression test: v5→v6 journal migration — `journal` table gains `run_id`.
 *
 * Bug (the pre-public journal-migration review finding — verified real):
 *   The v5→v6 migration block in `openConduitDB` added `run_id` to `card_log`
 *   via TABLE-RECREATE (needed because its UNIQUE changed), but did NOTHING for
 *   the `journal` table itself. On an EXISTING v5 journal DB that already has a
 *   `journal` table WITHOUT `run_id`, the `JOURNAL_DDL` `CREATE TABLE IF NOT
 *   EXISTS` is a NO-OP — it leaves the old schema untouched. The very first
 *   `appendJournalSpan` then fails with:
 *     "table journal has no column named run_id"
 *
 * Fix: an idempotent `ALTER TABLE journal ADD COLUMN run_id` (same pattern as
 * `rework_count`/`pid`/`spawn_state` elsewhere in the file). The journal table
 * has no UNIQUE/PK constraint involving run_id, so ADDITIVE is sufficient —
 * no table-recreate needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID, SCHEMA_VERSION, type ConduitDB } from './db';

// ---------------------------------------------------------------------------
// Test scaffolding — mirrors the pattern in db.test.ts
// ---------------------------------------------------------------------------

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-journal-v6-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = null; // tests open db themselves via fixture helpers
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

function columnNames(database: Database, table: string): string[] {
  return database
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => (r as { name: string }).name);
}

// ---------------------------------------------------------------------------
// Fixture: a v5 journal DB whose `journal` table lacks `run_id`.
//
// We also need a v5-stamped STATE DB (user_version = 5) so `openConduitDB`
// follows the v5→v6 migration path for the journal too.
// ---------------------------------------------------------------------------

const V5_SCHEMA_VERSION = 5;

/**
 * Build a minimal v5 state DB fixture on disk (user_version = 5, no run_id
 * on any table), then close it.  The state DB is only needed so
 * `openConduitDB` sees a version-5 stamp and enters the v5→v6 branch.
 */
function buildV5StateFixture(): void {
  const raw = new Database(stateDbPath);
  raw.exec(`
    CREATE TABLE cards (
      id           TEXT PRIMARY KEY,
      parent_id    TEXT,
      lane         TEXT NOT NULL,
      status       TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      wave         INTEGER NOT NULL DEFAULT 0,
      owned_paths  TEXT NOT NULL DEFAULT '[]',
      rework_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  raw.exec(`
    CREATE TABLE station_outputs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id        TEXT NOT NULL,
      station        TEXT NOT NULL,
      attempt        INTEGER NOT NULL,
      findings_hash  TEXT NOT NULL,
      payload_json   TEXT NOT NULL DEFAULT '{}',
      return_to      TEXT,
      binding_stamp  TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (card_id, station, attempt)
    )
  `);
  raw.exec(`
    CREATE TABLE outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key  TEXT NOT NULL UNIQUE,
      payload_json     TEXT NOT NULL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      delivered_at     INTEGER
    )
  `);
  raw.exec(`
    CREATE TABLE active_workers (
      card_id     TEXT NOT NULL,
      station     TEXT NOT NULL,
      worker_id   TEXT NOT NULL,
      started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      lease_until INTEGER NOT NULL,
      pid         INTEGER,
      PRIMARY KEY (card_id, station)
    )
  `);
  raw.exec(`
    CREATE TABLE ingress_events (
      event_id       TEXT    PRIMARY KEY,
      received_at    INTEGER NOT NULL,
      spawn_state    TEXT    NOT NULL DEFAULT 'accepted',
      spawn_attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_active_workers_station ON active_workers(station)`);
  raw.exec(`PRAGMA user_version = ${V5_SCHEMA_VERSION}`);
  raw.close();
}

/**
 * Build a v5 journal DB fixture: the `journal` table WITHOUT `run_id` (as it
 * existed before the v6 migration), plus a pre-existing legacy row to verify
 * backfill.  Also creates `card_log` WITHOUT `run_id` (both tables are in the
 * same journal file).
 */
function buildV5JournalFixture(): void {
  const raw = new Database(journalDbPath);
  raw.exec('PRAGMA journal_mode = WAL');

  // v5 journal table — no run_id column
  raw.exec(`
    CREATE TABLE journal (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id          TEXT NOT NULL,
      station          TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      name             TEXT NOT NULL,
      attributes_json  TEXT NOT NULL DEFAULT '{}',
      model            TEXT,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      cost_usd         REAL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // v5 card_log table — no run_id column
  raw.exec(`
    CREATE TABLE card_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id       TEXT NOT NULL,
      station       TEXT NOT NULL,
      attempt       INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      source_lane   TEXT,
      dest_lane     TEXT,
      reason_class  TEXT,
      verdict       TEXT,
      findings_json TEXT,
      return_to     TEXT,
      reason        TEXT,
      UNIQUE(card_id, station, attempt, kind)
    )
  `);

  raw.exec(`CREATE TABLE IF NOT EXISTS work_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id     TEXT NOT NULL,
    station     TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    summary     TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Insert legacy rows (no run_id) — must survive migration
  raw.prepare(`
    INSERT INTO journal (card_id, station, attempt, name, attributes_json)
    VALUES ('legacy_card', 'brief', 0, 'brief.run', '{}')
  `).run();
  raw.prepare(`
    INSERT INTO work_summaries (card_id, station, attempt, summary)
    VALUES ('legacy_card', 'brief', 0, 'legacy summary')
  `).run();

  raw.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('journal v5→v6 migration: journal table gains run_id column', () => {
  it('openConduitDB migrates a v5 journal (no run_id) without throwing', () => {
    buildV5StateFixture();
    buildV5JournalFixture();

    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('journal table has a run_id column after migration', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const raw = new Database(journalDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'journal')).toContain('run_id');
    } finally {
      raw.close();
    }
  });

  it('legacy row survives migration with run_id backfilled to DEFAULT_RUN_ID', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const rows = raw.query('SELECT card_id, run_id FROM journal').all() as {
        card_id: string;
        run_id: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.card_id).toBe('legacy_card');
      expect(rows[0]!.run_id).toBe(DEFAULT_RUN_ID);
    } finally {
      raw.close();
    }
  });

  it('work_summaries gains run_id, legacy row backfilled to DEFAULT_RUN_ID', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const raw = new Database(journalDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'work_summaries')).toContain('run_id');
      const rows = raw.query('SELECT card_id, run_id FROM work_summaries').all() as {
        card_id: string;
        run_id: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.card_id).toBe('legacy_card');
      expect(rows[0]!.run_id).toBe(DEFAULT_RUN_ID);
    } finally {
      raw.close();
    }
  });

  it('appendJournalSpan with a run_id succeeds after migration (the bug)', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    // This INSERT references `run_id` — was failing with
    // "table journal has no column named run_id" before the fix.
    expect(() =>
      db!.appendJournalSpan({
        runId: 'run-abc',
        cardId: 'new_card',
        station: 'brief',
        attempt: 0,
        name: 'brief.run',
      }),
    ).not.toThrow();
  });

  it('the appended span is retrievable after migration', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });

    db!.appendJournalSpan({
      runId: 'run-abc',
      cardId: 'new_card',
      station: 'brief',
      attempt: 0,
      name: 'brief.run',
    });

    const spans = db!.getJournalSpansForRun('run-abc', 'new_card');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('brief.run');
  });

  it('state DB is stamped at SCHEMA_VERSION (6) after migration', () => {
    buildV5StateFixture();
    buildV5JournalFixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const raw = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = raw.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency: re-opening an already-migrated v6 journal must not throw
// ("duplicate column name" must be caught, not re-thrown).
// ---------------------------------------------------------------------------

describe('journal v5→v6 migration: idempotency on re-open', () => {
  it('re-opening an already-migrated v6 journal DB does not throw', () => {
    buildV5StateFixture();
    buildV5JournalFixture();

    // First open migrates.
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    // Second open must be a no-op, not a duplicate-column crash.
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('run_id column count stays at exactly 1 after two opens (no dup)', () => {
    buildV5StateFixture();
    buildV5JournalFixture();

    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const raw = new Database(journalDbPath, { readonly: true });
    try {
      const cols = columnNames(raw, 'journal');
      const runIdCount = cols.filter((c) => c === 'run_id').length;
      expect(runIdCount).toBe(1);
    } finally {
      raw.close();
    }
  });
});
