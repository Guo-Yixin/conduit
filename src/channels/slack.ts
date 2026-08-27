/**
 * Slack egress channel + outbox idempotency (WI-303 AC2-AC6, SPEC §4A, FR-13/14).
 *
 * TRANSPORT layer. Every egress send is EFFECTFUL, so it is guarded by the
 * outbox (WI-298): write a pending intent before posting, mark committed after.
 * On resume the outbox is consulted — committed intents are never re-posted
 * (no double-delivery, no double-ask).
 *
 * HITL holds carry a correlation id that encodes the cardId for stateless
 * round-trip mapping.  A timeout policy applies the configured on_timeout
 * (scrap / proceed_with_findings / escalate) and NEVER auto-picks a rank
 * winner (FR-14 — autoSelected is structurally false in the return type).
 *
 * Reuses: outbox functions from src/checkpoint/checkpoint.ts (WI-298);
 *         card state mutations via db.getStateDb() SQL (direct, no new accessor).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import {
  writePendingIntent,
  commitIntent,
  getIntentStatus,
  getPendingIntentPayload,
  reconcileOnResume,
  type Reconciler,
} from '../checkpoint/checkpoint';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The Slack transport seam — tests inject a recording stub; production uses real Slack. */
/**
 * Wall-clock bounds on Slack transport fetches (found live, arcane-flows
 * studio: Bun's fetch has NO default timeout, so one stalled connection to
 * slack.com hung a run's kernel process forever, silently — the station's
 * card pinned at attempt 0 while the listener's redrive re-ran its script
 * every sweep). A bounded fetch turns a network stall into a THROWN error
 * that the existing named failure paths (hold-with-reason) already handle.
 *
 * Two budgets, because the workloads differ by orders of magnitude:
 *   - SLACK_FETCH_TIMEOUT_MS bounds the small JSON Web API round-trips
 *     (chat.postMessage, the two external-upload control steps) and the
 *     reconciler probe. 60s is generous headroom for those.
 *   - SLACK_UPLOAD_TIMEOUT_MS bounds ONLY the raw byte POST to the pre-signed
 *     upload_url, whose ceiling is the upload size gate (default 1 GiB, see
 *     DEFAULT_SLACK_MAX_UPLOAD_BYTES). 60s cannot service a gigabyte on a slow
 *     link, so the byte transfer gets its own 15-minute budget (~1 GiB at a
 *     ~10 Mbps floor). Both are env-overridable at the executor call sites.
 * These are the defaults for createSlackTransport's fetchTimeoutMs /
 * uploadTimeoutMs params; the executor resolves the env overrides and passes
 * them through.
 */
export const SLACK_FETCH_TIMEOUT_MS = 60_000;
export const SLACK_UPLOAD_TIMEOUT_MS = 900_000; // 15 min — byte POST only; see note above.

export interface SlackTransport {
  post(req: {
    channel: string;
    text: string;
    correlationId?: string;
    threadTs?: string;
  }): Promise<{ ts: string }>;
  /**
   * Upload a file via Slack's external-upload flow (WI-597). Optional so
   * existing post-only stubs across the suite still satisfy the interface.
   */
  uploadFile?(req: {
    channel: string;
    filePath: string;
    threadTs?: string;
    caption?: string;
    /**
     * Pre-read file bytes. When present, the transport uploads these verbatim
     * and does NOT re-read `filePath` — the caller (egressSendFile) has already
     * read and fingerprinted them, so re-reading risks uploading different
     * bytes than the idempotency key attests, and double-buffers a large file.
     * Absent → the transport reads `filePath` itself (direct-call back-compat).
     * `Uint8Array<ArrayBuffer>` (the non-shared buffer `readFileSync` yields) so
     * it is a valid `fetch` body without a defensive copy.
     */
    bytes?: Uint8Array<ArrayBuffer>;
  }): Promise<{ ok: true; files: Array<{ id: string }> }>;
}

/** A message to send via the egress channel. */
export interface EgressMessage {
  channel: string;
  text: string;
  /** Stable idempotency key — prevents double-send on resume. */
  idempotencyKey: string;
  correlationId?: string;
  /** Optional thread address (WI-598, FR-7) — forwarded to transport.post. */
  threadTs?: string;
}

export type OnTimeout = 'scrap' | 'proceed_with_findings' | 'escalate';

/**
 * A reconciler capable of an ASYNC verdict (e.g. a real network probe), unlike
 * the synchronous `Reconciler` that `reconcileOnResume`/`egressSend` consume
 * (WI-602). A plain synchronous `Reconciler` is trivially a valid
 * `FileReconciler` too (a non-promise return awaits to itself), so existing
 * sync reconcilers continue to typecheck unchanged against this wider type.
 */
export type FileReconciler = (
  intent: Record<string, unknown>,
) => ('landed' | 'not_landed' | 'unknown') | Promise<'landed' | 'not_landed' | 'unknown'>;

