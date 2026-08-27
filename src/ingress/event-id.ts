/**
 * WI-405 — Deterministic event_id derivation (SPEC §9 / D2, FR-8).
 *
 * Turns an inbound event into a stable id so the same external event yields the
 * same id across retries and listener restarts. The source is per-binding, with
 * type-specific smart defaults when no source is declared, a fail-closed `require`
 * mode, and a surfaced content-hash fallback that warns once per binding.
 */
import { createHash } from 'node:crypto';
import type { EventIdSource } from './binding';
import { resolveJsonPath } from './json-path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The deriver accepts a binding whose event_id source MAY be absent —
 * "no declared source" is the smart-default trigger. */
interface DeriveBinding {
  type: 'webhook' | 'slack' | 'cli';
  event_id?: EventIdSource;
}

interface IngressEvent {
  headers?: Record<string, unknown>;
  /** The parsed body — used for json_path/native-id extraction. */
  body?: unknown;
  /**
   * The RAW request body bytes exactly as received on the wire. When present,
   * the content-hash fallback hashes these bytes directly so dedup is immune to
   * a proxy re-serializing the JSON with a different key order (The original webhook-signature validation work). When
   * absent, the fallback canonicalizes `body` (recursively sorted keys) before
   * hashing.
   */
  rawBody?: string | Buffer;
}

export type DeriveEventIdResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: 'no_explicit_id' }; // require-mode fail-closed (FR-8)

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/**
 * Guards the degraded-dedup console.warn: fires ONCE per binding.
 *
 * Keyed on a STABLE STRING (not object identity). The adapters construct a fresh
 * `{ type, event_id }` literal on every request, so an identity-keyed WeakSet
 * would never match a previous call and the warning would fire on every single
 * request (The original single-read request-body work). A string key derived from the binding's stable fields
 * (`type` + serialized `event_id`) — or an explicit `bindingKey` supplied by the
 * caller — collapses all requests for the same binding to a single warning.
 */
const warnedBindings = new Set<string>();

