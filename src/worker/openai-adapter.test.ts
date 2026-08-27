/**
 * Tests for the REAL OpenAI-compatible model adapter (LiteLLM gateway) + doctor
 * probe (WI-354, FR-6 / NFR-5 / NFR-6).
 *
 * This module is the concrete ModelAdapter that sits behind the kernel adapter
 * seam (src/worker/adapter.ts). It speaks the OpenAI chat/completions wire
 * protocol against one configurable gateway (LiteLLM by default), returns real
 * token counts + gateway-reported cost, and reads its credentials from the
 * environment ONLY at call time so `--help`, `doctor`, and fail-closed
 * validation all run without a key.
 *
 * The CLI wiring that replaces buildLazyModelAdapter() in src/cli/main.ts lands
 * in WI-357 — this module stays standalone and injectable. Every test here
 * injects the HTTP transport (a fetch stub); NOTHING in this file may touch a
 * real network, including the doctor probe.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/worker/openai-adapter.ts
 * ---------------------------------------------------------------------------
 *
 *   import type { ModelAdapter, ModelCall, ModelResponse } from './adapter';
 *
 *   export interface OpenAiAdapterConfig {
 *     fetchFn?: typeof fetch;                       // injected transport; default = global fetch
 *     env?: Record<string, string | undefined>;    // injected env reader; default = process.env
 *     now?: () => number;                           // injected clock (ms); default = Date.now
 *   }
 *
 *   export function createOpenAiAdapter(config?: OpenAiAdapterConfig): ModelAdapter;
 *
 *   export interface GatewayDoctorResult {
 *     reachable: boolean;     // did the (non-billed) reachability ping succeed?
 *     latency_ms: number;     // now() AFTER the ping minus now() BEFORE it
 *     hasApiKey: boolean;     // CONDUIT_API_KEY ?? OPENAI_API_KEY present?
 *     baseUrl: string | undefined;  // CONDUIT_BASE_URL as configured
 *   }
 *
 *   export function probeGateway(config?: OpenAiAdapterConfig): Promise<GatewayDoctorResult>;
 *
 * Wire behaviour pinned below (LiteLLM / OpenAI-compatible):
 *   - call() POSTs to `${CONDUIT_BASE_URL}/chat/completions` with header
 *     `Authorization: Bearer <key>` and JSON body
 *     { model, messages: [{ role: 'user', content: prompt }], ...allowlistedParams }.
 *   - Credentials: key = env.CONDUIT_API_KEY ?? env.OPENAI_API_KEY; base URL =
 *     env.CONDUIT_BASE_URL. Read at CALL time, not construction time.
 *   - ModelResponse parsing:
 *       text         = choices[0].message.content
 *       inputTokens  = usage.prompt_tokens
 *       outputTokens = usage.completion_tokens
 *       costUsd      = Number(response header 'x-litellm-response-cost'), or 0 when
 *                      the gateway reports no cost (explicit zero, never a silent guess — NFR-6).
 *   - Errors fail loudly: an unreachable transport or a non-2xx status throws an
 *     Error whose message names the failure (cause / HTTP status).
 *   - Secret hygiene (NFR-5): the API key never appears in the returned
 *     ModelResponse, never in a thrown Error (message or stack), and is never
 *     logged. Only allow-listed inference params from the call are forwarded —
 *     non-allowlisted keys (e.g. a stray `api_key`) are dropped from the body.
 *   - probeGateway() reports configuration status + reachability via the injected
 *     transport WITHOUT making a billed chat/completions call.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { createOpenAiAdapter, probeGateway } from './openai-adapter';

// ---------------------------------------------------------------------------
// Test helpers — an injected fetch transport that records every request.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/**
 * Build a fetch-shaped stub. `handler` produces the Response for each call;
 * `calls` records every request so tests can assert on URL / headers / body.
 * No real network is ever touched.
 */
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

/** A transport that always rejects, simulating an unreachable gateway. */
function unreachableFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** Read a single header off a captured request, normalising HeadersInit shape. */
function header(req: CapturedRequest, name: string): string | null {
  return new Headers(req.init.headers as HeadersInit | undefined).get(name);
}

/** Parse the JSON body of a captured request. */
function jsonBody(req: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(req.init.body)) as Record<string, unknown>;
}

