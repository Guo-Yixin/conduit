/**
 * Slack Socket Mode ingress adapter (the original Slack Socket Mode work).
 *
 * The second Slack transport: instead of Slack pushing Events API webhooks to a
 * public HTTPS endpoint, the listener opens an OUTBOUND websocket
 * (apps.connections.open with an app-level token → wss:// URL) and Slack
 * delivers the same event envelopes over it. Zero inbound reachability — built
 * for deployments with no public edge (tailnet-only engines).
 *
 * What is shared with the webhook transport, deliberately:
 *   - The entire post-ack pipeline: parse → channel-resolve → derive-event-id →
 *     accept/spawn is processSlackPayload from slack-events.ts. The transports
 *     differ ONLY in delivery + ack.
 *   - At-least-once + durable dedup: an unacked envelope is redelivered by
 *     Slack; the WI-406 accept gate absorbs the replay.
 *   - The thin-listener rule: this module verifies nothing (the wss connection
 *     IS the auth — established by the app token at apps.connections.open),
 *     dedups via the shared path, and spawns. No orchestration at the edge.
 *
 * What is genuinely new — connection lifecycle:
 *   - Envelope ack: echo `{envelope_id}` on the socket, ack-FIRST (the Socket
 *     Mode equivalent of the webhook's HTTP 2xx, same ~3s expectation).
 *   - `disconnect` frames: Slack recycles connections (~hourly,
 *     reason 'refresh_requested'). The client opens the REPLACEMENT connection
 *     before closing the old one so no envelope falls in the gap.
 *   - reason 'link_disabled' (app disabled) is terminal: surface it and stop —
 *     never retry-loop against a disabled app.
 *   - Any other close reconnects with injected backoff.
 *
 * All I/O is seamed (SocketSeam, sleep, backoffMs) so unit tests drive the full
 * lifecycle deterministically with fake connections — mirroring the
 * slack-events.ts posture where only the outermost effects are stubbed.
 */
import { processSlackPayload, processSlackInteractive, type SlackChannelResolution } from './slack-events';
import type { SpawnPathDeps } from '../spawn';

// ---------------------------------------------------------------------------
// Public types (pinned by slack-socket.test.ts)
// ---------------------------------------------------------------------------

export type SocketOpenResult = { ok: true; url: string } | { ok: false; error: string };

export interface SocketHandlers {
  onMessage(raw: string): void;
  onClose(): void;
}

/** A live websocket connection, reduced to the two operations the client needs. */
export interface SocketConnection {
  send(data: string): void;
  close(): void;
}

/**
 * The two outermost Socket Mode I/O effects, seamed for testability:
 * the apps.connections.open call and the websocket dial.
 */
export interface SocketSeam {
  openConnection(appToken: string): Promise<SocketOpenResult>;
  connect(url: string, handlers: SocketHandlers): SocketConnection;
}

/** Lifecycle observability — production logs these; tests assert on them. */
export type SocketLifecycleEvent =
  | { kind: 'connected' }
  | { kind: 'refresh' }
  | { kind: 'open_failed'; error: string }
  | { kind: 'reconnect_scheduled'; attempt: number; delayMs: number }
  | { kind: 'terminal'; reason: string }
  | { kind: 'stopped' };

export interface SlackSocketDeps {
  /** WI-406 persistence + spawn + alert seams (shared with the webhook adapter). */
  spawnDeps: SpawnPathDeps;
  /** FR-6: resolve a Slack channel id to its flow + binding — SAME map as the webhook path. */
  resolveChannel(channel: string): SlackChannelResolution | null;
  /** Injected clock — returns received_at in unix MILLISECONDS. */
  now(): number;
  /** apps.connections.open + websocket seams. */
  socket: SocketSeam;
  /** Lifecycle observability sink. */
  onLifecycle(event: SocketLifecycleEvent): void;
  /** Reconnect delay for the given consecutive-failure attempt (1-based). */
  backoffMs(attempt: number): number;
  /** Injected sleep so tests drive reconnection deterministically. */
  sleep(ms: number): Promise<void>;
  /** The original HITL reply-and-resume work: post-reply resume hook, threaded to the shared processors. */
  onHitlResumed?(runId: string): Promise<void> | void;
}

