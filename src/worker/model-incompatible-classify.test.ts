/**
 * Tests for classifying an image-to-text-only-model rejection as a non-retryable
 * `vision-unsupported` fast-scrap (WI-421, FR-6, Resolved Q1).
 *
 * Capability behind a model gateway is not kernel-knowable, so an image sent to a
 * text-only model surfaces as a provider rejection at CALL time. This item:
 *   1. (adapter) classifies that rejection as a typed, NON-transient
 *      capability-mismatch error with a clear kernel message — not an opaque raw
 *      provider 400 surfaced verbatim.
 *   2. (transform) lets that classified error FAST-SCRAP on the FIRST occurrence
 *      with a DISTINCT reason `vision-unsupported` — without iterating the
 *      parse/validate retry loop or consuming an execution attempt.
 *   3. (executor) the existing scrap path maps that reason onto the card, so it
 *      lands in `scrap`/`scrapped` with terminal reason `vision-unsupported`
 *      (greppable apart from cap-exhaustion's `model-incompatible`), and writes
 *      no checkpoint (so a config fix + resume RE-RUNS the station — Resolved Q1).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins (src/worker/openai-adapter.ts + src/worker/transform.ts)
 * ---------------------------------------------------------------------------
 *  - openai-adapter: on a capability-mismatch gateway rejection (a 400 whose
 *    error body indicates the model does not accept image/vision input), call()
 *    throws an Error carrying `code === 'vision-unsupported'` and a clear kernel
 *    message (mentions vision/image; NOT the raw provider body verbatim). A
 *    generic 400 (no vision signal) still throws the existing generic HTTP error;
 *    a 200 success is unaffected. (B.A. may implement the classified error as a
 *    custom Error subclass — the load-bearing, tested signal is the `code`.)
 *  - transform: when adapter.call(...) throws an error with
 *    `code === 'vision-unsupported'`, runTransformStation returns
 *    `{ status:'scrapped', reason:'vision-unsupported', attempts: 0 }` on the
 *    first occurrence — it does NOT retry to the cap and does NOT journal a bill.
 *    Other errors propagate; a parse/validate failure still consumes attempts and
 *    scraps with reason `model-incompatible` (UNCHANGED).
 *  - executor: the existing scrap path (executor.ts ~855) carries the reason, so
 *    the card scraps with terminal reason `vision-unsupported` and no checkpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from './adapter';
import type { ImageInput } from './image-input';
import { runTransformStation, type OutputSchema, type TransformContext, type TransformResult } from './transform';
import { createOpenAiAdapter } from './openai-adapter';

import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The classification code the adapter must stamp on a capability-mismatch error. */
const VISION_UNSUPPORTED = 'vision-unsupported';

/** Read the (duck-typed) classification code off a thrown error. */
function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** Await a promise expected to reject; return the thrown Error. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected the promise to reject, but it resolved');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal valid-PNG ImageInput literal (enough to form a multimodal call). */
function fakeImage(): ImageInput {
  return { path: 'frame.png', bytes: Uint8Array.from(PNG_SIGNATURE), mediaType: 'image/png' };
}

// ===========================================================================
// Part A — adapter classification (src/worker/openai-adapter.ts)
// ===========================================================================

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
    calls.push({ url, init: init ?? {} });
    return handler(calls[calls.length - 1]!);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const BASE_URL = 'https://gateway.example/v1';
function envWithKey(): Record<string, string | undefined> {
  return { CONDUIT_API_KEY: 'sk-test-key', CONDUIT_BASE_URL: BASE_URL };
}

