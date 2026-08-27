/**
 * WI-409 — Slack-events ingress adapter with mandatory request-signature auth.
 *
 * Two public exports:
 *
 *   verifySlackSignature — the REAL Slack v0 signing verification:
 *     HMAC-SHA256(signingSecret, `v0:${ts}:${rawBody}`), constant-time compare,
 *     replay-window check. Used directly by tests with computed signatures.
 *
 *   handleSlackEvent — ack-fast-then-async orchestration:
 *     Signature verification is the ONLY pre-ack gate (fail-closed, FR-5).
 *     A valid signature returns 2xx IMMEDIATELY; parse → channel-resolve →
 *     derive-id → accept-spawn all run asynchronously in `processed`. This
 *     satisfies Slack's 3s ack window without double-billing, and WI-406 dedup
 *     absorbs Slack's retry re-deliveries.
 *
 * Boundary order inside `processed` (async, after ack):
 *   1. JSON parse body     — fail → log rejected_malformed, return
 *   2. Extract channel + resolveChannel — null → log rejected_unknown_flow, return
 *   3. deriveEventId (WI-405) — fail → log rejected_malformed, return
 *   4. runSpawnPath (WI-406) — writes accepted / duplicate
 *
 * The signing secret is NEVER written to any log entry, attribute bag, or
 * substrate field (NFR-5). It flows only into the injected verifyAuth seam.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveEventId } from '../event-id';
import { applyHitlReply } from '../../channels/slack';
import { runSpawnPath, type SpawnPathDeps } from '../spawn';
import type { IngressBinding } from '../binding';
import type { FlowConfig } from '../../types/kernel';

// ---------------------------------------------------------------------------
// Public types (pinned by slack-events.test.ts)
// ---------------------------------------------------------------------------

export interface SlackRequest {
  headers: Record<string, string>;
  rawBody: string;
}

export interface SlackResponse {
  status: number;
  /**
   * Optional response body for synchronous replies (e.g. url_verification challenge echo).
   * Absent on normal event acks — the async-processing path produces no HTTP body.
   */
  body?: string;
  /** Resolves when the async accept/spawn (or post-ack rejection logging) finishes. */
  processed: Promise<void>;
}

export interface SlackChannelResolution {
  flowId: string;
  flowPath: string;
  flow: FlowConfig;
  binding: IngressBinding;
}

