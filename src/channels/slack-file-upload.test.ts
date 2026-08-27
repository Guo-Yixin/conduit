/**
 * Slack transport — file upload (3-step external), threading, caption, size-check,
 * token redaction (WI-597, PRD "Slack Egress File Delivery" §6 FR-4/6/7/8/9, NFR-1/3).
 *
 * TRANSPORT layer only — NO outbox logic (that is WI-598's egressSendFile, which
 * wraps this). This file pins the authoritative transport surface WI-598/WI-599
 * consume: a new `uploadFile` capability on the Slack transport alongside the
 * existing text `post`, plus optional thread addressing on `post`.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/channels/slack.ts
 * ---------------------------------------------------------------------------
 *
 *   interface SlackTransport {
 *     post(req: { channel; text; correlationId?; threadTs? }): Promise<{ ts: string }>;
 *     // OPTIONAL — text-only stubs across the suite must still satisfy the interface.
 *     uploadFile?(req: {
 *       channel: string;
 *       filePath: string;
 *       threadTs?: string;
 *       caption?: string;
 *     }): Promise<{ ok: true; files: Array<{ id: string }> }>;
 *   }
 *
 *   createSlackTransport({ botToken, fetchImpl?, apiBaseUrl?, maxUploadBytes? })
 *     → the returned transport's uploadFile performs Slack's external-upload
 *       three-step, IN ORDER, per call (never a cached/persisted URL — FR-4, W-3):
 *         1. files.getUploadURLExternal  (Bearer bot token; filename + byte length)
 *              → { ok, upload_url, file_id }
 *         2. raw byte POST to the returned upload_url  (the file's bytes)
 *         3. files.completeUploadExternal (Bearer bot token; carries file_id +
 *              channel, optional thread_ts, optional initial_comment)
 *              → resolves with the parsed completion body.
 *
 * Redaction (NFR-1, parity with chat.postMessage at slack.ts:404): the bot token
 * NEVER appears in any thrown error / message / property from ANY of the three
 * steps — including a failure in the raw byte POST.
 *
 * Size check (NFR-3): a file whose byte length exceeds the configured
 * `maxUploadBytes` fails with a typed, diagnosable error naming the size problem,
 * raised BEFORE any network call.
 *
 * Do NOT rebuild the outbox/HITL machinery — this only adds the transport
 * capability. The three-step is a re-runnable prelude + completion edge; the
 * outbox guarding of the completion is WI-598.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema, getIntentStatus } from '../checkpoint/checkpoint';
import { createSlackTransport, egressSend, type SlackTransport } from './slack';

// A clearly-marked secret so any leak is unmistakable in an assertion failure.
const BOT_TOKEN = 'xoxb-SECRET-do-not-leak-9f3a2b';
const UPLOAD_URL = 'https://files.slack.example/upload/v1/ABC123XYZ';
const FILE_ID = 'F0ABCDEF1';
const THREAD_TS = '1699999999.123456';
const SLACK_OK_TS = '1700000000.000100';
// Fixed known bytes so we can assert the exact byte length + content reach Slack.
const FILE_CONTENT = 'PRETEND-JPEG-BYTES-0123456789';
const FILE_CONTENT_BYTES = Buffer.byteLength(FILE_CONTENT);

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
  step: 'getUrl' | 'bytePost' | 'complete';
}

/** Which of the three external-upload steps a request URL belongs to. */
function classify(url: string): CapturedCall['step'] {
  if (url.includes('files.getUploadURLExternal')) return 'getUrl';
  if (url.includes('files.completeUploadExternal')) return 'complete';
  return 'bytePost'; // the pre-signed upload_url — anything that is not a Web API call
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type StepHandler = (callIndex: number) => Response | Promise<Response>;

/**
 * A fake `fetch` that routes the three external-upload steps. Each step returns a
 * realistic success response by default; per-step override handlers can return an
 * error response or throw to simulate a network failure at that exact step.
 */
function makeUploadFetch(opts?: {
  uploadUrl?: string;
  fileId?: string;
  onGetUrl?: StepHandler;
  onBytePost?: StepHandler;
  onComplete?: StepHandler;
}): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const uploadUrl = opts?.uploadUrl ?? UPLOAD_URL;
  const fileId = opts?.fileId ?? FILE_ID;
  const calls: CapturedCall[] = [];
  const counters = { getUrl: 0, bytePost: 0, complete: 0 };

  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const step = classify(u);
    calls.push({ url: u, init, step });
    const i = counters[step]++;

    // Route through Promise.resolve().then(...) so a handler that THROWS becomes a
    // rejected promise (a network failure), mirroring a real fetch transport error.
    if (step === 'getUrl') {
      if (opts?.onGetUrl) return Promise.resolve().then(() => opts.onGetUrl!(i));
      return Promise.resolve(jsonResponse({ ok: true, upload_url: uploadUrl, file_id: fileId }));
    }
    if (step === 'bytePost') {
      if (opts?.onBytePost) return Promise.resolve().then(() => opts.onBytePost!(i));
      // Slack's upload_url replies 200 with a plain-text body, NOT JSON.
      return Promise.resolve(new Response('OK', { status: 200 }));
    }
    if (opts?.onComplete) return Promise.resolve().then(() => opts.onComplete!(i));
    return Promise.resolve(jsonResponse({ ok: true, files: [{ id: fileId, title: 'edited.jpg' }] }));
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** A fetch that records calls and replies to chat.postMessage with a Slack ts. */
function makeChatFetch(): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init, step: 'complete' });
    return Promise.resolve(jsonResponse({ ok: true, ts: SLACK_OK_TS }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Decode a request body (string / Uint8Array / ArrayBuffer / Buffer) to text. */
function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf-8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf-8');
  if (Buffer.isBuffer(body)) return body.toString('utf-8');
  return String(body);
}

/** Read the Authorization header regardless of headers-object shape. */
function authHeaderOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get('authorization');
}

