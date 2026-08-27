/**
 * Tests for the ingress_events spawn-state machine + atomic accept-before-spawn
 * and the v3→v4 schema migration (WI-401, D1, NFR-2, FR-3).
 *
 * This is the durable correctness ledger that makes exactly-once triggering
 * possible: each accepted ingress event is recorded with a spawn_state and an
 * attempt count, written atomically so two concurrent deliveries of the same
 * event_id cannot both spawn a run.
 *
 * NOTE ON SCOPE — the existing src/persistence/db.test.ts already owns:
 *   - ingress_events.event_id PRIMARY KEY + recordIngressEvent duplicate-throws
 *   - the v0 (fresh) and v2 (rework_count) migration branches in isolation
 *   - the incompatible-version (999999) schema-mismatch throw
 * This file deliberately does NOT re-cover those. It pins the NEW surface:
 * the spawn-state accessors, the v3→v4 migration, and the 2→3→4 chain.
 *
 * Contract this file pins for src/persistence/db.ts (extends ConduitDB):
 *
 *   export type IngressSpawnState = 'accepted' | 'spawned' | 'failed';
 *
 *   // snake_case fields, mirroring the Card record returned by getCard.
 *   // event_id is REQUIRED (listRedrivable callers need it to re-spawn).
 *   export interface IngressEventRecord {
 *     event_id: string;
 *     received_at: number;
 *     spawn_state: IngressSpawnState;
 *     spawn_attempts: number;
 *   }
 *
 *   export interface IngressAcceptResult {
 *     // true  → this call won the accept (fresh insert OR re-drive of a failed
 *     //         row); caller should spawn.
 *     // false → an 'accepted'/'spawned' row already exists; suppress the spawn.
 *     accepted: boolean;
 *   }
 *
 *   // ConduitDB gains:
 *   acceptIngressEvent(eventId: string, receivedAt: number): IngressAcceptResult; // single atomic stmt
 *   incrementSpawnAttempts(eventId: string): void;  // spawn_attempts += 1, state UNCHANGED
 *   markIngressSpawned(eventId: string): void;   // 'accepted' → 'spawned', attempts UNCHANGED
 *   markIngressFailed(eventId: string): void;    // → 'failed', attempts UNCHANGED (no double-count)
 *   getIngressEvent(eventId: string): IngressEventRecord | null;
 *   listRedrivable(cap: number): IngressEventRecord[]; // 'accepted'|'failed' with spawn_attempts < cap
 *
 * ATTEMPT-COUNTING CONTRACT (WI-406 AC3, Q2 — reconciled): spawn_attempts is the
 * count of spawn ATTEMPTS, incremented exactly once BEFORE each attempt via
 * incrementSpawnAttempts (keeping state='accepted' so a crash mid-spawn leaves a
 * recoverable 'accepted' row with the attempt already counted). The terminal
 * transitions markIngressSpawned / markIngressFailed therefore do NOT touch
 * spawn_attempts — incrementing in markIngressFailed too would double-count the
 * attempt. This supersedes the original WI-401 "markIngressFailed increments"
 * behaviour; B.A. (WI-406) reconciles db.ts to match.
 *
 * Migration (db.ts ~762-789): SCHEMA_VERSION bumps 3→4. openConduitDB gains a NEW
 * `user_version === 3` branch that runs, each in the existing duplicate-column
 * try/catch:
 *   ALTER TABLE ingress_events ADD COLUMN spawn_state   TEXT    NOT NULL DEFAULT 'accepted'
 *   ALTER TABLE ingress_events ADD COLUMN spawn_attempts INTEGER NOT NULL DEFAULT 0
 * then stamps user_version = SCHEMA_VERSION. The v2 branch chains forward so a v2
 * DB migrates 2→3→4 in one open. Both columns are also added to STATE_DDL so a
 * fresh (v0) DB gets them directly.
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
  type IngressEventRecord,
} from './db';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let opened: ConduitDB[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-ingress-'));
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

/** Open (or migrate) the DB at the shared paths and track it for cleanup. */
function open(): ConduitDB {
  const d = openConduitDB({ stateDbPath, journalDbPath });
  opened.push(d);
  return d;
}

/** Assert a stored event exists and return its narrowed record (fails loud otherwise). */
function expectRecord(db: ConduitDB, eventId: string): IngressEventRecord {
  const rec = db.getIngressEvent(eventId);
  expect(rec).not.toBeNull();
  if (rec === null) throw new Error(`expected a stored ingress event for ${eventId}`);
  return rec;
}

