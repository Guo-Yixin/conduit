/**
 * Tests for deleteRun — remove a run's entire footprint by id (WI-481).
 *
 * deleteRun(runId) must:
 *   AC-1: Remove that run's rows from ALL 8 per-run tables (cards, station_outputs,
 *         outbox, active_workers, journal, card_log, work_summaries, runs) — no row
 *         with that run_id remains in any table after deletion.
 *   AC-2: Leave every other run's data untouched (cross-run isolation).
 *   AC-3: Be atomic — a partially-deleted run footprint is never observable.
 *   AC-4: Be a safe no-op for an unknown run id — deletes nothing, does not throw.
 *
 * Two physical DB files: state DB (cards, station_outputs, outbox, active_workers,
 * runs) and journal DB (journal, card_log, work_summaries). Each gets its own
 * transaction because SQLite cannot span transactions across database files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from './db';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-del-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = openConduitDB({ stateDbPath, journalDbPath });
});

afterEach(() => {
  try { db?.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers: seed per-run rows into each table for a given run_id.
// These use the raw stateDb / journalDb connections via getStateDb() and a
// second raw connection to journalDbPath, matching how the impl works.
// ---------------------------------------------------------------------------

function seedStateRows(runId: string, tag: string): void {
  const raw = db.getStateDb();

  raw.prepare(
    `INSERT INTO runs (run_id, flow, input_fingerprint, status)
     VALUES ($r, 'studio', 'fp-${tag}', 'running')`
  ).run({ $r: runId });

  raw.prepare(
    `INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count)
     VALUES ($r, 'card-${tag}', NULL, 'brief', 'ready', 0, 0, '[]', 0)`
  ).run({ $r: runId });

  raw.prepare(
    `INSERT INTO station_outputs (run_id, card_id, station, attempt, findings_hash)
     VALUES ($r, 'card-${tag}', 'brief', 0, 'h-${tag}')`
  ).run({ $r: runId });

  raw.prepare(
    `INSERT INTO outbox (run_id, idempotency_key, payload_json)
     VALUES ($r, 'key-${tag}', '{}')`
  ).run({ $r: runId });

  raw.prepare(
    `INSERT INTO active_workers (run_id, card_id, station, worker_id, lease_until)
     VALUES ($r, 'card-${tag}', 'brief', 'w-${tag}', 9999)`
  ).run({ $r: runId });
}

function seedJournalRows(runId: string, tag: string): void {
  // Journal DB is only accessible via a raw connection (separate file).
  const raw = new Database(journalDbPath);
  try {
    raw.prepare(
      `INSERT INTO journal (run_id, card_id, station, attempt, name)
       VALUES ($r, 'card-${tag}', 'brief', 0, 'brief.run')`
    ).run({ $r: runId });

    raw.prepare(
      `INSERT INTO card_log (run_id, card_id, station, attempt, kind, source_lane, dest_lane, reason_class)
       VALUES ($r, 'card-${tag}', 'brief', 0, 'entered_lane', 'intake', 'brief', 'forward')`
    ).run({ $r: runId });

    raw.prepare(
      `INSERT INTO work_summaries (run_id, card_id, station, attempt, summary)
       VALUES ($r, 'card-${tag}', 'brief', 0, 'summary-${tag}')`
    ).run({ $r: runId });
  } finally {
    raw.close();
  }
}

/**
 * Seed a checkpoints row. The checkpoints table is owned by the checkpoint
 * layer (ensureCheckpointSchema), NOT by openConduitDB — so create it on the
 * state DB first, matching the table the executor wires at runtime. We CREATE
 * the table inline here (mirroring checkpoint.ts) rather than importing
 * ensureCheckpointSchema so this deleteRun test stays decoupled from the
 * checkpoint module's DDL helper.
 */
function ensureCheckpointTable(): void {
  db.getStateDb().exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id        TEXT NOT NULL DEFAULT 'default',
      flow          TEXT NOT NULL,
      card          TEXT NOT NULL,
      station       TEXT NOT NULL,
      attempt       INTEGER NOT NULL,
      binding_stamp TEXT NOT NULL,
      output_json   TEXT NOT NULL,
      PRIMARY KEY (run_id, flow, card, station, attempt)
    );
  `);
}

function seedCheckpointRow(runId: string, tag: string): void {
  const raw = db.getStateDb();
  ensureCheckpointTable();
  raw.prepare(
    `INSERT OR REPLACE INTO checkpoints (run_id, flow, card, station, attempt, binding_stamp, output_json)
     VALUES ($r, 'studio', 'card-${tag}', 'brief', 0, 'stamp-${tag}', '{}')`
  ).run({ $r: runId });
}

function countCheckpointRows(runId: string): number {
  const raw = db.getStateDb();
  return (
    raw.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = $r`).get({ $r: runId }) as {
      n: number;
    }
  ).n;
}