/** Everything the request could carry, as one searchable string (url + auth + body). */
function requestSurface(call: CapturedCall): string {
  return `${call.url}\n${authHeaderOf(call.init) ?? ''}\n${bodyToString(call.init?.body as BodyInit)}`;
}

/** Collect everything a thrown error could expose, to scan for token leaks. */
function leakSurface(err: unknown): string {
  const e = err as Error;
  let extra = '';
  try {
    extra = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
  } catch {
    extra = '';
  }
  return `${String(err)}\n${e?.message ?? ''}\n${e?.stack ?? ''}\n${extra}`;
}

/** A hostile network error whose message embeds the bot token (the leak case). */
function hostileError(where: string): Error {
  return new Error(`${where} to slack failed (Authorization: Bearer ${BOT_TOKEN})`);
}

/** Create a real temp file with known bytes; returns the path + a cleanup dir. */
function withTempFile(content: string, name = 'edited.jpg'): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-slack-upload-'));
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return { dir, filePath };
}

// ===========================================================================
// AC1 — the three-step external-upload sequence, in order
// ===========================================================================

describe('production SlackTransport.uploadFile — external-upload three-step (AC1/FR-4)', () => {
  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('exposes uploadFile as a function on the production transport', () => {
    const { fetchImpl } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });
    expect(typeof transport.uploadFile).toBe('function');
  });

  it('calls getUploadURLExternal → byte POST → completeUploadExternal, in that order', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    expect(calls.map((c) => c.step)).toEqual(['getUrl', 'bytePost', 'complete']);
  });

  it('step 1 sends the filename and byte length to getUploadURLExternal with a Bearer bot token', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const getUrl = calls.find((c) => c.step === 'getUrl')!;
    expect(getUrl.url).toContain('files.getUploadURLExternal');
    expect(authHeaderOf(getUrl.init)).toBe(`Bearer ${BOT_TOKEN}`);
    const surface = requestSurface(getUrl);
    expect(surface).toContain('edited.jpg');
    expect(surface).toContain(String(FILE_CONTENT_BYTES));
  });

  it('step 1 is form-encoded, never JSON — live Slack rejects a JSON body as invalid_arguments', async () => {
    // Regression pin (verified against live Slack 2026-07-15): unlike most Web
    // API methods, files.getUploadURLExternal accepts ONLY
    // application/x-www-form-urlencoded. A JSON body fails with
    // invalid_arguments ("missing required field: filename/length").
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const getUrl = calls.find((c) => c.step === 'getUrl')!;
    const contentType = new Headers(getUrl.init?.headers as HeadersInit).get('content-type') ?? '';
    expect(contentType).toContain('application/x-www-form-urlencoded');
    const body = bodyToString(getUrl.init?.body as BodyInit);
    expect(() => JSON.parse(body)).toThrow(); // a JSON body is the regression
    const params = new URLSearchParams(body);
    expect(params.get('filename')).toBe('edited.jpg');
    expect(params.get('length')).toBe(String(FILE_CONTENT_BYTES));
  });

  it('step 2 POSTs the raw file bytes to the upload_url returned by step 1', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const bytePost = calls.find((c) => c.step === 'bytePost')!;
    expect(bytePost.url).toBe(UPLOAD_URL);
    expect((bytePost.init?.method ?? 'GET').toUpperCase()).toBe('POST');
    expect(bodyToString(bytePost.init?.body as BodyInit)).toContain(FILE_CONTENT);
  });

  it('step 3 completes with the file_id from step 1 and the target channel, Bearer token attached', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const complete = calls.find((c) => c.step === 'complete')!;
    expect(complete.url).toContain('files.completeUploadExternal');
    expect(authHeaderOf(complete.init)).toBe(`Bearer ${BOT_TOKEN}`);
    const surface = requestSurface(complete);
    expect(surface).toContain(FILE_ID);
    expect(surface).toContain('C123');
  });

  it('resolves with the completion result carrying the uploaded file id', async () => {
    const { fetchImpl } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    const result = await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    expect(result.ok).toBe(true);
    expect(result.files[0]!.id).toBe(FILE_ID);
  });
});

