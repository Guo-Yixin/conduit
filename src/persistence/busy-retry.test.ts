/**
 * Unit tests for bounded SQLITE_BUSY retry (the original run-lock and busy-retry work part 2).
 *
 * Pure unit tests — sleep is injected so no test actually waits. See
 * busy-retry.ts for the empirically-verified busy-error shape this module
 * detects (err.code === 'SQLITE_BUSY' | 'SQLITE_BUSY_SNAPSHOT').
 */
import { describe, it, expect } from 'bun:test';
import { withBusyRetry } from './busy-retry';

function makeBusyError(code: 'SQLITE_BUSY' | 'SQLITE_BUSY_SNAPSHOT' = 'SQLITE_BUSY'): Error {
  const err = new Error('database is locked') as Error & { code: string; errno: number };
  err.name = 'SQLiteError';
  err.code = code;
  err.errno = 5;
  return err;
}

/**
 * Cold-start bootstrap-pragma throw shape (db.ts openConduitDB): a plain Error
 * whose MESSAGE carries the busy signal but which may lack a populated `.code`
 * — observed when bun:sqlite throws on a fresh connection's own bootstrap
 * pragma before busy_timeout has taken effect for that connection.
 */
function makeCodelessBusyError(message: string): Error {
  return new Error(message);
}

describe('withBusyRetry', () => {
  it('returns the value on first-try success without sleeping', () => {
    const sleep = (_ms: number) => {
      throw new Error('should not sleep on immediate success');
    };

    const result = withBusyRetry(() => 42, { sleep });

    expect(result).toBe(42);
  });

  it('retries a busy error and returns the value once it succeeds', () => {
    let calls = 0;
    const sleeps: number[] = [];

    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 3) throw makeBusyError();
        return 'ok';
      },
      { sleep: (ms) => sleeps.push(ms) },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    // Two retries were needed → two sleeps, strictly growing (exponential backoff).
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
  });

  it('also retries SQLITE_BUSY_SNAPSHOT', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 2) throw makeBusyError('SQLITE_BUSY_SNAPSHOT');
        return 'ok';
      },
      { sleep: () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries a codeless busy error detected by "database is locked" message', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 2) throw makeCodelessBusyError('database is locked');
        return 'ok';
      },
      { sleep: () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries a codeless busy error detected by "SQLITE_BUSY" message', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 2) throw makeCodelessBusyError('SQLITE_BUSY: unable to acquire lock');
        return 'ok';
      },
      { sleep: () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows a non-busy error immediately without retrying or sleeping', () => {
    let calls = 0;
    const sleep = (_ms: number) => {
      throw new Error('should not sleep on a non-busy error');
    };
    const boom = new Error('constraint violation');

    expect(() =>
      withBusyRetry(
        () => {
          calls++;
          throw boom;
        },
        { sleep },
      ),
    ).toThrow(boom);
    expect(calls).toBe(1);
  });

  it('calls onRetry with the 1-based attempt number before each sleep', () => {
    let calls = 0;
    const seen: number[] = [];

    withBusyRetry(
      () => {
        calls++;
        if (calls < 3) throw makeBusyError();
        return 'ok';
      },
      { sleep: () => {}, onRetry: (attempt) => seen.push(attempt) },
    );

    expect(seen).toEqual([1, 2]);
  });

  it('exhausts attempts and throws a wrapping error with cause set', () => {
    const busyErr = makeBusyError();
    let calls = 0;
    const sleeps: number[] = [];

    let thrown: unknown;
    try {
      withBusyRetry(
        () => {
          calls++;
          throw busyErr;
        },
        { attempts: 4, sleep: (ms) => sleeps.push(ms) },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/sustained write contention/i);
    expect(err.message).toMatch(/retried 4 times/i);
    expect(err.cause).toBe(busyErr);
    // 4 attempts total → 3 sleeps between them, no sleep after the last failure.
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it('respects a custom attempts count of 1 (no retries at all)', () => {
    const busyErr = makeBusyError();
    let calls = 0;
    const sleep = (_ms: number) => {
      throw new Error('should not sleep when attempts=1');
    };

    expect(() =>
      withBusyRetry(
        () => {
          calls++;
          throw busyErr;
        },
        { attempts: 1, sleep },
      ),
    ).toThrow(/sustained write contention/i);
    expect(calls).toBe(1);
  });

  it('respects maxDelayMs as an upper bound on backoff', () => {
    let calls = 0;
    const sleeps: number[] = [];

    withBusyRetry(
      () => {
        calls++;
        if (calls < 6) throw makeBusyError();
        return 'ok';
      },
      { attempts: 6, baseDelayMs: 100, maxDelayMs: 150, sleep: (ms) => sleeps.push(ms) },
    );

    for (const ms of sleeps) {
      expect(ms).toBeLessThanOrEqual(150);
    }
  });
});