function chatSuccess(text = 'a caption'): Response {
  const payload = {
    choices: [{ index: 0, message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A 400 whose body clearly signals the model cannot accept image/vision input. */
const VISION_MISMATCH_BODY = JSON.stringify({
  error: {
    message: 'This model does not support image input — vision is not available for this model.',
    type: 'invalid_request_error',
    code: 'unsupported_content',
  },
});
function visionMismatch400(): Response {
  return new Response(VISION_MISMATCH_BODY, { status: 400, headers: { 'content-type': 'application/json' } });
}

/** Build a 400 whose error body carries `message` (OpenAI-style error envelope). */
function error400(message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

describe('openai-adapter — classifies a capability-mismatch rejection (AC1/AC4/AC5)', () => {
  it('throws a vision-unsupported-coded error with a clear message on an image-to-text-only-model 400', async () => {
    const { fetchFn } = makeFetchStub(() => visionMismatch400());
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const err = await rejection(
      adapter.call({ model: 'gpt-3.5-turbo', prompt: 'describe', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).toBe(VISION_UNSUPPORTED); // classified, non-transient
    expect(err.message).toMatch(/vision|image/i); // clear kernel message
    expect(err.message).not.toContain(VISION_MISMATCH_BODY); // not the raw provider body verbatim
  });

  // AC4: the classifier must match the CONCEPT (model cannot handle images), NOT
  // the mere appearance of the word "image"/"vision" anywhere in a 400 body. Each
  // of these is a genuine, unrelated 400 that happens to mention "image" — they
  // must stay the generic HTTP error so an operator is not told to swap the model
  // when the real fix is a parameter/size/format change. (Flagged by Amy.)
  it.each([
    ["a temperature param error", "Invalid value for 'temperature': must be <= 2"],
    ['an image_quality param error', 'Invalid parameter: image_quality is not supported'],
    ['an image-too-large error', 'Request error: the image is too large, max 20MB'],
    ['an invalid-image-format error', 'Invalid image format: only JPEG is supported'],
    // Amy round-2 confirmed false positives: "image"/"vision" appears, but the
    // message is NOT a model-can't-do-vision rejection. A bare keyword/wildcard
    // matcher trips on all of these; a correct matcher must not.
    ['an image_url param-type error', 'This model does not support image_url type'],
    ['an image_url processing error', 'Server cannot process image_url types'],
    ['an endpoint image-processing-tier error', 'This endpoint does not support image processing in this tier'],
    ['a "vision of" prose false-friend', "My statistical model does not support the vision of what we're doing here"],
    ['a hardware vision error', 'Vision not supported by hardware'],
  ])('does NOT classify %s as vision-unsupported (stays the generic HTTP 400)', async (_label, message) => {
    const { fetchFn } = makeFetchStub(() => error400(message));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const err = await rejection(
      adapter.call({ model: 'gpt-4o', prompt: 'p', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).not.toBe(VISION_UNSUPPORTED);
    expect(err.message).toContain('400');
  });

  // Counterpart to the above: genuine capability statements (worded differently)
  // MUST still classify — so tightening the matcher to fix the false positives
  // above does not introduce false negatives.
  it.each([
    ['no-support phrasing', 'This model does not support image input.'],
    ['plural image-inputs phrasing', 'This model does not support image inputs.'],
    ['vision-not-supported phrasing', 'Vision is not supported for this model.'],
  ])('classifies a genuine capability mismatch (%s) as vision-unsupported', async (_label, message) => {
    const { fetchFn } = makeFetchStub(() => error400(message));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const err = await rejection(
      adapter.call({ model: 'gpt-3.5-turbo', prompt: 'p', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).toBe(VISION_UNSUPPORTED);
  });

  it('classifies a local OpenAI-compatible 422 by structured error code, without relying on English prose', async () => {
    const { fetchFn } = makeFetchStub(() =>
      new Response(
        JSON.stringify({
          error: {
            code: 'unsupported_content',
            type: 'invalid_request_error',
            message: 'content rejected by local server',
          },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const err = await rejection(
      adapter.call({ model: 'local-gemma:12b', prompt: 'p', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).toBe(VISION_UNSUPPORTED);
    expect(err.message).toMatch(/vision|image/i);
  });

  it('classifies a local 500 by structured vision code after bounded retries are exhausted', async () => {
    const { fetchFn } = makeFetchStub(() =>
      new Response(
        JSON.stringify({
          object: 'error',
          code: 'vision_unsupported',
          type: 'local_server_error',
          message: 'local runner rejected the request',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    const sleepFn = () => Promise.resolve();
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey(), sleepFn });

    const err = await rejection(
      adapter.call({ model: 'local-qwen-vl', prompt: 'p', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).toBe(VISION_UNSUPPORTED);
  });

  it('lets a local provider-specific structured code opt into vision-unsupported classification', async () => {
    const { fetchFn } = makeFetchStub(() =>
      new Response(
        JSON.stringify({
          error: {
            code: 'ollama_image_disabled',
            message: 'Server cannot process image_url types',
          },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    const sleepFn = () => Promise.resolve();
    const adapter = createOpenAiAdapter({
      fetchFn,
      env: {
        ...envWithKey(),
        CONDUIT_VISION_UNSUPPORTED_ERROR_CODES: 'ollama_image_disabled',
      },
      sleepFn,
    });

    const err = await rejection(
      adapter.call({ model: 'ollama/gemma3:12b', prompt: 'p', params: {}, images: [fakeImage()] }),
    );

    expect(codeOf(err)).toBe(VISION_UNSUPPORTED);
  });

  it('does not classify text-only requests as vision-unsupported even when a structured code mentions unsupported content', async () => {
    const { fetchFn } = makeFetchStub(() =>
      new Response(
        JSON.stringify({
          error: {
            code: 'unsupported_content',
            message: 'content rejected by local server',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const err = await rejection(
      adapter.call({ model: 'local-text-model', prompt: 'p', params: {} }),
    );

    expect(codeOf(err)).not.toBe(VISION_UNSUPPORTED);
    expect(err.message).toContain('400');
  });

  it('does not misclassify a successful vision call (AC5 — no false positive)', async () => {
    const { fetchFn } = makeFetchStub(() => chatSuccess('a sunny field'));
    const adapter = createOpenAiAdapter({ fetchFn, env: envWithKey() });

    const res = await adapter.call({ model: 'gpt-4o', prompt: 'describe', params: {}, images: [fakeImage()] });

    expect(res.text).toBe('a sunny field');
  });
});

// ===========================================================================
// Part B — transform fast-scrap (src/worker/transform.ts)
// ===========================================================================

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

function resp(text: string): ModelResponse {
  return { text, inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
}

/** Adapter that records calls and throws `toThrow` on every call. */
function throwingAdapter(toThrow: unknown): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      throw toThrow;
    },
  };
  return { adapter, calls };
}

/** Adapter that returns the same response every call (records calls). */
function repeatingAdapter(response: ModelResponse): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return response;
    },
  };
  return { adapter, calls };
}

/** A classified capability-mismatch error exactly as the adapter would throw it. */
function visionUnsupportedError(): Error {
  return Object.assign(new Error('Model does not support image input (vision-unsupported)'), {
    code: VISION_UNSUPPORTED,
  });
}

describe('runTransformStation — fast-scraps a vision-unsupported error (AC2/AC3/AC4)', () => {
  let tdb: ConduitDB;
  beforeEach(() => {
    tdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  });
  afterEach(() => {
    tdb.close();
  });

  function ctx(over: Partial<TransformContext<Foo>> & { adapter: ModelAdapter }): TransformContext<Foo> {
    return {
      cardId: 'card-1',
      station: 'caption',
      runId: 'run-default',
      attempt: 0,
      maxExecutionAttempts: 4,
      model: 'gpt-3.5-turbo',
      prompt: 'describe',
      params: {},
      schema: fooSchema,
      db: tdb,
      ...over,
    };
  }

  it('scraps immediately with reason vision-unsupported, no retry and no re-bill', async () => {
    const { adapter, calls } = throwingAdapter(visionUnsupportedError());

    let result: TransformResult<Foo> | undefined;
    let threw = false;
    try {
      result = await runTransformStation(ctx({ adapter }));
    } catch {
      threw = true;
    }

    // The classified error must NOT propagate out — it is mapped to a scrap.
    expect(threw).toBe(false);
    expect(result?.status).toBe('scrapped');
    // Distinct reason, greppable apart from cap-exhaustion's 'model-incompatible'.
    expect((result as { reason: string }).reason).toBe(VISION_UNSUPPORTED);
    // No execution attempt consumed (the throwing call is not a completed re-bill).
    expect((result as { attempts: number }).attempts).toBe(0);
    // Called exactly ONCE — it did not iterate the parse/validate retry loop.
    expect(calls).toHaveLength(1);
  });

  it('keeps the distinct parse-failure path: cap-exhaustion still scraps model-incompatible (AC4)', async () => {
    // A parse failure is NOT a capability mismatch — it still consumes attempts
    // and scraps with the EXISTING reason, proving the two failure modes stay apart.
    const { adapter, calls } = repeatingAdapter(resp('not valid json'));

    const result = await runTransformStation(ctx({ adapter, maxExecutionAttempts: 4 }));

    expect(result.status).toBe('scrapped');
    expect((result as { reason: string }).reason).toBe('model-incompatible');
    expect((result as { attempts: number }).attempts).toBe(4);
    expect(calls).toHaveLength(4);
  });
});

// ===========================================================================
// Part C — executor end-to-end: card scraps with the distinct reason and writes
//          no checkpoint (AC2 / AC6).
// ===========================================================================

const WORKER_MODEL = 'gpt-3.5-turbo';

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}
const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const handle = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(handle.getStateDb());
  return handle;
}

function seedCard(handle: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  handle.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? ['caption.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function terminalReasons(handle: ConduitDB, cardId: string): string[] {
  return handle
    .getCardLog(cardId)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

function checkpointStamps(handle: ConduitDB, station: string): string[] {
  return (
    handle
      .getStateDb()
      .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
      .all({ $s: station }) as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

function setupVisionFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'caption.md'), 'Describe the attached image.');
  // A valid PNG so loadImageInput succeeds and the failure is the model call, not the load.
  writeFileSync(join(dir, 'frame.png'), Buffer.from(Uint8Array.from(PNG_SIGNATURE)));

  const flowYaml = `
flow: vision-scrap
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: caption
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/caption.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: caption, type: string, required: true }
    inputs: []
    image_inputs: [{ path: frame.png }]
    outputs: [caption.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`vision fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

describe('executor — a vision-unsupported model call scraps with the distinct reason (AC2/AC6)', () => {
  let projectDir: string;
  let originalCwd: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-vision-scrap-'));
    process.chdir(projectDir);
    db = null;
  });
  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('lands the card in scrap with terminal reason vision-unsupported and writes no checkpoint', async () => {
    const flow = setupVisionFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'c1', lane: 'caption' });
    // The worker model rejects the image call → classified vision-unsupported.
    const { adapter } = throwingAdapter(visionUnsupportedError());
    const { io } = makeIO();

    // Before the impl lands, the typed error propagates and runExecutor rejects;
    // after it lands, the executor fast-scraps the card. Tolerate both, then assert
    // the post-condition the card must be in.
    try {
      await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    } catch {
      /* pre-impl: error propagates instead of mapping to a scrap */
    }

    const card = db.getCard(DEFAULT_RUN_ID, 'c1');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    expect(terminalReasons(db, 'c1')).toContain(VISION_UNSUPPORTED);
    // AC6 / Resolved Q1: no checkpoint persisted → resume RE-RUNS, never skip-replays a scrap.
    expect(checkpointStamps(db, 'caption')).toHaveLength(0);
  });
});
