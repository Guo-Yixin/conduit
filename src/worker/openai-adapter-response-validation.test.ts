/**
 * Tests for gateway response SHAPE validation (pre-launch punch-list #1).
 *
 * The adapter previously dereferenced the parsed gateway response with a
 * non-null assertion and no validation:
 *
 *     const text = data.choices[0]!.message.content;
 *
 * A malformed/absent body — empty `choices: []`, a missing `message`, or a
 * non-string `content` — threw a raw `TypeError: Cannot read properties of
 * undefined`, which is opaque and unclassifiable. This file pins the contract
 * that the adapter validates the response shape BEFORE dereferencing and throws
 * a clear, terse Error naming which part was malformed — and that the existing
 * well-formed happy path is unchanged (regression guard).
 *
 * A malformed response is a GENERIC failure: it is intentionally NOT classified
 * as `vision-unsupported` or `model-incompatible` (those are fast-scrap codes).
 *
 * Every test injects the HTTP transport (a fetch stub) — nothing here touches a
 * real network. The subject under test is the adapter's response parsing.
 */
import { describe, it, expect } from 'bun:test';
import { createOpenAiAdapter } from './openai-adapter';

// ---------------------------------------------------------------------------
// Transport stub (mirrors openai-adapter-vision-usage.test.ts) — no real net.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFetchStub(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const captured: CapturedRequest = { url, init: init ?? {} };
    calls.push(captured);
    return handler(captured);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const BASE_URL = 'https://gateway.example/v1';
function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };
}

/** Build a 200 chat/completions Response from an ARBITRARY payload. */
function rawResponse(payload: unknown, opts: { cost?: string | null } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cost !== null && opts.cost !== undefined) {
    headers['x-litellm-response-cost'] = opts.cost;
  }
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

// ===========================================================================
// AC1 — empty choices array → clear malformed-response error (not a TypeError).
// ===========================================================================

describe('response validation — empty choices array (AC1)', () => {
  it('throws a clear malformed-response error, not a raw TypeError', async () => {
    const { fetchFn } = makeFetchStub(() => rawResponse({ choices: [] }, { cost: '0.001' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    await expect(promise).rejects.toThrow(/malformed response/i);
    // Must NOT surface as the opaque raw dereference crash.
    await expect(promise).rejects.not.toThrow(/Cannot read propert/i);
    // Must NOT be misclassified as a fast-scrap capability error.
    let code: unknown;
    try {
      await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBeUndefined();
  });
});

// ===========================================================================
// AC2 — choices[0] missing `message` → clear malformed-response error.
// ===========================================================================

describe('response validation — missing message (AC2)', () => {
  it('throws a clear malformed-response error, not a raw TypeError', async () => {
    const { fetchFn } = makeFetchStub(() => rawResponse({ choices: [{}] }, { cost: '0.001' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    await expect(promise).rejects.toThrow(/malformed response/i);
    await expect(promise).rejects.not.toThrow(/Cannot read propert/i);
  });
});

// ===========================================================================
// AC3 — non-string content → clear malformed-response error.
// ===========================================================================

describe('response validation — non-string content (AC3)', () => {
  it('throws a clear malformed-response error for numeric content', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse({ choices: [{ message: { content: 123 } }] }, { cost: '0.001' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    await expect(promise).rejects.toThrow(/malformed response/i);
    await expect(promise).rejects.not.toThrow(/Cannot read propert/i);
  });

  it('throws a clear malformed-response error when choices is absent entirely', async () => {
    const { fetchFn } = makeFetchStub(() => rawResponse({}, { cost: '0.001' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    await expect(promise).rejects.toThrow(/malformed response/i);
    await expect(promise).rejects.not.toThrow(/Cannot read propert/i);
  });

  it('does not echo the raw response body in the error message', async () => {
    const secretish = 'leaked-token-marker';
    const { fetchFn } = makeFetchStub(() =>
      rawResponse({ choices: [{ message: { content: 123, secret: secretish } }] }, { cost: '0.001' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    let message = '';
    try {
      await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(secretish);
  });
});

// ===========================================================================
// AC4 / regression — a well-formed response still returns the full result.
// ===========================================================================

describe('response validation — well-formed response unchanged (AC4)', () => {
  it('returns { text, inputTokens, outputTokens, costUsd } for a well-formed body', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ message: { content: 'hello world' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
        { cost: '0.00042' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'hi', params: {} });

    expect(res.text).toBe('hello world');
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(7);
    expect(res.costUsd).toBeCloseTo(0.00042, 8);
  });

  it('accepts an empty-string content as well-formed (string, not absent)', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse({ choices: [{ message: { content: '' } }] }, { cost: '0.001' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    expect(res.text).toBe('');
  });
});

// ===========================================================================
// The original reasoning-response parsing work — reasoning models: fall back to message.reasoning_content when
// message.content carries no answer (DeepSeek V4, Qwen reasoning variants).
// ===========================================================================

describe('response validation — reasoning_content fallback (the original reasoning-response parsing work)', () => {
  it('falls back to reasoning_content when content is an empty string', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ message: { content: '', reasoning_content: 'thinking… {"foo":"ok"}' } }] },
        { cost: '0.001' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'deepseek-v4', prompt: 'hi', params: {} });

    expect(res.text).toBe('thinking… {"foo":"ok"}');
  });

  it('falls back to reasoning_content when content is absent entirely', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ message: { reasoning_content: 'the answer' } }] },
        { cost: '0.001' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'deepseek-v4', prompt: 'hi', params: {} });

    expect(res.text).toBe('the answer');
  });

  it('prefers a non-empty content over reasoning_content', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ message: { content: 'primary answer', reasoning_content: 'scratch work' } }] },
        { cost: '0.001' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'deepseek-v4', prompt: 'hi', params: {} });

    expect(res.text).toBe('primary answer');
  });

  it('returns empty string when both content and reasoning_content are empty (before reasoning-response parsing contract preserved)', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ message: { content: '', reasoning_content: '' } }] },
        { cost: '0.001' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'deepseek-v4', prompt: 'hi', params: {} });

    expect(res.text).toBe('');
  });

  it('throws a clear malformed-response error when content is absent AND no reasoning_content', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse({ choices: [{ message: {} }] }, { cost: '0.001' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const promise = adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    await expect(promise).rejects.toThrow(/malformed response/i);
    await expect(promise).rejects.not.toThrow(/Cannot read propert/i);
  });

  it("surfaces choices[0].finish_reason on the response ('length' → truncation-detectable)", async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(
        { choices: [{ finish_reason: 'length', message: { content: 'partial…' } }] },
        { cost: '0.001' },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-oss-120b', prompt: 'hi', params: {} });

    expect(res.finishReason).toBe('length');
  });

  it('leaves finishReason undefined when the gateway omits finish_reason', async () => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse({ choices: [{ message: { content: 'hello' } }] }, { cost: '0.001' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'hi', params: {} });

    expect(res.finishReason).toBeUndefined();
  });
});
