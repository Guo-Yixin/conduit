/**
 * Tests for per-call wall-clock timeout (pre-launch punch-list #8, transform path)
 * and its bounded retry / honest-default hardening (the original transform-timeout work).
 *
 * A transform station's `timeout_seconds` reaches the adapter as `ModelCall.timeoutMs`.
 * The adapter bounds EACH network attempt with a fresh `AbortSignal.timeout`, so a
 * hung gateway call (one that never responds) is aborted instead of blocking the
 * worker forever — a hung call is an *active* worker the liveness watchdog never
 * trips on.
 *
 * The original transform-timeout work hardening asserted here:
 *   • "Unbounded" is not truly unbounded — an absent `timeoutMs` gets an explicit
 *     ENGINE-DEFAULT AbortSignal (Bun's fetch has a hidden ~300s default), and the
 *     adapter always passes Bun's non-standard `timeout: false` so its own signal
 *     is the sole bound (a station `timeout_seconds > 300` can actually lengthen).
 *   • A stalled call is the SAME transient class as 429/5xx: it is retried within
 *     the bounded budget rather than fatal-ing the run. Only after the retries are
 *     exhausted does it surface — and the message NAMES its source (never `undefinedms`).
 *
 * Every test injects the HTTP transport — nothing here touches a real network —
 * and a no-op `sleepFn` so the bounded-retry backoff does not slow the suite.
 * The "hanging" stub returns a promise that only ever settles by REJECTING when
 * the injected AbortSignal fires, faithfully modelling a stalled connection.
 */
import { describe, it, expect } from 'bun:test';
import { createOpenAiAdapter } from './openai-adapter';

const BASE_URL = 'https://gateway.example/v1';
function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };
}

/** No-op sleep so bounded-retry backoff does not add real wall-clock to the suite. */
const noSleep = async (): Promise<void> => {};

/** A well-formed 200 completion body. */
function okBody(): string {
  return JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

/**
 * A fetch stub that NEVER resolves on its own — it only settles by rejecting
 * with the abort reason when the caller's AbortSignal fires. This models a
 * gateway that accepted the connection and then stalled indefinitely. Records
 * each call's RequestInit so a test can assert what was attached and how many
 * attempts were made.
 */
function hangingFetch(): { fetchFn: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }
      // No signal → never settles. After transform-timeout hardening the adapter always attaches one.
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** A fetch stub that immediately returns a well-formed 200 completion. */
function okFetch(): { fetchFn: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(okBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/**
 * A fetch stub that stalls (aborts on the AbortSignal) for its first
 * `stallCount` calls, then returns a well-formed 200. Models a transient
 * slow-prefill stall that clears on retry (the original transform-timeout work).
 */
function stallThenOk(stallCount: number): { fetchFn: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const n = calls.length;
    calls.push(init ?? {});
    if (n < stallCount) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
      });
    }
    return new Response(okBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('adapter per-call timeout (punch-list #8)', () => {
  it('does not tag the timeout error with a fast-scrap code (generic failure)', async () => {
    const { fetchFn } = hangingFetch();
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: noSleep });

    let code: unknown = 'unset';
    try {
      await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {}, timeoutMs: 25 });
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBeUndefined();
  });

  it('a fast call under its timeout returns normally (regression)', async () => {
    const { fetchFn } = okFetch();
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: noSleep });
    const res = await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {}, timeoutMs: 5000 });
    expect(res.text).toBe('ok');
  });
});

describe('adapter timeout hardening (the original transform-timeout work)', () => {
  it('always attaches an AbortSignal and disables Bun\'s hidden default (timeout:false)', async () => {
    // Station-configured timeout.
    const withTimeout = okFetch();
    await createOpenAiAdapter({ fetchFn: withTimeout.fetchFn, env: envWithKey(), sleepFn: noSleep }).call({
      model: 'gpt-4o',
      prompt: 'hi',
      params: {},
      timeoutMs: 5000,
    });
    expect(withTimeout.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect((withTimeout.calls[0] as { timeout?: unknown }).timeout).toBe(false);

    // Unbounded caller — still gets an (engine-default) signal, no longer bare.
    const noTimeout = okFetch();
    await createOpenAiAdapter({ fetchFn: noTimeout.fetchFn, env: envWithKey(), sleepFn: noSleep }).call({
      model: 'gpt-4o',
      prompt: 'hi',
      params: {},
    });
    expect(noTimeout.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect((noTimeout.calls[0] as { timeout?: unknown }).timeout).toBe(false);
  });

  it('retries a stalled call within the bounded budget and succeeds when it clears', async () => {
    // Stalls twice, then the third attempt lands — the run must survive.
    const { fetchFn, calls } = stallThenOk(2);
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: noSleep });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {}, timeoutMs: 25 });
    expect(res.text).toBe('ok');
    expect(calls.length).toBe(3); // 2 stalls + 1 success
  });

  it('surfaces a clear timeout error only after exhausting the bounded retries', async () => {
    const { fetchFn, calls } = hangingFetch();
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: noSleep });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {}, timeoutMs: 25 });
    // Reads as a timeout naming its source — NOT a generic transport failure.
    await expect(promise).rejects.toThrow(/exceeded its 25ms timeout \(station timeout_seconds\)/i);
    await expect(promise).rejects.not.toThrow(/unreachable/i);
    // 1 initial + MAX_TRANSIENT_RETRIES (3) = 4 attempts before giving up.
    expect(calls.length).toBe(4);
  });

  it('names the engine default and never prints "undefinedms" when no timeout is configured', async () => {
    // Force the engine-default path to abort on the very first tick so we can
    // read the surfaced message without waiting ~300s: an already-aborted signal.
    const calls: RequestInit[] = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      // Reject immediately with a TimeoutError, as an expired AbortSignal would.
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn: noSleep });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });
    await expect(promise).rejects.toThrow(/exceeded its 300000ms timeout \(engine default\)/i);
    await expect(promise).rejects.not.toThrow(/undefinedms/i);
  });
});
