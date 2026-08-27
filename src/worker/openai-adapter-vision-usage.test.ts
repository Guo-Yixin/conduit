/**
 * Tests for finite token/cost accounting on vision calls (WI-418, FR-8).
 *
 * Vision calls make a malformed or absent `usage` block in the gateway response
 * more likely. The adapter's usage parsing (src/worker/openai-adapter.ts
 * executeModelCall, ~lines 268-275) currently reads `data.usage.prompt_tokens`
 * and `data.usage.completion_tokens` DIRECTLY — which throws when `usage` is
 * absent and yields NaN/garbage for non-numeric fields. `costUsd` is already
 * NaN-guarded; this item hardens the TOKEN reads to the same discipline so a
 * vision response with no/odd usage can never NaN-poison the consumption andon.
 *
 * ── Contract this file pins for src/worker/openai-adapter.ts ───────────────
 *
 * After parsing the response JSON, the adapter MUST coerce both token counts to
 * FINITE numbers (the same Number()-then-finite-guard the cost header already
 * uses), defaulting to 0 when a field is absent, null, or non-numeric:
 *
 *     inputTokens  = finite(usage?.prompt_tokens)      // else 0
 *     outputTokens = finite(usage?.completion_tokens)  // else 0
 *     costUsd      = finite(Number(costHeader))        // else 0  (UNCHANGED)
 *
 * Well-formed responses (text-only OR vision) parse exactly as today (NFR-1).
 *
 * Every test injects the HTTP transport (a fetch stub) — nothing here touches a
 * real network. The subject under test is the adapter's response parsing; the
 * ImageInput value on the call is plain input data, not a mock of any subject.
 */
import { describe, it, expect } from 'bun:test';
import { createOpenAiAdapter } from './openai-adapter';
import type { ModelCall } from './adapter';
import type { ImageInput } from './image-input';

// ---------------------------------------------------------------------------
// Transport stub (mirrors openai-adapter.test.ts) — no real network.
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

/** Parse the JSON body of a captured request. */
function jsonBody(req: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(req.init.body)) as Record<string, unknown>;
}

const BASE_URL = 'https://gateway.example/v1';
function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };
}

/**
 * Build an OpenAI-compatible chat/completions Response from an ARBITRARY payload
 * — so usage can be omitted or malformed. `cost` null → omit the cost header.
 */
function rawResponse(payload: unknown, opts: { cost?: string | null; status?: number } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cost !== null && opts.cost !== undefined) {
    headers['x-litellm-response-cost'] = opts.cost;
  }
  return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers });
}

/** Minimal valid choices block (the adapter reads choices[0].message.content). */
function withText(text: string, usage?: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = { choices: [{ message: { content: text } }] };
  if (usage !== undefined) payload.usage = usage;
  return payload;
}

/** A declared image input (plain ImageInput data — not a mock of any subject). */
const IMAGE: ImageInput = {
  path: 'frames/keyframe.png',
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
  mediaType: 'image/png',
};

/** A vision ModelCall (carries an image, exercising the WI-415 content-parts path). */
function visionCall(): ModelCall {
  return { model: 'gpt-4o', prompt: 'Describe the image', params: {}, images: [IMAGE] };
}

// ===========================================================================
// AC1 — a vision response whose usage reports prompt_tokens (including image
//        tokens) is reflected in inputTokens.
// ===========================================================================