/** Build an OpenAI-compatible chat/completions success Response. */
function chatResponse(opts: {
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: string | null; // null → omit the x-litellm-response-cost header
  status?: number;
} = {}): Response {
  const payload = {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: opts.text ?? 'hello' } }],
    usage: {
      prompt_tokens: opts.promptTokens ?? 11,
      completion_tokens: opts.completionTokens ?? 7,
      total_tokens: (opts.promptTokens ?? 11) + (opts.completionTokens ?? 7),
    },
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cost !== null && opts.cost !== undefined) {
    headers['x-litellm-response-cost'] = opts.cost;
  }
  return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers });
}

const BASE_URL = 'https://gateway.example/v1';

function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };
}

// ---------------------------------------------------------------------------
// AC1 — call() POSTs an OpenAI-compatible request and parses ModelResponse.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — request shape & response parsing (AC1)', () => {
  it('POSTs to chat/completions with the model + prompt and parses the response', async () => {
    const { fetchFn, calls } = makeFetchStub(() =>
      chatResponse({ text: 'a fresh idea', promptTokens: 12, completionTokens: 5, cost: '0.00042' }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'Write an idea', params: {} });

    // ── request ──
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(BASE_URL);
    expect(calls[0]!.url).toContain('chat/completions');
    expect(calls[0]!.init.method).toBe('POST');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer sk-test-key');

    const sent = jsonBody(calls[0]!) as { model: string; messages: { role: string; content: string }[] };
    expect(sent.model).toBe('gpt-4o-mini');
    const userMessage = sent.messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe('Write an idea');

    // ── response ──
    expect(res.text).toBe('a fresh idea');
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(5);
    expect(res.costUsd).toBeCloseTo(0.00042, 8);
  });

  it('reports costUsd = 0 (explicit, not a silent guess) when the gateway reports no cost — NFR-6', async () => {
    const { fetchFn } = makeFetchStub(() => chatResponse({ text: 'idea', cost: null }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(res.costUsd).toBe(0);
  });

  it('reports costUsd = 0 for a malformed (non-numeric) cost header — never NaN (NFR-6)', async () => {
    // Regression (Amy WI-354): Number('not-a-number') is NaN, which silently
    // poisons budget math. A non-parseable gateway cost is "no reported cost" →
    // explicit 0, consistent with the absent-header case.
    const { fetchFn } = makeFetchStub(() => chatResponse({ text: 'idea', cost: 'not-a-number' }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(Number.isNaN(res.costUsd)).toBe(false);
    expect(res.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — credentials are read from env at CALL time; no key on construction is
//        fine, but calling without a key throws a clear error.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter — credentials read at call time (AC2)', () => {
  it('does not throw when constructed without an API key', () => {
    const { fetchFn } = makeFetchStub(() => chatResponse());
    expect(() => createOpenAiAdapter({ fetchFn, env: { CONDUIT_BASE_URL: BASE_URL } })).not.toThrow();
  });

  it('throws a clear "no model API key" error (and never hits the network) when calling without a key', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: { CONDUIT_BASE_URL: BASE_URL } });

    await expect(
      adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} }),
    ).rejects.toThrow(/no model API key/i);
    expect(calls).toHaveLength(0);
  });

  it('reads the key at call time, not at construction time', async () => {
    // Construct with NO key in the env object...
    const env: Record<string, string | undefined> = { CONDUIT_BASE_URL: BASE_URL };
    const { fetchFn, calls } = makeFetchStub(() => chatResponse({ text: 'ok' }));
    const adapter = createOpenAiAdapter({ fetchFn, env });

    // ...key appears only AFTER construction; the call must pick it up.
    env.CONDUIT_API_KEY = 'sk-late-bound';
    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(res.text).toBe('ok');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer sk-late-bound');
  });

  it('falls back to OPENAI_API_KEY when CONDUIT_API_KEY is unset', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { OPENAI_API_KEY: 'sk-openai-fallback', CONDUIT_BASE_URL: BASE_URL },
    });

    await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(header(calls[0]!, 'authorization')).toBe('Bearer sk-openai-fallback');
  });
});

