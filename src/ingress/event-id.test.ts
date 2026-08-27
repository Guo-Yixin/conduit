/**
 * Tests for deterministic event_id derivation (WI-405, SPEC §9 / FR-8, D2).
 *
 * deriveEventId turns an inbound event into a STABLE id so the same external
 * event yields the same id across retries and listener restarts (the dedup
 * ledger keys on it). The source is per-binding (WI-402 IngressBinding), with
 * type-specific smart defaults when no source is declared, a fail-closed
 * `require` mode, and a surfaced content-hash fallback.
 *
 * Contract this file pins for src/ingress/event-id.ts:
 *
 *   import type { EventIdSource } from './binding';
 *
 *   // The deriver accepts a binding whose event_id source MAY be absent —
 *   // "no declared source" is the FR-8 smart-default trigger. (WI-402's strict
 *   // flow-config parse requires event_id; the deriver is the more permissive
 *   // runtime home of the smart default.)
 *   interface DeriveBinding { type: 'webhook' | 'slack' | 'cli'; event_id?: EventIdSource }
 *   interface IngressEvent  { headers?: Record<string, unknown>; body?: unknown }
 *
 *   type DeriveEventIdResult =
 *     | { ok: true;  eventId: string }
 *     | { ok: false; reason: 'no_explicit_id' };   // require-mode fail-closed (FR-8)
 *
 *   export function deriveEventId(binding: DeriveBinding, event: IngressEvent): DeriveEventIdResult
 *
 * Pinned contract decisions (resolving AC ambiguity — see each test):
 *   - Result is a discriminated union: success carries `eventId`; the require-mode
 *     keyless case is `{ ok: false, reason: 'no_explicit_id' }` (never throws, never hashes).
 *   - Slack's native id is read from `event.body.event_id` (Slack Events API field).
 *   - Webhook smart-default probe order is the built-in list
 *     [X-Conduit-Delivery-Id, Idempotency-Key, X-GitHub-Delivery, X-Shopify-Webhook-Id,
 *     X-Request-Id] then a Stripe-style `event.body.id`; first match wins.
 *   - The degraded-dedup warning fires via console.warn, guarded ONCE PER BINDING
 *     (a module-scoped WeakSet keyed on the binding) — not once per event. Distinct
 *     binding instances each warn once; the same binding warns only on its first
 *     keyless event. Explicit `from:'content_hash'` is an intentional opt-in and
 *     does NOT warn.
 *   - Header lookups in tests use canonical casing, so the contract is agnostic to
 *     whether the impl does case-insensitive header matching.
 *
 * RED state before WI-405: src/ingress/event-id.ts does not exist, so the import
 * fails to resolve and every test errors at module load.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { deriveEventId } from './event-id';

/** Narrow a result to its success branch, failing loud otherwise. */
function expectId(result: ReturnType<typeof deriveEventId>): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected an event id, got ${result.reason}`);
  return result.eventId;
}

// ---------------------------------------------------------------------------
// AC1 — explicit per-binding source: header | json_path | content_hash.
// ---------------------------------------------------------------------------
describe('deriveEventId — explicit declared source (AC1)', () => {
  it("from:'header' returns the named header's value", () => {
    const id = expectId(
      deriveEventId(
        { type: 'webhook', event_id: { from: 'header', name: 'X-GitHub-Delivery' } },
        { headers: { 'X-GitHub-Delivery': 'gh-delivery-123' }, body: {} },
      ),
    );
    expect(id).toBe('gh-delivery-123');
  });

  it("from:'json_path' returns the value at that path in the body", () => {
    const id = expectId(
      deriveEventId(
        { type: 'webhook', event_id: { from: 'json_path', path: '$.data.object.id' } },
        { body: { data: { object: { id: 'obj-789' } } } },
      ),
    );
    expect(id).toBe('obj-789');
  });

  // The original JSON-path array-projection work — the shared resolver indexes arrays, so json_path event-id
  // sources can address array-shaped payloads (Slack files[], GitHub commits[]).
  it("from:'json_path' indexes into arrays with numeric segments (The original JSON-path array-projection work)", () => {
    const id = expectId(
      deriveEventId(
        { type: 'webhook', event_id: { from: 'json_path', path: '$.event.files.0.id' } },
        { body: { event: { files: [{ id: 'F111' }, { id: 'F222' }] } } },
      ),
    );
    expect(id).toBe('F111');
  });

  it("from:'content_hash' returns a stable hash — same body yields the same id", () => {
    const binding = { type: 'webhook' as const, event_id: { from: 'content_hash' as const } };
    const first = expectId(deriveEventId(binding, { body: { order: 42, items: ['a', 'b'] } }));
    const again = expectId(deriveEventId(binding, { body: { order: 42, items: ['a', 'b'] } }));

    expect(first).toBe(again);
    expect(first.length).toBeGreaterThan(0);
  });

  it("from:'content_hash' yields a different id for a different body", () => {
    const binding = { type: 'webhook' as const, event_id: { from: 'content_hash' as const } };
    const a = expectId(deriveEventId(binding, { body: { order: 42 } }));
    const b = expectId(deriveEventId(binding, { body: { order: 43 } }));

    expect(a).not.toBe(b);
  });

  it("from:'content_hash' is an intentional opt-in and does NOT emit the degraded warning", () => {
    const warnSpy = spyOn(console, 'warn');
    try {
      deriveEventId(
        { type: 'webhook', event_id: { from: 'content_hash' } },
        { body: { explicit: true } },
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — slack binding with no declared source → native event id from payload.
// ---------------------------------------------------------------------------
describe('deriveEventId — slack native default (AC2)', () => {
  it('defaults a sourceless slack binding to the native event_id in the payload', () => {
    const id = expectId(
      deriveEventId(
        { type: 'slack' },
        { body: { event_id: 'Ev09XYZ', event: { type: 'message', text: 'hi' } } },
      ),
    );
    expect(id).toBe('Ev09XYZ');
  });
});

// ---------------------------------------------------------------------------
// AC3 — webhook with no declared source → probe ordered well-known delivery-id
//       headers, then a Stripe-style body id; first match wins.
// ---------------------------------------------------------------------------
describe('deriveEventId — webhook smart-default probe (AC3)', () => {
  it.each([
    ['X-Conduit-Delivery-Id', 'cd-1'],
    ['Idempotency-Key', 'idem-2'],
    ['X-GitHub-Delivery', 'gh-3'],
    ['X-Shopify-Webhook-Id', 'shop-4'],
    ['X-Request-Id', 'req-5'],
  ])('probes the well-known delivery-id header %s', (header, value) => {
    const id = expectId(
      deriveEventId({ type: 'webhook' }, { headers: { [header]: value }, body: {} }),
    );
    expect(id).toBe(value);
  });

  it('returns the FIRST match in probe order when several well-known headers are present', () => {
    // X-Conduit-Delivery-Id precedes X-GitHub-Delivery in the built-in list.
    const id = expectId(
      deriveEventId(
        { type: 'webhook' },
        {
          headers: { 'X-Conduit-Delivery-Id': 'conduit-win', 'X-GitHub-Delivery': 'gh-lose' },
          body: {},
        },
      ),
    );
    expect(id).toBe('conduit-win');
  });

  it('falls back to a Stripe-style body id when no well-known header matches', () => {
    const id = expectId(
      deriveEventId({ type: 'webhook' }, { headers: {}, body: { id: 'evt_stripe_1', object: 'event' } }),
    );
    expect(id).toBe('evt_stripe_1');
  });
});

// ---------------------------------------------------------------------------
// AC4 — no well-known id → content-hash fallback + ONE-TIME degraded warning.
// ---------------------------------------------------------------------------
describe('deriveEventId — degraded content-hash fallback (AC4)', () => {
  it('content-hashes the body and warns ONCE PER BINDING, not once per event', () => {
    // Fresh binding instance → its per-binding warn guard starts untripped.
    const binding = { type: 'webhook' as const };
    const warnSpy = spyOn(console, 'warn');
    try {
      const r1 = deriveEventId(binding, { headers: {}, body: { n: 1 } });
      const r2 = deriveEventId(binding, { headers: {}, body: { n: 2 } });
      const r3 = deriveEventId(binding, { headers: {}, body: { n: 1 } });

      // Each keyless event still derives a deterministic content-hash id.
      const id1 = expectId(r1);
      expect(expectId(r2).length).toBeGreaterThan(0);
      // Same body as r1 → identical id (stable across "retries").
      expect(expectId(r3)).toBe(id1);

      // Surfaced exactly once for this binding across three keyless events.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — require mode is fail-closed: no explicit id → typed rejection, no hash.
// ---------------------------------------------------------------------------
describe('deriveEventId — require mode fail-closed (AC5)', () => {
  it("returns { ok: false, reason: 'no_explicit_id' } when the event lacks an explicit id", () => {
    const warnSpy = spyOn(console, 'warn');
    try {
      const result = deriveEventId(
        { type: 'webhook', event_id: { from: 'require' } },
        { headers: {}, body: { payload: 'no id here' } },
      );

      expect(result).toEqual({ ok: false, reason: 'no_explicit_id' });
      // Fail-closed: it must NOT silently content-hash, so it does not warn either.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still accepts an explicit well-known id under require mode', () => {
    const id = expectId(
      deriveEventId(
        { type: 'webhook', event_id: { from: 'require' } },
        { headers: { 'X-GitHub-Delivery': 'gh-required' }, body: {} },
      ),
    );
    expect(id).toBe('gh-required');
  });
});

// ---------------------------------------------------------------------------
// AC7 — a declared header/json_path that is absent (non-require) is handled
//       deterministically (content-hash fallback) rather than throwing.
// ---------------------------------------------------------------------------
describe('deriveEventId — absent declared source handled deterministically (AC7)', () => {
  it.each([
    ['header', { from: 'header', name: 'X-Missing-Delivery' } as const],
    ['json_path', { from: 'json_path', path: '$.never.here' } as const],
  ])('does not throw and yields a stable id when the %s source is absent', (_label, source) => {
    const binding = { type: 'webhook' as const, event_id: source };
    const event = { headers: {}, body: { stable: 'payload' } };
    const warnSpy = spyOn(console, 'warn'); // suppress + ignore the degraded warning here

    try {
      let first: ReturnType<typeof deriveEventId>;
      let second: ReturnType<typeof deriveEventId>;
      expect(() => {
        first = deriveEventId(binding, event);
        second = deriveEventId(binding, event);
      }).not.toThrow();

      expect(expectId(first!)).toBe(expectId(second!));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