/** Outcome of an egress send through the outbox-guarded transport. */
export interface EgressResult {
  /** True iff transport.post was actually called and the intent committed on this call. */
  posted: boolean;
  /**
   * True iff a pending-on-entry intent could not be reconciled (no/ambiguous
   * reconciler) and was escalated to hold instead of re-posting (#2, SPEC §5).
   * When set, `posted` is false and the side effect was NOT re-fired.
   */
  escalatedToHold?: boolean;
  /**
   * The reconcile-FSM decision applied to a pending-on-entry intent (WI-602) —
   * absent when the intent was 'none' or already 'committed' on entry (no
   * reconciliation happened). Lets a caller (e.g. the executor) journal WHICH
   * branch fired without re-deriving it from posted/escalatedToHold.
   */
  reconcileDecision?: 'skip' | 'fire' | 'escalate';
  /**
   * Slack ts of the message when this call actually posted one (the original HITL reply-and-resume work) —
   * absent on skip/escalate paths and on file deliveries. Lets the rank
   * station journal its ask's thread address so thread replies can be routed
   * back as selections.
   */
  ts?: string;
}

// ---------------------------------------------------------------------------
// egressSend — outbox-guarded transport (AC5, #2 crash-after-post recovery)
// ---------------------------------------------------------------------------

/**
 * Send an egress message through the Slack transport, guarded by the outbox.
 *
 * Protocol (SPEC §5 effectful outbox):
 *   1. committed  → skip (already delivered; posted:false).
 *   2. pending    → a prior attempt wrote the intent but crashed before commit.
 *                   Route through reconcileOnResume — NEVER blind re-post, NEVER
 *                   throw on the duplicate idempotency_key (#2):
 *                     skip          → posted:false  (already landed/committed)
 *                     fire          → post + commit  (the existing pending row is
 *                                     committed; we do NOT re-insert it)
 *                     escalate_hold → posted:false, escalatedToHold:true
 *   3. none       → write pending → post → commit → posted:true.
 *
 * This ensures a resume never re-posts a delivery or re-asks an approval, and a
 * crash between post and commit no longer wedges the card on a UNIQUE-constraint
 * throw (#2).
 *
 * @param reconciler optional external verifier consulted for a pending-on-entry
 *   intent (e.g. "did this Slack message actually land?"). Without it, a pending
 *   intent escalates to hold rather than risking a double-post.
 */
export async function egressSend(
  db: ConduitDB,
  transport: SlackTransport,
  msg: EgressMessage,
  reconciler?: Reconciler,
): Promise<EgressResult> {
  const stateDb = db.getStateDb();

  const status = getIntentStatus(stateDb, msg.idempotencyKey);

  // AC5 resume safety: skip if already delivered.
  if (status === 'committed') {
    return { posted: false };
  }

  // #2: a pending row means a prior send crashed between post and commit. The
  // intent already exists, so a plain INSERT would throw on the UNIQUE column.
  // Reconcile instead of blind re-posting (SPEC §5 C3 — never blind-retry).
  if (status === 'pending') {
    const decision = reconcileOnResume(stateDb, msg.idempotencyKey, reconciler);

    if (decision.action === 'skip') {
      // The effect already landed (confirmed or committed) — never re-post.
      return { posted: false };
    }

    if (decision.action === 'escalate_hold') {
      // Ambiguous outcome — surface to hold rather than risk a double-delivery.
      return { posted: false, escalatedToHold: true };
    }

    // decision.action === 'fire': the reconciler confirmed the prior post did
    // NOT land. Re-post, but reuse the EXISTING pending row (do NOT re-insert —
    // that would throw on the UNIQUE idempotency_key).
    const refired = await transport.post({
      channel: msg.channel,
      text: msg.text,
      correlationId: msg.correlationId,
      threadTs: msg.threadTs,
    });
    commitIntent(stateDb, msg.idempotencyKey);
    return { posted: true, ts: refired.ts };
  }

  // status === 'none': first attempt — write the pending intent, then post.
  writePendingIntent(stateDb, {
    flow: 'egress',
    card: msg.channel,
    station: 'slack',
    attempt: 0,
    idempotencyKey: msg.idempotencyKey,
    intent: { kind: 'slack_post', channel: msg.channel, text: msg.text, correlationId: msg.correlationId },
  });

  const postedMsg = await transport.post({
    channel: msg.channel,
    text: msg.text,
    correlationId: msg.correlationId,
    threadTs: msg.threadTs,
  });

  commitIntent(stateDb, msg.idempotencyKey);

  return { posted: true, ts: postedMsg.ts };
}

// ---------------------------------------------------------------------------
// egressSendFile — outbox-guarded file delivery (WI-598, AC1-AC6)
// ---------------------------------------------------------------------------