// ---------------------------------------------------------------------------
// AC3 — the run fails loudly on the first real call: unreachable or non-2xx
//        throws an error that names the failure.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — fails loudly (AC3)', () => {
  it('throws naming the cause when the gateway is unreachable', async () => {
    const fetchFn = unreachableFetch('connect ECONNREFUSED 127.0.0.1:4000');
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await expect(
      adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws naming the HTTP status on a non-2xx response', async () => {
    const { fetchFn } = makeFetchStub(() => new Response('upstream exploded', { status: 500 }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await expect(
      adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} }),
    ).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// The original gateway-error surfacing work — the gateway's own error body is folded into the thrown Error for
// ALL non-OK statuses (previously discarded, leaving only the bare status).
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — gateway error body surfaced (the original gateway-error surfacing work)', () => {
  it('includes the gateway error message in the thrown Error, with the API key redacted', async () => {
    const SECRET = 'sk-secret-in-gateway-body';
    const { fetchFn } = makeFetchStub(() =>
      new Response(
        JSON.stringify({
          error: {
            message: `context length exceeded: 200k vs 131k window (key ${SECRET})`,
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
    });

    let caught: unknown;
    try {
      await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('400');
    expect(message).toContain('context length exceeded: 200k vs 131k window');
    expect(message).not.toContain(SECRET);
    expect((caught as Error).stack).not.toContain(SECRET);
  });

  it('length-caps a huge gateway error body', async () => {
    const hugeMessage = 'x'.repeat(5000);
    const { fetchFn } = makeFetchStub(() =>
      new Response(JSON.stringify({ error: { message: hugeMessage } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    let caught: unknown;
    try {
      await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.length).toBeLessThan(600);
  });

  it('falls back to just the status when the body is empty', async () => {
    const { fetchFn } = makeFetchStub(() => new Response('', { status: 400 }));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await expect(
      adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} }),
    ).rejects.toThrow(/^Model gateway returned HTTP 400$/);
  });

  it('preserves the vision-unsupported classification branch (not the generic HTTP throw)', async () => {
    // Regression guard: enriching the generic HTTP throw with the error body
    // must not disturb the pre-existing vision-unsupported classification,
    // which throws a distinctly-coded error instead of a generic HTTP Error.
    const { fetchFn } = makeFetchStub(() =>
      new Response(JSON.stringify({ error: { message: 'This model does not support image inputs' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    let caught: unknown;
    try {
      await adapter.call({
        model: 'gpt-4o-mini',
        prompt: 'p',
        params: {},
        images: [{ path: '/tmp/stub.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
      });
    } catch (e) {
      caught = e;
    }

    expect((caught as { code?: string } | undefined)?.code).toBe('vision-unsupported');
  });
});

// ---------------------------------------------------------------------------
// AC4 — secret hygiene + allow-listed params (NFR-5).
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter — secret hygiene & param allowlist (AC4 / NFR-5)', () => {
  it('never includes the API key in the returned ModelResponse', async () => {
    const { fetchFn } = makeFetchStub(() => chatResponse({ text: 'idea', cost: '0.01' }));
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { CONDUIT_API_KEY: 'sk-secret-in-response', CONDUIT_BASE_URL: BASE_URL },
    });

    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(JSON.stringify(res)).not.toContain('sk-secret-in-response');
  });

  it('never logs the API key — on success or on failure', async () => {
    const SECRET = 'sk-must-never-be-logged';
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      // Success path.
      const ok = makeFetchStub(() => chatResponse({ text: 'idea', cost: '0.01' }));
      await createOpenAiAdapter({
        fetchFn: ok.fetchFn,
        env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
      }).call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

      // Failure path (non-2xx) — error handling must not log the key either.
      const bad = makeFetchStub(() => new Response('boom', { status: 500 }));
      await createOpenAiAdapter({
        fetchFn: bad.fetchFn,
        env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
      })
        .call({ model: 'gpt-4o-mini', prompt: 'p', params: {} })
        .catch(() => undefined);

      const logged = spies
        .flatMap((s) => s.mock.calls.flat())
        .map((arg) => String(arg))
        .join('  ');
      expect(logged).not.toContain(SECRET);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('never includes the API key in a thrown error (message or stack)', async () => {
    const SECRET = 'sk-secret-in-error';
    const { fetchFn } = makeFetchStub(() => new Response('unauthorized', { status: 401 }));
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
    });

    let caught: unknown;
    try {
      await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(SECRET);
    expect(String((caught as Error).stack)).not.toContain(SECRET);
  });

  it('never includes the API key in a thrown error when the TRANSPORT-failure cause carries it', async () => {
    // Regression (Amy WI-354): the 401 test above only exercises the HTTP-status
    // path. The transport-failure catch block rethrows with the original cause
    // string, which can echo the key (a transport error that embeds the request
    // URL/credentials). The rethrown error must be scrubbed of the key.
    const SECRET = 'sk-secret-in-transport-cause';
    const fetchFn = unreachableFetch(`Connection to ${SECRET}@gateway failed`);
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
    });

    let caught: unknown;
    try {
      await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(SECRET);
    expect(String((caught as Error).stack)).not.toContain(SECRET);
  });

  it('forwards only allow-listed inference params and drops non-allowlisted/secret-bearing keys', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({
      model: 'gpt-4o-mini',
      prompt: 'p',
      params: { temperature: 0.7, api_key: 'LEAK-must-not-be-forwarded' },
    });

    const sent = jsonBody(calls[0]!);
    expect(sent.temperature).toBe(0.7);
    expect(sent).not.toHaveProperty('api_key');
    expect(JSON.stringify(sent)).not.toContain('LEAK-must-not-be-forwarded');
  });

  it('forwards reasoning-model budget params (reasoning_effort, max_completion_tokens) — the original reasoning-budget work', async () => {
    const { fetchFn, calls } = makeFetchStub(() => chatResponse());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    await adapter.call({
      model: 'gpt-oss-120b',
      prompt: 'p',
      params: { reasoning_effort: 'low', max_completion_tokens: 8000 },
    });

    const sent = jsonBody(calls[0]!);
    // Both reach the gateway body — the flow author can now bound thinking and
    // budget reasoning+output so the answer fits (previously silently dropped).
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.max_completion_tokens).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// AC5 + AC6 — the doctor probe reports config + reachability via the injected
//        transport WITHOUT a real network call and WITHOUT a billed completion.
// ---------------------------------------------------------------------------

describe('probeGateway — doctor prereq probe (AC5/AC6)', () => {
  it('reports config status (api key + base URL) without making a billed completion call', async () => {
    const { fetchFn, calls } = makeFetchStub(() => new Response('{"data":[]}', { status: 200 }));

    const result = await probeGateway({
      fetchFn,
      env: { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL },
    });

    expect(result.hasApiKey).toBe(true);
    expect(result.baseUrl).toBe(BASE_URL);
    // A doctor probe must never spend money: it never POSTs a chat/completions.
    for (const c of calls) {
      expect(c.url).not.toContain('chat/completions');
    }
  });

  it('returns reachable:true with a measured latency_ms using the injected transport (no real network)', async () => {
    const { fetchFn } = makeFetchStub(() => new Response('{"data":[]}', { status: 200 }));
    // now() is called exactly twice: start, then end. 1000 → 1250 ⇒ 250ms.
    const ticks = [1000, 1250];
    let i = 0;
    const now = () => ticks[i++]!;

    const result = await probeGateway({ fetchFn, now, env: envWithKey() });

    expect(result.reachable).toBe(true);
    expect(result.latency_ms).toBe(250);
  });

  it('returns reachable:false when the gateway transport fails (no throw)', async () => {
    const fetchFn = unreachableFetch('ECONNREFUSED');

    const result = await probeGateway({ fetchFn, env: envWithKey() });

    expect(result.reachable).toBe(false);
  });

  it('reports hasApiKey:false without throwing when no key is configured', async () => {
    const { fetchFn } = makeFetchStub(() => new Response('{"data":[]}', { status: 200 }));

    const result = await probeGateway({ fetchFn, env: { CONDUIT_BASE_URL: BASE_URL } });

    expect(result.hasApiKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC7 — 429 retry-after delay is clamped to a sane maximum (DoS-ish guard).
//
// A malicious or buggy gateway returning retry-after: 600 must NOT block the
// executor for ~602 s. The adapter clamps the base delay to 60 s, so the
// total sleep (base + 2 s jitter) is at most 62 000 ms.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — 429 retry delay is clamped (AC7)', () => {
  it('clamps an absurd retry-after header (600 s) to a 62 000 ms max sleep, not 602 000 ms', async () => {
    // First call: 429 with an adversarial retry-after; second call: success.
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: {} }), {
          status: 429,
          headers: { 'retry-after': '600', 'content-type': 'application/json' },
        });
      }
      return chatResponse({ text: 'ok after retry' });
    });

    const sleepArgs: number[] = [];
    const sleepFn = (ms: number): Promise<void> => {
      sleepArgs.push(ms);
      return Promise.resolve();
    };

    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });
    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(res.text).toBe('ok after retry');
    expect(sleepArgs).toHaveLength(1);
    // With clamp to 60 s + 2 s jitter = 62 000 ms max.
    expect(sleepArgs[0]).toBeLessThanOrEqual(62_000);
    // Must still sleep something (not zero) — ensure jitter is applied.
    expect(sleepArgs[0]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC8 — transient 5xx is retried with bounded backoff (finding #2).
//
// A single transient gateway hiccup (502/503/504 from an overloaded upstream)
// must NOT be a fatal halt: the adapter retries a bounded number of times with
// capped backoff before surfacing. Non-transient errors (404 unknown-model,
// 401 auth) are surfaced immediately — retrying cannot fix them.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — transient 5xx retry (AC8)', () => {
  it('retries a transient 503 and succeeds on the next attempt (not a fatal halt)', async () => {
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => {
      callCount++;
      if (callCount === 1) return new Response('upstream overloaded', { status: 503 });
      return chatResponse({ text: 'ok after 503' });
    });
    const sleepArgs: number[] = [];
    const sleepFn = (ms: number): Promise<void> => { sleepArgs.push(ms); return Promise.resolve(); };

    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });
    const res = await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });

    expect(res.text).toBe('ok after 503');
    expect(callCount).toBe(2); // initial + 1 retry
    expect(sleepArgs).toHaveLength(1);
    // First backoff = 2 s + 2 s jitter = 4 000 ms; bounded well under the cap.
    expect(sleepArgs[0]).toBeLessThanOrEqual(32_000);
    expect(sleepArgs[0]).toBeGreaterThan(0);
  });

  it('gives up after a bounded number of retries on a persistent 503 (no infinite loop)', async () => {
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => { callCount++; return new Response('still down', { status: 503 }); });
    const sleepArgs: number[] = [];
    const sleepFn = (ms: number): Promise<void> => { sleepArgs.push(ms); return Promise.resolve(); };

    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });
    await expect(adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} })).rejects.toThrow(/HTTP 503/);

    // Bounded: initial attempt + a fixed number of retries, then surface.
    expect(sleepArgs.length).toBeGreaterThanOrEqual(1);
    expect(sleepArgs.length).toBeLessThanOrEqual(3);
    expect(callCount).toBe(sleepArgs.length + 1);
    // Every backoff is clamped, so the total wait is bounded.
    expect(Math.max(...sleepArgs)).toBeLessThanOrEqual(32_000);
  });

  it('does NOT retry a non-transient 404 (unknown model) — surfaces immediately', async () => {
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => { callCount++; return new Response('model not found', { status: 404 }); });
    const sleepArgs: number[] = [];
    const sleepFn = (ms: number): Promise<void> => { sleepArgs.push(ms); return Promise.resolve(); };

    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });
    await expect(adapter.call({ model: 'gpt-4o', prompt: 'p', params: {} })).rejects.toThrow(/HTTP 404/);

    expect(callCount).toBe(1);      // one shot, no retry
    expect(sleepArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC9 — transport failure during a retry is surfaced gracefully (not raw).
//
// The first fetchFn call is already wrapped in a try/catch that redacts the key.
// The retry fetchFn call inside the retry loop must also be wrapped — otherwise
// a network error thrown during a retry (e.g. ECONNRESET) propagates raw and
// may carry the API key in its message.
// ---------------------------------------------------------------------------

describe('createOpenAiAdapter.call — retry transport failure is surfaced gracefully (AC9)', () => {
  it('surfaces a transport failure during retry as a named error, not a raw crash', async () => {
    // First call → transient 503 (triggers retry); second call → transport throws.
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => {
      callCount++;
      if (callCount === 1) return new Response('upstream overloaded', { status: 503 });
      throw new Error('read ECONNRESET');
    });
    const sleepFn = (_ms: number): Promise<void> => Promise.resolve();

    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });

    await expect(
      adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} }),
    ).rejects.toThrow(/unreachable on retry/i);
  });

  it('never leaks the API key when a retry transport error message contains the key', async () => {
    const SECRET = 'sk-retry-transport-secret';
    let callCount = 0;
    const { fetchFn } = makeFetchStub(() => {
      callCount++;
      if (callCount === 1) return new Response('upstream overloaded', { status: 503 });
      throw new Error(`connect failed for ${SECRET}`);
    });
    const sleepFn = (_ms: number): Promise<void> => Promise.resolve();

    const adapter = createOpenAiAdapter({
      fetchFn,
      env: { CONDUIT_API_KEY: SECRET, CONDUIT_BASE_URL: BASE_URL },
      sleepFn,
    });

    let caught: unknown;
    try {
      await adapter.call({ model: 'gpt-4o-mini', prompt: 'p', params: {} });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(SECRET);
    expect(String((caught as Error).stack)).not.toContain(SECRET);
    expect((caught as Error).message).toContain('[REDACTED]');
  });
});