function countStateRows(runId: string): Record<string, number> {
  const raw = db.getStateDb();
  const count = (table: string) =>
    (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = $r`).get({ $r: runId }) as { n: number }).n;
  return {
    runs: count('runs'),
    cards: count('cards'),
    station_outputs: count('station_outputs'),
    outbox: count('outbox'),
    active_workers: count('active_workers'),
  };
}

function countJournalRows(runId: string): Record<string, number> {
  const raw = new Database(journalDbPath, { readonly: true });
  try {
    const count = (table: string) =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = $r`).get({ $r: runId }) as { n: number }).n;
    return {
      journal: count('journal'),
      card_log: count('card_log'),
      work_summaries: count('work_summaries'),
    };
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// AC-1: deleteRun removes rows from all 8 per-run tables.
// ---------------------------------------------------------------------------

describe('WI-481 AC-1: deleteRun removes all rows for the given run_id', () => {
  it('removes the run record from the runs table', () => {
    seedStateRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countStateRows('run-del').runs).toBe(0);
  });

  it('removes all card rows for the run', () => {
    seedStateRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countStateRows('run-del').cards).toBe(0);
  });

  it('removes all station_outputs rows for the run', () => {
    seedStateRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countStateRows('run-del').station_outputs).toBe(0);
  });

  it('removes all outbox rows for the run', () => {
    seedStateRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countStateRows('run-del').outbox).toBe(0);
  });

  it('removes all active_workers rows for the run', () => {
    seedStateRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countStateRows('run-del').active_workers).toBe(0);
  });

  it('removes all journal rows for the run', () => {
    seedStateRows('run-del', 'A');
    seedJournalRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countJournalRows('run-del').journal).toBe(0);
  });

  it('removes all card_log rows for the run', () => {
    seedStateRows('run-del', 'A');
    seedJournalRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countJournalRows('run-del').card_log).toBe(0);
  });

  it('removes all work_summaries rows for the run', () => {
    seedStateRows('run-del', 'A');
    seedJournalRows('run-del', 'A');
    db.deleteRun('run-del');
    expect(countJournalRows('run-del').work_summaries).toBe(0);
  });

  it('removes rows from all 8 tables in a single call (no row with run_id survives)', () => {
    seedStateRows('run-full', 'F');
    seedJournalRows('run-full', 'F');

    db.deleteRun('run-full');

    const state = countStateRows('run-full');
    const journal = countJournalRows('run-full');

    expect(state.runs).toBe(0);
    expect(state.cards).toBe(0);
    expect(state.station_outputs).toBe(0);
    expect(state.outbox).toBe(0);
    expect(state.active_workers).toBe(0);
    expect(journal.journal).toBe(0);
    expect(journal.card_log).toBe(0);
    expect(journal.work_summaries).toBe(0);
  });

  it('removes multiple cards when a run has more than one', () => {
    const raw = db.getStateDb();
    raw.prepare(
      `INSERT INTO runs (run_id, flow, input_fingerprint, status) VALUES ('run-multi', 'f', 'fp', 'running')`
    ).run();
    for (const id of ['c1', 'c2', 'c3']) {
      raw.prepare(
        `INSERT INTO cards (run_id, id, parent_id, lane, status, attempt, wave, owned_paths, rework_count)
         VALUES ('run-multi', '${id}', NULL, 'brief', 'ready', 0, 0, '[]', 0)`
      ).run();
    }

    db.deleteRun('run-multi');
    expect(countStateRows('run-multi').cards).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2: deleteRun leaves other runs' data untouched.
// ---------------------------------------------------------------------------

describe('WI-481 AC-2: deleteRun leaves other runs untouched', () => {
  it('run B state rows are unchanged after deleting run A', () => {
    seedStateRows('run-A', 'A');
    seedStateRows('run-B', 'B');

    const beforeB = countStateRows('run-B');
    db.deleteRun('run-A');
    const afterB = countStateRows('run-B');

    expect(afterB.runs).toBe(beforeB.runs);
    expect(afterB.cards).toBe(beforeB.cards);
    expect(afterB.station_outputs).toBe(beforeB.station_outputs);
    expect(afterB.outbox).toBe(beforeB.outbox);
    expect(afterB.active_workers).toBe(beforeB.active_workers);
  });

  it('run B journal rows are unchanged after deleting run A', () => {
    seedStateRows('run-A', 'A');
    seedJournalRows('run-A', 'A');
    seedStateRows('run-B', 'B');
    seedJournalRows('run-B', 'B');

    const beforeB = countJournalRows('run-B');
    db.deleteRun('run-A');
    const afterB = countJournalRows('run-B');

    expect(afterB.journal).toBe(beforeB.journal);
    expect(afterB.card_log).toBe(beforeB.card_log);
    expect(afterB.work_summaries).toBe(beforeB.work_summaries);
  });

  it('DEFAULT_RUN_ID rows survive deletion of a non-default run', () => {
    seedStateRows(DEFAULT_RUN_ID, 'def');
    seedJournalRows(DEFAULT_RUN_ID, 'def');
    seedStateRows('run-other', 'other');
    seedJournalRows('run-other', 'other');

    db.deleteRun('run-other');

    const stateDefault = countStateRows(DEFAULT_RUN_ID);
    const journalDefault = countJournalRows(DEFAULT_RUN_ID);

    expect(stateDefault.runs).toBe(1);
    expect(stateDefault.cards).toBe(1);
    expect(journalDefault.journal).toBe(1);
    expect(journalDefault.card_log).toBe(1);
    expect(journalDefault.work_summaries).toBe(1);
  });

  it('deleting one of three runs leaves the other two fully intact', () => {
    for (const [id, tag] of [['run-1', '1'], ['run-2', '2'], ['run-3', '3']]) {
      seedStateRows(id, tag);
      seedJournalRows(id, tag);
    }

    db.deleteRun('run-2');

    // run-2 is gone
    const del = { ...countStateRows('run-2'), ...countJournalRows('run-2') };
    for (const n of Object.values(del)) expect(n).toBe(0);

    // run-1 and run-3 intact
    for (const runId of ['run-1', 'run-3']) {
      expect(countStateRows(runId).runs).toBe(1);
      expect(countStateRows(runId).cards).toBe(1);
      expect(countJournalRows(runId).journal).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: deleteRun is atomic — no partial footprint observable.
// ---------------------------------------------------------------------------

describe('WI-481 AC-3: deleteRun is atomic across state tables', () => {
  it('after deleteRun completes, no state table retains the run_id', () => {
    seedStateRows('run-atomic', 'at');
    db.deleteRun('run-atomic');

    // All or nothing — every state table must be 0.
    const counts = countStateRows('run-atomic');
    expect(counts.runs + counts.cards + counts.station_outputs + counts.outbox + counts.active_workers).toBe(0);
  });

  it('after deleteRun completes, no journal table retains the run_id', () => {
    seedStateRows('run-atomic2', 'at2');
    seedJournalRows('run-atomic2', 'at2');
    db.deleteRun('run-atomic2');

    const counts = countJournalRows('run-atomic2');
    expect(counts.journal + counts.card_log).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: deleteRun for an unknown run id is a safe no-op.
// ---------------------------------------------------------------------------

describe('WI-481 AC-4: deleteRun on unknown run id is a no-op', () => {
  it('does not throw for a run id that was never inserted', () => {
    expect(() => db.deleteRun('no-such-run')).not.toThrow();
  });

  it('does not throw even when the DB is completely empty', () => {
    expect(() => db.deleteRun('phantom-run')).not.toThrow();
  });

  it('leaves existing runs untouched when deleting a non-existent run id', () => {
    seedStateRows('run-real', 'real');
    const before = countStateRows('run-real');

    db.deleteRun('run-ghost');

    const after = countStateRows('run-real');
    expect(after.runs).toBe(before.runs);
    expect(after.cards).toBe(before.cards);
  });

  it('calling deleteRun twice on the same id is safe (second call is also a no-op)', () => {
    seedStateRows('run-twice', 'tw');
    db.deleteRun('run-twice');
    expect(() => db.deleteRun('run-twice')).not.toThrow();
    expect(countStateRows('run-twice').runs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finding #3: deleteRun must also remove the run's checkpoints rows, otherwise
// a later run reusing the same (run_id, flow, card, station, attempt) reads a
// stale binding stamp and skips-on-resume over deleted work.
// ---------------------------------------------------------------------------

describe('finding #3: deleteRun removes checkpoints rows', () => {
  it('removes all checkpoints rows for the deleted run', () => {
    seedStateRows('run-cp', 'cp');
    seedCheckpointRow('run-cp', 'cp');
    expect(countCheckpointRows('run-cp')).toBe(1);

    db.deleteRun('run-cp');

    expect(countCheckpointRows('run-cp')).toBe(0);
  });

  it("leaves another run's checkpoints rows untouched", () => {
    seedStateRows('run-cp-A', 'cpa');
    seedCheckpointRow('run-cp-A', 'cpa');
    seedStateRows('run-cp-B', 'cpb');
    seedCheckpointRow('run-cp-B', 'cpb');

    db.deleteRun('run-cp-A');

    expect(countCheckpointRows('run-cp-A')).toBe(0);
    expect(countCheckpointRows('run-cp-B')).toBe(1);
  });

  it('is a safe no-op when the checkpoints table was never created', () => {
    // openConduitDB does NOT create the checkpoints table — only the executor
    // (ensureCheckpointSchema) does. deleteRun must not throw on such a DB.
    seedStateRows('run-no-cp', 'nocp');
    expect(() => db.deleteRun('run-no-cp')).not.toThrow();
    expect(countStateRows('run-no-cp').runs).toBe(0);
  });

  it('is re-runnable after deleting checkpoints with no cross-run damage', () => {
    seedStateRows('run-rerun', 'rr');
    seedCheckpointRow('run-rerun', 'rr');
    seedStateRows('run-keep', 'keep');
    seedCheckpointRow('run-keep', 'keep');

    db.deleteRun('run-rerun');
    expect(() => db.deleteRun('run-rerun')).not.toThrow();

    expect(countCheckpointRows('run-rerun')).toBe(0);
    expect(countCheckpointRows('run-keep')).toBe(1);
    expect(countStateRows('run-keep').runs).toBe(1);
  });
});