export interface SocketModeClient {
  /** Open the initial connection. Resolves once connected (or stopped/terminal). */
  start(): Promise<void>;
  /** Close the active connection and suppress all future reconnects. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Creates a Socket Mode client for ONE app-level token. Deployments where
 * several flows share a Slack app share a single client — envelope routing to
 * flows happens per-channel via resolveChannel, exactly like the webhook path.
 */
export function createSocketModeClient(
  deps: SlackSocketDeps,
  appToken: string,
): SocketModeClient {
  const { spawnDeps, socket, onLifecycle, backoffMs, sleep } = deps;
  const { db } = spawnDeps;

  /**
   * db.appendIngressLog wrapped in try/catch: handleMessage/handleClose are
   * fired void (fire-and-forget) from the connection handlers, so ANY throw
   * inside them — including from the observability log itself (disk I/O
   * error, etc.) — becomes an unhandled rejection and crashes the listener.
   * If the log write fails there is nothing left to record the failure INTO,
   * so we can only swallow it and keep the socket alive.
   */
  function logSafely(entry: Parameters<typeof db.appendIngressLog>[0]): void {
    try {
      db.appendIngressLog(entry);
    } catch {
      /* the ingress log itself failed — nothing left to log it to; swallow */
    }
  }

  let stopped = false;
  /** Consecutive connection-failure counter — reset on a successful hello. */
  let attempt = 0;
  /**
   * Monotonic connection generation. Every dial bumps it; handlers captured by
   * an older connection compare their generation before acting, so a stale
   * socket's frames and close events can never tear down, double-reconnect, or
   * leak connections past its successor.
   */
  let generation = 0;
  /**
   * True while an establish() loop is in flight (between its first
   * openConnection call and connectTo/stop). The generation alone cannot fence
   * this window — it is only bumped once the dial SUCCEEDS — so without this
   * flag a refresh handoff racing a natural onClose could run two establish()
   * loops concurrently and leak a connection.
   */
  let connecting = false;
  let active: SocketConnection | null = null;

  /** Dial until a connection is established, backing off on open failures. */
  async function establish(): Promise<void> {
    if (connecting) return; // a reconnect loop is already in flight — it owns the dial
    connecting = true;
    try {
      await establishLoop();
    } finally {
      connecting = false;
    }
  }

  async function establishLoop(): Promise<void> {
    while (!stopped) {
      let open: SocketOpenResult;
      try {
        open = await socket.openConnection(appToken);
      } catch (err) {
        open = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (stopped) return;

      if (!open.ok) {
        attempt += 1;
        const delayMs = backoffMs(attempt);
        onLifecycle({ kind: 'open_failed', error: open.error });
        onLifecycle({ kind: 'reconnect_scheduled', attempt, delayMs });
        await sleep(delayMs);
        continue;
      }

      try {
        connectTo(open.url);
      } catch (err) {
        // Bun's `new WebSocket(url)` (inside socket.connect) can throw
        // synchronously on a malformed URL. connectTo() is invoked from this
        // loop, which is itself invoked from the fire-and-forget
        // handleMessage (refresh handoffs) — an uncaught throw here would
        // become an unhandled rejection and crash the listener. Treat it
        // exactly like an openConnection failure: back off and keep looping.
        attempt += 1;
        const delayMs = backoffMs(attempt);
        onLifecycle({
          kind: 'open_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        onLifecycle({ kind: 'reconnect_scheduled', attempt, delayMs });
        await sleep(delayMs);
        continue;
      }
      return;
    }
  }

  function connectTo(url: string): void {
    const gen = ++generation;
    const conn: SocketConnection = socket.connect(url, {
      onMessage: (raw) => {
        void handleMessage(gen, conn, raw);
      },
      onClose: () => {
        void handleClose(gen);
      },
    });
    active = conn;
  }

  async function handleClose(gen: number): Promise<void> {
    // A newer connection has already replaced this one (refresh handoff), the
    // client was stopped, or a reconnect dial is already in flight (a refresh
    // handoff's establish() — the old socket closing behind it is expected).
    if (stopped || gen !== generation || connecting) return;

    active = null;
    // Note: a close followed by a failed re-open advances the backoff schedule
    // by two steps (this increment + establish's own) — acceptable: the
    // schedule is capped and a healthy hello resets it.
    attempt += 1;
    const delayMs = backoffMs(attempt);
    onLifecycle({ kind: 'reconnect_scheduled', attempt, delayMs });
    await sleep(delayMs);

    // Re-check: stop(), a refresh handoff, or another reconnect may have raced
    // the sleep (establish() itself also no-ops when a dial is in flight).
    if (stopped || gen !== generation) return;
    await establish();
  }

  async function handleMessage(gen: number, conn: SocketConnection, raw: string): Promise<void> {
    // Frames from a superseded socket (Slack keeps the old connection briefly
    // open after a refresh handoff) must not act — in particular a straggler
    // disconnect frame must not dial ANOTHER replacement. Dropping is safe:
    // unacked envelopes are redelivered on the live connection and dedup
    // absorbs any that were already processed.
    if (stopped || gen !== generation) return;

    // ── Parse the envelope ───────────────────────────────────────────────────
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      logSafely({
        source: 'slack-socket',
        eventId: null,
        outcome: 'rejected_malformed',
        reason: 'socket envelope is not a JSON object',
      });
      return;
    }

    const type = typeof envelope['type'] === 'string' ? envelope['type'] : '';

    // ── hello: connection established ────────────────────────────────────────
    if (type === 'hello') {
      attempt = 0; // healthy connection — reset the backoff schedule
      onLifecycle({ kind: 'connected' });
      return;
    }

    // ── disconnect: refresh handoff or terminal ─────────────────────────────
    if (type === 'disconnect') {
      const reason = typeof envelope['reason'] === 'string' ? envelope['reason'] : 'unknown';

      if (reason === 'link_disabled') {
        // The app was disabled — terminal. Never retry-loop against it.
        stopped = true;
        onLifecycle({ kind: 'terminal', reason });
        conn.close();
        return;
      }

      // Slack recycles connections (~hourly, 'refresh_requested'). Open the
      // replacement BEFORE closing the old socket so no envelope falls in the
      // gap — Slack permits multiple concurrent connections per app precisely
      // for this handoff. Stale-generation guards make the old socket's own
      // close event a no-op.
      onLifecycle({ kind: 'refresh' });
      await establish();
      conn.close();
      return;
    }

    // ── Enveloped event: ack FIRST, then process ─────────────────────────────
    const envelopeId = typeof envelope['envelope_id'] === 'string' ? envelope['envelope_id'] : null;
    if (envelopeId === null) {
      logSafely({
        source: 'slack-socket',
        eventId: null,
        outcome: 'rejected_malformed',
        reason: `socket envelope of type '${type}' has no envelope_id`,
      });
      return;
    }

    // The ack is the Socket Mode equivalent of the webhook's fast HTTP 2xx —
    // send it before any processing so Slack's ~3s window is met regardless of
    // how long the spawn path takes. An unacked envelope would be redelivered;
    // the shared dedup absorbs replays either way.
    try {
      conn.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (err) {
      logSafely({
        source: 'slack-socket',
        eventId: null,
        outcome: 'spawn_failed',
        reason: `failed to ack envelope: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (type === 'interactive') {
      // The original HITL reply-and-resume work FR-3a: a HITL reply arrives on the SAME socket as events
      // (docs/slack-channel.md §2A) — a button tap whose action_id round-trips
      // the correlation id. Already acked above; route to the shared
      // interactivity processor (transport-agnostic, mirrors processSlackPayload).
      try {
        await processSlackInteractive(spawnDeps.db, envelope['payload'], deps.onHitlResumed);
      } catch (interactiveError) {
        // Never let a malformed payload crash the socket loop — the envelope
        // is acked; the failure is journaled, not thrown.
        logSafely({
          source: 'slack-socket',
          eventId: null,
          outcome: 'rejected_malformed',
          reason: `interactive envelope processing failed: ${
            interactiveError instanceof Error ? interactiveError.message : 'unknown error'
          }`,
        });
      }
      return;
    }

    if (type !== 'events_api') {
      // slash_commands / unknown: acked (so Slack stops redelivering) but not
      // processed. Observable, not silent.
      logSafely({
        source: 'slack-socket',
        eventId: null,
        outcome: 'rejected_malformed',
        reason: `unsupported socket envelope type '${type}' — acked but not processed`,
      });
      return;
    }

    // events_api payload is the SAME event_callback body the webhook receives.
    // rawBody is re-serialized from the parsed payload — good enough for the
    // content-hash fallback (no upstream proxy can reorder keys on a socket we
    // opened ourselves); explicit json_path/native-id sources are unaffected.
    const payload = envelope['payload'];
    await processSlackPayload(
      { spawnDeps, resolveChannel: deps.resolveChannel, now: deps.now, onHitlResumed: deps.onHitlResumed },
      {
        headers: {},
        rawBody: JSON.stringify(payload ?? null),
        body: payload,
        sourceLabel: 'slack-socket',
      },
    );
  }

  return {
    start: () => establish(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Bump the generation so any in-flight sleep/establish loop no-ops.
      generation += 1;
      active?.close();
      active = null;
      onLifecycle({ kind: 'stopped' });
    },
  };
}

/**
 * Production backoff schedule: 1s, 2s, 4s, … capped at 30s. Deterministic
 * (no jitter) — a single self-hosted engine reconnecting to Slack does not
 * need thundering-herd protection.
 */
export function defaultSocketBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