// ===========================================================================
// AC2 — thread addressing on the upload (FR-6/FR-8): positive AND negative
// ===========================================================================

describe('production SlackTransport.uploadFile — thread addressing (FR-6/FR-8)', () => {
  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('carries thread_ts on completeUploadExternal when threadTs is provided (threaded reply)', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath, threadTs: THREAD_TS });

    const complete = calls.find((c) => c.step === 'complete')!;
    expect(requestSurface(complete)).toContain(THREAD_TS);
  });

  it('omits thread_ts entirely when threadTs is absent (posts unthreaded)', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const complete = calls.find((c) => c.step === 'complete')!;
    expect(requestSurface(complete)).not.toContain('thread_ts');
  });
});

// ===========================================================================
// AC3 — caption rides completeUploadExternal as initial_comment, NOT a separate
//        send (FR-9, decision 7): positive AND negative
// ===========================================================================

describe('production SlackTransport.uploadFile — caption as initial_comment (FR-9)', () => {
  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('sends the caption as initial_comment on completeUploadExternal — never a separate chat.postMessage', async () => {
    const caption = 'here is your edited photo';
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath, caption });

    // The caption reaches Slack on the completion call…
    const complete = calls.find((c) => c.step === 'complete')!;
    expect(requestSurface(complete)).toContain(caption);
    // …and NOT as a separate message/send: chat.postMessage is never called.
    expect(calls.some((c) => c.url.includes('chat.postMessage'))).toBe(false);
    // Still exactly the three upload steps — no extra effectful send.
    expect(calls.map((c) => c.step)).toEqual(['getUrl', 'bytePost', 'complete']);
  });

  it('omits initial_comment entirely when no caption is provided', async () => {
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    const complete = calls.find((c) => c.step === 'complete')!;
    expect(requestSurface(complete)).not.toContain('initial_comment');
  });
});

// ===========================================================================
// AC4 — pre-upload size check (NFR-3): typed error BEFORE any network call
// ===========================================================================

