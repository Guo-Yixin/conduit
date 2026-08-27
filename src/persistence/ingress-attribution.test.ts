/**
 * Tests for ingress event attribution + the v8→v9 schema migration (the original ingress-attribution work).
 *
 * v9 makes the ingress_events row self-sufficient for re-drive: the owning
 * flow (name + path), the derived run id, and the projected substrate payload
 * are persisted ATOMICALLY with the accept, so a listener restart — or a
 * periodic sweep on a listener hosting N flows — can relaunch any failed event
 * faithfully: right flow, right input, same run id.
 *
 * Contract pinned here (extends src/persistence/db.ts):
 *
 *   export interface IngressAttribution {
 *     flowId: string; flowPath: string; runId: string; substrateJson: string;
 *   }
 *
 *   // IngressEventRecord gains nullable flow_id / flow_path / run_id /
 *   // substrate_json (null on pre-v9 rows).
 *
 *   acceptIngressEvent(eventId, receivedAt, attribution?): IngressAcceptResult
 *   //  - attribution rides the SAME atomic statement as the accept;
 *   //  - failed→accepted re-drive with attribution overwrites, without preserves;
 *   //  - a losing accept ('accepted'/'spawned' row exists) writes NOTHING.
 *
 * Migration: SCHEMA_VERSION bumps 8→9; a `user_version === 8` branch adds the
 * four nullable columns via guarded additive ALTERs and stamps 9. Existing
 * rows survive with null attribution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openConduitDB,
  SCHEMA_VERSION,
  type ConduitDB,
  type IngressAttribution,
  type IngressEventRecord,
} from './db';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let opened: ConduitDB[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-ingress-attr-'));
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

function expectRecord(db: ConduitDB, eventId: string): IngressEventRecord {
  const rec = db.getIngressEvent(eventId);
  expect(rec).not.toBeNull();
  if (rec === null) throw new Error(`expected a stored ingress event for ${eventId}`);
  return rec;
}

const ATTR: IngressAttribution = {
  flowId: 'pic-edit',
  flowPath: '/flows/pic-edit/flow.yaml',
  runId: 'ig-Ev06ABC-deadbeef1234',
  substrateJson: '{"image_url":"https://files.slack/abc.jpg"}',
};

// ---------------------------------------------------------------------------
// Attribution semantics on the accept path
// ---------------------------------------------------------------------------

describe('acceptIngressEvent attribution (v9)', () => {
  it('persists attribution atomically with a winning fresh accept', () => {
    const db = open();
    const result = db.acceptIngressEvent('ev-1', 1000, ATTR);
    expect(result.accepted).toBe(true);

    const rec = expectRecord(db, 'ev-1');
    expect(rec.flow_id).toBe('pic-edit');
    expect(rec.flow_path).toBe('/flows/pic-edit/flow.yaml');
    expect(rec.run_id).toBe('ig-Ev06ABC-deadbeef1234');
    expect(rec.substrate_json).toBe('{"image_url":"https://files.slack/abc.jpg"}');
  });

  it('accepts without attribution (legacy callers) leaving null attribution', () => {
    const db = open();
    expect(db.acceptIngressEvent('ev-legacy', 1000).accepted).toBe(true);
    const rec = expectRecord(db, 'ev-legacy');
    expect(rec.flow_id).toBeNull();
    expect(rec.flow_path).toBeNull();
    expect(rec.run_id).toBeNull();
    expect(rec.substrate_json).toBeNull();
  });

  it('a losing accept (row already accepted) does NOT overwrite attribution', () => {
    const db = open();
    db.acceptIngressEvent('ev-2', 1000, ATTR);
    const losing = db.acceptIngressEvent('ev-2', 2000, {
      ...ATTR,
      flowId: 'other-flow',
      substrateJson: '{"different":true}',
    });
    expect(losing.accepted).toBe(false);
    expect(expectRecord(db, 'ev-2').flow_id).toBe('pic-edit');
  });

  it('a losing accept against a spawned row does NOT overwrite attribution', () => {
    const db = open();
    db.acceptIngressEvent('ev-3', 1000, ATTR);
    db.markIngressSpawned('ev-3');
    expect(db.acceptIngressEvent('ev-3', 2000, { ...ATTR, flowId: 'other' }).accepted).toBe(false);
    expect(expectRecord(db, 'ev-3').flow_id).toBe('pic-edit');
  });

  it('failed→accepted re-drive WITH attribution overwrites the stored values', () => {
    const db = open();
    db.acceptIngressEvent('ev-4', 1000, ATTR);
    db.incrementSpawnAttempts('ev-4');
    db.markIngressFailed('ev-4');

    const redrive = db.acceptIngressEvent('ev-4', 2000, {
      ...ATTR,
      flowPath: '/flows/pic-edit-moved/flow.yaml',
    });
    expect(redrive.accepted).toBe(true);
    const rec = expectRecord(db, 'ev-4');
    expect(rec.flow_path).toBe('/flows/pic-edit-moved/flow.yaml');
    // Attempts survive re-drive (the cap still bites) — pre-existing contract.
    expect(rec.spawn_attempts).toBe(1);
  });

  it('failed→accepted re-drive WITHOUT attribution preserves the stored values', () => {
    const db = open();
    db.acceptIngressEvent('ev-5', 1000, ATTR);
    db.incrementSpawnAttempts('ev-5');
    db.markIngressFailed('ev-5');

    expect(db.acceptIngressEvent('ev-5', 2000).accepted).toBe(true);
    const rec = expectRecord(db, 'ev-5');
    expect(rec.flow_id).toBe('pic-edit');
    expect(rec.run_id).toBe('ig-Ev06ABC-deadbeef1234');
    expect(rec.substrate_json).toBe('{"image_url":"https://files.slack/abc.jpg"}');
  });

  it('listRedrivable returns attribution on redrivable rows', () => {
    const db = open();
    db.acceptIngressEvent('ev-6', 1000, ATTR);
    db.incrementSpawnAttempts('ev-6');
    db.markIngressFailed('ev-6');

    const rows = db.listRedrivable(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flow_path).toBe('/flows/pic-edit/flow.yaml');
    expect(rows[0]!.run_id).toBe('ig-Ev06ABC-deadbeef1234');
    expect(rows[0]!.substrate_json).toBe(ATTR.substrateJson);
  });
});

// ---------------------------------------------------------------------------
// v8→v9 migration
// ---------------------------------------------------------------------------

/**
 * Build a realistic v8 state DB on disk: the pre-v9 ingress_events shape plus
 * a minimal runs table (v8's marker), stamped user_version = 8.
 */