/** Ordered probe list for keyless webhook delivery-id headers (first match wins). */
const WEBHOOK_DELIVERY_HEADERS = [
  'X-Conduit-Delivery-Id',
  'Idempotency-Key',
  'X-GitHub-Delivery',
  'X-Shopify-Webhook-Id',
  'X-Request-Id',
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives a stable event_id for an inbound event.
 *
 * Resolution order:
 *   1. Explicit source declared on the binding (content_hash, require, header, json_path).
 *   2. Type-specific smart default (slack → body.event_id; webhook → probe headers then body.id).
 *   3. Content-hash fallback with a one-time per-binding degraded-dedup warning.
 */
export function deriveEventId(
  binding: DeriveBinding,
  event: IngressEvent,
  /**
   * Optional stable identifier (e.g. `flowId` or `flowId:route`) used to key the
   * once-per-binding degraded-dedup warning. Defaults to a key derived from the
   * binding's stable fields when omitted (The original single-read request-body work).
   */
  bindingKey?: string,
): DeriveEventIdResult {
  const source = binding.event_id;
  // Normalize headers once so all lookups are HTTP-correct case-insensitive (The original Slack envelope-handling work).
  const headers = normalizeHeaders(event.headers);

  // --- Explicit: content_hash (intentional opt-in — no warn, return immediately) ---
  if (source?.from === 'content_hash') {
    return { ok: true, eventId: contentHash(event) };
  }

  // --- Explicit: require (fail-closed — probe well-known id or return typed rejection) ---
  if (source?.from === 'require') {
    const wellKnownId = probeWellKnownId(binding.type, event, headers);
    if (wellKnownId !== null) {
      return { ok: true, eventId: wellKnownId };
    }
    return { ok: false, reason: 'no_explicit_id' };
  }

  // --- Explicit: header (absent header falls through to content-hash) ---
  if (source?.from === 'header') {
    // HTTP headers are case-insensitive: lowercase the binding's declared name
    // to match the normalized header map (The original Slack envelope-handling work).
    const value = headers[source.name.toLowerCase()];
    if (value !== undefined && value !== null) {
      return { ok: true, eventId: String(value) };
    }
    // Header absent → fall through to content-hash fallback with warn.
  }

  // --- Explicit: json_path (unresolved path falls through to content-hash) ---
  else if (source?.from === 'json_path') {
    const value = resolveJsonPath(event.body, source.path);
    if (value !== null && value !== undefined) {
      return { ok: true, eventId: String(value) };
    }
    // Path unresolved → fall through to content-hash fallback with warn.
  }

  // --- Smart defaults (no declared source) ---
  else if (source === undefined) {
    if (binding.type === 'slack') {
      const slackId = extractSlackNativeId(event.body);
      if (slackId !== null) {
        return { ok: true, eventId: slackId };
      }
    } else if (binding.type === 'webhook') {
      const wellKnownId = probeWellKnownId('webhook', event, headers);
      if (wellKnownId !== null) {
        return { ok: true, eventId: wellKnownId };
      }
    }
    // No match → fall through to content-hash fallback with warn.
  }

  // --- Content-hash fallback (degraded dedup — warn once per binding) ---
  const warnKey = bindingKey ?? defaultBindingKey(binding);
  if (!warnedBindings.has(warnKey)) {
    warnedBindings.add(warnKey);
    console.warn(
      '[conduit:ingress] degraded duplicate detection: no stable event id found for this ' +
        'binding. Falling back to a content hash of the request body — identical re-deliveries ' +
        'of the SAME payload will be deduplicated, but re-deliveries with any mutation will not. ' +
        'Set event_id.from = "content_hash" to suppress this warning, or configure a ' +
        'header/json_path source for reliable idempotency.',
    );
  }

  return { ok: true, eventId: contentHash(event) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lowercases every key of an incoming headers object so lookups are
 * case-insensitive, as HTTP headers require (The original Slack envelope-handling work). On a duplicate
 * (differently-cased) key the last value wins. Returns a plain own-property
 * object so callers can index it directly.
 */
function normalizeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (headers) {
    for (const key of Object.keys(headers)) {
      normalized[key.toLowerCase()] = headers[key];
    }
  }
  return normalized;
}

/**
 * Derives a stable string key for the once-per-binding warn guard from the
 * binding's stable fields. Used when the caller does not supply an explicit
 * bindingKey (The original single-read request-body work).
 */
function defaultBindingKey(binding: DeriveBinding): string {
  return `${binding.type}:${JSON.stringify(binding.event_id ?? null)}`;
}

/**
 * Probes for a well-known delivery id based on binding type.
 * Returns the first match, or null if none is found.
 *
 * `headers` is the already-lowercased header map (The original Slack envelope-handling work); the well-known
 * names are lowercased here to match.
 */
function probeWellKnownId(
  type: string,
  event: IngressEvent,
  headers: Record<string, unknown>,
): string | null {
  if (type === 'webhook') {
    // 1. Probe ordered well-known delivery-id headers (case-insensitive).
    for (const headerName of WEBHOOK_DELIVERY_HEADERS) {
      const value = headers[headerName.toLowerCase()];
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }
    // 2. Stripe-style body.id.
    if (
      event.body !== null &&
      event.body !== undefined &&
      typeof event.body === 'object' &&
      !Array.isArray(event.body)
    ) {
      const body = event.body as Record<string, unknown>;
      if (body.id !== undefined && body.id !== null) {
        return String(body.id);
      }
    }
    return null;
  }

  if (type === 'slack') {
    return extractSlackNativeId(event.body);
  }

  return null;
}

/** Extracts Slack's native event id from the Events API payload (`body.event_id`). */
function extractSlackNativeId(body: unknown): string | null {
  if (
    body !== null &&
    body !== undefined &&
    typeof body === 'object' &&
    !Array.isArray(body)
  ) {
    const record = body as Record<string, unknown>;
    const eventId = record['event_id'];
    if (eventId !== undefined && eventId !== null) {
      return String(eventId);
    }
  }
  return null;
}

/**
 * Stable sha256 digest of the request body, for degraded content-hash dedup.
 *
 * The original webhook-signature validation work: the digest MUST NOT depend on JSON key ordering. The parser
 * preserves the sender's wire order, so re-serializing a parsed object would let
 * a proxy that re-serializes with a different key order defeat dedup. To be
 * order-independent:
 *   1. Prefer the RAW body bytes (`event.rawBody`) — hashed verbatim. This is
 *      exact across re-deliveries of the identical wire payload.
 *   2. Otherwise canonicalize the parsed body — recursively sort object keys at
 *      every level — before stringifying, so two semantically-equal bodies that
 *      differ only in key order hash to the same id.
 */
function contentHash(event: IngressEvent): string {
  const hash = createHash('sha256');
  if (event.rawBody !== undefined) {
    hash.update(event.rawBody);
  } else {
    hash.update(JSON.stringify(canonicalize(event.body ?? null)));
  }
  return hash.digest('hex');
}

/**
 * Recursively returns a structurally-equal copy of `value` with every object's
 * keys sorted alphabetically, so JSON.stringify produces a canonical,
 * key-order-independent string. Arrays keep their order (order is significant);
 * primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}