export interface SlackAdapterDeps {
  /** WI-406 persistence + spawn + alert seams. */
  spawnDeps: SpawnPathDeps;
  /** App-global Slack signing secret — never logged. */
  signingSecret: string;
  /** FR-6: resolve a Slack channel id to its flow + binding, or null if unknown. */
  resolveChannel(channel: string): SlackChannelResolution | null;
  /** FR-5: verify the Slack request signature. Constant-time HMAC lives behind this seam. */
  verifyAuth(signingSecret: string, req: SlackRequest): boolean;
  /** Injected clock — returns received_at in unix MILLISECONDS for determinism (D3/FR-10). */
  now(): number;
  /** The original HITL reply-and-resume work: post-reply resume hook, threaded to the shared processors. */
  onHitlResumed?(runId: string): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Slack request-signing verification (the real HMAC, tested directly)
// ---------------------------------------------------------------------------

/**
 * Verifies a Slack v0 request signature.
 *
 * Algorithm (per Slack docs):
 *   baseString = `v0:${timestamp}:${rawBody}`
 *   expected   = 'v0=' + HMAC-SHA256(signingSecret, baseString).hex
 *   compare    = timingSafeEqual(expected, X-Slack-Signature)
 *
 * Rejects if:
 *   - Either header is absent or the timestamp is not a valid integer.
 *   - The request is outside the replay-tolerance window (default 300 s).
 *   - The computed signature does not match the supplied one.
 *
 * @param opts.now             Current time in unix SECONDS (injected for testing).
 * @param opts.toleranceSeconds Replay-window in seconds (default 300).
 */
export function verifySlackSignature(
  signingSecret: string,
  req: SlackRequest,
  opts?: { now?: number; toleranceSeconds?: number },
): boolean {
  const tsHeader = req.headers['X-Slack-Request-Timestamp'];
  const sigHeader = req.headers['X-Slack-Signature'];

  if (!tsHeader || !sigHeader) return false;

  const tsSeconds = parseInt(tsHeader, 10);
  if (isNaN(tsSeconds)) return false;

  const nowSeconds = opts?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts?.toleranceSeconds ?? 300;

  // Unit note: replay-window math here is in SECONDS (Slack's signing scheme).
  // This is intentionally distinct from `received_at`, which is stored in Unix
  // ms via the injected now() seam in processAsync — the two never mix.
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return false;

  const baseString = `v0:${tsSeconds}:${req.rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');

  // Constant-time compare — both are v0=<64 hex chars> so lengths always match
  // when the signature is well-formed; the length guard handles malformed inputs.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const sigBuf = Buffer.from(sigHeader, 'utf8');

  if (expectedBuf.length !== sigBuf.length) return false;

  return timingSafeEqual(expectedBuf, sigBuf);
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handles a single inbound Slack Events API POST.
 *
 * Returns SYNCHRONOUSLY with the ack status and a `processed` promise.
 * Signature verification is the only pre-ack gate — an invalid signature
 * produces a synchronous 4xx with the rejection already logged.
 * Everything else (parse, channel-resolve, derive, spawn) runs in `processed`
 * so the 3s Slack ack window is met without blocking on SQLite or Bun.spawn.
 */
export function handleSlackEvent(deps: SlackAdapterDeps, req: SlackRequest): SlackResponse {
  const { spawnDeps, signingSecret, resolveChannel, verifyAuth, now, onHitlResumed } = deps;
  const { db } = spawnDeps;

  // ── Pre-ack gate: signature verification (FR-5, fail-closed) ────────────
  // This is the ONLY check before acking. An invalid/missing signature is
  // rejected immediately — the async path never runs, no accept record created.
  if (!verifyAuth(signingSecret, req)) {
    db.appendIngressLog({ source: 'slack', eventId: null, outcome: 'rejected_auth' });
    return { status: 401, processed: Promise.resolve() };
  }

  // ── url_verification challenge (Slack app-setup) ────────────────────────
  // Slack sends a signed url_verification POST when an operator configures or
  // tests the app's Request URL. We MUST echo the challenge value back — but
  // ONLY after the signature passes (above). We return synchronously here and
  // never run the async event-processing path (no accept record, no spawn).
  // No ingress_log entry: no IngressOutcome fits a protocol handshake.
  let parsedForChallenge: unknown;
  try {
    parsedForChallenge = JSON.parse(req.rawBody);
  } catch {
    parsedForChallenge = null;
  }
  if (
    parsedForChallenge !== null &&
    typeof parsedForChallenge === 'object' &&
    !Array.isArray(parsedForChallenge) &&
    (parsedForChallenge as Record<string, unknown>)['type'] === 'url_verification'
  ) {
    const challenge = (parsedForChallenge as Record<string, unknown>)['challenge'];
    const challengeStr = typeof challenge === 'string' ? challenge : '';
    return {
      status: 200,
      body: JSON.stringify({ challenge: challengeStr }),
      processed: Promise.resolve(),
    };
  }

  // ── Ack immediately; process async ──────────────────────────────────────
  const processed = processAsync(db, spawnDeps, resolveChannel, now, req, onHitlResumed);
  return { status: 200, processed };
}

// ---------------------------------------------------------------------------
// Async processing (after ack)
// ---------------------------------------------------------------------------

async function processAsync(
  db: SpawnPathDeps['db'],
  spawnDeps: SpawnPathDeps,
  resolveChannel: (channel: string) => SlackChannelResolution | null,
  now: () => number,
  req: SlackRequest,
  onHitlResumed?: (runId: string) => Promise<void> | void,
): Promise<void> {
  // Yield one microtask tick so handleSlackEvent returns its ack status to the
  // caller BEFORE any processing begins. Without this, synchronous code paths
  // (JSON.parse → resolveChannel → deriveEventId → runSpawnPath-until-first-await)
  // execute in the same tick, causing the spawn call to precede the ack return
  // (violating AC6 and Slack's 3s ack window requirement).
  await Promise.resolve();

  await processSlackPayload(
    { spawnDeps, resolveChannel, now, onHitlResumed },
    { headers: req.headers, rawBody: req.rawBody, sourceLabel: 'slack' },
  );
}

// ---------------------------------------------------------------------------
// Shared post-ack pipeline (Events API webhook + Socket Mode, the original Slack Socket Mode work)
// ---------------------------------------------------------------------------

/** The transport-agnostic slice of SlackAdapterDeps consumed after the ack. */
export interface SlackPayloadDeps {
  spawnDeps: SpawnPathDeps;
  resolveChannel(channel: string): SlackChannelResolution | null;
  /** Injected clock — returns received_at in unix MILLISECONDS. */
  now(): number;
  /**
   * The original HITL reply-and-resume work: invoked after a HITL reply successfully un-holds a card, with
   * the run it belongs to. The listener wires this to spawn `conduit resume`
   * (the parked run's kernel process exited when it held — without a resume,
   * a recorded selection sits ready forever). Optional: absent means the
   * operator resumes manually (`conduit resume --run <id> <flow>`), which the
   * reply's ingress_log entry names.
   */
  onHitlResumed?(runId: string): Promise<void> | void;
}

export interface SlackPayloadEvent {
  /** Transport-level headers — empty for Socket Mode (no per-envelope headers). */
  headers: Record<string, string>;
  /**
   * Raw payload text: the HTTP body bytes on the webhook transport, or the
   * re-serialized envelope payload on Socket Mode. Feeds the content-hash
   * event-id fallback.
   */
  rawBody: string;
  /** Pre-parsed payload when the transport already parsed it (Socket Mode). */
  body?: unknown;
  /** ingress_log source label until the flow is resolved (e.g. 'slack', 'slack-socket'). */
  sourceLabel: string;
}

/**
 * The transport-agnostic Slack event pipeline: parse → channel-resolve →
 * derive-event-id → accept/spawn. Both the Events API webhook adapter and the
 * Socket Mode adapter (the original Slack Socket Mode work) feed the SAME pipeline — the transports
 * differ only in delivery and ack.
 *
 * The ack has already been sent by the caller. Everything here is best-effort:
 * a throw cannot be signalled back to Slack, so failures are made observable
 * in the ingress log rather than becoming silent unhandled rejections
 * (The original Slack acknowledgement work). Never re-throws.
 */
export async function processSlackPayload(
  deps: SlackPayloadDeps,
  event: SlackPayloadEvent,
): Promise<void> {
  const { spawnDeps, resolveChannel, now, onHitlResumed } = deps;
  const { db } = spawnDeps;

  let eventId: string | null = null;
  let source = event.sourceLabel;
  try {
    await processInner();
  } catch (err) {
    // The fallback log call itself can throw (disk I/O error on the journal
    // db, etc.). We are already in the outermost catch of a function whose
    // contract is "never re-throws" — and Socket Mode now invokes this from a
    // fire-and-forget handler, so an escaping throw here would become an
    // unhandled rejection and crash the listener. There is nothing left to
    // record the failure into, so swallow it.
    try {
      db.appendIngressLog({
        source,
        eventId,
        outcome: 'spawn_failed',
        reason: `post-ack processing error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      /* the ingress log itself failed — swallow to honor never-re-throw */
    }
  }

  // Inner closure so the catch above can see the latest derived eventId/source
  // for whatever step failed.
  async function processInner(): Promise<void> {
    // ── Step 1: Parse body (skipped when the transport already parsed it) ───
    let body: unknown;
    if (event.body !== undefined) {
      body = event.body;
    } else {
      try {
        body = JSON.parse(event.rawBody);
      } catch {
        db.appendIngressLog({
          source: event.sourceLabel,
          eventId: null,
          outcome: 'rejected_malformed',
          reason: 'request body is not valid JSON',
        });
        return;
      }
    }

    // ── Step 1b: HITL thread-reply routing (the original HITL reply-and-resume work FR-3b) ─────────────────
    // A non-bot message replying IN THE THREAD of a posted HITL ask is a
    // SELECTION, not a trigger — route it to applyHitlReply and never spawn.
    // Anything else falls through to the existing trigger pipeline untouched.
    if (await routeHitlThreadReply(db, body, deps.onHitlResumed)) {
      return;
    }

    // ── Step 2: Channel resolution (FR-6) ────────────────────────────────────
    const channel = extractChannel(body);
    const resolution = resolveChannel(channel ?? '');
    if (resolution === null) {
      db.appendIngressLog({
        source: event.sourceLabel,
        eventId: null,
        outcome: 'rejected_unknown_flow',
      });
      return;
    }
    // Resolved the flow — narrow the source for any subsequent post-ack failure.
    source = resolution.flowId;

    // ── Step 3: Event ID derivation (WI-405) ─────────────────────────────────
    const idResult = deriveEventId(
      { type: resolution.binding.type, event_id: resolution.binding.event_id },
      // Pass rawBody so the content-hash fallback is immune to JSON key reordering
      // by an upstream proxy (The original webhook-signature validation work).
      { headers: event.headers, body, rawBody: event.rawBody },
      // Stable warn key so the degraded-dedup warning fires once per flow, not
      // once per request (The original single-read request-body work).
      resolution.flowId,
    );

    if (!idResult.ok) {
      db.appendIngressLog({
        source: resolution.flowId,
        eventId: null,
        outcome: 'rejected_malformed',
        reason: `event id derivation failed: ${idResult.reason}`,
      });
      return;
    }
    // Derived the event id — surface it on any subsequent post-ack failure.
    eventId = idResult.eventId;

    // ── Step 4: Accept-spawn path (WI-406) ───────────────────────────────────
    // buildEnvelope (inside runSpawnPath) runs filterAttributes on headers so
    // sensitive values are stripped before the substrate is serialized (NFR-5).
    await runSpawnPath(spawnDeps, {
      source: resolution.flowId,
      eventId: idResult.eventId,
      authVerified: true,
      headers: event.headers,
      body,
      flowId: resolution.flowId,
      flowPath: resolution.flowPath,
      flow: resolution.flow,
      substrateMapping: resolution.binding.substrate,
      // now() returns Unix ms — distinct from the SECONDS convention used by
      // verifySlackSignature's replay window.
      receivedAt: now(), // Unix ms
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Route a message event that replies in a HITL ask's thread (the original HITL reply-and-resume work FR-3b).
 *
 * Returns true when the event WAS a thread reply addressed at a recorded
 * `hitl.ask` (whether or not the selection parsed) — the caller must then NOT
 * treat it as a trigger. Returns false for everything else: no thread_ts,
 * bot-authored, or a thread that matches no recorded ask.
 *
 * Selection grammar (deliberately strict, the original HITL reply-and-resume work open Q1): a 1-based index
 * into the ask's recorded short_list, or an exact case-insensitive label
 * match. Anything else is journaled as rejected_malformed and IGNORED — the
 * card stays held, the human re-replies; the kernel never guesses.
 */
export async function routeHitlThreadReply(
  db: SpawnPathDeps['db'],
  body: unknown,
  onHitlResumed?: (runId: string) => Promise<void> | void,
): Promise<boolean> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const event = (body as Record<string, unknown>)['event'];
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  const e = event as Record<string, unknown>;

  if (e['type'] !== 'message') return false;
  if (typeof e['bot_id'] === 'string' && e['bot_id'].length > 0) return false;
  const threadTs = e['thread_ts'];
  if (typeof threadTs !== 'string' || threadTs.length === 0) return false;

  // Fix 8: message edits/deletes/joins (any `subtype`) and empty/whitespace-only
  // messages are never human reply attempts. Decide this BEFORE any rejection
  // journaling so such thread chatter produces no rejected_malformed /
  // rejected_ambiguous noise — when it lands in one of our ask threads it is
  // consumed silently; outside an ask thread it falls through unchanged.
  const subtype = e['subtype'];
  const isNonReply =
    (typeof subtype === 'string' && subtype.length > 0) ||
    typeof e['text'] !== 'string' ||
    e['text'].trim().length === 0;

  const ask = db.findHitlAskByThreadTs(threadTs);
  if (ask === null) return false; // ordinary thread chatter — not ours
  if (isNonReply) return true; // in our thread but not a human reply — no noise

  if (ask.ambiguous) {
    // Fix 4: two or more still-live asks share this thread root (e.g. a fan-out
    // where each child parked its own rank+HITL). A bare reply carries no
    // correlation id, so there is no sound way to say which ask it targets —
    // fail closed: journal and leave every card held, never guess the newest.
    db.appendIngressLog({
      source: 'slack-hitl-reply',
      eventId: null,
      outcome: 'rejected_ambiguous',
      reason:
        `thread reply is ambiguous — ${ask.correlationIds.length} live asks share ` +
        `this thread (${ask.correlationIds.join(', ')}); reply with the ask's ` +
        `button or in that ask's own thread so the selection is unambiguous`,
    });
    return true; // it WAS in our ask thread — never spawn a trigger for it
  }

  const text = typeof e['text'] === 'string' ? e['text'].trim() : '';
  let selection: string | null = null;
  if (text.startsWith('=')) {
    // Explicit human override (the original HITL reply-and-resume work follow-up): "= Your Own Name" picks
    // a candidate NOT on the shortlist. The prefix is what preserves the
    // never-guess property — bare unmatched text stays ignored, but a
    // prefixed reply is an unambiguous conscious selection.
    const override = text.slice(1).trim();
    selection = override.length > 0 ? override : null;
  } else if (/^(0|[1-9][0-9]*)$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= ask.shortList.length) {
      selection = ask.shortList[index - 1]!;
    }
  } else if (text.length > 0) {
    selection =
      ask.shortList.find((label) => label.toLowerCase() === text.toLowerCase()) ?? null;
  }

  if (selection === null) {
    db.appendIngressLog({
      source: 'slack-hitl-reply',
      eventId: null,
      outcome: 'rejected_malformed',
      reason:
        `thread reply did not resolve to a candidate (correlation ` +
        `'${ask.correlationId}'): reply with 1-${ask.shortList.length}, an exact ` +
        `name, or '= Your Own Name' to override`,
    });
    return true; // it WAS a reply at our ask — never spawn a trigger for it
  }

  const result = applyHitlReply(db, ask.correlationId, selection, ask.runId);
  db.appendIngressLog({
    source: 'slack-hitl-reply',
    eventId: null,
    outcome: result.resumed ? 'accepted' : 'duplicate',
    reason: result.resumed
      ? `selection '${selection}' recorded for ${ask.correlationId}`
      : `reply for ${ask.correlationId} ignored — card not held (already answered or timed out)`,
  });
  if (result.resumed && onHitlResumed !== undefined) {
    await onHitlResumed(ask.runId);
  }
  return true;
}

/**
 * Process a Slack INTERACTIVITY payload (the original HITL reply-and-resume work FR-3a) — a button tap whose
 * action_id round-trips the HITL correlation id and whose value carries the
 * chosen option (docs/slack-channel.md §2/§3 contract). Shared by both
 * transports: the socket adapter feeds `interactive` envelope payloads here;
 * an Events-API interactivity webhook can feed the same shape.
 *
 * Unknown/foreign action_ids (not `hitl::`-prefixed, or matching no recorded
 * run) are journaled and refused — never guessed at (mirrors applyHitlReply's
 * unknown-id posture).
 */
export async function processSlackInteractive(
  db: SpawnPathDeps['db'],
  payload: unknown,
  onHitlResumed?: (runId: string) => Promise<void> | void,
): Promise<void> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    db.appendIngressLog({
      source: 'slack-interactive',
      eventId: null,
      outcome: 'rejected_malformed',
      reason: 'interactivity payload is not an object',
    });
    return;
  }
  const p = payload as Record<string, unknown>;
  const actions = Array.isArray(p['actions']) ? (p['actions'] as unknown[]) : [];
  const first = actions[0];
  const action =
    first !== null && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  const actionId = action !== null && typeof action['action_id'] === 'string' ? action['action_id'] : '';
  const value = action !== null && typeof action['value'] === 'string' ? action['value'] : '';

  if (!actionId.startsWith('hitl::') || value.length === 0) {
    db.appendIngressLog({
      source: 'slack-interactive',
      eventId: null,
      outcome: 'rejected_malformed',
      reason: `interactivity action is not a HITL selection (action_id '${actionId}')`,
    });
    return;
  }

  // The correlation id carries no run id (it predates run namespacing) — the
  // await_selection path surfaced it on the card_log, so resolve the run there.
  const runId = db.findRunForHitlCorrelation(actionId);
  if (runId === null) {
    db.appendIngressLog({
      source: 'slack-interactive',
      eventId: null,
      outcome: 'rejected_malformed',
      reason: `no run recorded HITL correlation '${actionId}' — refusing the reply`,
    });
    return;
  }

  const result = applyHitlReply(db, actionId, value, runId);
  db.appendIngressLog({
    source: 'slack-interactive',
    eventId: null,
    outcome: result.resumed ? 'accepted' : 'duplicate',
    reason: result.resumed
      ? `selection '${value}' recorded for ${actionId}`
      : `interactive reply for ${actionId} ignored — card not held`,
  });
  if (result.resumed && onHitlResumed !== undefined) {
    await onHitlResumed(runId);
  }
}