/**
 * Drive an event through n full accept→attempt→fail cycles, leaving
 * spawn_attempts === n, state 'failed'. The attempt is counted by
 * incrementSpawnAttempts BEFORE the (simulated) spawn; markIngressFailed only
 * sets the terminal state and does NOT itself increment.
 */
function failCycles(db: ConduitDB, eventId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    db.acceptIngressEvent(eventId, 1000 + i); // i===0 inserts; later iters re-drive the failed row
    db.incrementSpawnAttempts(eventId); // count this attempt (state stays 'accepted')
    db.markIngressFailed(eventId); // terminal state only — no increment here
  }
}

// ---------------------------------------------------------------------------
// Build a legacy state DB at a chosen user_version, so the migration ladder can
// be exercised against a realistic on-disk predecessor.
// ---------------------------------------------------------------------------

/** ingress_events as shipped before WI-401 (no spawn_state / spawn_attempts). */
const OLD_INGRESS_DDL =
  'CREATE TABLE ingress_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)';

/** cards as shipped at v2 — BEFORE the v2→v3 rework_count column was added. */
const OLD_CARDS_DDL_V2 = `CREATE TABLE cards (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  lane        TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 0,
  wave        INTEGER NOT NULL DEFAULT 0,
  owned_paths TEXT NOT NULL DEFAULT '[]'
)`;

function makeLegacyStateDb(userVersion: number, ddls: string[]): void {
  const raw = new Database(stateDbPath);
  try {
    for (const ddl of ddls) raw.exec(ddl);
    raw.exec(`PRAGMA user_version = ${userVersion}`);
  } finally {
    raw.close();
  }
}

function columnNames(table: string): string[] {
  const raw = new Database(stateDbPath, { readonly: true });
  try {
    return raw
      .query(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => (r as { name: string }).name);
  } finally {
    raw.close();
  }
}

function persistedUserVersion(): number {
  const raw = new Database(stateDbPath, { readonly: true });
  try {
    return (raw.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    raw.close();
  }
}

function ingressRowCount(): number {
  const raw = new Database(stateDbPath, { readonly: true });
  try {
    return (raw.query('SELECT COUNT(*) AS n FROM ingress_events').get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

// ===========================================================================
// AC1 — atomic accept-before-spawn
// ===========================================================================

describe('acceptIngressEvent (AC1 — atomic accept-before-spawn)', () => {
  it('inserts a fresh event as accepted/0 and reports the insert won', () => {
    const db = open();
    const result = db.acceptIngressEvent('evt-1', 1000);
    expect(result.accepted).toBe(true);

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('accepted');
    expect(rec.spawn_attempts).toBe(0);
  });

  it('reports a duplicate for a second accept of the same event_id and keeps exactly one row', () => {
    const db = open();
    expect(db.acceptIngressEvent('evt-1', 1000).accepted).toBe(true);
    // A concurrent re-delivery must NOT win a second spawn.
    expect(db.acceptIngressEvent('evt-1', 2000).accepted).toBe(false);
    expect(ingressRowCount()).toBe(1);
  });

  it('admits exactly one winner across many same-id accepts (no read-then-write race)', () => {
    const db = open();
    const outcomes = Array.from({ length: 5 }, () => db.acceptIngressEvent('evt-hot', 1000).accepted);
    expect(outcomes.filter((won) => won === true)).toHaveLength(1);
    expect(outcomes.filter((won) => won === false)).toHaveLength(4);
    expect(ingressRowCount()).toBe(1);
  });
});

// ===========================================================================
// AC2 — spawn_state transitions
// ===========================================================================

describe('spawn_state transitions (AC2)', () => {
  it('markIngressSpawned moves an accepted row to spawned', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    db.markIngressSpawned('evt-1');
    expect(expectRecord(db, 'evt-1').spawn_state).toBe('spawned');
  });

  // ── Attempt-counting contract (WI-406 AC3 / Q2, reconciled) ──────────────
  // incrementSpawnAttempts is the SOLE increment point and runs before the spawn
  // (keeping state 'accepted'); the terminal transitions do not double-count.

  it('incrementSpawnAttempts increments spawn_attempts while keeping state accepted', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000); // accepted, 0
    db.incrementSpawnAttempts('evt-1');

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('accepted'); // still recoverable before spawn (WI-406 AC8)
    expect(rec.spawn_attempts).toBe(1); // initial attempt counts as 1, not 0
  });

  it('markIngressSpawned leaves spawn_attempts unchanged (success keeps attempts at 1)', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    db.incrementSpawnAttempts('evt-1'); // attempt 1
    db.markIngressSpawned('evt-1');

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('spawned');
    expect(rec.spawn_attempts).toBe(1);
  });

  it('markIngressFailed moves the row to failed WITHOUT double-counting the attempt', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    db.incrementSpawnAttempts('evt-1'); // attempt already counted → 1
    db.markIngressFailed('evt-1');

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('failed');
    expect(rec.spawn_attempts).toBe(1); // NOT 2 — markIngressFailed must not increment
  });

  it('accumulates one spawn_attempt per accept→attempt→fail re-drive cycle', () => {
    const db = open();
    failCycles(db, 'evt-1', 3); // increments once per cycle via incrementSpawnAttempts

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('failed');
    expect(rec.spawn_attempts).toBe(3);
  });
});

