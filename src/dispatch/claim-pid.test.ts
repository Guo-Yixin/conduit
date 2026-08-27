/**
 * Tests for dead-PID detection in reclaimOrphanedWorkers (WI-467, FR-5).
 *
 * Under K>1 a worker SUBPROCESS can die mid-run while the kernel process is
 * still alive and the (long) lease has not yet expired. Lease-expiry reconcile
 * (reconcile) will not catch it — the lease is still valid. reclaimOrphanedWorkers,
 * which today reclaims ALL claimed/working cards unconditionally on resume,
 * gains an OPTIONAL injectable `isPidAlive` predicate: when supplied, a slot is
 * reclaimed iff its owning PID is no longer alive (liveness pass); a live PID is
 * left untouched even though it occupies a slot. When the predicate is OMITTED,
 * the existing unconditional resume behavior is unchanged.
 *
 * Contract this file pins:
 *
 *   attemptClaim(db, req)                      // req.pid written into active_workers.pid
 *   reclaimOrphanedWorkers(db, now, isPidAlive?) // isPidAlive: (pid:number)=>boolean
 *
 * Persistence contract pinned here (db.ts):
 *   - SCHEMA_VERSION bumped 4 -> 5
 *   - active_workers gains a `pid INTEGER` column on a fresh DB
 *   - v4 DB (active_workers without pid, user_version=4) migrates IN PLACE to v5:
 *     the pid column is added, prior rows preserved with pid NULL, no recreate.
 *
 * The pid column is introspected with a raw bun:sqlite connection — the
 * assertion checks what is actually persisted, not a wrapper getter.
 *
 * `now` is epoch seconds and INJECTED so lease expiry is deterministic.
 * PID-liveness is INJECTED so no real processes are spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, SCHEMA_VERSION, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { attemptClaim, reconcile, reclaimOrphanedWorkers } from './claim';

const NOW = 1_000_000; // fixed epoch-seconds base
const LEASE = 600; // a long, still-valid lease — so lease-expiry never fires

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-claim-pid-'));
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

/**
 * Read the raw pid stored for a (card, station) slot, or undefined if absent.
 *
 * Reads through the PRIMARY connection (db.getStateDb()) — the same connection
 * the claim writes commit on — exactly as getActiveWorker does. A second
 * readonly bun:sqlite connection to the same WAL-mode file does not reliably
 * observe writes committed on the primary handle within a test, so the raw-
 * connection approach is avoided here.
 */
function pidOf(cardId: string, station: string): number | null | undefined {
  // bun:sqlite .get() returns null (not undefined) when no row matches, so
  // guard against both: a released/absent slot yields undefined.
  const row = db!
    .getStateDb()
    .query('SELECT pid FROM active_workers WHERE card_id = $c AND station = $s')
    .get({ $c: cardId, $s: station }) as { pid: number | null } | null | undefined;
  return row == null ? undefined : row.pid;
}

function columnNames(database: Database, table: string): string[] {
  return database
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => (r as { name: string }).name);
}

/** Claim a card and drive it to 'working' with a long, still-valid lease. */
function claimWorking(cardId: string, station: string, pid: number): void {
  db!.insertCard(makeCard({ id: cardId, status: 'ready' }));
  const result = attemptClaim(db!, {
    cardId,
    station,
    workerId: `w-${cardId}`,
    wipCap: 100,
    now: NOW,
    leaseSeconds: LEASE,
    pid,
  });
  expect(result.ok).toBe(true);
  // Move the card into 'working' so it models a worker subprocess running.
  db!.getStateDb().prepare("UPDATE cards SET status = 'working' WHERE id = $id").run({ $id: cardId });
}

// ---------------------------------------------------------------------------
// AC: attemptClaim records the claiming worker's pid into active_workers.pid
// ---------------------------------------------------------------------------

describe('attemptClaim — records pid (AC)', () => {
  it('writes the claiming worker pid into active_workers.pid', () => {
    db!.insertCard(makeCard({ id: 'c1' }));

    const result = attemptClaim(db!, {
      cardId: 'c1',
      station: 'work',
      workerId: 'w1',
      wipCap: 5,
      now: NOW,
      leaseSeconds: LEASE,
      pid: 42424,
    });

    expect(result.ok).toBe(true);
    expect(pidOf('c1', 'work')).toBe(42424);
  });
});

