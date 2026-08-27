/**
 * Per-run advisory lease lock (the original run-lock and busy-retry work, part 1).
 *
 * Run namespacing (schema v6/v7) made multiple concurrent `conduit run`
 * processes with DIFFERENT `--run-id`s on one shared DB a supported feature.
 * The invariant this module enforces is narrower: at most one process may
 * DRIVE a given run_id at a time. Two processes driving the same run_id would
 * double-dispatch and corrupt executor-loop assumptions (liveness stamps,
 * pool slots, watchdog).
 *
 * This is a single-host advisory lock, not a distributed one — the holder is
 * identified by OS pid, stored on the run's own row in the `runs` table
 * (columns `holder_pid` / `lease_acquired_at`, schema v8). Acquisition and
 * release run inside a single `BEGIN IMMEDIATE` transaction on the state DB,
 * mirroring the linearization idiom in src/dispatch/claim.ts.
 *
 * Both writes are wrapped in `withBusyRetry` (src/persistence/busy-retry.ts,
 * the original run-lock and busy-retry work part 2), same as the claim-path transactions, so sustained
 * cross-process contention on the state DB is absorbed with backoff instead
 * of throwing raw SQLITE_BUSY. The two calls are NOT symmetric on exhaustion,
 * though: `acquireRunLease` throws (it runs before any engine work starts, so
 * an informative crash is fine and correct), while `releaseRunLease` never
 * throws (see its doc comment — it always runs from a caller's `finally`,
 * where a thrown error would mask the engine's real result).
 *
 * KNOWN LIMITATION (accepted for a single-host advisory lock): the liveness
 * check is bare pid existence (`isPidAlive`), not process identity. After a
 * host reboot or pid-space wraparound, an unrelated process could reuse the
 * stale holder's pid and be mistaken for the still-live holder, blocking
 * acquisition until an operator intervenes. A fully sound design would also
 * compare process start-time, as `reclaimOrphanedWorkers` does for
 * active_workers — the `runs` table does not currently carry that.
 */

import type { ConduitDB } from '../persistence/db';
import { withBusyRetry } from '../persistence/busy-retry';

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

/**
 * Default liveness check: signal 0 probes for existence without killing.
 * ESRCH (no such process) → dead. EPERM (exists, owned by another user) or
 * any other unexpected errno → treat as alive — never steal a lease we
 * cannot prove is dead (fail closed).
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== 'ESRCH';
  }
}

// ---------------------------------------------------------------------------
// acquireRunLease / releaseRunLease
// ---------------------------------------------------------------------------

export type AcquireRunLeaseResult =
  | { acquired: true }
  | { acquired: false; holderPid: number; acquiredAt: number };

interface RunHolderRow {
  holder_pid: number | null;
  lease_acquired_at: number | null;
}

/**
 * Attempt to become the driving process for `runId`.
 *
 * Acquires when: no row is holding the lease (holder_pid IS NULL), the
 * current holder IS this same pid (re-entrant — refreshes lease_acquired_at),
 * or the current holder's pid is no longer alive (stale — the previous
 * driver crashed without releasing). Refuses only when a DIFFERENT, live
 * pid holds the lease — a live holder's lease is never silently stolen.
 *
 * A run_id with no `runs` row at all (not yet registered, or a legacy DB
 * predating run registration) has nothing to protect — treated as a free
 * acquire; the UPDATE below is then a safe no-op (matches zero rows).
 *
 * Wrapped in `withBusyRetry` (the original run-lock and busy-retry work part 2): under sustained contention
 * from concurrent `conduit run` processes sharing this DB, a writer that
 * cannot acquire the BEGIN IMMEDIATE reservation within busy_timeout throws
 * SQLITE_BUSY. Retrying with backoff lets transient contention wait instead
 * of aborting the acquire outright. On exhaustion this still throws — no
 * engine work has started yet, so an informative crash here is correct.
 */
export function acquireRunLease(
  db: ConduitDB,
  runId: string,
  pid: number,
  now: number,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): AcquireRunLeaseResult {
  const stateDb = db.getStateDb();

  return withBusyRetry(() =>
    stateDb
      .transaction((): AcquireRunLeaseResult => {
        const row = stateDb
          .prepare('SELECT holder_pid, lease_acquired_at FROM runs WHERE run_id = $run_id')
          .get({ $run_id: runId }) as RunHolderRow | undefined;

        const holderPid = row?.holder_pid ?? null;

        if (holderPid !== null && holderPid !== pid && isPidAlive(holderPid)) {
          return { acquired: false, holderPid, acquiredAt: row?.lease_acquired_at ?? 0 };
        }

        stateDb
          .prepare(
            'UPDATE runs SET holder_pid = $pid, lease_acquired_at = $now WHERE run_id = $run_id',
          )
          .run({ $pid: pid, $now: now, $run_id: runId });

        return { acquired: true };
      })
      .immediate(),
  );
}

/**
 * Release the lease held by `pid` on `runId`. A no-op when `pid` is not the
 * current holder (never clears someone else's lease) and when the run has no
 * row at all.
 *
 * The write is wrapped in `withBusyRetry` (the original run-lock and busy-retry work part 2) so transient
 * contention is absorbed the same as `acquireRunLease`. Unlike acquire,
 * though, a release failure must NEVER propagate: every caller invokes this
 * from a `finally` block after the engine has already run (see
 * src/cli/main.ts), and a thrown error here would replace/mask the engine's
 * real error or result rather than add to it. So any error surviving
 * busy-retry — exhaustion or otherwise — is caught, reported to stderr, and
 * swallowed; the function reports success via its boolean return instead of
 * by not-throwing. A swallowed failure leaves `holder_pid` stuck, but this
 * self-heals: the next `acquireRunLease` against this run_id finds the
 * recorded holder's pid dead (the process that failed to release is the same
 * one that is now exiting) and reclaims the stale lease.
 */
export function releaseRunLease(db: ConduitDB, runId: string, pid: number): boolean {
  const stateDb = db.getStateDb();

  try {
    withBusyRetry(() =>
      stateDb
        .prepare(
          'UPDATE runs SET holder_pid = NULL, lease_acquired_at = NULL WHERE run_id = $run_id AND holder_pid = $pid',
        )
        .run({ $run_id: runId, $pid: pid }),
    );
    return true;
  } catch (err) {
    console.error(
      `releaseRunLease: failed to release lease for run '${runId}' (pid ${pid}) — ` +
        `leaving holder_pid set; it will self-heal once this pid is found dead: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// peekRunLeaseHolder — read-only inspection, never claims the lease
// ---------------------------------------------------------------------------

/**
 * Report the current holder of `runId`'s lease without acquiring it.
 *
 * Used by callers that are NOT about to drive the engine (e.g. an idempotent
 * `conduit run` re-submit that only prints run state) but still want to warn
 * the operator that a live process currently owns this run, rather than
 * silently racing it. Returns null when unheld (no row, or holder_pid IS NULL).
 */
export function peekRunLeaseHolder(
  db: ConduitDB,
  runId: string,
): { holderPid: number; acquiredAt: number } | null {
  const row = db
    .getStateDb()
    .prepare('SELECT holder_pid, lease_acquired_at FROM runs WHERE run_id = $run_id')
    .get({ $run_id: runId }) as RunHolderRow | undefined;

  if (!row || row.holder_pid === null) return null;
  return { holderPid: row.holder_pid, acquiredAt: row.lease_acquired_at ?? 0 };
}
