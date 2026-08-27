/**
 * Production SlackTransport — HTTP chat.postMessage behind the egress seam (WI-395).
 *
 * PRD FR7/FR11, SPEC §4A. The channel seam, outbox, and HITL machinery ALREADY
 * exist in src/channels/slack.ts (covered by egress.test.ts). This file pins the
 * ONLY missing piece: a production HTTP implementation of the existing
 * SlackTransport interface that posts via a bot token and returns a correlation
 * id (the Slack message `ts`), while NEVER leaking the bot token.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/channels/slack.ts
 * ---------------------------------------------------------------------------
 *
 *   export function createSlackTransport(config: {
 *     botToken: string;            // read from configuration; NEVER logged/journaled
 *     fetchImpl?: typeof fetch;    // injectable for tests; defaults to global fetch
 *     apiBaseUrl?: string;         // defaults to https://slack.com/api
 *   }): SlackTransport;            // the EXISTING interface — drop-in substitute
 *
 *   post({ channel, text, correlationId? }): Promise<{ ts: string }>
 *     - POSTs to <apiBaseUrl>/chat.postMessage with `Authorization: Bearer <botToken>`
 *       and a body carrying { channel, text }.
 *     - Slack returns HTTP 200 with a JSON body: { ok: true, ts } on success or
 *       { ok: false, error: '<code>' } on a logical failure (auth, channel, …).
 *     - ok:true  → resolves { ts } (the unique message id / correlation id).
 *     - ok:false → REJECTS with a typed Error whose message carries the Slack
 *       error code but NEVER the bot token.
 *     - transport/network failure → REJECTS with a typed Error, token redacted,
 *       and is catchable (it must not crash the executor / call process.exit).
 *
 * Do NOT rebuild the seam/outbox/HITL — this only fills in the transport. The
 * drop-in suite proves conformance by driving the REAL egressSend consumer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema, getIntentStatus } from '../checkpoint/checkpoint';
import { createSlackTransport, createFilesInfoReconciler, egressSend, type SlackTransport } from './slack';

// A clearly-marked secret so any leak is unmistakable in an assertion failure.
const BOT_TOKEN = 'xoxb-SECRET-do-not-leak-9f3a2b';
const SLACK_OK_TS = '1700000000.000100';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fake `fetch` that records calls and replies with a Slack-shaped JSON body. */
function makeFetch(reply: { status?: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fake `fetch` that rejects, simulating a transport/network failure. */
function makeFailingFetch(error: Error): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.reject(error);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Read the Authorization header regardless of whether headers is a plain object or Headers. */
function authHeaderOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get('authorization');
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

// ===========================================================================
// AC1 — a post hits chat.postMessage with the bot token and returns the ts
// ===========================================================================

describe('production SlackTransport — posts via chat.postMessage (AC1)', () => {
  it('POSTs to chat.postMessage with a Bearer bot token and the configured channel/text', async () => {
    const { fetchImpl, calls } = makeFetch({ body: { ok: true, ts: SLACK_OK_TS, channel: 'C123' } });
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await transport.post({ channel: 'C123', text: 'pick a variant' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain('chat.postMessage');
    expect((call.init?.method ?? 'GET').toUpperCase()).toBe('POST');
    // The bot token IS sent to Slack (as a Bearer credential).
    expect(authHeaderOf(call.init)).toBe(`Bearer ${BOT_TOKEN}`);
    // The configured channel + text reach Slack in the request body.
    const bodyStr = String(call.init?.body ?? '');
    expect(bodyStr).toContain('C123');
    expect(bodyStr).toContain('pick a variant');
  });

  it('returns the Slack message ts as the correlation id that uniquely identifies the post', async () => {
    const { fetchImpl } = makeFetch({ body: { ok: true, ts: SLACK_OK_TS, channel: 'C123' } });
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    const result = await transport.post({ channel: 'C123', text: 'hello' });

    // The returned ts is surfaced from Slack's response (not invented/hardcoded).
    expect(result.ts).toBe(SLACK_OK_TS);
  });
});

// ===========================================================================
// AC3 — a Slack API error surfaces a typed error, token-redacted, no crash
// ===========================================================================

describe('production SlackTransport — Slack API error handling (AC3)', () => {
  it.each([['auth failure', 'invalid_auth'], ['bad channel', 'channel_not_found']])(
    'rejects with a typed error carrying the Slack code (%s) and never the bot token',
    async (_label, slackCode) => {
      // Slack signals logical errors with HTTP 200 + { ok:false, error:<code> }.
      const { fetchImpl } = makeFetch({ status: 200, body: { ok: false, error: slackCode } });
      const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

      let caught: unknown;
      try {
        await transport.post({ channel: 'C123', text: 'hello' });
      } catch (e) {
        caught = e;
      }

      // It REJECTED (a catchable rejection — the executor is not crashed).
      expect(caught).toBeInstanceOf(Error);
      const surface = leakSurface(caught);
      // The actionable Slack error code is surfaced on the error (message/props/stack)…
      expect(surface).toContain(slackCode);
      // …but the bot token is NOT anywhere in the error.
      expect(surface).not.toContain(BOT_TOKEN);
    },
  );

  it('rejects with a token-redacted error when the underlying transport throws (network failure)', async () => {
    const { fetchImpl } = makeFailingFetch(new Error('ECONNREFUSED slack.com:443'));
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    let caught: unknown;
    try {
      await transport.post({ channel: 'C123', text: 'hello' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(leakSurface(caught)).not.toContain(BOT_TOKEN);
  });

  it('redacts the bot token when the underlying network error message embeds it (FR-11)', async () => {
    // Hostile input (the case the benign 'ECONNREFUSED' message never exercises):
    // some HTTP clients echo the outbound request — including the Authorization
    // header — into their own failure message. If the transport passes that
    // message through verbatim, the bot token leaks into the thrown error,
    // violating AC2/FR-11. The token must be scrubbed before it surfaces.
    const { fetchImpl } = makeFailingFetch(
      new Error(`Request to slack.com:443 failed (Authorization: Bearer ${BOT_TOKEN})`),
    );
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    let caught: unknown;
    try {
      await transport.post({ channel: 'C123', text: 'hello' });
    } catch (e) {
      caught = e;
    }

    // It still REJECTS with a catchable typed error (executor not crashed)…
    expect(caught).toBeInstanceOf(Error);
    // …and the bot token does NOT appear anywhere on the thrown error, even
    // though the originating network error embedded it.
    expect(leakSurface(caught)).not.toContain(BOT_TOKEN);
  });
});

// ===========================================================================
// AC2 — the bot token never appears in any log line (success OR failure)
// ===========================================================================

describe('production SlackTransport — secret hygiene (AC2)', () => {
  it('never writes the bot token to the console on a successful or a failed post', async () => {
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
      // Success path.
      const okT = createSlackTransport({
        botToken: BOT_TOKEN,
        fetchImpl: makeFetch({ body: { ok: true, ts: SLACK_OK_TS } }).fetchImpl,
      });
      await okT.post({ channel: 'C123', text: 'hello', correlationId: 'hitl::c1::n' });

      // Failure path.
      const failT = createSlackTransport({
        botToken: BOT_TOKEN,
        fetchImpl: makeFetch({ body: { ok: false, error: 'invalid_auth' } }).fetchImpl,
      });
      await failT.post({ channel: 'C123', text: 'hello' }).catch(() => {});
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
// AC4 — drop-in substitute: the REAL egressSend consumer drives the production
//        transport end-to-end (outbox commits), and the token never lands in
//        any journaled/outbox state (AC2, end-to-end).
// ===========================================================================

describe('production SlackTransport — drop-in behind egressSend (AC4)', () => {
  let dir: string;
  let db: ConduitDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-slack-transport-'));
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

  it('is accepted by egressSend as a SlackTransport, posts once, and commits the outbox', async () => {
    const { fetchImpl, calls } = makeFetch({ body: { ok: true, ts: SLACK_OK_TS } });
    // Compile-time conformance: the factory output satisfies the existing interface.
    const transport: SlackTransport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    const result = await egressSend(db, transport, {
      channel: '#content',
      text: 'delivery: final.zip',
      idempotencyKey: 'send-1',
    });

    expect(result.posted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('chat.postMessage');
    // The outbox-guarded path committed the intent (resume would not re-post).
    expect(getIntentStatus(db.getStateDb(), 'send-1')).toBe('committed');
  });

  it('does not leak the bot token into the journaled outbox payload', async () => {
    const { fetchImpl } = makeFetch({ body: { ok: true, ts: SLACK_OK_TS } });
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl });

    await egressSend(db, transport, {
      channel: '#content',
      text: 'delivery: final.zip',
      idempotencyKey: 'send-1',
    });

    const rows = db
      .getStateDb()
      .prepare('SELECT payload_json FROM outbox')
      .all() as Array<{ payload_json: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.payload_json).join('\n')).not.toContain(BOT_TOKEN);
  });
});

// ===========================================================================
// Fetch timeouts — every transport fetch is BOUNDED (the pre-public Slack fetch-timeout review fixes 1-3)
//
// Bun's fetch has no default timeout; one stalled connection hung a run's kernel
// forever. These pin (a) a non-null AbortSignal on every fetch, (b) that a hung
// call REJECTS (token-scrubbed) rather than hangs, and (c) that the byte-upload
// POST is governed by uploadTimeoutMs while the control steps use fetchTimeoutMs.
// ===========================================================================

/** A routing fetch for the 3-step external upload that records each call's init. */
function makeUploadRouter(opts?: {
  onGetUrl?: (init?: RequestInit) => Promise<Response>;
  onBytePost?: (init?: RequestInit) => Promise<Response>;
  onComplete?: (init?: RequestInit) => Promise<Response>;
}): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('files.getUploadURLExternal')) {
      return opts?.onGetUrl?.(init) ?? json({ ok: true, upload_url: 'https://files.slack.example/up/1', file_id: 'F1' });
    }
    if (u.includes('files.completeUploadExternal')) {
      return opts?.onComplete?.(init) ?? json({ ok: true, files: [{ id: 'F1' }] });
    }
    // the pre-signed upload_url — raw byte POST replies 200 plain text, not JSON.
    return opts?.onBytePost?.(init) ?? Promise.resolve(new Response('OK', { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that settles ONLY when its AbortSignal fires — a stall the bound must break. */
function hangingUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    // No signal → never settles: the test would time out, which is the failure we want to catch.
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

const THREE_BYTES = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;

describe('production SlackTransport — every fetch is bounded (the pre-public Slack fetch-timeout review)', () => {
  it('attaches a non-null AbortSignal to post, all 3 upload steps, and the reconciler probe', async () => {
    const postFetch = makeFetch({ body: { ok: true, ts: SLACK_OK_TS } });
    await createSlackTransport({ botToken: BOT_TOKEN, fetchImpl: postFetch.fetchImpl }).post({
      channel: '#c',
      text: 'hi',
    });
    expect(postFetch.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);

    const upload = makeUploadRouter();
    await createSlackTransport({ botToken: BOT_TOKEN, fetchImpl: upload.fetchImpl }).uploadFile!({
      channel: '#c',
      filePath: 'x.jpg',
      bytes: THREE_BYTES,
    });
    expect(upload.calls).toHaveLength(3);
    for (const call of upload.calls) {
      expect(call.init!.signal).toBeInstanceOf(AbortSignal);
    }

    const probe = makeFetch({ body: { ok: true, files: [] } });
    const reconciler = createFilesInfoReconciler({ botToken: BOT_TOKEN, fetchImpl: probe.fetchImpl, channel: 'C1' });
    await reconciler({ path: 'x.jpg', size: 3 });
    expect(probe.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung post rather than hanging, surfacing a token-scrubbed network error', async () => {
    const { fetchImpl } = makeFailingFetchThatHangs();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl, fetchTimeoutMs: 10 });
    let thrown: unknown;
    try {
      await transport.post({ channel: '#c', text: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Slack transport network failure (chat.postMessage)');
    expect(leakSurface(thrown)).not.toContain(BOT_TOKEN);
  });

  it('aborts a hung upload step rather than hanging, surfacing a token-scrubbed network error', async () => {
    const { fetchImpl } = makeFailingFetchThatHangs();
    const transport = createSlackTransport({ botToken: BOT_TOKEN, fetchImpl, fetchTimeoutMs: 10 });
    let thrown: unknown;
    try {
      await transport.uploadFile!({ channel: '#c', filePath: 'x.jpg', bytes: THREE_BYTES });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Slack transport network failure (files.getUploadURLExternal)');
    expect(leakSurface(thrown)).not.toContain(BOT_TOKEN);
  });

  it('governs the byte POST by uploadTimeoutMs and the control steps by fetchTimeoutMs', async () => {
    // Scenario A — only the byte POST hangs. A tiny uploadTimeoutMs must abort it
    // even though the control steps run under a long fetchTimeoutMs. Proves the
    // byte transfer carries its OWN, longer budget.
    const byteHang = makeUploadRouter({ onBytePost: (init) => hangingUntilAbort(init) });
    let thrownByte: unknown;
    try {
      await createSlackTransport({
        botToken: BOT_TOKEN,
        fetchImpl: byteHang.fetchImpl,
        fetchTimeoutMs: 10_000,
        uploadTimeoutMs: 10,
      }).uploadFile!({ channel: '#c', filePath: 'x.jpg', bytes: THREE_BYTES });
    } catch (err) {
      thrownByte = err;
    }
    expect((thrownByte as Error).message).toContain('Slack transport network failure (byte upload)');
    // The control step (getUploadURLExternal) completed within its long budget.
    expect(byteHang.calls.some((c) => c.url.includes('files.getUploadURLExternal'))).toBe(true);

    // Scenario B — only step 1 hangs. A tiny fetchTimeoutMs must abort it even
    // though uploadTimeoutMs is long. Proves the control steps are NOT governed by
    // the upload budget (the request never reaches the byte POST).
    const getUrlHang = makeUploadRouter({ onGetUrl: (init) => hangingUntilAbort(init) });
    let thrownCtl: unknown;
    try {
      await createSlackTransport({
        botToken: BOT_TOKEN,
        fetchImpl: getUrlHang.fetchImpl,
        fetchTimeoutMs: 10,
        uploadTimeoutMs: 10_000,
      }).uploadFile!({ channel: '#c', filePath: 'x.jpg', bytes: THREE_BYTES });
    } catch (err) {
      thrownCtl = err;
    }
    expect((thrownCtl as Error).message).toContain('Slack transport network failure (files.getUploadURLExternal)');
    expect(getUrlHang.calls).toHaveLength(1); // aborted at step 1 — byte POST never fired.
  });
});

/** A fetch that never resolves on its own, only rejecting when its AbortSignal fires. */
function makeFailingFetchThatHangs(): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return hangingUntilAbort(init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
