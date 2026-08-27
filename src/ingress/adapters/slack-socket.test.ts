/**
 * Tests for the Slack Socket Mode ingress adapter (the original Slack Socket Mode work).
 *
 * Socket Mode is the second Slack transport: an OUTBOUND wss connection
 * (apps.connections.open with an app-level token) over which Slack delivers the
 * same event envelopes the Events API webhook receives — for deployments with
 * zero inbound reachability.
 *
 * Mirrors the slack-events.test.ts posture: the REAL WI-406 accept-spawn path /
 * WI-405 deriveEventId / WI-404 ingress_log run against a real on-disk SQLite
 * db; only the outermost I/O is seamed (SocketSeam for apps.connections.open +
 * websocket, spawn, alert, sleep).
 *
 * Contract this file pins for src/ingress/adapters/slack-socket.ts:
 *
 *   export interface SocketSeam {
 *     openConnection(appToken): Promise<{ok:true;url} | {ok:false;error}>;
 *     connect(url, handlers: {onMessage(raw), onClose()}): SocketConnection;
 *   }
 *   export interface SocketConnection { send(data): void; close(): void }
 *   export function createSocketModeClient(deps: SlackSocketDeps, appToken): SocketModeClient;
 *   export function defaultSocketBackoffMs(attempt): number;
 *
 * Pinned contract decisions:
 *   - Envelope ack ({envelope_id} echoed on the socket) is sent BEFORE any
 *     processing — the Socket Mode equivalent of the webhook's fast HTTP 2xx.
 *   - events_api payloads feed the SAME shared pipeline as the webhook
 *     transport (processSlackPayload): channel-resolve → derive → accept/spawn,
 *     with the same dedup absorbing envelope redelivery.
 *   - disconnect(refresh_requested) performs an overlap handoff: the
 *     replacement connection is opened BEFORE the old socket is closed, and the
 *     old socket's own close event is a stale-generation no-op.
 *   - disconnect(link_disabled) is terminal: no reconnect loop against a
 *     disabled app.
 *   - Unexpected closes and open failures reconnect with the injected backoff;
 *     a successful hello resets the backoff schedule.
 *   - interactive / unknown envelope types are acked (so Slack stops
 *     redelivering) but logged as unsupported, never spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../../persistence/db';
import { type SpawnPathDeps, type SpawnSeam, type SpawnInvocation } from '../spawn';
import type { IngressBinding } from '../binding';
import type { SlackChannelResolution } from './slack-events';
import {
  createSocketModeClient,
  defaultSocketBackoffMs,
  type SlackSocketDeps,
  type SocketConnection,
  type SocketHandlers,
  type SocketLifecycleEvent,
  type SocketOpenResult,
  type SocketSeam,
} from './slack-socket';

const APP_TOKEN = 'xapp-1-A0-fake-app-token';
const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeConnection implements SocketConnection {
  sent: string[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}

  send(data: string): void {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }

  /** Test helper: Slack delivers a frame. */
  deliver(envelope: unknown): void {
    this.handlers.onMessage(
      typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    );
  }
  /** Test helper: the underlying socket drops. */
  drop(): void {
    this.handlers.onClose();
  }
}

function makeSocketSeam(opts: { openResults?: SocketOpenResult[]; manualOpen?: boolean } = {}) {
  const connections: FakeConnection[] = [];
  const openCalls: string[] = [];
  /** manualOpen mode: each openConnection call parks here until the test resolves it. */
  const pendingOpens: Array<(result: SocketOpenResult) => void> = [];
  const seam: SocketSeam = {
    openConnection: async (appToken) => {
      openCalls.push(appToken);
      if (opts.manualOpen) {
        return new Promise<SocketOpenResult>((resolve) => pendingOpens.push(resolve));
      }
      return opts.openResults?.shift() ?? { ok: true, url: `wss://fake/${openCalls.length}` };
    },
    connect: (_url, handlers) => {
      const conn = new FakeConnection(handlers);
      connections.push(conn);
      return conn;
    },
  };
  return { seam, connections, openCalls, pendingOpens };
}