describe('vision usage — reported prompt tokens (incl. image tokens) are counted (AC1)', () => {
  it('reflects the reported prompt_tokens/completion_tokens for a vision call', async () => {
    const { fetchFn, calls } = makeFetchStub(() =>
      // 1024 prompt tokens — inflated by the attached image, as a vision call reports.
      rawResponse(withText('a cat on a mat', { prompt_tokens: 1024, completion_tokens: 12 }), { cost: '0.0030' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call(visionCall());

    // Sanity: the request really used the vision content-parts shape (WI-415).
    const sent = jsonBody(calls[0]!) as { messages: { content: unknown }[] };
    expect(Array.isArray(sent.messages[0]!.content)).toBe(true);

    expect(res.inputTokens).toBe(1024);
    expect(res.outputTokens).toBe(12);
    expect(res.costUsd).toBeCloseTo(0.003, 8);
  });
});

// ===========================================================================
// AC2 — a response that omits the usage object entirely yields finite token
//        counts (0), never NaN or undefined-arithmetic (today it crashes).
// ===========================================================================

describe('vision usage — absent usage object yields finite token counts (AC2)', () => {
  it('returns finite inputTokens/outputTokens (0) when usage is omitted entirely', async () => {
    const { fetchFn } = makeFetchStub(() => rawResponse(withText('a cat'), { cost: '0.001' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call(visionCall());

    expect(Number.isFinite(res.inputTokens)).toBe(true);
    expect(Number.isFinite(res.outputTokens)).toBe(true);
    expect(res.inputTokens).toBe(0);
    expect(res.outputTokens).toBe(0);
  });
});

// ===========================================================================
// AC3 — malformed usage (non-numeric or partial fields) is coerced to finite
//        token counts, never NaN. Valid numeric fields are preserved.
// ===========================================================================

describe('vision usage — malformed usage is coerced to finite counts (AC3)', () => {
  it.each([
    ['non-numeric prompt_tokens', { prompt_tokens: 'lots', completion_tokens: 7 }, 0, 7],
    ['null token fields', { prompt_tokens: null, completion_tokens: null }, 0, 0],
    ['only prompt_tokens present', { prompt_tokens: 50 }, 50, 0],
    ['only completion_tokens present', { completion_tokens: 9 }, 0, 9],
  ])('coerces %s to finite counts (valid fields preserved, invalid → 0)', async (_label, usage, expectIn, expectOut) => {
    const { fetchFn } = makeFetchStub(() => rawResponse(withText('x', usage), { cost: '0.002' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call(visionCall());

    expect(Number.isFinite(res.inputTokens)).toBe(true);
    expect(Number.isFinite(res.outputTokens)).toBe(true);
    expect(res.inputTokens).toBe(expectIn);
    expect(res.outputTokens).toBe(expectOut);
  });
});

// ===========================================================================
// AC4 — costUsd remains finite in all cases; the existing cost-header path is
//        unchanged (absent / non-numeric / empty header → 0, never NaN).
// ===========================================================================

describe('vision usage — costUsd stays finite for odd cost headers (AC4)', () => {
  it.each([
    ['an absent cost header', null],
    ['a non-numeric cost header', 'free'],
    ['an empty cost header', ''],
  ])('keeps costUsd finite (0) with %s', async (_label, cost) => {
    const { fetchFn } = makeFetchStub(() =>
      rawResponse(withText('x', { prompt_tokens: 100, completion_tokens: 10 }), { cost }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call(visionCall());

    expect(Number.isFinite(res.costUsd)).toBe(true);
    expect(res.costUsd).toBe(0);
  });

  it('a vision response missing BOTH usage and cost yields all-finite accounting (no NaN anywhere)', async () => {
    // The worst case for the consumption andon: nothing reported. Every field
    // must still be a finite number so the andon is never NaN-poisoned.
    const { fetchFn } = makeFetchStub(() => rawResponse(withText('x'), { cost: null }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call(visionCall());

    expect(Number.isFinite(res.inputTokens)).toBe(true);
    expect(Number.isFinite(res.outputTokens)).toBe(true);
    expect(Number.isFinite(res.costUsd)).toBe(true);
    expect(res.inputTokens).toBe(0);
    expect(res.outputTokens).toBe(0);
    expect(res.costUsd).toBe(0);
  });
});

// ===========================================================================
// AC5 / NFR-1 — text-only well-formed usage parsing is unchanged.
// ===========================================================================

describe('vision usage — text-only well-formed parsing is unchanged (AC5 / NFR-1)', () => {
  it('parses a well-formed text-only response exactly as today', async () => {
    const { fetchFn, calls } = makeFetchStub(() =>
      rawResponse(withText('hello', { prompt_tokens: 11, completion_tokens: 7 }), { cost: '0.00042' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    // No images → legacy string-content request shape (NFR-1).
    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'hi', params: {} });

    const sent = jsonBody(calls[0]!) as { messages: { content: unknown }[] };
    expect(typeof sent.messages[0]!.content).toBe('string');

    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(7);
    expect(res.costUsd).toBeCloseTo(0.00042, 8);
  });
});