function buildV8StateDb(): void {
  const raw = new Database(stateDbPath);
  raw.exec(`
    CREATE TABLE ingress_events (
      event_id       TEXT    PRIMARY KEY,
      received_at    INTEGER NOT NULL,
      spawn_state    TEXT    NOT NULL DEFAULT 'accepted',
      spawn_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE runs (
      run_id            TEXT PRIMARY KEY,
      flow              TEXT NOT NULL,
      project_root      TEXT,
      input_fingerprint TEXT NOT NULL,
      status            TEXT NOT NULL,
      outcome           TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      holder_pid        INTEGER,
      lease_acquired_at INTEGER
    );
  `);
  raw.exec(
    `INSERT INTO ingress_events (event_id, received_at, spawn_state, spawn_attempts)
     VALUES ('pre-v9-event', 999, 'failed', 2)`,
  );
  raw.exec('PRAGMA user_version = 8');
  raw.close();
}

describe('v8→v9 migration', () => {
  it('migrates a v8 DB: columns added, existing rows survive with null attribution, version stamped', () => {
    buildV8StateDb();
    const db = open();

    const rec = expectRecord(db, 'pre-v9-event');
    expect(rec.spawn_state).toBe('failed');
    expect(rec.spawn_attempts).toBe(2);
    expect(rec.flow_id).toBeNull();
    expect(rec.flow_path).toBeNull();
    expect(rec.run_id).toBeNull();
    expect(rec.substrate_json).toBeNull();

    db.close();
    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });

  it('migrated v8 rows accept new attribution on re-drive', () => {
    buildV8StateDb();
    const db = open();
    expect(db.acceptIngressEvent('pre-v9-event', 2000, ATTR).accepted).toBe(true);
    expect(expectRecord(db, 'pre-v9-event').flow_id).toBe('pic-edit');
  });

  it('re-opening a migrated DB is idempotent', () => {
    buildV8StateDb();
    open().close();
    const db = open(); // second open re-enters no migration branch
    expect(expectRecord(db, 'pre-v9-event').spawn_attempts).toBe(2);
  });
});