/** Flush the void-ed async message handler (one macrotask is enough). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wraps a real ConduitDB so `appendIngressLog` throws while every other method
 * still works against the real on-disk SQLite fixture. A plain object spread
 * (`{ ...realDb, appendIngressLog: ... }`) does NOT work here: ConduitDB is a
 * class instance whose methods live on the prototype, not as own enumerable
 * properties, so a spread silently drops them all. A Proxy forwards every
 * other property to the real instance (bound, so internal `this.stateDb` /
 * `this.journalDb` access still resolves correctly).
 */
function dbWithThrowingIngressLog(realDb: ConduitDB): ConduitDB {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'appendIngressLog') {
        return () => {
          throw new Error('journal write failed');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Shared fixture (mirrors slack-events.test.ts)
// ---------------------------------------------------------------------------

let dir: string;
let db: ConduitDB;
let spawnCalls: SpawnInvocation[];
let lifecycle: SocketLifecycleEvent[];
let sleeps: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-slack-socket-'));
  db = openConduitDB({
    stateDbPath: join(dir, 'state.sqlite'),
    journalDbPath: join(dir, 'journal.sqlite'),
  });
  spawnCalls = [];
  lifecycle = [];
  sleeps = [];
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
    flowId: 'studio-flow',
    flowPath: '/flows/studio.yaml',
    flow: { version: 1, stations: {} },
    binding: {
      type: 'slack',
      transport: 'socket',
      app_token_env: 'SLACK_APP_TOKEN',
      event_id: { from: 'json_path', path: '$.event_id' },
    } satisfies IngressBinding,
    ...over,
  };
}

function makeDeps(
  seam: SocketSeam,
  opts: { resolution?: SlackChannelResolution | null } = {},
): SlackSocketDeps {
  const resolution = opts.resolution === undefined ? makeResolution() : opts.resolution;
  return {
    spawnDeps: makeSpawnDeps(),
    resolveChannel: () => resolution,
    now: () => NOW_MS,
    socket: seam,
    onLifecycle: (e) => lifecycle.push(e),
    backoffMs: (attempt) => attempt * 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function eventsEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'events_api',
    envelope_id: 'env-0001',
    payload: {
      event_id: 'Ev0001',
      event: { type: 'message', channel: 'C-STUDIO', text: 'raw shot drop', files: [{ name: 'shot.jpg' }] },
    },
    ...over,
  };
}

function lifecycleKinds(): string[] {
  return lifecycle.map((e) => e.kind);
}

// ===========================================================================
// Connection establishment
// ===========================================================================

describe('createSocketModeClient — connection establishment', () => {
  it('opens the connection with the app token and reports connected on hello', async () => {
    const { seam, connections, openCalls } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);

    await client.start();
    expect(openCalls).toEqual([APP_TOKEN]);
    expect(connections).toHaveLength(1);

    connections[0]!.deliver({ type: 'hello' });
    await flush();
    expect(lifecycleKinds()).toContain('connected');
  });

  it('retries a failed apps.connections.open with backoff, then connects', async () => {
    const { seam, connections, openCalls } = makeSocketSeam({
      openResults: [{ ok: false, error: 'invalid_auth' }, { ok: true, url: 'wss://fake/ok' }],
    });
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);

    await client.start();

    expect(openCalls).toHaveLength(2);
    expect(connections).toHaveLength(1);
    expect(sleeps).toEqual([100]); // backoffMs(1)
    expect(lifecycle).toContainEqual({ kind: 'open_failed', error: 'invalid_auth' });
    expect(lifecycle).toContainEqual({ kind: 'reconnect_scheduled', attempt: 1, delayMs: 100 });
  });
});

// ===========================================================================
// events_api envelopes → the shared pipeline
// ===========================================================================