/**
 * Send a file via the Slack transport's `uploadFile` capability, guarded by
 * the SAME outbox protocol as egressSend: write a pending intent, upload,
 * commit. On resume the outbox is consulted so a crash never re-uploads a
 * file that already landed (or leaves an ambiguous outcome unresolved).
 *
 * Idempotency key (FR-5, decision 5): `keyPrefix` (caller-composed from run,
 * card, station, attempt) combined with a sha256 fingerprint of the file's
 * CURRENT bytes, read at send time. Either input changing yields a genuine
 * re-delivery: a reworked artifact (new bytes, same prefix) or a later
 * execution attempt (new prefix, same bytes) both produce a fresh key; an
 * unchanged resume produces the same key and is deduplicated.
 *
 * The persisted intent payload carries only the path, byte size, and
 * fingerprint — NEVER the file bytes (NFR-2).
 *
 * Protocol (mirrors egressSend):
 *   1. committed  → skip (posted:false).
 *   2. pending    → AWAIT the reconciler INLINE (WI-602 — not via the
 *                   synchronous reconcileOnResume, so a real network probe can
 *                   run): no reconciler escalates to hold; 'landed' skips;
 *                   'not_landed' fires (reusing the existing pending row,
 *                   never re-inserting it); 'unknown' escalates to hold
 *                   (fail-closed — never guess landed).
 *   3. none       → write pending → upload → commit → posted:true.
 *
 * A missing/unreadable file, or a transport lacking `uploadFile`, fails with
 * a typed, diagnosable error BEFORE any outbox row is written — no stored
 * bytes, no silent success, no dangling pending row for a config mistake.
 *
 * @param reconciler optional external verifier consulted for a pending-on-entry
 *   intent (e.g. "did this upload actually land?"). Without it, a pending
 *   intent escalates to hold rather than risking a double-upload. May be
 *   asynchronous (WI-602's createFilesInfoReconciler) — a plain synchronous
 *   Reconciler is also accepted.
 */
export async function egressSendFile(
  db: ConduitDB,
  transport: SlackTransport,
  req: {
    /**
     * The run this delivery belongs to. Scopes every outbox row (the table is
     * UNIQUE (run_id, idempotency_key)), so two runs that compute an identical
     * key — same card/station/attempt/bytes, which recurs because card ids
     * repeat across runs (why run namespacing exists) — do NOT collide: run 2
     * would otherwise find run 1's committed intent and silently skip delivery
     * (FR-5). Absent falls back to DEFAULT_RUN_ID for pre-namespacing callers.
     */
    runId?: string;
    channel: string;
    filePath: string;
    /** Caller-composed prefix (run/card/station/attempt/file) — combined with a content fingerprint to form the idempotency key. */
    keyPrefix: string;
    threadTs?: string;
    caption?: string;
  },
  reconciler?: FileReconciler,
): Promise<EgressResult> {
  // Fail fast on a transport that can't upload — no I/O, no outbox row.
  if (typeof transport.uploadFile !== 'function') {
    throw new Error(
      `Slack file egress: transport does not support uploadFile (channel '${req.channel}', path '${req.filePath}')`,
    );
  }

  // AC5: read + fingerprint BEFORE any outbox write — a missing/unreadable OR
  // empty file must fail with no stored bytes and no silent success (PRD edge
  // case "Declared file missing/EMPTY" — hold with a naming error, never
  // silently deliver a 0-byte file).
  // Non-shared buffer type (what readFileSync yields) so the bytes pass to the
  // transport's fetch body without a defensive copy.
  let fileBytes: Uint8Array<ArrayBuffer>;
  try {
    fileBytes = readFileSync(req.filePath);
  } catch (readError) {
    const detail = readError instanceof Error ? readError.message : 'unknown error';
    throw new Error(`Slack file egress: cannot read file '${req.filePath}': ${detail}`);
  }
  if (fileBytes.length === 0) {
    throw new Error(`Slack file egress: file '${req.filePath}' is empty (0 bytes) — refusing to deliver`);
  }
  const size = fileBytes.length;
  const fingerprint = createHash('sha256').update(fileBytes).digest('hex');
  const idempotencyKey = `${req.keyPrefix}::${fingerprint}`;

  // Scope every outbox operation to this run — the table is UNIQUE (run_id,
  // idempotency_key), so a run-scoped read/write cannot see or collide with a
  // same-key row from another run (FR-5). Absent → DEFAULT_RUN_ID (back-compat).
  const runId = req.runId;

  const stateDb = db.getStateDb();
  const status = getIntentStatus(stateDb, idempotencyKey, runId);

  if (status === 'committed') {
    return { posted: false };
  }

  const doUpload = (): Promise<unknown> =>
    transport.uploadFile!({
      channel: req.channel,
      filePath: req.filePath,
      threadTs: req.threadTs,
      caption: req.caption,
      // Pass the already-read bytes so uploadFile does NOT re-read the file:
      // a re-read could observe different bytes than the fingerprint attested
      // (a key promising bytes that never landed), and buffers a large file
      // twice. The transport falls back to reading only if bytes are absent.
      bytes: fileBytes,
    });

  if (status === 'pending') {
    // WI-602: await the reconciler INLINE — bypasses the synchronous
    // reconcileOnResume (which cannot await a real network probe). No
    // reconciler at all preserves WI-598's hold-only base behaviour exactly.
    if (!reconciler) {
      return { posted: false, escalatedToHold: true };
    }

    const intent = getPendingIntentPayload(stateDb, idempotencyKey, runId) ?? {};
    const verdict = await reconciler(intent);

    if (verdict === 'landed') {
      // Confirmed delivered — commit the EXISTING pending row (never re-insert)
      // so it converges to the same committed state a first-attempt success
      // would reach. Without this the row stays pending forever: every future
      // resume re-probes Slack for an outcome already conclusively proven, and
      // delivered_at-reading tooling (committedOutboxCount, explain) undercounts
      // a delivery that genuinely landed.
      commitIntent(stateDb, idempotencyKey, runId);
      return { posted: false, reconcileDecision: 'skip' };
    }
    if (verdict === 'unknown') {
      // Fail-closed — never guess landed; leave the row pending, unchanged.
      return { posted: false, escalatedToHold: true, reconcileDecision: 'escalate' };
    }

    // verdict === 'not_landed': reuse the EXISTING pending row — never re-insert.
    await doUpload();
    commitIntent(stateDb, idempotencyKey, runId);
    return { posted: true, reconcileDecision: 'fire' };
  }

  // status === 'none': first attempt — write the pending intent (path/size/
  // fingerprint only, NEVER the bytes — NFR-2), then upload.
  writePendingIntent(stateDb, {
    run: runId,
    flow: 'egress',
    card: req.channel,
    station: 'slack_file',
    attempt: 0,
    idempotencyKey,
    intent: {
      kind: 'slack_upload_file',
      channel: req.channel,
      path: req.filePath,
      size,
      fingerprint,
      threadTs: req.threadTs,
      caption: req.caption,
    },
  });

  await doUpload();
  commitIntent(stateDb, idempotencyKey, runId);
  return { posted: true };
}