/** Seam that spawns `conduit resume <flowPath> --run <runId>` (the original HITL reply-and-resume work). */
export type HitlResumeSpawn = (req: {
  flowPath: string;
  runId: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * Resume the parked run after a successful HITL reply (the original HITL reply-and-resume work).
 *
 * The per-run kernel exits when its only remaining work is a held card, so a
 * recorded selection needs a `conduit resume` to actually advance. Ingress-
 * spawned runs carry their flow path on ingress_events; CLI-triggered runs
 * have no attribution — those are journaled as needing a manual resume, never
 * guessed at (a wrong flow path would re-anchor the run's workspace).
 */
export async function resumeAfterHitlReply(
  db: SpawnPathDeps['db'],
  runId: string,
  spawnResume: HitlResumeSpawn,
): Promise<void> {
  const flowPath = db.getFlowPathForRun(runId);
  if (flowPath === null) {
    db.appendIngressLog({
      source: 'slack-hitl-reply',
      eventId: null,
      outcome: 'rejected_malformed',
      reason:
        `selection recorded for run '${runId}' but the run has no ingress flow ` +
        `attribution — resume manually: conduit resume --run ${runId} <flow.yaml>`,
    });
    return;
  }
  const result = await spawnResume({ flowPath, runId });
  db.appendIngressLog({
    source: 'slack-hitl-reply',
    eventId: null,
    outcome: result.ok ? 'accepted' : 'spawn_failed',
    reason: result.ok
      ? `conduit resume spawned for run '${runId}'`
      : `conduit resume failed for run '${runId}': ${result.error ?? 'unknown'}`,
  });
}

/**
 * Extracts the Slack channel id from the parsed event payload.
 * Slack Events API places the channel under `body.event.channel`.
 * Returns null when the field is absent or the body is not a plain object.
 */
function extractChannel(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;

  const b = body as Record<string, unknown>;
  const event = b['event'];

  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;

  const channel = (event as Record<string, unknown>)['channel'];
  return typeof channel === 'string' ? channel : null;
}