describe('createSocketModeClient — events_api envelopes', () => {
  async function startedClient(opts: { resolution?: SlackChannelResolution | null } = {}) {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam, opts), APP_TOKEN);
    await client.start();
    return { client, conn: connections[0]!, connections };
  }

  it('acks the envelope_id FIRST, then derives the native id and spawns once', async () => {
    const { conn } = await startedClient();

    conn.deliver(eventsEnvelope());
    // The ack must be synchronous with delivery — before any async processing.
    expect(conn.sent).toEqual([JSON.stringify({ envelope_id: 'env-0001' })]);

    await flush();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.flowPath).toBe('/flows/studio.yaml');
    expect(spawnCalls[0]!.inputInline).toContain('Ev0001');
    expect(spawnCalls[0]!.inputInline).toContain('raw shot drop');
    expect(spawnCalls[0]!.inputInline).toContain('shot.jpg');
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });

  it('dedups an envelope redelivery: second delivery acks but does not spawn again', async () => {
    const { conn } = await startedClient();

    conn.deliver(eventsEnvelope());
    await flush();
    // Slack redelivers with a fresh envelope_id but the SAME payload event_id.
    conn.deliver(eventsEnvelope({ envelope_id: 'env-0002' }));
    await flush();

    expect(conn.sent).toHaveLength(2); // both acked
    expect(spawnCalls).toHaveLength(1); // spawned once
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
  });

  it('logs rejected_unknown_flow for an event in an unwatched channel (still acked)', async () => {
    const { conn } = await startedClient({ resolution: null });

    conn.deliver(eventsEnvelope());
    await flush();

    expect(conn.sent).toHaveLength(1); // acked regardless
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_unknown_flow' })).toHaveLength(1);
  });

  it('logs rejected_malformed for a non-JSON frame without acking or crashing', async () => {
    const { conn } = await startedClient();

    conn.deliver('this is not json');
    await flush();

    expect(conn.sent).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('logs rejected_malformed for an enveloped frame with no envelope_id', async () => {
    const { conn } = await startedClient();

    conn.deliver(eventsEnvelope({ envelope_id: undefined }));
    await flush();

    expect(conn.sent).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('acks an interactive envelope and routes it to the HITL reply processor (the original HITL reply-and-resume work)', async () => {
    const { conn } = await startedClient();

    // No run has recorded this correlation id — the reply is REFUSED (never
    // guessed at), observably; a trigger is never spawned for a button tap.
    conn.deliver({
      type: 'interactive',
      envelope_id: 'env-hitl-1',
      payload: { actions: [{ action_id: 'hitl::card-1::n', value: 'opt-a' }] },
    });
    await flush();

    expect(conn.sent).toEqual([JSON.stringify({ envelope_id: 'env-hitl-1' })]);
    expect(spawnCalls).toHaveLength(0);
    const logs = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.reason).toContain("no run recorded HITL correlation 'hitl::card-1::n'");
  });

  it('an interactive envelope for a HELD card records the selection and un-holds it (the original HITL reply-and-resume work FR-3a)', async () => {
    const { conn } = await startedClient();

    // Seed the exact state executeRankStation leaves behind: a held card whose
    // correlation id is surfaced on the card_log.
    db.insertCard({
      run_id: 'run-hitl',
      id: 'card-1',
      parent_id: null,
      lane: 'select',
      status: 'held',
      attempt: 0,
      wave: 0,
      owned_paths: [],
    });
    db.appendCardLog({
      runId: 'run-hitl',
      kind: 'terminal',
      cardId: 'card-1',
      station: 'select',
      attempt: 0,
      reason: 'hitl::card-1::select::0',
    });

    conn.deliver({
      type: 'interactive',
      envelope_id: 'env-hitl-2',
      payload: { actions: [{ action_id: 'hitl::card-1::select::0', value: 'Bubblegum Beach' }] },
    });
    await flush();

    expect(conn.sent).toEqual([JSON.stringify({ envelope_id: 'env-hitl-2' })]);
    expect(spawnCalls).toHaveLength(0);
    expect((db.getCard('run-hitl', 'card-1') as { status: string }).status).toBe('ready');
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });

  it('logs spawn_failed when the ack send throws (socket died mid-flight), and does not spawn', async () => {
    const { conn } = await startedClient();

    conn.closed = true; // socket died between delivery and ack
    conn.deliver(eventsEnvelope());
    await flush();

    expect(spawnCalls).toHaveLength(0);
    const logs = db.getIngressLog({ outcome: 'spawn_failed' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.reason).toContain('failed to ack');
  });
});

// ===========================================================================
// Lifecycle: disconnect frames, unexpected closes, stop
// ===========================================================================

describe('createSocketModeClient — connection lifecycle', () => {
  it('disconnect(refresh_requested): opens the replacement BEFORE closing the old socket', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();
    const oldConn = connections[0]!;

    oldConn.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();

    expect(connections).toHaveLength(2);
    expect(oldConn.closed).toBe(true);
    expect(connections[1]!.closed).toBe(false);
    expect(lifecycleKinds()).toContain('refresh');

    // Events on the replacement connection still process normally.
    connections[1]!.deliver(eventsEnvelope());
    await flush();
    expect(spawnCalls).toHaveLength(1);
  });

  it('the replaced socket\'s own close event is a stale-generation no-op (no double reconnect)', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();
    const oldConn = connections[0]!;

    oldConn.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();
    expect(connections).toHaveLength(2);

    // The real websocket fires onclose after close() — must not reconnect again.
    oldConn.drop();
    await flush();
    expect(connections).toHaveLength(2);
  });

  it('disconnect(link_disabled) is terminal: closes, reports, and never reconnects', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();
    const conn = connections[0]!;

    conn.deliver({ type: 'disconnect', reason: 'link_disabled' });
    await flush();

    expect(conn.closed).toBe(true);
    expect(connections).toHaveLength(1);
    expect(lifecycle).toContainEqual({ kind: 'terminal', reason: 'link_disabled' });

    // Even the socket's own close event must not resurrect the client.
    conn.drop();
    await flush();
    expect(connections).toHaveLength(1);
  });

  it('an unexpected close reconnects with backoff', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();

    connections[0]!.drop();
    await flush();

    expect(connections).toHaveLength(2);
    expect(sleeps).toEqual([100]); // backoffMs(1)
    expect(lifecycle).toContainEqual({ kind: 'reconnect_scheduled', attempt: 1, delayMs: 100 });
  });

  it('a successful hello resets the backoff schedule', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();

    connections[0]!.drop(); // attempt 1
    await flush();
    connections[1]!.deliver({ type: 'hello' }); // healthy again — reset
    await flush();
    connections[1]!.drop(); // must be attempt 1 again, not 2
    await flush();

    expect(sleeps).toEqual([100, 100]);
  });

  it('a straggler refresh frame on a superseded socket does NOT dial a third connection', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();
    const oldConn = connections[0]!;

    oldConn.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();
    expect(connections).toHaveLength(2);

    // Slack keeps the old socket briefly open after a handoff — a queued
    // disconnect frame can still arrive on it. It must be a stale no-op.
    oldConn.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();
    expect(connections).toHaveLength(2);

    // Stale enveloped events are dropped too (redelivered on the live socket).
    oldConn.deliver(eventsEnvelope());
    await flush();
    expect(spawnCalls).toHaveLength(0);
  });

  it('a refresh handoff racing the old socket\'s close dials exactly ONE replacement', async () => {
    const { seam, connections, pendingOpens } = makeSocketSeam({ manualOpen: true });
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);

    const started = client.start();
    pendingOpens.shift()!({ ok: true, url: 'wss://fake/1' });
    await started;
    const oldConn = connections[0]!;

    // Slack sends the refresh frame, then closes the old socket while the
    // replacement dial is still awaiting apps.connections.open.
    oldConn.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();
    oldConn.drop();
    await flush();

    // Resolve every dial the client attempted; a second concurrent establish
    // loop would have parked a second pending open here.
    while (pendingOpens.length > 0) {
      pendingOpens.shift()!({ ok: true, url: 'wss://fake/replacement' });
      await flush();
    }

    expect(connections).toHaveLength(2); // old + exactly one replacement
  });

  it('stop() during a reconnect backoff sleep suppresses the pending dial', async () => {
    const { seam, connections } = makeSocketSeam();
    const sleepResolvers: Array<() => void> = [];
    const deps = makeDeps(seam);
    deps.sleep = (ms) => {
      sleeps.push(ms);
      return new Promise((resolve) => sleepResolvers.push(resolve));
    };
    const client = createSocketModeClient(deps, APP_TOKEN);
    await client.start();

    connections[0]!.drop(); // schedules a reconnect, parks in sleep
    await flush();
    expect(sleepResolvers).toHaveLength(1);

    client.stop();
    sleepResolvers.shift()!(); // the sleep elapses AFTER stop
    await flush();

    expect(connections).toHaveLength(1); // no reconnect
  });

  it('stop() closes the active connection and suppresses reconnection', async () => {
    const { seam, connections } = makeSocketSeam();
    const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
    await client.start();
    const conn = connections[0]!;

    client.stop();
    expect(conn.closed).toBe(true);
    expect(lifecycleKinds()).toContain('stopped');

    conn.drop();
    await flush();
    expect(connections).toHaveLength(1); // no reconnect after stop
  });
});

