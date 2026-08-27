/**
 * Bounded SQLITE_BUSY retry/backoff (the original run-lock and busy-retry work part 2).
 *
 * The state DB opens WAL with `PRAGMA busy_timeout = 5000` (db.ts) and the
 * atomic claim runs inside `BEGIN IMMEDIATE` (dispatch/claim.ts). That gives
 * per-transaction correctness, but `conduit run` is supported with multiple
 * processes (different --run-ids) sharing one DB file (SPEC §11 run
 * namespacing). Under sustained overlap, a writer that cannot acquire the
 * write reservation within busy_timeout throws SQLITE_BUSY, aborting that
 * process's tick entirely instead of waiting for the contention to clear.
 * This wraps a synchronous write transaction with bounded retry so transient
 * contention is absorbed rather than fatal.
 *
 * Empirically observed busy-error shape (bun:sqlite, verified against a real
 * two-connection BEGIN IMMEDIATE collision on one state DB file):
 *   err instanceof Error === true
 *   err.name    === 'SQLiteError'
 *   err.code    === 'SQLITE_BUSY'
 *   err.errno   === 5
 *   err.message === 'database is locked'
 * The same shape is thrown whether the collision happens via a raw
 * `db.exec('BEGIN IMMEDIATE')` or via `db.transaction(fn).immediate()` (the
 * pattern claim.ts uses) — confirmed with a scratch probe holding a real
 * write reservation on one connection and colliding a second connection's
 * BEGIN IMMEDIATE against it. We additionally treat 'SQLITE_BUSY_SNAPSHOT' as
 * retryable (WAL snapshot contention) since it shares the same underlying
 * "try again shortly" semantics, though it was not independently reproduced.
 */

export interface BusyRetryOptions {
  /** Maximum number of attempts (first try + retries). Default 5. */
  attempts?: number;
  /** Base delay in ms before the first retry. Default 50. */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms. Default 1000. */
  maxDelayMs?: number;
  /** Injectable synchronous sleep, so tests never actually wait. Default Bun.sleepSync. */
  sleep?: (ms: number) => void;
  /** Called before each retry sleep with the 1-based retry attempt number. */
  onRetry?: (attempt: number) => void;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 1000;

/**
 * Worst-case wait math (defaults: attempts=5, baseDelayMs=50, maxDelayMs=1000):
 * there are 4 backoff sleeps (before retries 2..5). Equal-jitter delay before
 * retry N is a random value in [capped/2, capped), where
 * capped = min(baseDelayMs * 2^(N-1), maxDelayMs):
 *   N=1: capped=50   → [25, 50)ms
 *   N=2: capped=100  → [50, 100)ms
 *   N=3: capped=200  → [100, 200)ms
 *   N=4: capped=400  → [200, 400)ms
 * Sum of sleeps ranges ~375ms–~750ms across the 4 retries — modest, and
 * bounded well under a second even at the top of the range. This is ON TOP OF
 * the existing per-attempt SQLite busy_timeout (5000ms, db.ts): each of the 5
 * attempts can itself block inside SQLite for up to busy_timeout before
 * throwing, so the absolute theoretical worst case for one call is
 * ~5 * 5000ms + ~750ms ≈ 25.75s. In practice contention clears within one or
 * two backoffs, resolving in well under a second beyond the first
 * busy_timeout wait.
 */

export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return true;
  // Cold-start fallback: bun:sqlite can throw a busy error on a fresh
  // connection's OWN bootstrap pragma (db.ts openConduitDB) before .code is
  // populated — the message still carries the busy signal. Code-based
  // detection stays primary; this only rescues the codeless bootstrap shape.
  return /database is locked|SQLITE_BUSY/i.test(err.message);
}

/** Equal-jitter backoff: a random delay in [cappedDelay/2, cappedDelay). */
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const capped = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const half = capped / 2;
  return Math.floor(half + Math.random() * half);
}

/**
 * Run a synchronous write transaction, retrying only on SQLITE_BUSY /
 * SQLITE_BUSY_SNAPSHOT with exponential backoff + jitter. Any other error
 * propagates immediately on the first attempt — no retry.
 *
 * On exhausting all attempts, throws a new Error wrapping the last busy
 * error as `cause`, with a message identifying sustained write contention
 * from concurrent conduit processes.
 */
export function withBusyRetry<T>(fn: () => T, opts: BusyRetryOptions = {}): T {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? Bun.sleepSync;

  let lastBusyError: unknown;
  let elapsedMs = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;

      lastBusyError = err;
      if (attempt === attempts) break;

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      elapsedMs += delay;
      opts.onRetry?.(attempt);
      sleep(delay);
    }
  }

  throw new Error(
    `state DB is under sustained write contention from concurrent conduit ` +
      `processes; retried ${attempts} times over ~${elapsedMs}ms without acquiring ` +
      `the write reservation`,
    { cause: lastBusyError },
  );
}
