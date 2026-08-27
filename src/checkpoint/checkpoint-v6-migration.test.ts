/**
 * Regression test for the checkpoints table v5→v6 migration.
 *
 * Bug: on an EXISTING v5 database the `checkpoints` table already has the OLD
 * schema (no `run_id` column, PK on (flow, card, station, attempt)). The
 * `CREATE TABLE IF NOT EXISTS` in ensureCheckpointSchema is a NO-OP, leaving
 * the old schema in place. Subsequent calls to writeCheckpoint/readCheckpoint
 * (which reference `run_id` in their SQL) throw "no such column: run_id".
 *
 * Fix contract:
 *   1. ensureCheckpointSchema detects the old schema and runs a RECREATE-AND-COPY.
 *   2. Legacy rows survive with run_id backfilled to DEFAULT_RUN_ID ('default').
 *   3. writeCheckpoint / readCheckpoint round-trip successfully after migration.
 *   4. A second call to ensureCheckpointSchema is a no-op (idempotent).
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  ensureCheckpointSchema,
  writeCheckpoint,
  readCheckpoint,
  computeBindingStamp,
} from './checkpoint';
import type { CheckpointKey, BindingStampInputs } from './checkpoint';
import { DEFAULT_RUN_ID } from '../persistence/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hand-creates the OLD (v5) checkpoints schema — no run_id, 4-column PK. */
function createOldCheckpointsTable(db: Database): void {
  db.exec(`
    CREATE TABLE checkpoints (
      flow          TEXT NOT NULL,
      card          TEXT NOT NULL,
      station       TEXT NOT NULL,
      attempt       INTEGER NOT NULL,
      binding_stamp TEXT NOT NULL,
      output_json   TEXT NOT NULL,
      PRIMARY KEY (flow, card, station, attempt)
    )
  `);
}

/** Returns column names for a table via PRAGMA table_info. */
function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

const STAMP_INPUTS: BindingStampInputs = {
  modelId: 'gpt-4o',
  promptTemplateVersion: 'v3',
  inputArtifactHashes: ['hashA', 'hashB'],
  flowVersion: 7,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoints v5→v6 migration', () => {
  it('fails with "no such column: run_id" on OLD schema BEFORE the fix', () => {
    // This test documents the bug. We set up the old schema, call
    // ensureCheckpointSchema (which was previously a no-op), then try to
    // writeCheckpoint and expect it to throw — proving the bug exists before
    // the fix. After the fix this same sequence should NOT throw.
    //
    // Because we want this test to PASS after the fix, we assert the FIXED
    // behavior (no throw). The comment documents what used to happen.
    const db = new Database(':memory:');
    try {
      createOldCheckpointsTable(db);

      // Insert a legacy checkpoint row the old way.
      db.exec(`
        INSERT INTO checkpoints (flow, card, station, attempt, binding_stamp, output_json)
        VALUES ('ref', 'card-1', 'render', 0, 'legacy-stamp', '{"payload":{"v":"legacy"}}')
      `);

      // After ensureCheckpointSchema the table MUST have run_id.
      ensureCheckpointSchema(db);

      const cols = columnNames(db, 'checkpoints');
      expect(cols).toContain('run_id');
    } finally {
      db.close();
    }
  });

  it('migrates the checkpoints table: run_id column is present after ensureCheckpointSchema on old schema', () => {
    const db = new Database(':memory:');
    try {
      createOldCheckpointsTable(db);

      // Verify it really starts without run_id.
      expect(columnNames(db, 'checkpoints')).not.toContain('run_id');

      ensureCheckpointSchema(db);

      // After migration run_id must exist.
      expect(columnNames(db, 'checkpoints')).toContain('run_id');
    } finally {
      db.close();
    }
  });

  it('backfills legacy rows with run_id = DEFAULT_RUN_ID after migration', () => {
    const db = new Database(':memory:');
    try {
      createOldCheckpointsTable(db);

      // Two legacy rows.
      db.exec(`
        INSERT INTO checkpoints (flow, card, station, attempt, binding_stamp, output_json)
        VALUES
          ('ref', 'card-1', 'render',   0, 'stamp-A', '{"payload":{"n":1}}'),
          ('ref', 'card-2', 'critique', 1, 'stamp-B', '{"payload":{"n":2}}')
      `);

      ensureCheckpointSchema(db);

      // All rows must now carry the default run id.
      const rows = db
        .prepare(`SELECT run_id FROM checkpoints`)
        .all() as { run_id: string }[];

      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.run_id).toBe(DEFAULT_RUN_ID);
      }
    } finally {
      db.close();
    }
  });

  it('writeCheckpoint and readCheckpoint round-trip successfully after migration (no "no such column: run_id")', () => {
    const db = new Database(':memory:');
    try {
      createOldCheckpointsTable(db);

      // Insert a legacy row.
      db.exec(`
        INSERT INTO checkpoints (flow, card, station, attempt, binding_stamp, output_json)
        VALUES ('ref', 'card-1', 'render', 0, 'legacy-stamp', '{"payload":{"v":"legacy"},"findings_hash":"fh0","return_to":null,"usage":{"tokens":5,"cost":0.001}}')
      `);

      ensureCheckpointSchema(db);

      // The migrated legacy row must be readable via readCheckpoint.
      const legacyKey: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };
      const legacy = readCheckpoint(db, legacyKey);
      expect(legacy).not.toBeNull();
      expect(legacy!.stamp).toBe('legacy-stamp');

      // Now write a NEW checkpoint under the default run and read it back.
      const newKey: CheckpointKey = { flow: 'ref', card: 'card-2', station: 'critique', attempt: 0 };
      const stamp = computeBindingStamp(STAMP_INPUTS);
      const output = {
        payload: { result: 'ok' },
        findings_hash: 'fh-1',
        return_to: null,
        usage: { tokens: 10, cost: 0.002 },
      };
      writeCheckpoint(db, newKey, { output, stamp });

      const retrieved = readCheckpoint(db, newKey);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.stamp).toBe(stamp);
      expect(retrieved!.output).toEqual(output);
    } finally {
      db.close();
    }
  });

  it('is idempotent: calling ensureCheckpointSchema twice on old schema does not throw and row count is stable', () => {
    const db = new Database(':memory:');
    try {
      createOldCheckpointsTable(db);

      db.exec(`
        INSERT INTO checkpoints (flow, card, station, attempt, binding_stamp, output_json)
        VALUES ('ref', 'card-1', 'render', 0, 'stamp-X', '{"payload":{"n":1},"findings_hash":"fh","return_to":null,"usage":{"tokens":5,"cost":0.001}}')
      `);

      ensureCheckpointSchema(db);

      // Second call must not throw and must not duplicate rows.
      expect(() => ensureCheckpointSchema(db)).not.toThrow();

      const { n } = db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number };
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is a no-op on an already-migrated (new-schema) DB: run_id still present, rows unchanged', () => {
    const db = new Database(':memory:');
    try {
      // Fresh new-schema DB.
      ensureCheckpointSchema(db);

      const key: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };
      const stamp = computeBindingStamp(STAMP_INPUTS);
      const output = {
        payload: { v: 1 },
        findings_hash: 'fh-ok',
        return_to: null,
        usage: { tokens: 3, cost: 0.001 },
      };
      writeCheckpoint(db, key, { output, stamp });

      // Second call — must be silent no-op.
      expect(() => ensureCheckpointSchema(db)).not.toThrow();

      // Data survives.
      expect(readCheckpoint(db, key)).toEqual({ output, stamp });
    } finally {
      db.close();
    }
  });
});