// ===========================================================================
// Fix 2 — a synchronous connect() throw is treated as an open failure
// (PR review, slack-socket.ts:163). Bun's `new WebSocket(url)` can throw
// synchronously on a malformed URL; connectTo() is reached from establishLoop,
// which establish() reaches from the fire-and-forget handleMessage during a
// refresh handoff — an uncaught throw there becomes an unhandled rejection.
// ===========================================================================

describe('createSocketModeClient — synchronous connect() throw (Fix 2)', () => {
  it('backs off, schedules a reconnect, and succeeds on the next attempt — no unhandled rejection', async () => {
    const connections: FakeConnection[] = [];
    let connectCalls = 0;
    const seam: SocketSeam = {
      openConnection: async () => ({ ok: true, url: 'wss://fake/1' }),
      connect: (_url, handlers) => {
        connectCalls += 1;
        if (connectCalls === 1) {
          // Models `new WebSocket(url)` throwing synchronously on a malformed URL.
          throw new Error('invalid url');
        }
        const conn = new FakeConnection(handlers);
        connections.push(conn);
        return conn;
      },
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const client = createSocketModeClient(makeDeps(seam), APP_TOKEN);
      // Must resolve, not reject — this is exactly what fails before the fix
      // (the synchronous throw propagates out of establishLoop and rejects
      // the promise returned by start()).
      await expect(client.start()).resolves.toBeUndefined();
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(connectCalls).toBe(2);
    expect(connections).toHaveLength(1); // exactly one usable connection afterward
    expect(sleeps).toEqual([100]); // backoffMs(1)
    expect(lifecycle).toContainEqual({ kind: 'open_failed', error: 'invalid url' });
    expect(lifecycle).toContainEqual({ kind: 'reconnect_scheduled', attempt: 1, delayMs: 100 });
  });
});

// ===========================================================================
// Fix 1 (extended) — logSafely guards every direct db.appendIngressLog call
// site in this file against a throwing ingress log (PR review, slack-events.ts:258,
// extended to slack-socket.ts). handleMessage is fired void from the connection
// handlers, so if the ingress log itself fails (disk I/O error, etc.) the throw
// must be swallowed rather than becoming an unhandled rejection.
// ===========================================================================

describe('createSocketModeClient — logSafely guards a throwing ingress log (Fix 1)', () => {
  it('delivers a malformed frame against a throwing-log db without an unhandled rejection, and stays functional', async () => {
    const { seam, connections } = makeSocketSeam();
    // Wrap the REAL on-disk db so every other method still works, but the
    // fallback logging call itself throws (models a journal disk I/O error).
    const throwingDb = dbWithThrowingIngressLog(db);
    const deps = makeDeps(seam);
    deps.spawnDeps = { ...deps.spawnDeps, db: throwingDb };
    const client = createSocketModeClient(deps, APP_TOKEN);
    await client.start();

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      // Non-JSON frame → the `catch` branch calls (the pre-fix) db.appendIngressLog
      // directly, which throws with a throwing db.
      connections[0]!.deliver('this is not json');
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    // The throwing db swallowed the log row — none was recorded — but the
    // client must still be alive and process subsequent frames normally.
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);

    connections[0]!.deliver(eventsEnvelope());
    await flush();
    expect(spawnCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Production backoff schedule
// ===========================================================================

describe('defaultSocketBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(defaultSocketBackoffMs(1)).toBe(1_000);
    expect(defaultSocketBackoffMs(2)).toBe(2_000);
    expect(defaultSocketBackoffMs(3)).toBe(4_000);
    expect(defaultSocketBackoffMs(6)).toBe(30_000);
    expect(defaultSocketBackoffMs(50)).toBe(30_000);
  });
});
