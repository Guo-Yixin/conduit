/**
 * Retry pacing for harness invocations (issue #3).
 *
 * WHY THIS EXISTS: `max_execution_attempts` is a budget for DISTINCT failures.
 * With no delay between attempts it silently doubled as the wall-clock retry
 * policy too, so any persistent-but-temporary condition meant "fail N times
 * fast" rather than "try N times". A provider rate limit exhausted a card's
 * entire budget in about three seconds and scrapped it, discarding paid work
 * from earlier attempts along with it.
 *
 * Backoff alone would have collapsed three wasted attempts into one, and it
 * helps every transient class — a flaky spawn, a momentary network fault — not
 * just the rate limit that exposed it. Classification (parking a 429 without
 * spending an attempt) is the other half and lives in the adapter + executor;
 * the two are independent and neither requires the other.
 */

/** Base delay before the FIRST retry. Doubles per subsequent attempt. */
export const HARNESS_RETRY_BASE_MS = 1_000;

/** Ceiling on a single backoff wait, so a large attempt cap cannot idle a run. */
export const HARNESS_RETRY_MAX_MS = 30_000;

/**
 * How long to wait before the next harness attempt.
 *
 * `attemptsMade` is the number of attempts ALREADY consumed, so the first retry
 * (attemptsMade = 1) waits the base delay. Bounded exponential: 1s, 2s, 4s …
 * capped at HARNESS_RETRY_MAX_MS.
 *
 * Deliberately NOT jittered. Conduit dispatches a bounded number of concurrent
 * workers against one provider account, not a thundering herd of independent
 * clients, so the coordinated-retry problem jitter solves does not arise here —
 * and a deterministic delay is one less source of non-reproducibility in a
 * kernel whose whole premise is deterministic control flow.
 */
export function harnessRetryDelayMs(attemptsMade: number): number {
  if (attemptsMade <= 0) return 0;
  const exponential = HARNESS_RETRY_BASE_MS * 2 ** (attemptsMade - 1);
  return Math.min(exponential, HARNESS_RETRY_MAX_MS);
}