describe('production SlackTransport.uploadFile — size check (NFR-3)', () => {
  it('rejects a file exceeding the configured maxUploadBytes with a diagnosable size error, before any network call', async () => {
    // The file is larger than the configured limit.
    const big = 'x'.repeat(2048);
    const tmp = withTempFile(big, 'huge.jpg');
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({
      botToken: BOT_TOKEN,
      fetchImpl,
      maxUploadBytes: 1024,
    });

    let caught: unknown;
    try {
      await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
    } catch (e) {
      caught = e;
    }

    try {
      expect(caught).toBeInstanceOf(Error);
      // The error names the size problem (diagnosable, not a raw Slack API error).
      expect((caught as Error).message).toMatch(/size|too large|exceed|limit/i);
      // Raised BEFORE any network upload — zero fetch calls happened.
      expect(calls).toHaveLength(0);
      // And it never leaks the bot token.
      expect(leakSurface(caught)).not.toContain(BOT_TOKEN);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  it('uploads a file within the configured limit normally (size check does not block valid files)', async () => {
    const tmp = withTempFile(FILE_CONTENT);
    const { fetchImpl, calls } = makeUploadFetch();
    const transport = createSlackTransport({
      botToken: BOT_TOKEN,
      fetchImpl,
      maxUploadBytes: 1024,
    });

    try {
      const result = await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
      expect(result.files[0]!.id).toBe(FILE_ID);
      expect(calls.map((c) => c.step)).toEqual(['getUrl', 'bytePost', 'complete']);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// AC5 — token redaction across ALL THREE steps, including the byte POST (NFR-1)
// ===========================================================================

describe('production SlackTransport.uploadFile — token redaction across all steps (NFR-1)', () => {
  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  // Each of the three steps is its own entry point into the transport; a hostile
  // network error at ANY of them must have the token scrubbed before it surfaces.
  it.each([
    ['files.getUploadURLExternal', { onGetUrl: () => { throw hostileError('getUploadURLExternal'); } }],
    ['the raw byte POST', { onBytePost: () => { throw hostileError('byte upload'); } }],
    ['files.completeUploadExternal', { onComplete: () => { throw hostileError('completeUploadExternal'); } }],
  ] as const)(
    'redacts the bot token when %s throws a network error embedding it',
    async (_label, overrides) => {
      const { fetchImpl } = makeUploadFetch(overrides);
      const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

      let caught: unknown;
      try {
        await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
      } catch (e) {
        caught = e;
      }

      // Rejected with a catchable typed error (the executor is not crashed)…
      expect(caught).toBeInstanceOf(Error);
      // …and the bot token appears nowhere on the thrown error, despite being
      // embedded in the originating network error message.
      expect(leakSurface(caught)).not.toContain(BOT_TOKEN);
    },
  );

  // Slack Web API logical failures (HTTP 200 + { ok:false, error }) at steps 1 and 3.
  it.each([
    ['files.getUploadURLExternal', 'invalid_auth', { onGetUrl: () => jsonResponse({ ok: false, error: 'invalid_auth' }) }],
    ['files.completeUploadExternal', 'file_not_found', { onComplete: () => jsonResponse({ ok: false, error: 'file_not_found' }) }],
  ] as const)(
    'surfaces the Slack error code from %s but never the bot token',
    async (_label, slackCode, overrides) => {
      const { fetchImpl } = makeUploadFetch(overrides);
      const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

      let caught: unknown;
      try {
        await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      const surface = leakSurface(caught);
      expect(surface).toContain(slackCode);
      expect(surface).not.toContain(BOT_TOKEN);
    },
  );

  it('rejects diagnosably when the byte POST returns a non-2xx status', async () => {
    const { fetchImpl } = makeUploadFetch({
      onBytePost: () => new Response('Forbidden', { status: 403 }),
    });
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    let caught: unknown;
    try {
      await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(leakSurface(caught)).not.toContain(BOT_TOKEN);
  });

  it('never writes the bot token to the console on a successful upload', async () => {
    const logs: string[] = [];
    const cap = (...args: unknown[]): void => {
      logs.push(args.map((a) => String(a)).join(' '));
    };
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    console.log = cap;
    console.info = cap;
    console.warn = cap;
    console.error = cap;
    console.debug = cap;

    try {
      const { fetchImpl } = makeUploadFetch();
      const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });
      await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath, caption: 'hi', threadTs: THREAD_TS });
    } finally {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      console.debug = orig.debug;
    }

    expect(logs.join('\n')).not.toContain(BOT_TOKEN);
  });
});

// ===========================================================================
// Regression (Amy FLAG, NFR-1) — a Slack `ok:false` response's `error` code is
// UNTRUSTED and may itself embed the bot token; it must be scrubbed before it
// surfaces on the thrown message. The AC5 cases above use benign codes
// (invalid_auth / file_not_found) that never happen to contain the token, so
// they never exercised the ok:false redaction path. These do: the `error` field
// literally carries the token at each of the three ok:false sites.
// ===========================================================================

describe('production SlackTransport — token-embedding ok:false error field is redacted (Amy regression, NFR-1)', () => {
  // A hostile Slack error code that carries the bot token (Amy's repro shape).
  const TOKEN_IN_ERROR = `invalid_auth Bearer ${BOT_TOKEN}`;

  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it.each([
    ['files.getUploadURLExternal', { onGetUrl: () => jsonResponse({ ok: false, error: TOKEN_IN_ERROR }) }],
    ['files.completeUploadExternal', { onComplete: () => jsonResponse({ ok: false, error: TOKEN_IN_ERROR }) }],
  ] as const)(
    'scrubs the token from a %s ok:false error while keeping the code diagnosable',
    async (_label, overrides) => {
      const { fetchImpl } = makeUploadFetch(overrides);
      const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

      let caught: unknown;
      try {
        await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      const surface = leakSurface(caught);
      // The token embedded in the error code does NOT leak…
      expect(surface).not.toContain(BOT_TOKEN);
      // …but the diagnosable, non-secret part of the code is still surfaced.
      expect(surface).toContain('invalid_auth');
    },
  );

  it('scrubs the token from a chat.postMessage ok:false error while keeping the code diagnosable', async () => {
    // post()'s ok:false branch: the same untrusted-error-code leak on the text path.
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse({ ok: false, error: TOKEN_IN_ERROR }))) as unknown as typeof fetch;
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    let caught: unknown;
    try {
      await transport.post({ channel: 'C123', text: 'hello' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const surface = leakSurface(caught);
    expect(surface).not.toContain(BOT_TOKEN);
    expect(surface).toContain('invalid_auth');
  });
});

// ===========================================================================
// AC6 — post gains optional thread addressing (FR-7 transport half): pos AND neg
// ===========================================================================

describe('production SlackTransport.post — optional thread addressing (FR-7)', () => {
  it('carries the thread address on chat.postMessage when threadTs is provided', async () => {
    const { fetchImpl, calls } = makeChatFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.post({ channel: 'C123', text: 'delivered', threadTs: THREAD_TS });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('chat.postMessage');
    expect(bodyToString(calls[0]!.init?.body as BodyInit)).toContain(THREAD_TS);
  });

  it('omits the thread address when threadTs is absent (unthreaded post)', async () => {
    const { fetchImpl, calls } = makeChatFetch();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.post({ channel: 'C123', text: 'delivered' });

    expect(bodyToString(calls[0]!.init?.body as BodyInit)).not.toContain('thread_ts');
  });
});

// ===========================================================================
// AC7 — uploadFile is OPTIONAL on the interface: a text-only stub still satisfies
//        SlackTransport and drives real code (egressSend) end-to-end.
// ===========================================================================

describe('SlackTransport interface — uploadFile is optional (cross-item compatibility)', () => {
  let dir: string;
  let db: ConduitDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-slack-optional-'));
    db = openConduitDB({
      stateDbPath: join(dir, 'state.sqlite'),
      journalDbPath: join(dir, 'journal.sqlite'),
    });
    ensureCheckpointSchema(db.getStateDb());
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a post-only transport (no uploadFile) as a SlackTransport and sends through egressSend', async () => {
    const posted: Array<{ channel: string; text: string }> = [];
    // The `: SlackTransport` annotation is the compile-time proof that uploadFile
    // is optional — this object would fail typecheck if uploadFile were required.
    const textOnly: SlackTransport = {
      async post(req) {
        posted.push({ channel: req.channel, text: req.text });
        return { ts: SLACK_OK_TS };
      },
    };
    expect(textOnly.uploadFile).toBeUndefined();

    const result = await egressSend(db, textOnly, {
      channel: '#content',
      text: 'text-only delivery notice',
      idempotencyKey: 'text-only-1',
    });

    expect(result.posted).toBe(true);
    expect(posted).toEqual([{ channel: '#content', text: 'text-only delivery notice' }]);
    expect(getIntentStatus(db.getStateDb(), 'text-only-1')).toBe('committed');
  });
});

// ===========================================================================
// AC8 — a retried uploadFile re-acquires a FRESH upload URL each call; a stale
//        URL is never persisted or reused (FR-4, W-3).
// ===========================================================================

describe('production SlackTransport.uploadFile — fresh upload URL per call (W-3)', () => {
  let tmp: { dir: string; filePath: string };
  beforeEach(() => {
    tmp = withTempFile(FILE_CONTENT);
  });
  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('re-acquires a fresh upload_url from getUploadURLExternal on each call and POSTs bytes to the new URL', async () => {
    const urls = ['https://files.slack.example/upload/UP-A', 'https://files.slack.example/upload/UP-B'];
    const { fetchImpl, calls } = makeUploadFetch({
      onGetUrl: (i) => jsonResponse({ ok: true, upload_url: urls[i], file_id: FILE_ID }),
    });
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });
    await transport.uploadFile!({ channel: 'C123', filePath: tmp.filePath });

    // getUploadURLExternal was hit once per call — the URL is never cached/reused.
    const getUrlCalls = calls.filter((c) => c.step === 'getUrl');
    expect(getUrlCalls).toHaveLength(2);

    // Each call's byte POST targeted the URL that its OWN step-1 returned.
    const bytePostCalls = calls.filter((c) => c.step === 'bytePost');
    expect(bytePostCalls.map((c) => c.url)).toEqual(urls);
  });
});
