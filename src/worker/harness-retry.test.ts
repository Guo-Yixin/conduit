/**
 * Tests for harness retry pacing (issue #3).
 *
 * The defect these guard: with no delay, `max_execution_attempts` silently
 * doubled as the wall-clock retry policy, so a rate limit with a multi-hour
 * reset consumed a card's remaining attempts in about three seconds and
 * scrapped it — discarding paid work from earlier attempts along with it.
 */
import { describe, it, expect } from 'bun:test';
import {
  harnessRetryDelayMs,
  HARNESS_RETRY_BASE_MS,
  HARNESS_RETRY_MAX_MS,
} from './harness-retry';

describe('harnessRetryDelayMs', () => {
  it('waits the base delay before the first retry', () => {
    expect(harnessRetryDelayMs(1)).toBe(HARNESS_RETRY_BASE_MS);
  });

  it('doubles per consumed attempt', () => {
    expect(harnessRetryDelayMs(2)).toBe(HARNESS_RETRY_BASE_MS * 2);
    expect(harnessRetryDelayMs(3)).toBe(HARNESS_RETRY_BASE_MS * 4);
    expect(harnessRetryDelayMs(4)).toBe(HARNESS_RETRY_BASE_MS * 8);
  });

  it('caps a single wait so a large attempt cap cannot idle a run', () => {
    expect(harnessRetryDelayMs(50)).toBe(HARNESS_RETRY_MAX_MS);
    expect(harnessRetryDelayMs(1000)).toBe(HARNESS_RETRY_MAX_MS);
  });

  it('does not wait before the FIRST attempt', () => {
    expect(harnessRetryDelayMs(0)).toBe(0);
    expect(harnessRetryDelayMs(-1)).toBe(0);
  });

  it('turns the reported three-attempts-in-three-seconds burst into real spacing', () => {
    // The journal in issue #3 recorded attempts 2, 3 and 4 at 1 second each.
    // Under this policy those same three retries span 1s + 2s + 4s of waiting,
    // which is the difference between "fail N times fast" and "try N times".
    const spent = [1, 2, 3].reduce((total, n) => total + harnessRetryDelayMs(n), 0);
    expect(spent).toBe(7_000);
  });
});
