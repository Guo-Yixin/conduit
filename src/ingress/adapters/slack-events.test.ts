/**
 * Tests for the Slack-events ingress adapter (WI-409, FR-4/FR-5/FR-6/NFR-5).
 *
 * A signed Slack message in a watched channel triggers exactly one `conduit run`
 * with the message + attachments as substrate. Unsigned / unknown-channel /
 * malformed events are rejected and logged; Slack's 3s-ack retries are absorbed
 * by dedup. Two distinct concerns are pinned here:
 *
 *   1. verifySlackSignature — the REAL mandatory request-signing crypto
 *      (signing secret + timestamp + body HMAC-SHA256, constant-time, replay
 *      window). Tested directly with computed signatures.
 *   2. handleSlackEvent — the adapter orchestration. Mirrors the WI-408 webhook
 *      adapter: composes the REAL WI-406 accept-spawn path / WI-405 deriveEventId
 *      / WI-404 ingress_log / WI-411 secret-filter against a real on-disk SQLite
 *      db; only the two outermost I/O seams (Bun.spawn, alert) and the auth seam
 *      are stubbed. Slack's fast-ack/async-process semantics are modelled by a
 *      SlackResponse whose `status` is the immediate ack and whose `processed`
 *      promise resolves when the async accept/spawn (or rejection logging) finishes.
 *
 * Contract this file pins for src/ingress/adapters/slack-events.ts:
 *
 *   export interface SlackRequest  { headers: Record<string, string>; rawBody: string }
 *   export interface SlackResponse { status: number; processed: Promise<void> }
 *
 *   export interface SlackChannelResolution {
 *     flowId: string; flowPath: string; flow: FlowConfig; binding: IngressBinding;
 *   }
 *
 *   export interface SlackAdapterDeps {
 *     spawnDeps: SpawnPathDeps;                                       // WI-406
 *     signingSecret: string;                                         // app-global Slack signing secret (never logged)
 *     resolveChannel(channel: string): SlackChannelResolution | null;// FR-6
 *     verifyAuth(signingSecret: string, req: SlackRequest): boolean; // mandatory signing seam (fail-closed)
 *     now(): number;                                                 // deterministic received_at
 *   }
 *
 *   export function handleSlackEvent(deps: SlackAdapterDeps, req: SlackRequest): SlackResponse;
 *   export function verifySlackSignature(
 *     signingSecret: string, req: SlackRequest,
 *     opts?: { now?: number; toleranceSeconds?: number },           // now in unix SECONDS; default tolerance 300s
 *   ): boolean;
 *
 * Pinned contract decisions (resolving AC ambiguity):
 *   - Signature verification is the ONLY pre-ack gate (the security boundary,
 *     fail-closed). An invalid/missing signature is rejected SYNCHRONOUSLY with a
 *     non-2xx status, logs 'rejected_auth', and never runs the accept-spawn path.
 *   - A VALID signature acks 2xx immediately; parse → channel-resolve → derive →
 *     accept-spawn all happen asynchronously (the 3s window). Outcomes determined
 *     after the ack (rejected_unknown_flow, rejected_malformed, duplicate, accepted)
 *     are logged in `processed`.
 *   - Happy/duplicate ingress_log rows ('accepted'/'duplicate') come from
 *     runSpawnPath; the adapter writes the rejection rows ('rejected_auth' /
 *     'rejected_malformed' / 'rejected_unknown_flow') itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../../persistence/db';
import { type SpawnPathDeps, type SpawnSeam, type SpawnInvocation } from '../spawn';
import type { IngressBinding } from '../binding';
import type { FlowConfig } from '../../types/kernel';
import {
  handleSlackEvent,
  verifySlackSignature,
  processSlackPayload,
  type SlackAdapterDeps,
  type SlackRequest,
  type SlackChannelResolution,
} from './slack-events';

const SIGNING_SECRET = 'slack-signing-secret-deadbeef';
const NOW_SECONDS = 1_700_000_000; // unix seconds

/** Produce a valid Slack v0 signature header for a (timestamp, body) pair. */
function signSlack(secret: string, tsSeconds: number, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${tsSeconds}:${body}`).digest('hex');
}

function signedRequest(over: { body?: string; tsSeconds?: number } = {}): SlackRequest {
  const ts = over.tsSeconds ?? NOW_SECONDS;
  const body =
    over.body ??
    JSON.stringify({
      event_id: 'Ev0001',
      event: { type: 'message', channel: 'C-DEPLOY', text: 'please deploy', files: [{ name: 'log.txt' }] },
    });
  return {
    headers: {
      'X-Slack-Request-Timestamp': String(ts),
      'X-Slack-Signature': signSlack(SIGNING_SECRET, ts, body),
    },
    rawBody: body,
  };
}

// ===========================================================================
// verifySlackSignature — the mandatory request-signing crypto (Context, AC2)
// ===========================================================================

describe('verifySlackSignature (mandatory request signing)', () => {
  it('accepts a correctly v0-signed, fresh request', () => {
    expect(verifySlackSignature(SIGNING_SECRET, signedRequest(), { now: NOW_SECONDS })).toBe(true);
  });

  it('rejects a request whose signature does not match the body', () => {
    const req = signedRequest();
    const tampered: SlackRequest = { ...req, rawBody: req.rawBody + ' tampered' };
    expect(verifySlackSignature(SIGNING_SECRET, tampered, { now: NOW_SECONDS })).toBe(false);
  });

  it('rejects a request signed with the wrong secret', () => {
    expect(verifySlackSignature('the-wrong-secret', signedRequest(), { now: NOW_SECONDS })).toBe(false);
  });

  it('rejects a stale request outside the replay tolerance window', () => {
    const staleTs = NOW_SECONDS - 600; // 10 minutes old
    const req = signedRequest({ tsSeconds: staleTs });
    expect(
      verifySlackSignature(SIGNING_SECRET, req, { now: NOW_SECONDS, toleranceSeconds: 300 }),
    ).toBe(false);
  });

  it('rejects a request with no signature header', () => {
    const req: SlackRequest = { headers: { 'X-Slack-Request-Timestamp': String(NOW_SECONDS) }, rawBody: '{}' };
    expect(verifySlackSignature(SIGNING_SECRET, req, { now: NOW_SECONDS })).toBe(false);
  });
});

// ===========================================================================
// handleSlackEvent — adapter orchestration
// ===========================================================================

let dir: string;
let db: ConduitDB;
let spawnCalls: SpawnInvocation[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-slack-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
  spawnCalls = [];
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const spawnSeam: SpawnSeam = async (invocation) => {
  spawnCalls.push(invocation);
  return { ok: true };
};

function makeSpawnDeps(): SpawnPathDeps {
  return { db, spawn: spawnSeam, alert: async () => {}, globalAlertChannel: 'slack:ops', redriveCap: 100 };
}

function makeResolution(over: Partial<SlackChannelResolution> = {}): SlackChannelResolution {
  return {
    flowId: 'deploy-flow',
    flowPath: '/flows/deploy.yaml',
    flow: { version: 1, stations: {} },
    binding: {
      type: 'slack',
      auth: { type: 'signing', secret_env: 'SLACK_SIGNING_SECRET' },
      // Derives Slack's native event id (body.event_id) deterministically. IngressBinding
      // requires an explicit event_id source, so we pin the json_path to the native id.
      event_id: { from: 'json_path', path: '$.event_id' },
    } satisfies IngressBinding,
    ...over,
  };
}

function makeDeps(opts: { resolution?: SlackChannelResolution | null; authOk?: boolean } = {}): SlackAdapterDeps {
  const resolution = opts.resolution === undefined ? makeResolution() : opts.resolution;
  return {
    spawnDeps: makeSpawnDeps(),
    signingSecret: SIGNING_SECRET,
    resolveChannel: () => resolution,
    verifyAuth: () => opts.authOk ?? true,
    now: () => NOW_SECONDS * 1000,
  };
}

// ── AC1 — signed event in a watched channel → derive native id → accept-spawn ──
describe('handleSlackEvent — signed happy path (AC1)', () => {
  it('acks 2xx, derives the native event id, maps message + attachments, and spawns once', async () => {
    const res = handleSlackEvent(makeDeps({ authOk: true }), signedRequest());

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    await res.processed;

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.flowPath).toBe('/flows/deploy.yaml');
    // Slack native event id (body.event_id) and the message text reached the substrate.
    expect(spawnCalls[0]!.inputInline).toContain('Ev0001');
    expect(spawnCalls[0]!.inputInline).toContain('please deploy');
    expect(spawnCalls[0]!.inputInline).toContain('log.txt'); // attachment carried through

    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });
});

// ── AC2 — missing/invalid signature → rejected_auth, fail-closed (FR-5) ──
describe('handleSlackEvent — auth failure is fail-closed (AC2, FR-5)', () => {
  it('rejects with non-2xx, logs rejected_auth, and never accepts or spawns', async () => {
    const res = handleSlackEvent(makeDeps({ authOk: false }), signedRequest());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    await res.processed;

    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_auth' })).toHaveLength(1);
    // The event was never recorded as accepted in the dedup ledger.
    expect(db.getIngressEvent('Ev0001')).toBeNull();
  });
});

// ── AC3 — signed but unparseable body → rejected_malformed, no spawn ──
describe('handleSlackEvent — malformed payload (AC3)', () => {
  it('logs rejected_malformed and never spawns when the signed body cannot be parsed', async () => {
    const ts = NOW_SECONDS;
    const badBody = '{ not valid json';
    const req: SlackRequest = {
      headers: {
        'X-Slack-Request-Timestamp': String(ts),
        'X-Slack-Signature': signSlack(SIGNING_SECRET, ts, badBody),
      },
      rawBody: badBody,
    };

    // Signature passes (authOk:true models a valid signature over the raw bytes).
    const res = handleSlackEvent(makeDeps({ authOk: true }), req);
    await res.processed;

    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });
});

// ── AC4 — Slack re-delivery of the same event → dedup → duplicate, no second spawn ──
describe('handleSlackEvent — Slack retry dedup (AC4)', () => {
  it('absorbs a re-delivered event as a duplicate with no second spawn', async () => {
    const deps = makeDeps({ authOk: true });

    const first = handleSlackEvent(deps, signedRequest());
    await first.processed;
    const second = handleSlackEvent(deps, signedRequest()); // Slack's 3s-ack retry — same event_id
    await second.processed;

    expect(spawnCalls).toHaveLength(1); // exactly one billed run
    expect(db.getIngressLog().map((e) => e.outcome)).toEqual(['accepted', 'duplicate']);
  });
});

// ── AC5 — channel resolves to no flow binding → rejected_unknown_flow, no spawn (FR-6) ──
describe('handleSlackEvent — unknown channel (AC5, FR-6)', () => {
  it('logs rejected_unknown_flow, never spawns, and never accepts', async () => {
    const res = handleSlackEvent(makeDeps({ resolution: null, authOk: true }), signedRequest());
    await res.processed;

    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_unknown_flow' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });
});

// ── AC6 — ack-fast-then-async + signing-secret hygiene (NFR-5) ──
describe('handleSlackEvent — fast ack + secret hygiene (AC6, NFR-5)', () => {
  it('returns the ack BEFORE the accept-spawn runs, then completes it asynchronously', async () => {
    const res = handleSlackEvent(makeDeps({ authOk: true }), signedRequest());

    // The ack status is available immediately; the spawn has NOT happened yet.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(spawnCalls).toHaveLength(0);

    // The accept-spawn completes only once the async work settles.
    await res.processed;
    expect(spawnCalls).toHaveLength(1);
  });

  it('never writes the signing secret into ingress_log or the spawned substrate', async () => {
    // Drive a rejected (auth) path and an accepted path against the same db.
    const reject = handleSlackEvent(makeDeps({ authOk: false }), signedRequest());
    await reject.processed;
    const accept = handleSlackEvent(makeDeps({ authOk: true }), signedRequest());
    await accept.processed;

    expect(JSON.stringify(db.getIngressLog())).not.toContain(SIGNING_SECRET);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.inputInline).not.toContain(SIGNING_SECRET);
  });
});

// ── url_verification — Slack app-setup challenge (FR-5 preserved) ──────────
describe('handleSlackEvent — url_verification challenge', () => {
  // Slack signs url_verification requests with the same signing scheme. The
  // adapter MUST verify the signature first (fail-closed, FR-5) and ONLY echo
  // the challenge on a valid signature. The async event-processing path (parse
  // → channel-resolve → accept/spawn) must NOT run for challenge requests.

  it('echoes the challenge on a signed url_verification request → 200, body contains challenge', async () => {
    const challenge = 'test-challenge-value-abc123';
    const body = JSON.stringify({ type: 'url_verification', challenge });
    const req = signedRequest({ body });

    const res = handleSlackEvent(makeDeps({ authOk: true }), req);

    expect(res.status).toBe(200);
    // body must be present and contain the challenge value
    expect(res.body).toBeDefined();
    expect(res.body).toContain(challenge);

    await res.processed;

    // No accept record, no spawn — the async event-processing path did NOT run.
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });

  it('rejects an UNSIGNED url_verification request → 401 (fail-closed preserved)', async () => {
    const challenge = 'test-challenge-value-xyz789';
    const body = JSON.stringify({ type: 'url_verification', challenge });
    // Unsigned: no signature headers at all.
    const req: SlackRequest = {
      headers: { 'X-Slack-Request-Timestamp': String(NOW_SECONDS) },
      rawBody: body,
    };

    // verifyAuth returns false (real verifySlackSignature would reject missing sig).
    const res = handleSlackEvent(makeDeps({ authOk: false }), req);

    expect(res.status).toBe(401);
    // Challenge must NOT be echoed — fail-closed.
    expect(res.body).toBeUndefined();

    await res.processed;

    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_auth' })).toHaveLength(1);
  });
});

// ── processSlackPayload — "Never re-throws" must hold even when the fallback
// ingress-log write itself fails (PR review, slack-events.ts:258). Socket Mode
// invokes this pipeline from a fire-and-forget handler, so an escaping throw
// here becomes an unhandled rejection that crashes the listener. ──────────
describe('processSlackPayload — never re-throws, even when the fallback log fails', () => {
  it('swallows a throwing db.appendIngressLog in the outer catch and resolves cleanly', async () => {
    // Force execution into the outer catch: resolveChannel throwing is the
    // simplest way to land there regardless of which pipeline step runs first.
    const resolveChannel = (): SlackChannelResolution | null => {
      throw new Error('resolveChannel exploded');
    };
    // Wrap the real db so every OTHER method still works, but the fallback
    // logging call itself throws (models a disk I/O error on the journal db).
    // A plain object spread would silently drop every method (ConduitDB is a
    // class instance; methods live on the prototype, not as own enumerable
    // properties) — a Proxy forwards everything except the overridden method.
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'appendIngressLog') {
          return () => {
            throw new Error('journal write failed');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ConduitDB;
    const spawnDeps: SpawnPathDeps = { ...makeSpawnDeps(), db: throwingDb };

    // Must resolve (not reject) — asserting this is exactly what would fail
    // before the fix, since the unguarded appendIngressLog call would escape
    // the outer catch and reject this promise.
    await expect(
      processSlackPayload(
        { spawnDeps, resolveChannel, now: () => NOW_SECONDS * 1000 },
        { headers: {}, rawBody: JSON.stringify({ event: { channel: 'C1' } }), sourceLabel: 'slack' },
      ),
    ).resolves.toBeUndefined();
  });
});
