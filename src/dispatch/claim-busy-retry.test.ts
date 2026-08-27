/**
 * Integration test: attemptClaim survives real SQLITE_BUSY contention from a
 * concurrent process (the original run-lock and busy-retry work part 2).
 *
 * Rationale for the cross-process shape: withBusyRetry's Bun.sleepSync backoff
 * blocks the calling thread entirely, so a same-process timer/async release of
 * the write lock can never fire while attemptClaim is mid-retry. A separate OS
 * process holding `BEGIN IMMEDIATE` is the only way to produce genuine,
 * deterministic contention while the caller under test keeps retrying — the
 * same pattern the AC4 race test in claim.test.ts already uses for the
 * opposite property (exactly-one-winner).
 *
 * The claiming connection here is a raw bun:sqlite Database (NOT
 * openConduitDB's, which hardcodes busy_timeout=5000 in db.ts — out of this
 * file's touch-set) wrapped in a minimal stub exposing only getStateDb(),
 * which is all claim.ts's exported functions read off a ConduitDB. Setting a
 * short busy_timeout on this connection means SQLite itself gives up quickly
 * per attempt, so withBusyRetry's own retry loop — not SQLite's internal
 * wait — is what bridges the contention window.
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import { attemptClaim, activeWorkerCount, getActiveWorker } from './claim';

const NOW = 1_000_000;
const LEASE = 30;

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

/** claim.ts only ever calls db.getStateDb() — this is enough of a ConduitDB. */
function stubConduitDb(raw: Database): ConduitDB {
  return { getStateDb: () => raw } as unknown as ConduitDB;
}

describe('attemptClaim — real SQLITE_BUSY contention (integration)', () => {
  it(
    'retries through a held BEGIN IMMEDIATE from a concurrent process and eventually claims',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'conduit-busy-retry-'));
      const stateDbPath = join(dir, 'state.sqlite');
      const journalDbPath = join(dir, 'journal.sqlite');
      const sentinelPath = join(dir, 'locked.sentinel');

      // Create schema + seed a ready card via the normal factory, then close —
      // subsequent connections are raw handles onto the same file.
      const seedDb = openConduitDB({ stateDbPath, journalDbPath });
      seedDb.insertCard(makeCard({ id: 'c1' }));
      seedDb.close();

      // A child process holds the write reservation for a fixed, known window
      // (HOLD_MS) so the contention this test observes is real and bounded.
      const HOLD_MS = 150;
      const holderSrc = `
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
const db = new Database(process.env.STATE);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO active_workers (run_id, card_id, station, worker_id, started_at, lease_until) VALUES ('holder-run', 'holder-card', 'holder-station', 'holder', 0, 0)").run();
writeFileSync(process.env.SENTINEL, 'locked');
Bun.sleepSync(${HOLD_MS});
db.exec('COMMIT');
db.close();
`;
      const holderPath = join(dir, 'holder.ts');
      writeFileSync(holderPath, holderSrc);

      const holder = Bun.spawn(['bun', holderPath], {
        env: { ...process.env, STATE: stateDbPath, SENTINEL: sentinelPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      try {
        // Wait for the holder to actually have the write reservation before
        // racing attemptClaim against it — otherwise this test could get lucky
        // and claim before contention ever exists.
        const deadline = Date.now() + 5000;
        while (!existsSync(sentinelPath)) {
          if (Date.now() > deadline) {
            throw new Error('holder process never signalled its lock sentinel');
          }
        }

        // Short busy_timeout: SQLite gives up almost immediately per attempt,
        // so withBusyRetry's own backoff loop is what bridges HOLD_MS, not
        // SQLite's internal wait.
        const clientRaw = new Database(stateDbPath);
        clientRaw.exec('PRAGMA busy_timeout = 50');
        const clientDb = stubConduitDb(clientRaw);

        const start = Date.now();
        const result = attemptClaim(clientDb, {
          cardId: 'c1',
          station: 'work',
          workerId: 'w1',
          wipCap: 5,
          now: NOW,
          leaseSeconds: LEASE,
        });
        const elapsedMs = Date.now() - start;

        expect(result.ok).toBe(true);
        // Sanity: this could only have succeeded by outlasting the holder's
        // reservation, which is held for HOLD_MS.
        expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS - 20); // small clock-skew tolerance

        expect(activeWorkerCount(clientDb, 'work')).toBe(1);
        expect(getActiveWorker(clientDb, 'c1', 'work')?.workerId).toBe('w1');

        clientRaw.close();
      } finally {
        await holder.exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('claims normally (no contention) with the busy-retry wrapper in place — regression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-busy-retry-regress-'));
    const stateDbPath = join(dir, 'state.sqlite');
    const journalDbPath = join(dir, 'journal.sqlite');

    try {
      const db = openConduitDB({ stateDbPath, journalDbPath });
      db.insertCard(makeCard({ id: 'c1' }));

      const result = attemptClaim(db, {
        cardId: 'c1',
        station: 'work',
        workerId: 'w1',
        wipCap: 5,
        now: NOW,
        leaseSeconds: LEASE,
      });

      expect(result.ok).toBe(true);
      expect(db.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('claimed');
      expect(activeWorkerCount(db, 'work')).toBe(1);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