// ---------------------------------------------------------------------------
// AC: a dead PID with a still-valid lease IS reclaimed by the liveness pass.
// ---------------------------------------------------------------------------

describe('reclaimOrphanedWorkers — dead PID reclaimed despite valid lease (AC)', () => {
  it('flips a card whose owning PID is dead to interrupted even though lease_until > now', () => {
    claimWorking('c1', 'work', 9001);

    // PID 9001 is dead; lease is still valid (lease_until = NOW + 600 > NOW).
    const isPidAlive = (pid: number): boolean => pid !== 9001;

    const { reclaimed } = reclaimOrphanedWorkers(db!, NOW, isPidAlive);

    expect(reclaimed).toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
    // Slot released.
    expect(pidOf('c1', 'work')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC: a LIVE PID with a valid lease is left UNTOUCHED (no false reclaim).
// ---------------------------------------------------------------------------

describe('reclaimOrphanedWorkers — live PID not falsely reclaimed (AC)', () => {
  it('leaves a card whose owning PID is alive and lease valid untouched', () => {
    claimWorking('c1', 'work', 7777);

    // PID 7777 is alive and lease_until = NOW + 600 > NOW.
    const isPidAlive = (pid: number): boolean => pid === 7777;

    const { reclaimed } = reclaimOrphanedWorkers(db!, NOW, isPidAlive);

    expect(reclaimed).not.toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('working'); // unchanged
    expect(pidOf('c1', 'work')).toBe(7777); // slot still held
  });

  it('reclaims only the dead-PID card when a live and a dead worker coexist', () => {
    claimWorking('dead', 'work', 5000);
    claimWorking('live', 'work', 6000);

    const isPidAlive = (pid: number): boolean => pid === 6000; // 5000 is dead

    const { reclaimed } = reclaimOrphanedWorkers(db!, NOW, isPidAlive);

    expect(reclaimed).toEqual(['dead']);
    expect(db!.getCard(DEFAULT_RUN_ID, 'dead')!.status).toBe('interrupted');
    expect(db!.getCard(DEFAULT_RUN_ID, 'live')!.status).toBe('working');
    expect(pidOf('dead', 'work')).toBeUndefined();
    expect(pidOf('live', 'work')).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// AC: existing behavior is unchanged for existing callers — the dead-PID check
// is ADDITIVE. With no predicate, reclaimOrphanedWorkers stays unconditional.
// ---------------------------------------------------------------------------

describe('reclaimOrphanedWorkers — additive: no predicate => unconditional (AC)', () => {
  it('reclaims every in-flight card unconditionally when no isPidAlive is supplied', () => {
    claimWorking('c1', 'work', 1111);
    claimWorking('c2', 'work', 2222);

    // No predicate — the resume path. Both reclaimed regardless of PID/lease.
    const { reclaimed } = reclaimOrphanedWorkers(db!, NOW);

    expect(reclaimed.sort()).toEqual(['c1', 'c2']);
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c2')!.status).toBe('interrupted');
  });

  it('reconcile (lease-expiry) is unchanged — it does NOT reclaim a valid-lease card', () => {
    claimWorking('c1', 'work', 3333);

    // Lease is valid (NOW + 600 > NOW): reconcile must no-op regardless of PID.
    const { interrupted } = reconcile(db!, NOW);

    expect(interrupted).not.toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('working');
  });
});

// ---------------------------------------------------------------------------
// AC (#6): the predicate is IDENTITY-aware — it receives the slot's stored
// started_at so a recycled PID (same number, different process generation) can be
// detected, not just "does a process with this PID exist".
// ---------------------------------------------------------------------------

describe('reclaimOrphanedWorkers — predicate receives started_at for identity (#6)', () => {
  it('passes the slot started_at to the predicate alongside the pid', () => {
    claimWorking('c1', 'work', 4444); // claim stamps started_at = NOW

    const seen: Array<{ pid: number; startedAt: number }> = [];
    reclaimOrphanedWorkers(db!, NOW, (pid, startedAt) => {
      seen.push({ pid, startedAt });
      return true; // pretend alive so we can inspect what was passed
    });

    expect(seen).toEqual([{ pid: 4444, startedAt: NOW }]);
  });

  it('an identity-aware predicate reclaims a RECYCLED pid (alive, but wrong generation)', () => {
    claimWorking('c1', 'work', 5555); // stored started_at = NOW

    // The PID 5555 now belongs to an UNRELATED process started later than our
    // slot — a bare existence check (pid === 5555) would wrongly keep the card
    // pinned. An identity-aware predicate compares the process start-time against
    // the slot's started_at and treats the mismatch as "not our worker" → reclaim.
    const actualProcessStartTime = NOW + 100; // recycled process started later
    const isWorkerAlive = (pid: number, startedAt: number): boolean =>
      pid === 5555 && actualProcessStartTime <= startedAt; // false → recycled

    const { reclaimed } = reclaimOrphanedWorkers(db!, NOW, isWorkerAlive);

    expect(reclaimed).toContain('c1');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('interrupted');
  });
});

// ---------------------------------------------------------------------------
// AC: fresh DB has the pid column and SCHEMA_VERSION is current.
// ---------------------------------------------------------------------------

describe('persistence — fresh v5 schema (AC)', () => {
  it('keeps SCHEMA_VERSION beyond the pid-column migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  });

  it('creates active_workers with a pid column on a fresh DB', () => {
    db!.close();
    db = null;
    const raw = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(raw, 'active_workers')).toContain('pid');
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC: a v4 DB (active_workers without pid) migrates IN PLACE to v5 — the pid
// column is added, prior rows preserved with pid NULL, no recreate-from-scratch.
// ---------------------------------------------------------------------------

describe('persistence — v4 -> v5 in-place migration (AC)', () => {
  /**
   * Build a v4 fixture on disk: recreate active_workers WITHOUT the pid column
   * (as it existed at v4), seed a row, stamp user_version = 4, and close. The
   * fresh DB opened by beforeEach is dropped first so we own the raw file.
   */
  function buildV4Fixture(): void {
    db!.close();
    db = null;

    const raw = new Database(stateDbPath);
    raw.exec('DROP TABLE IF EXISTS active_workers');
    raw.exec(`
      CREATE TABLE active_workers (
        card_id     TEXT NOT NULL,
        station     TEXT NOT NULL,
        worker_id   TEXT NOT NULL,
        started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        lease_until INTEGER NOT NULL,
        PRIMARY KEY (card_id, station)
      )
    `);
    // Seed a pre-existing in-flight slot to verify it survives with pid NULL.
    raw
      .prepare(
        "INSERT INTO active_workers (card_id, station, worker_id, started_at, lease_until) " +
          "VALUES ('pre_existing', 'work', 'w_old', 1, 2)",
      )
      .run();
    raw.exec('PRAGMA user_version = 4');
    raw.close();
  }

  it('migrates a v4 state DB to v5 without throwing', () => {
    buildV4Fixture();
    expect(() => {
      db = openConduitDB({ stateDbPath, journalDbPath });
    }).not.toThrow();
  });

  it('stamps the migrated DB with SCHEMA_VERSION (5)', () => {
    buildV4Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

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

  it('adds the pid column to the existing active_workers table', () => {
    buildV4Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const check = new Database(stateDbPath, { readonly: true });
    try {
      expect(columnNames(check, 'active_workers')).toContain('pid');
    } finally {
      check.close();
    }
  });

  it('preserves the pre-existing row with pid NULL (no data loss, no recreate)', () => {
    buildV4Fixture();
    db = openConduitDB({ stateDbPath, journalDbPath });
    db.close();
    db = null;

    const check = new Database(stateDbPath, { readonly: true });
    try {
      const row = check
        .query(
          'SELECT worker_id, lease_until, pid FROM active_workers WHERE card_id = $c',
        )
        .get({ $c: 'pre_existing' }) as
        | { worker_id: string; lease_until: number; pid: number | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.worker_id).toBe('w_old'); // prior data intact
      expect(row!.lease_until).toBe(2);
      expect(row!.pid).toBeNull(); // new column defaults to NULL on old rows
    } finally {
      check.close();
    }
  });
});