// ===========================================================================
// AC3 — duplicate suppression vs. failed-row re-drive (FR-3)
// ===========================================================================

describe('duplicate suppression vs re-drive (AC3, FR-3)', () => {
  it('treats an already-accepted event as a duplicate (suppresses re-spawn)', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    expect(db.acceptIngressEvent('evt-1', 2000).accepted).toBe(false);
  });

  it('treats a spawned event as a duplicate (suppresses re-spawn)', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    db.markIngressSpawned('evt-1');
    expect(db.acceptIngressEvent('evt-1', 2000).accepted).toBe(false);
  });

  it('does NOT treat a failed event as a duplicate — it is re-drivable, preserving attempts', () => {
    const db = open();
    db.acceptIngressEvent('evt-1', 1000);
    db.incrementSpawnAttempts('evt-1'); // attempt 1 counted before the (failed) spawn
    db.markIngressFailed('evt-1'); // state=failed, attempts=1

    // Re-driving the failed row wins the accept and returns it to 'accepted'.
    expect(db.acceptIngressEvent('evt-1', 3000).accepted).toBe(true);

    const rec = expectRecord(db, 'evt-1');
    expect(rec.spawn_state).toBe('accepted');
    // The attempt count from the prior failure is preserved so the cap still bites.
    expect(rec.spawn_attempts).toBe(1);
  });
});

// ===========================================================================
// AC4 — getIngressEvent + listRedrivable (boot recovery)
// ===========================================================================

describe('getIngressEvent (AC4)', () => {
  it('returns null for an unknown event_id', () => {
    const db = open();
    expect(db.getIngressEvent('nope')).toBeNull();
  });

  it('returns the stored spawn_state and spawn_attempts for a known event', () => {
    const db = open();
    failCycles(db, 'evt-1', 2); // failed, attempts=2
    expect(expectRecord(db, 'evt-1')).toMatchObject({
      event_id: 'evt-1',
      spawn_state: 'failed',
      spawn_attempts: 2,
    });
  });
});

describe('listRedrivable (AC4 — boot recovery)', () => {
  it('returns accepted and failed rows under the cap, excluding spawned and over-cap rows', () => {
    const db = open();

    db.acceptIngressEvent('evt-accepted', 1000); // accepted, attempts 0 → included

    db.acceptIngressEvent('evt-spawned', 1000);
    db.markIngressSpawned('evt-spawned'); //               spawned          → excluded

    failCycles(db, 'evt-failed-under', 1); // failed, attempts 1 → included (1 < 3)
    failCycles(db, 'evt-failed-over', 3); //  failed, attempts 3 → excluded (3 < 3 is false)

    const ids = db.listRedrivable(3).map((r) => r.event_id);

    expect(ids).toContain('evt-accepted');
    expect(ids).toContain('evt-failed-under');
    expect(ids).not.toContain('evt-spawned');
    expect(ids).not.toContain('evt-failed-over');
    expect(ids).toHaveLength(2);
  });

  it('returns rows in received_at order so a queued burst launches in arrival order (the original listener-backpressure work)', () => {
    const db = open();
    // Insert out of arrival order — the ORDER BY must do the work, not insert order.
    db.acceptIngressEvent('evt-third', 3000);
    db.acceptIngressEvent('evt-first', 1000);
    db.acceptIngressEvent('evt-second', 2000);

    const ids = db.listRedrivable(3).map((r) => r.event_id);
    expect(ids).toEqual(['evt-first', 'evt-second', 'evt-third']);
  });
});