// ---------------------------------------------------------------------------
// HITL hold (AC3)
// ---------------------------------------------------------------------------

/**
 * Post a HITL hold prompt to the Slack channel, encoding the cardId in the
 * correlation id for stateless round-trip mapping.
 *
 * The correlation id format is: `hitl::<cardId>::<nonce>`.
 * applyHitlReply and applyHoldTimeout extract the cardId by splitting on `::`.
 */
export async function postHitlHold(
  db: ConduitDB,
  transport: SlackTransport,
  req: { cardId: string; channel: string; prompt: string },
): Promise<{ correlationId: string }> {
  const nonce = crypto.randomUUID();
  const correlationId = `hitl::${req.cardId}::${nonce}`;

  await egressSend(db, transport, {
    channel: req.channel,
    text: req.prompt,
    idempotencyKey: correlationId,
    correlationId,
  });

  return { correlationId };
}

// ---------------------------------------------------------------------------
// Helpers — parse cardId from correlationId
// ---------------------------------------------------------------------------

function extractCardId(correlationId: string): string | null {
  const parts = correlationId.split('::');
  if (parts[0] !== 'hitl') return null;
  // Two correlation-id shapes feed this helper, distinguished by segment count:
  //   executor rank/HITL: hitl::<runId>::<cardId>::<stationId>::<attempt>  (5 segs)
  //   postHitlHold:       hitl::<cardId>::<nonce>                          (3 segs)
  // The executor form leads with runId so the id is run-unique (the outbox key,
  // card_log reason, and findRunForHitlCorrelation all key on the full string);
  // cardId therefore lives at index 2 there and index 1 in the postHitlHold form.
  if (parts.length >= 5) return parts[2] ?? null;
  if (parts.length >= 3) return parts[1] ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// applyHitlReply (AC3)
// ---------------------------------------------------------------------------

/**
 * Map an async human reply back to the card via the correlation id.
 *
 * If the card exists and is in status='held', transition it to 'ready' and
 * DURABLY record the human selection (durable HITL-selection work).  If the correlation id is unknown
 * or the card is not held, return { resumed: false }.
 *
 * SPEC §4A: the human reaction "is injected as the selection / managerial note."
 * SPEC §13 (Kaizen) notes every hold selection is "already journaled and keyed
 * to the card" so the HITL-preference loop needs no new ingestion infra. We
 * therefore persist the selection as a journal span (`hitl.selection`) keyed to
 * the card — the downstream `select` station and the Kaizen loop both read it.
 *
 * The postHitlHold correlation id (`hitl::<cardId>::<nonce>`) carries NO run id,
 * so the run must be supplied explicitly. `runId` defaults to DEFAULT_RUN_ID for
 * back-compat with any caller that predates run namespacing, matching the
 * optional-runId pattern of getRecordedHitlSelection. (The executor's rank/HITL
 * form leads with runId — `hitl::<runId>::<cardId>::<stationId>::<attempt>` — so
 * its id is already run-unique; the run is still passed here explicitly.) EVERY
 * card read, UPDATE, and journal span
 * is run-scoped so a reply can never flip a same-id card in another run, and the
 * recorded selection is retrievable via getRecordedHitlSelection(db, cardId, runId).
 */
export function applyHitlReply(
  db: ConduitDB,
  correlationId: string,
  selection: string,
  runId: string = DEFAULT_RUN_ID,
): { resumed: boolean; cardId?: string; selection?: string } {
  const cardId = extractCardId(correlationId);
  if (!cardId) return { resumed: false };

  const card = db.getCard(runId, cardId);
  if (!card || card.status !== 'held') return { resumed: false };

  const stateDb = db.getStateDb();

  // Transition held → ready (the card re-enters the dispatch queue), but only if
  // the row was actually held — guard against a concurrent transition. Scoped to
  // run_id so a same-id card in another run is never flipped (run-namespacing).
  const update = stateDb
    .prepare(`UPDATE cards SET status = 'ready' WHERE id = $id AND run_id = $runId AND status = 'held'`)
    .run({ $id: cardId, $runId: runId });

  if (update.changes === 0) return { resumed: false };

  // durable HITL-selection work: durably record the selection so it survives the held → ready transition
  // and is readable by the downstream station and the Kaizen HITL-preference loop.
  // Run-scoped so getRecordedHitlSelection(db, cardId, runId) finds it.
  db.appendJournalSpan({
    runId,
    cardId,
    station: card.lane,
    attempt: card.attempt,
    name: 'hitl.selection',
    attributes: { selection, correlation_id: correlationId },
  });

  return { resumed: true, cardId, selection };
}

/**
 * Read back the most recent HITL selection durably recorded for a card (durable HITL-selection work).
 * Returns null when no selection has been recorded.
 *
 * When `runId` is provided, the query is scoped to that run so cross-run
 * selections from a previous run of the same card do not bleed through.
 * Callers that predate run namespacing may omit `runId`; the unscoped
 * `getJournalSpans` is used as a backward-compatible fallback.
 */
export function getRecordedHitlSelection(db: ConduitDB, cardId: string, runId?: string): string | null {
  const spans = runId !== undefined
    ? db.getJournalSpansForRun(runId, cardId)
    : db.getJournalSpans(cardId);
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    if (span.name === 'hitl.selection' && typeof span.attributes.selection === 'string') {
      return span.attributes.selection as string;
    }
  }
  return null;
}

