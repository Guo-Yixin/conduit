/**
 * Tests for the transform worker runtime (WI-296).
 *
 * SPEC §16 step 3, SPEC §7: a `transform` station makes EXACTLY ONE
 * kernel-mediated model call through a per-model adapter (workers NEVER reach
 * the network themselves — the adapter is injected), tolerantly/coercively
 * parses the model text, validates it against the station output schema, and
 * bounds parse/validation re-bills against per_card.max_execution_attempts.
 * On exhaustion the station scraps with reason "model-incompatible"
 * (SPEC §7 rev-1 H5). No tools, no loop — a single typed-in / typed-out filter.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for the implementation
 * ---------------------------------------------------------------------------
 *
 * src/worker/adapter.ts  — the kernel-mediated model-call seam:
 *
 *   export interface ModelCall {
 *     model: string;
 *     prompt: string;
 *     params: Record<string, unknown>;   // ONLY the explicitly allowlisted params
 *   }
 *   export interface ModelResponse {
 *     text: string;
 *     inputTokens: number;
 *     outputTokens: number;
 *     costUsd: number;
 *   }
 *   export interface ModelAdapter {
 *     call(req: ModelCall): Promise<ModelResponse>;
 *   }
 *
 * src/worker/transform.ts — the runtime:
 *
 *   export interface OutputSchema<T> {
 *     validate(value: unknown):
 *       | { ok: true;  value: T }
 *       | { ok: false; error: string };
 *   }
 *   export interface TransformContext<T> {
 *     cardId: string;
 *     station: string;
 *     attempt: number;             // starting execution-attempt index (Card.attempt)
 *     maxExecutionAttempts: number;// per_card.max_execution_attempts — absolute call ceiling
 *     model: string;
 *     prompt: string;
 *     params: Record<string, unknown>;   // allowlisted params ONLY — never raw process.env
 *     schema: OutputSchema<T>;
 *     adapter: ModelAdapter;       // injected; the runtime calls THIS, never the network
 *     db: ConduitDB;               // token/cost journaled here (WI-290)
 *   }
 *   export type TransformResult<T> =
 *     | { status: 'complete';  output: StationOutput<T>; attempts: number }
 *     | { status: 'scrapped';  reason: 'model-incompatible'; attempts: number };
 *   export function runTransformStation<T>(ctx: TransformContext<T>): Promise<TransformResult<T>>;
 *
 * Behavioural contract pinned below:
 *  - Each model call is journaled (db.appendJournalSpan) under its OWN execution
 *    attempt number, starting at ctx.attempt and incrementing by 1 per re-bill,
 *    with usage = { model, inputTokens, outputTokens, costUsd }. Every call is
 *    billed — including failed ones (a parse miss is a PAID re-bill).
 *  - With ctx.attempt = 0, the runtime makes at most ctx.maxExecutionAttempts
 *    calls before scrapping.
 *  - On success, StationOutput.return_to is null (a maker proceeds) and
 *    findings_hash is a non-empty string (authoritative shape from WI-289 —
 *    do NOT invent a parallel envelope).
 *  - The ModelCall.params handed to the adapter equals ctx.params EXACTLY — no
 *    process-env-derived keys, no extra fields.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter, ModelCall, ModelResponse } from './adapter';
import { runTransformStation, coerciveParseCandidates } from './transform';
import type {
  OutputSchema,
  TransformContext,
  TransformResult,
} from './transform';

// ---------------------------------------------------------------------------
// Test fixtures: a trivial { foo: string } payload + its schema.
// ---------------------------------------------------------------------------

interface Foo {
  foo: string;
}

const fooSchema: OutputSchema<Foo> = {
  validate(value) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).foo === 'string'
    ) {
      return { ok: true, value: { foo: (value as Record<string, unknown>).foo as string } };
    }
    return { ok: false, error: 'expected { foo: string }' };
  },
};

// ---------------------------------------------------------------------------
// Stub kernel adapter — records every request, returns queued responses.
// Throws if called more times than responses were queued (catches over-calling
// past the execution-attempt cap).
// ---------------------------------------------------------------------------

function makeStubAdapter(responses: ModelResponse[]): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  const calls: ModelCall[] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    async call(req) {
      calls.push(req);
      if (i >= responses.length) {
        throw new Error(
          `stub adapter over-called: no response queued for call #${i + 1}`,
        );
      }
      return responses[i++];
    },
  };
  return { adapter, calls };
}

function resp(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return { text, inputTokens: 10, outputTokens: 5, costUsd: 0.001, ...overrides };
}

// ---------------------------------------------------------------------------
// Narrowing helpers — throw loudly with detail on the wrong branch.
// ---------------------------------------------------------------------------

function expectComplete<T>(
  r: TransformResult<T>,
): Extract<TransformResult<T>, { status: 'complete' }> {
  if (r.status !== 'complete') {
    throw new Error(`expected status=complete, got ${JSON.stringify(r)}`);
  }
  return r;
}

function expectScrapped<T>(
  r: TransformResult<T>,
): Extract<TransformResult<T>, { status: 'scrapped' }> {
  if (r.status !== 'scrapped') {
    throw new Error(`expected status=scrapped, got ${JSON.stringify(r)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Per-test in-memory split DB.
// ---------------------------------------------------------------------------

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

function makeCtx(
  over: Partial<TransformContext<Foo>> & { adapter: ModelAdapter },
): TransformContext<Foo> {
  return {
    cardId: 'card-1',
    station: 'brief',
    runId: 'run-default',
    attempt: 0,
    maxExecutionAttempts: 5,
    model: 'gpt-4o-mini',
    prompt: 'Summarize the brief.',
    params: { temperature: 0.2 },
    schema: fooSchema,
    db,
    ...over,
  };
}

// ===========================================================================
// AC1 — clean JSON → typed output
// ===========================================================================

describe('runTransformStation — clean parse', () => {
  it('parses and validates a clean JSON response into the typed output (AC1)', async () => {
    const { adapter, calls } = makeStubAdapter([resp('{"foo":"ok"}')]);

    const result = await runTransformStation(makeCtx({ adapter }));

    const ok = expectComplete(result);
    expect(ok.output.payload).toEqual({ foo: 'ok' });
    expect(ok.output.return_to).toBeNull();
    expect(typeof ok.output.findings_hash).toBe('string');
    expect(ok.output.findings_hash.length).toBeGreaterThan(0);
    expect(ok.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

// ===========================================================================
// AC2 — coercive recovery from fenced / prose-wrapped responses
// ===========================================================================

describe('runTransformStation — coercive parse', () => {
  it.each([
    ['markdown json fence', '```json\n{"foo":"ok"}\n```'],
    ['bare triple-backtick fence', '```\n{"foo":"ok"}\n```'],
    ['prose-wrapped', 'Sure — here is the output you requested:\n\n{"foo":"ok"}\n\nLet me know if you need changes.'],
  ])('coercively recovers the typed output from a %s response (AC2)', async (_label, text) => {
    const { adapter, calls } = makeStubAdapter([resp(text)]);

    const result = await runTransformStation(makeCtx({ adapter }));

    const ok = expectComplete(result);
    expect(ok.output.payload).toEqual({ foo: 'ok' });
    expect(calls).toHaveLength(1);
  });
});

// ===========================================================================
// The original reasoning-response parsing work — reasoning-model output: prefer the LAST schema-valid JSON object,
// falling back to an earlier one (no regression for non-reasoning flows).
// ===========================================================================

describe('runTransformStation — reasoning-model JSON recovery (the original reasoning-response parsing work)', () => {
  it('recovers the answer at the END of chain-of-thought prose, past a non-validating decoy object', async () => {
    // A reasoning model's CoT prose contains an earlier brace object that does
    // NOT satisfy the schema; the real answer is the LAST object.
    const text =
      'Let me think. First I considered {"step":"analyze the brief"} as an approach. ' +
      'Final answer:\n{"foo":"ok"}';
    const { adapter, calls } = makeStubAdapter([resp(text)]);

    const result = await runTransformStation(makeCtx({ adapter }));

    const ok = expectComplete(result);
    expect(ok.output.payload).toEqual({ foo: 'ok' });
    expect(calls).toHaveLength(1); // recovered on the FIRST call — no paid retry
  });

  it('falls back to an EARLIER object when the trailing object fails validation (no regression)', async () => {
    // The answer is first; trailing prose contains a schema-invalid object. The
    // last-preference must NOT clobber the valid earlier answer.
    const text = '{"foo":"ok"}\n\nNote: you could also try {"alt":"something"} next time.';
    const { adapter } = makeStubAdapter([resp(text)]);

    const result = await runTransformStation(makeCtx({ adapter }));

    expect(expectComplete(result).output.payload).toEqual({ foo: 'ok' });
  });

  it('prefers the LAST object when MULTIPLE objects satisfy the schema (the revised answer)', async () => {
    const text = 'Draft: {"foo":"first"} — on reflection the better answer is {"foo":"last"}';
    const { adapter } = makeStubAdapter([resp(text)]);

    const result = await runTransformStation(makeCtx({ adapter }));

    expect(expectComplete(result).output.payload).toEqual({ foo: 'last' });
  });
});

describe('runTransformStation — truncation fast-scrap (the original reasoning-response parsing work review)', () => {
  it("scraps 'output-truncated' — NOT 'model-incompatible' — when finish_reason is 'length' with no valid answer", async () => {
    // A single truncated, answerless response. Only ONE response is queued, so
    // the stub throws if the station retries — proving the fast-scrap.
    const { adapter, calls } = makeStubAdapter([
      resp('Let me reason step by step about the brief and', { finishReason: 'length' }),
    ]);

    const result = await runTransformStation(makeCtx({ adapter, maxExecutionAttempts: 5 }));

    const scrapped = expectScrapped(result);
    expect(scrapped.reason).toBe('output-truncated');
    expect(calls).toHaveLength(1); // fast-scrap: did NOT burn the remaining attempts
  });

  it('still completes when a truncated response nonetheless carried a schema-valid answer', async () => {
    // finish_reason 'length' but the answer was emitted before the cut — a
    // recovered valid candidate wins over the truncation flag.
    const { adapter } = makeStubAdapter([
      resp('{"foo":"ok"} …and then it kept reasoning until it ran ou', { finishReason: 'length' }),
    ]);

    const result = await runTransformStation(makeCtx({ adapter }));

    expect(expectComplete(result).output.payload).toEqual({ foo: 'ok' });
  });

  it("a non-truncated unparseable response still retries to the cap and scraps 'model-incompatible' (unchanged)", async () => {
    // No finishReason (or 'stop'): the truncation branch must not fire.
    const { adapter, calls } = makeStubAdapter([
      resp('not json', { finishReason: 'stop' }),
      resp('still not json', { finishReason: 'stop' }),
    ]);

    const result = await runTransformStation(makeCtx({ adapter, maxExecutionAttempts: 2 }));

    expect(expectScrapped(result).reason).toBe('model-incompatible');
    expect(calls).toHaveLength(2); // exhausted the cap, as before
  });
});

describe('coerciveParseCandidates (the original reasoning-response parsing work)', () => {
  it('orders embedded prose objects last-to-first', () => {
    const candidates = coerciveParseCandidates('x {"a":1} y {"b":2} z');
    expect(candidates).toEqual([{ b: 2 }, { a: 1 }]);
  });

  it('puts a clean whole-document parse first', () => {
    const candidates = coerciveParseCandidates('{"a":1}');
    expect(candidates[0]).toEqual({ a: 1 });
  });

  it('returns an empty list when nothing parses', () => {
    expect(coerciveParseCandidates('no json here at all')).toEqual([]);
  });

  it('is string-aware — a brace inside a JSON string does not split the object', () => {
    const candidates = coerciveParseCandidates('answer: {"foo":"a}b"}');
    expect(candidates).toContainEqual({ foo: 'a}b' });
  });
});

// ===========================================================================
// AC3 — a schema violation costs exactly one execution attempt, then recovers
// ===========================================================================

describe('runTransformStation — attempt accounting', () => {
  it('a schema violation consumes exactly one execution attempt, then recovers (AC3)', async () => {
    const { adapter, calls } = makeStubAdapter([
      resp('{"foo":123}'), // wrong type → schema violation (one attempt)
      resp('{"foo":"ok"}'), // valid on the retry
    ]);

    const result = await runTransformStation(
      makeCtx({ adapter, maxExecutionAttempts: 5 }),
    );

    const ok = expectComplete(result);
    expect(ok.output.payload).toEqual({ foo: 'ok' });
    expect(ok.attempts).toBe(2); // the violation cost one attempt; success was the second
    expect(calls).toHaveLength(2);
  });
});

// ===========================================================================
// AC4 — exhausting the execution-attempt cap scraps with model-incompatible.
// Covers BOTH failure modes that share the retry path: unparseable text and
// schema-violating JSON (shared-handler symmetry).
// ===========================================================================

describe('runTransformStation — scrap at cap', () => {
  it.each([
    ['unparseable prose', ['I cannot help with that.', 'No structured output here.', 'Still nothing.']],
    ['schema-violating json', ['{"foo":1}', '{"foo":true}', '{"bar":"x"}']],
  ])('scraps with model-incompatible when %s exhausts the cap (AC4)', async (_label, texts) => {
    const { adapter, calls } = makeStubAdapter(texts.map((t) => resp(t)));

    const result = await runTransformStation(
      makeCtx({ adapter, maxExecutionAttempts: 3 }),
    );

    const scr = expectScrapped(result);
    expect(scr.reason).toBe('model-incompatible');
    expect(scr.attempts).toBe(3);
    expect(calls).toHaveLength(3); // exactly the cap — never a 4th (over-call would throw)
  });

  it('bills every execution attempt to the journal, including failed ones (paid re-bill)', async () => {
    const { adapter } = makeStubAdapter([
      resp('garbage one', { inputTokens: 7, outputTokens: 2, costUsd: 0.002 }),
      resp('{"foo":1}', { inputTokens: 8, outputTokens: 3, costUsd: 0.003 }),
      resp('garbage three', { inputTokens: 9, outputTokens: 4, costUsd: 0.004 }),
    ]);

    await runTransformStation(
      makeCtx({ cardId: 'card-bill', adapter, maxExecutionAttempts: 3 }),
    );

    // Each of the 3 attempts has its own billed usage row at its own attempt index.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(db.getStationUsage('card-bill', 'brief', attempt)).not.toBeNull();
    }
  });
});

// ===========================================================================
// Finding #19 — coercive extractor must be STRING-AWARE: a brace inside a JSON
// string value must NOT break the balanced-brace scan.
// ===========================================================================

interface Bag {
  k: string;
}

const bagSchema: OutputSchema<Bag> = {
  validate(value) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).k === 'string'
    ) {
      return { ok: true, value: { k: (value as Record<string, unknown>).k as string } };
    }
    return { ok: false, error: 'expected { k: string }' };
  },
};

describe('runTransformStation — string-aware coercive parse (finding #19)', () => {
  it.each([
    ['closing brace inside a string value', 'Here you go:\n\n{"k":"a}b"}\n\nThanks!'],
    ['opening brace inside a string value', 'Output below:\n{"k":"x{y"}\nDone.'],
    ['both braces inside a string value', 'Result: {"k":"{nested}"} ok'],
    ['escaped quote then a brace inside the string', 'Result: {"k":"he said \\"hi\\" }"} done'],
  ])('recovers prose-wrapped JSON with %s', async (_label, text) => {
    const { adapter, calls } = makeStubAdapter([resp(text)]);

    const result = await runTransformStation<Bag>({
      cardId: 'card-str',
      station: 'brief',
      runId: 'run-default',
      attempt: 0,
      maxExecutionAttempts: 5,
      model: 'gpt-4o-mini',
      prompt: 'p',
      params: {},
      schema: bagSchema,
      adapter,
      db,
    });

    const ok = expectComplete(result);
    expect(typeof ok.output.payload.k).toBe('string');
    expect(calls).toHaveLength(1); // recovered on the FIRST call — no false re-bill
  });
});

// ===========================================================================
// Finding #25 — findings_hash must be canonical (key-order invariant) so
// Guard 3's progress-monotonicity is not defeated by incidental key reordering.
// ===========================================================================

describe('runTransformStation — canonical findings_hash (finding #25)', () => {
  it('produces the same findings_hash for the same payload with reordered keys', async () => {
    // Two responses that are equal as objects but differ in key order (and in a
    // nested object's key order). The canonical hash must be identical.
    const r1 = await runTransformStation<Record<string, unknown>>({
      cardId: 'card-h1',
      station: 'brief',
      runId: 'run-default',
      attempt: 0,
      maxExecutionAttempts: 5,
      model: 'm',
      prompt: 'p',
      params: {},
      schema: { validate: (v) => ({ ok: true, value: v as Record<string, unknown> }) },
      adapter: makeStubAdapter([resp('{"a":1,"b":{"x":1,"y":2}}')]).adapter,
      db,
    });
    const r2 = await runTransformStation<Record<string, unknown>>({
      cardId: 'card-h2',
      station: 'brief',
      runId: 'run-default',
      attempt: 0,
      maxExecutionAttempts: 5,
      model: 'm',
      prompt: 'p',
      params: {},
      schema: { validate: (v) => ({ ok: true, value: v as Record<string, unknown> }) },
      adapter: makeStubAdapter([resp('{"b":{"y":2,"x":1},"a":1}')]).adapter,
      db,
    });

    expect(expectComplete(r1).output.findings_hash).toBe(
      expectComplete(r2).output.findings_hash,
    );
  });
});

// ===========================================================================
// Finding #6 (part 3) — transform's internal parse-retry loop vs the durable
// Guard-2 counter: the relationship is EXPLICIT and surfaced, never hidden.
// ===========================================================================

describe('runTransformStation — internal retries vs durable Guard-2 counter (finding #6)', () => {
  it('surfaces the exact number of calls made via `attempts` so the caller can advance the durable counter', async () => {
    // Two parse misses then a success → 3 calls. The caller (tick) advances the
    // durable executionAttempt by exactly this surfaced count; the FSM owns the
    // authoritative scrap. The internal loop never burns the cap invisibly.
    const { adapter, calls } = makeStubAdapter([
      resp('not json'),
      resp('{"foo":1}'), // schema miss
      resp('{"foo":"ok"}'), // success
    ]);

    const result = await runTransformStation(makeCtx({ adapter, maxExecutionAttempts: 5 }));

    const ok = expectComplete(result);
    expect(ok.attempts).toBe(3); // == calls made — observable, not hidden
    expect(calls).toHaveLength(3);
  });

  it('the internal loop is bounded by maxExecutionAttempts — it cannot out-spend the durable cap', async () => {
    // A model that ALWAYS parse-misses must make at MOST maxExecutionAttempts
    // calls (the stub throws on an over-call), then scrap — documented behaviour,
    // not an undocumented runaway.
    const { adapter, calls } = makeStubAdapter([resp('x'), resp('y'), resp('z')]);

    const result = await runTransformStation(makeCtx({ adapter, maxExecutionAttempts: 3 }));

    const scr = expectScrapped(result);
    expect(scr.attempts).toBe(3); // exactly the cap value — surfaced
    expect(calls).toHaveLength(3); // never a 4th call
  });
});

// ===========================================================================
// AC5 — the model call is routed through the injected kernel adapter
// ===========================================================================

describe('runTransformStation — kernel-mediated call', () => {
  it('routes the call through the injected adapter with the station model/prompt/params (AC5)', async () => {
    const { adapter, calls } = makeStubAdapter([resp('{"foo":"ok"}')]);

    await runTransformStation(
      makeCtx({
        adapter,
        model: 'gpt-4o',
        prompt: 'do the thing',
        params: { temperature: 0.1, max_tokens: 256 },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('gpt-4o');
    expect(calls[0].prompt).toBe('do the thing');
    expect(calls[0].params).toEqual({ temperature: 0.1, max_tokens: 256 });
  });
});

// ===========================================================================
// AC6 — per-call tokens + cost written to the journal with OTel GenAI fields
// ===========================================================================

describe('runTransformStation — journal usage (OTel GenAI)', () => {
  it('writes per-call input/output tokens and cost with OTel GenAI-aligned fields (AC6)', async () => {
    const { adapter } = makeStubAdapter([
      resp('{"foo":"ok"}', { inputTokens: 42, outputTokens: 7, costUsd: 0.0123 }),
    ]);

    await runTransformStation(
      makeCtx({ cardId: 'card-otel', adapter, model: 'gpt-4o-mini', attempt: 0 }),
    );

    expect(db.getStationUsage('card-otel', 'brief', 0)).toEqual({
      'gen_ai.usage.input_tokens': 42,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.request.model': 'gpt-4o-mini',
      cost_usd: 0.0123,
    });
  });
});

// ===========================================================================
// The original per-run usage-attribution work — per-call usage must be attributed to the RUN that made the call,
// not the DEFAULT_RUN_ID sweep. runTransformStation threads ctx.runId onto the
// usage span so getRunUsageTotals(runId) — the per-run cost view — is correct.
// Before the fix the span omitted runId and every run's tokens collapsed under
// 'default', making per-run attribution impossible.
// ===========================================================================

describe('runTransformStation — per-run usage attribution (the original per-run usage-attribution work)', () => {
  it('journals the usage span under ctx.runId, not DEFAULT_RUN_ID', async () => {
    const { adapter } = makeStubAdapter([
      resp('{"foo":"ok"}', { inputTokens: 30, outputTokens: 12, costUsd: 0.05 }),
    ]);

    await runTransformStation(
      makeCtx({ cardId: 'card-run', adapter, runId: 'run-alpha', attempt: 0 }),
    );

    // Tokens + cost land under the run that actually made the call...
    expect(db.getRunUsageTotals('run-alpha')).toEqual({ tokens: 42, costUsd: 0.05 });
    // ...and NOT under the 'default' namespace (the before per-run usage attribution mis-attribution).
    expect(db.getRunUsageTotals(DEFAULT_RUN_ID)).toEqual({ tokens: 0, costUsd: 0 });
  });
});

// ===========================================================================
// AC7 — SECRET HYGIENE: raw process env never reaches the model-call context
// ===========================================================================

describe('runTransformStation — secret hygiene', () => {
  const ENV_KEY = 'CONDUIT_PROVIDER_API_KEY';
  const SECRET = 'sk-conduit-must-not-leak-9f3a2b';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('passes only the allowlisted params to the adapter — never raw process env (AC7)', async () => {
    process.env[ENV_KEY] = SECRET;

    const { adapter, calls } = makeStubAdapter([resp('{"foo":"ok"}')]);

    await runTransformStation(
      makeCtx({ cardId: 'card-sec', adapter, params: { temperature: 0.2 } }),
    );

    expect(calls).toHaveLength(1);
    // ONLY the explicitly allowlisted params — no env-derived keys, no extras.
    expect(calls[0].params).toEqual({ temperature: 0.2 });
    // The secret value must appear nowhere in the model-call request...
    expect(JSON.stringify(calls[0])).not.toContain(SECRET);
    // ...nor anywhere in the journal.
    expect(JSON.stringify(db.getJournalSpans('card-sec'))).not.toContain(SECRET);
  });
});

// ===========================================================================
// Punch-list #8 — per-call timeout threads from TransformContext into the
// ModelCall the adapter receives (so the adapter can bound a hung gateway call).
// ===========================================================================

describe('runTransformStation — timeoutMs threading (punch-list #8)', () => {
  it('passes ctx.timeoutMs through to the ModelCall handed to the adapter', async () => {
    const { adapter, calls } = makeStubAdapter([resp('{"foo":"ok"}')]);
    await runTransformStation(makeCtx({ adapter, timeoutMs: 30_000 }));
    expect(calls[0].timeoutMs).toBe(30_000);
  });

  it('omits timeoutMs from the ModelCall when the context carries none (unbounded, NFR-1 shape)', async () => {
    const { adapter, calls } = makeStubAdapter([resp('{"foo":"ok"}')]);
    await runTransformStation(makeCtx({ adapter }));
    expect('timeoutMs' in calls[0]).toBe(false);
  });
});