// ===========================================================================
// AC5 / AC6 — schema migration ladder (v0 fresh, v3 additive, v2→3→4 chain)
// ===========================================================================

describe('schema migration to v4 (AC5, AC6)', () => {
  it('bumps SCHEMA_VERSION beyond the prior shipped version (3)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(3);
  });

  it('creates a fresh (v0) DB with spawn_state and spawn_attempts already present (AC7)', () => {
    const db = open();
    db.close();

    const cols = columnNames('ingress_events');
    expect(cols).toContain('spawn_state');
    expect(cols).toContain('spawn_attempts');
    expect(persistedUserVersion()).toBe(SCHEMA_VERSION);
  });

  it('migrates a shipped v3 DB additively — adds both columns, preserves rows, no schema-mismatch throw', () => {
    // A shipped MVP DB: ingress_events at the old shape, stamped user_version 3,
    // carrying a pre-existing accepted event.
    makeLegacyStateDb(3, [
      OLD_INGRESS_DDL,
      "INSERT INTO ingress_events (event_id, received_at) VALUES ('legacy-evt', 500)",
    ]);

    expect(() => open()).not.toThrow();

    const db = opened[0]!;
    // The pre-existing row gains the DEFAULTs from the additive ALTERs.
    expect(expectRecord(db, 'legacy-evt')).toMatchObject({
      event_id: 'legacy-evt',
      spawn_state: 'accepted',
      spawn_attempts: 0,
    });
    db.close();

    const cols = columnNames('ingress_events');
    expect(cols).toContain('spawn_state');
    expect(cols).toContain('spawn_attempts');
    expect(persistedUserVersion()).toBe(SCHEMA_VERSION);
  });

  it('chains a v2 DB forward through 2→3→4 in a single open', () => {
    // A v2 DB: cards WITHOUT rework_count, ingress_events at the old shape.
    makeLegacyStateDb(2, [OLD_CARDS_DDL_V2, OLD_INGRESS_DDL]);

    expect(() => open()).not.toThrow();
    opened[0]!.close();

    // v2→v3 migration applied: cards gained rework_count.
    expect(columnNames('cards')).toContain('rework_count');
    // v3→v4 migration applied in the same open: ingress_events gained both columns.
    const ingressCols = columnNames('ingress_events');
    expect(ingressCols).toContain('spawn_state');
    expect(ingressCols).toContain('spawn_attempts');
    // Stamped to the current head version, not left at an intermediate.
    expect(persistedUserVersion()).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — a v3 DB whose ingress_events already has spawn_state does not throw (duplicate-column caught)', () => {
    // Simulates a crash mid-migration: spawn_state already added, spawn_attempts
    // not yet, user_version still 3. Re-opening must catch the duplicate column
    // and complete, not abort.
    makeLegacyStateDb(3, [
      'CREATE TABLE ingress_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, ' +
        "spawn_state TEXT NOT NULL DEFAULT 'accepted')",
    ]);

    expect(() => open()).not.toThrow();
    opened[0]!.close();

    const cols = columnNames('ingress_events');
    expect(cols).toContain('spawn_state');
    expect(cols).toContain('spawn_attempts');
    expect(persistedUserVersion()).toBe(SCHEMA_VERSION);
  });
});

// ===========================================================================
// AC7 — no regression for the existing recordIngressEvent / PK dedup path
// ===========================================================================

describe('recordIngressEvent regression on the extended schema (AC7)', () => {
  it('still inserts via recordIngressEvent, defaulting the new columns to accepted/0', () => {
    const db = open();
    db.recordIngressEvent('evt-legacy-path', 1234);
    expect(expectRecord(db, 'evt-legacy-path')).toMatchObject({
      event_id: 'evt-legacy-path',
      spawn_state: 'accepted',
      spawn_attempts: 0,
    });
  });

  it('still rejects a duplicate event_id on the PRIMARY KEY after the schema extension', () => {
    const db = open();
    db.recordIngressEvent('evt-dup', 1000);
    expect(() => db.recordIngressEvent('evt-dup', 2000)).toThrow();
  });
});