/**
 * Like getRecordedHitlSelection, but returns the full recorded detail —
 * the selection plus the correlation id it answered (the original HITL reply-and-resume work). The rank
 * station's resume path writes this into the flow-facing `selection_out`
 * artifact so downstream stations can consume the pick without touching the
 * journal. Returns null when no selection has been recorded.
 */
export function getRecordedHitlSelectionDetail(
  db: ConduitDB,
  cardId: string,
  runId?: string,
): { selection: string; correlationId: string | null } | null {
  const spans = runId !== undefined
    ? db.getJournalSpansForRun(runId, cardId)
    : db.getJournalSpans(cardId);
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    if (span.name === 'hitl.selection' && typeof span.attributes.selection === 'string') {
      const correlation = span.attributes.correlation_id;
      return {
        selection: span.attributes.selection as string,
        correlationId: typeof correlation === 'string' ? correlation : null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// applyHoldTimeout (AC4 / FR-14)
// ---------------------------------------------------------------------------

/** Result of applying a hold-timeout policy. */
export interface HoldTimeoutResult {
  applied: OnTimeout;
  /** The resolved card id, or null when the correlation id was unparseable (correlation-ID refusal work). */
  cardId: string | null;
  /** True iff an actual card row was updated by the policy (correlation-ID refusal work). */
  matched: boolean;
  /** Always false — the kernel NEVER silently picks a rank winner (FR-14). */
  autoSelected: false;
}

/**
 * Apply the hold timeout policy to the card identified by the correlation id.
 *
 * Policies:
 *   scrap                — set status='scrapped', lane='scrap'
 *   proceed_with_findings — set status='ready' (tick re-evaluates with findings)
 *   escalate             — move to the 'hold' terminal lane (status stays 'held')
 *
 * correlation-ID refusal work (security): an unparseable / unknown correlation id is REFUSED — we do NOT
 * fall back to treating the whole correlation id as a raw card id (a crafted id
 * could otherwise scrap an arbitrary card). This is symmetric with applyHitlReply,
 * which returns { resumed:false } for an unknown id. Each UPDATE checks
 * result.changes so a timeout against a nonexistent card is reported as
 * matched:false (a no-op) rather than a silent fake success.
 *
 * The correlation id carries NO run id, so the run is supplied explicitly. The
 * executor's hold-timeout sweep iterates held rows already scoped to a run, so
 * `runId` must be threaded through and every UPDATE run-scoped — otherwise a
 * crafted/colliding card id could mutate a same-id card in another run. `runId`
 * defaults to DEFAULT_RUN_ID for back-compat with callers predating namespacing.
 *
 * autoSelected is ALWAYS false — the kernel never silently picks a rank winner
 * (FR-14).  Selection is a conscious human or explicit policy decision only.
 */
export function applyHoldTimeout(
  db: ConduitDB,
  correlationId: string,
  onTimeout: OnTimeout,
  runId: string = DEFAULT_RUN_ID,
): HoldTimeoutResult {
  const cardId = extractCardId(correlationId);

  // correlation-ID refusal work: refuse an unparseable correlation id — never coerce it into a card id.
  if (!cardId) {
    return { applied: onTimeout, cardId: null, matched: false, autoSelected: false };
  }

  const stateDb = db.getStateDb();
  let changes = 0;

  switch (onTimeout) {
    case 'scrap':
      changes = stateDb
        .prepare(`UPDATE cards SET status = 'scrapped', lane = 'scrap' WHERE id = $id AND run_id = $runId`)
        .run({ $id: cardId, $runId: runId }).changes;
      break;

    case 'escalate':
      // Route to the hold terminal lane — stays held awaiting human intervention.
      changes = stateDb
        .prepare(`UPDATE cards SET lane = 'hold', status = 'held' WHERE id = $id AND run_id = $runId`)
        .run({ $id: cardId, $runId: runId }).changes;
      break;

    case 'proceed_with_findings':
      // Allow the card to re-enter dispatch; the tick will advance it.
      changes = stateDb
        .prepare(`UPDATE cards SET status = 'ready' WHERE id = $id AND run_id = $runId`)
        .run({ $id: cardId, $runId: runId }).changes;
      break;
  }

  return { applied: onTimeout, cardId, matched: changes > 0, autoSelected: false };
}

// ---------------------------------------------------------------------------
// Production SlackTransport (WI-395, FR7/FR11)
// ---------------------------------------------------------------------------

/**
 * Default Slack API base for the production transport (WITH the `/api` path).
 * Deliberately NOT named after the `SLACK_API_BASE_URL` env var, which holds
 * the bare host (no `/api`) and is read only by resolveSlackApiBaseUrl() in
 * controller/executor.ts — callers there append exactly one `/api` segment.
 */
const DEFAULT_SLACK_API_BASE = 'https://slack.com/api';

/**
 * Create a production SlackTransport that posts to Slack's chat.postMessage
 * endpoint via a bot token.
 *
 * Security contract (FR-11):
 *   - The botToken is used ONLY in the `Authorization: Bearer` header of the
 *     outbound HTTP request. It is NEVER logged, journaled, or surfaced in any
 *     error message, stack trace, or thrown-error property.
 *   - Network and API failures are wrapped in a typed Error that names the
 *     failure mode but redacts the token.
 *
 * @param config.botToken   Slack bot token — read from configuration/env.
 * @param config.fetchImpl  Injectable HTTP client (defaults to global `fetch`).
 * @param config.apiBaseUrl Slack API base URL (defaults to https://slack.com/api).
 */
export function createSlackTransport(config: {
  botToken: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** Files larger than this are rejected before any network call (NFR-3). */
  maxUploadBytes?: number;
  /** Wall-clock bound (ms) on the JSON Web API calls (post + the two upload control steps). */
  fetchTimeoutMs?: number;
  /** Wall-clock bound (ms) on the raw byte POST only — a large upload on a slow link. */
  uploadTimeoutMs?: number;
}): SlackTransport {
  const {
    botToken,
    fetchImpl = globalThis.fetch,
    apiBaseUrl = DEFAULT_SLACK_API_BASE,
    maxUploadBytes,
    fetchTimeoutMs = SLACK_FETCH_TIMEOUT_MS,
    uploadTimeoutMs = SLACK_UPLOAD_TIMEOUT_MS,
  } = config;
  const endpoint = `${apiBaseUrl}/chat.postMessage`;

  /**
   * Scrub the bot token from any string before it surfaces in a thrown error
   * (FR-11 / NFR-1). Applies to BOTH the network-error path (some HTTP clients
   * embed the Authorization header verbatim in their error messages) AND the
   * parsed-body path (a Slack `ok:false` response's `error` code is untrusted
   * text and must be scrubbed the same way before it is interpolated into a
   * thrown message — a hostile/misconfigured response could otherwise echo
   * the token back).
   */
  function redactToken(text: string): string {
    return text.replaceAll(botToken, '[REDACTED]');
  }

  function redactedNetworkError(step: string, err: unknown): Error {
    const rawDetail = err instanceof Error ? err.message : 'network error';
    return new Error(`Slack transport network failure (${step}): ${redactToken(rawDetail)}`);
  }

  return {
    async post(req: {
      channel: string;
      text: string;
      correlationId?: string;
      threadTs?: string;
    }): Promise<{ ts: string }> {
      // ── Network call ────────────────────────────────────────────────────────
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: req.channel,
            text: req.text,
            ...(req.threadTs !== undefined ? { thread_ts: req.threadTs } : {}),
          }),
        });
      } catch (networkError) {
        throw redactedNetworkError('chat.postMessage', networkError);
      }

      // ── Response handling ───────────────────────────────────────────────────
      const body = (await response.json()) as {
        ok: boolean;
        ts?: string;
        error?: string;
      };

      if (!body.ok) {
        // Surface the Slack error code but never the bot token (FR-11). The
        // code is untrusted response text, so it is scrubbed the same way as
        // a network-error message before being interpolated into the thrown
        // message.
        const slackCode = redactToken(body.error ?? 'unknown_error');
        throw new Error(`Slack API error: ${slackCode}`);
      }

      return { ts: body.ts! };
    },

    async uploadFile(req: {
      channel: string;
      filePath: string;
      threadTs?: string;
      caption?: string;
      bytes?: Uint8Array<ArrayBuffer>;
    }): Promise<{ ok: true; files: Array<{ id: string }> }> {
      const filename = basename(req.filePath);

      // Prefer caller-supplied bytes (egressSendFile already read+fingerprinted
      // them) — re-reading here could observe different bytes than the outbox
      // key attests. Fall back to reading for direct callers that pass none.
      const fileBytes: Uint8Array<ArrayBuffer> = req.bytes ?? readFileSync(req.filePath);
      const size = fileBytes.length;

      // ── NFR-3: size check BEFORE any network call, on the ACTUAL bytes being
      // uploaded (not a separate stat that could disagree with them) ──────────
      if (maxUploadBytes !== undefined && size > maxUploadBytes) {
        throw new Error(
          `Slack file upload exceeds size limit: file is ${size} bytes, limit is ${maxUploadBytes} bytes`,
        );
      }

      // ── Step 1: files.getUploadURLExternal — request an upload slot ────────
      // Unlike most Web API methods (and step 3 below), this endpoint does NOT
      // accept a JSON body — form-encoded only. A JSON body fails as
      // `invalid_arguments` with "missing required field: filename/length".
      // Verified against live Slack 2026-07-15 (first studio-edit delivery).
      let getUrlResponse: Response;
      try {
        getUrlResponse = await fetchImpl(`${apiBaseUrl}/files.getUploadURLExternal`, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: new URLSearchParams({ filename, length: String(size) }).toString(),
        });
      } catch (networkError) {
        throw redactedNetworkError('files.getUploadURLExternal', networkError);
      }

      const getUrlBody = (await getUrlResponse.json()) as {
        ok: boolean;
        upload_url?: string;
        file_id?: string;
        error?: string;
      };

      if (!getUrlBody.ok) {
        const slackCode = redactToken(getUrlBody.error ?? 'unknown_error');
        throw new Error(`Slack API error (files.getUploadURLExternal): ${slackCode}`);
      }

      const uploadUrl = getUrlBody.upload_url!;
      const fileId = getUrlBody.file_id!;

      // ── Step 2: raw byte POST to the pre-signed upload_url ─────────────────
      // Never persist/reuse this URL across calls (W-3) — it is re-acquired
      // from step 1 on every uploadFile invocation.
      let bytePostResponse: Response;
      try {
        bytePostResponse = await fetchImpl(uploadUrl, {
          signal: AbortSignal.timeout(uploadTimeoutMs),
          method: 'POST',
          body: fileBytes,
        });
      } catch (networkError) {
        throw redactedNetworkError('byte upload', networkError);
      }

      // Slack replies 200 with a plain-text body here, NOT JSON — check status,
      // don't attempt to parse it.
      if (!bytePostResponse.ok) {
        throw new Error(`Slack file byte upload failed with status ${bytePostResponse.status}`);
      }

      // ── Step 3: files.completeUploadExternal — finalize the upload ─────────
      let completeResponse: Response;
      try {
        completeResponse = await fetchImpl(`${apiBaseUrl}/files.completeUploadExternal`, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            files: [{ id: fileId }],
            channel_id: req.channel,
            ...(req.threadTs !== undefined ? { thread_ts: req.threadTs } : {}),
            ...(req.caption !== undefined ? { initial_comment: req.caption } : {}),
          }),
        });
      } catch (networkError) {
        throw redactedNetworkError('files.completeUploadExternal', networkError);
      }

      const completeBody = (await completeResponse.json()) as {
        ok: boolean;
        files?: Array<{ id: string }>;
        error?: string;
      };

      if (!completeBody.ok) {
        const slackCode = redactToken(completeBody.error ?? 'unknown_error');
        throw new Error(`Slack API error (files.completeUploadExternal): ${slackCode}`);
      }

      return { ok: true, files: completeBody.files ?? [] };
    },
  };
}

// ---------------------------------------------------------------------------
// files.info/thread-history reconciler (WI-602, FR-3/FR-4/FR-11, NFR-1)
// ---------------------------------------------------------------------------

/** A file entry as returned by Slack's files.list / conversations.replies. */
interface SlackProbeFile {
  name?: string;
  size?: number;
}

/**
 * Build a FileReconciler that probes a Slack channel/thread for a pending
 * upload's outcome, upgrading egressSendFile's hold-only base (WI-598) to a
 * safe auto-resume: a probe that PROVES the file did not land re-fires the
 * delivery; a probe that proves it DID land skips a duplicate upload; any
 * anomaly or probe failure fails closed to 'unknown' (never guesses 'landed').
 *
 * Matches the pending intent's persisted `path`/`size` against the probed
 * file list on basename(path) + size — the content fingerprint stays the
 * OUTBOX's own idempotency key; Slack exposes no content hash to probe by.
 *
 * The bot token never surfaces on a probe failure (NFR-1): a thrown network
 * error or a Slack `ok:false` response both fail closed to 'unknown' without
 * inspecting or logging the error detail, so a hostile/misconfigured response
 * embedding the token has nowhere to leak through.
 */
export function createFilesInfoReconciler(config: {
  botToken: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  channel: string;
  threadTs?: string;
  /** Wall-clock bound (ms) on the probe fetch (defaults to SLACK_FETCH_TIMEOUT_MS). */
  fetchTimeoutMs?: number;
}): FileReconciler {
  const {
    botToken,
    fetchImpl = globalThis.fetch,
    apiBaseUrl = DEFAULT_SLACK_API_BASE,
    channel,
    threadTs,
    fetchTimeoutMs = SLACK_FETCH_TIMEOUT_MS,
  } = config;

  return async (intent: Record<string, unknown>): Promise<'landed' | 'not_landed' | 'unknown'> => {
    const path = typeof intent.path === 'string' ? intent.path : '';
    const expectedSize = typeof intent.size === 'number' ? intent.size : undefined;
    const expectedName = basename(path);

    try {
      // A threaded delivery probes the thread's message history (files ride on
      // a specific reply); an unthreaded delivery probes the channel's file
      // list directly. Either shape is tolerated below.
      const endpoint =
        threadTs !== undefined
          ? `${apiBaseUrl}/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`
          : `${apiBaseUrl}/files.list?channel=${encodeURIComponent(channel)}`;

      const response = await fetchImpl(endpoint, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
        method: 'GET',
        headers: { Authorization: `Bearer ${botToken}` },
      });

      const body = (await response.json()) as {
        ok: boolean;
        error?: string;
        files?: SlackProbeFile[];
        messages?: Array<{ files?: SlackProbeFile[] }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };

      if (!body.ok) {
        // Never inspect/log body.error — it is untrusted response text that
        // could embed the bot token (NFR-1); fail closed instead.
        return 'unknown';
      }

      const candidates: SlackProbeFile[] = body.files ?? (body.messages ?? []).flatMap((m) => m.files ?? []);
      const matches = candidates.filter((f) => f.name === expectedName && f.size === expectedSize);

      // A found file is dispositive on any page — 'landed' short-circuits.
      if (matches.length === 1) return 'landed';
      if (matches.length > 1) return 'unknown'; // ambiguous, fail-closed

      // matches.length === 0: 'not_landed' is the ONLY verdict that re-fires an
      // upload, so it must be PROVABLE, not merely "absent from the page I saw".
      // Slack paginates files.list / conversations.replies (~100 default), so a
      // zero-match on a partial result cannot prove absence — a landed file on a
      // later page would be re-uploaded (double-post). Only a provably COMPLETE
      // probe (no further pages) may conclude 'not_landed'; otherwise fail-closed
      // to 'unknown' (→ hold). (Residual: files.list is eventually consistent, so
      // a just-landed file may not be indexed yet; on resume enough time has
      // usually passed, and 'unknown' → hold is the safe fallback either way.)
      const morePages = body.has_more === true || (body.response_metadata?.next_cursor ?? '') !== '';
      return morePages ? 'unknown' : 'not_landed';
    } catch {
      // Network throw (which may embed the token in its message, NFR-1) —
      // swallow into a fail-closed verdict; never rethrow, never log.
      return 'unknown';
    }
  };
}
