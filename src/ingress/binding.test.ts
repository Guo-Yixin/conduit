/**
 * Tests for the channels.ingress binding schema + boot validation (WI-402).
 *
 * Implements FR-1 / Principle 10 — "config is validated, not trusted." A flow's
 * `channels.ingress` binding is parsed into a typed, validated shape, and the
 * listener refuses to start when a binding is malformed or two active flows
 * collide on a webhook route (D4, D2, FR-9, FR-6, FR-8).
 *
 * Contract this file pins for src/ingress/binding.ts (follow the typed-error
 * style of src/flow/load.ts — return structured errors, never throw):
 *
 *   export interface IngressValidationError { code: string; message: string }
 *
 *   export type EventIdSource =
 *     | { from: 'header';       name: string }
 *     | { from: 'json_path';    path: string }
 *     | { from: 'content_hash' }
 *     | { from: 'require' }            // strict opt-in — deriver rejects keyless events (D2/FR-8)
 *
 *   export interface IngressAuthConfig { type: string; [k: string]: unknown }
 *
 *   export interface IngressBinding {
 *     type: 'webhook' | 'slack' | 'cli';
 *     route?: string;                    // webhook only
 *     auth?: IngressAuthConfig;          // required for webhook + slack
 *     event_id: EventIdSource;           // required for every binding (no silent default)
 *     substrate?: Record<string, string>;// optional JSON-path projection mapping
 *   }
 *
 *   export type ParseIngressBindingResult =
 *     | { ok: true;  binding: IngressBinding }
 *     | { ok: false; error: IngressValidationError }
 *   export function parseIngressBinding(raw: unknown): ParseIngressBindingResult
 *
 *   export interface FlowIngressDeclaration { flow: string; ingress: unknown }
 *   export type ValidateIngressBindingsResult =
 *     | { ok: true }
 *     | { ok: false; errors: IngressValidationError[] }
 *   export function validateIngressBindings(
 *     declarations: FlowIngressDeclaration[],
 *   ): ValidateIngressBindingsResult
 *
 * Required-field rules (documented contract — pinned by the tests below):
 *   - webhook : requires `route` AND `auth`
 *   - slack   : requires `auth`           (no route)
 *   - cli     : requires neither route nor auth (local ingress)
 *   - all     : `event_id` source present and well-formed for its `from` kind
 *
 * Stable error codes pinned by these tests:
 *   UNKNOWN_INGRESS_TYPE | MISSING_WEBHOOK_ROUTE | MISSING_AUTH |
 *   MISSING_AUTH_SECRET | MISSING_EVENT_ID_SOURCE | INVALID_EVENT_ID_SOURCE |
 *   INVALID_SUBSTRATE_MAPPING | ROUTE_COLLISION
 */
import { describe, it, expect } from 'bun:test';
import {
  parseIngressBinding,
  validateIngressBindings,
  type IngressBinding,
  type IngressValidationError,
  type EventIdSource,
  type FlowIngressDeclaration,
} from './binding';

// A canonical well-formed webhook binding. Individual tests spread over it to
// mutate exactly one field, so the assertion targets that field in isolation.
const validWebhookRaw = {
  type: 'webhook',
  route: '/hooks/github',
  auth: { type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' },
  event_id: { from: 'header', name: 'X-GitHub-Delivery' },
} as const;

/** Assert a parse succeeded and return the narrowed binding (fails loud otherwise). */
function expectParsed(result: ReturnType<typeof parseIngressBinding>): IngressBinding {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a parsed binding, got error ${result.error.code}`);
  return result.binding;
}

/** Assert a parse failed and return the narrowed error (fails loud otherwise). */
function expectParseError(
  result: ReturnType<typeof parseIngressBinding>,
): IngressValidationError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a validation error, got a parsed binding');
  return result.error;
}

/** Assert a boot validation failed and return its collected errors (fails loud otherwise). */
function expectValidationErrors(
  result: ReturnType<typeof validateIngressBindings>,
): IngressValidationError[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected validation errors, got ok');
  return result.errors;
}

function decl(flow: string, ingress: unknown): FlowIngressDeclaration {
  return { flow, ingress };
}

describe('parseIngressBinding', () => {
  it('parses a well-formed webhook binding into a typed shape', () => {
    const binding = expectParsed(parseIngressBinding(validWebhookRaw));
    expect(binding.type).toBe('webhook');
    expect(binding.route).toBe('/hooks/github');
    expect(binding.auth).toEqual({ type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' });
    expect(binding.event_id).toEqual({ from: 'header', name: 'X-GitHub-Delivery' });
  });

  it('parses a cli binding without requiring a route (route is webhook-only)', () => {
    const binding = expectParsed(
      parseIngressBinding({ type: 'cli', event_id: { from: 'content_hash' } }),
    );
    expect(binding.type).toBe('cli');
    expect(binding.route).toBeUndefined();
  });

  // Typed as EventIdSource[] so `from` keeps its literal type — otherwise the
  // array widens `from: 'header'` to `from: string` and `toEqual(source)` fails
  // tsc (the widened shape is not assignable to the EventIdSource union).
  const eventIdSources: Array<[string, EventIdSource]> = [
    ['header', { from: 'header', name: 'X-Event-Id' }],
    ['json_path', { from: 'json_path', path: '$.delivery.id' }],
    ['content_hash', { from: 'content_hash' }],
    ['require', { from: 'require' }],
  ];
  it.each(eventIdSources)(
    'captures the %s event_id source verbatim on the parsed binding',
    (_label, source) => {
      const binding = expectParsed(parseIngressBinding({ ...validWebhookRaw, event_id: source }));
      expect(binding.event_id).toEqual(source);
    },
  );

  it('records event_id {from: require} as the strict opt-in (deriver may reject keyless events)', () => {
    const binding = expectParsed(
      parseIngressBinding({ ...validWebhookRaw, event_id: { from: 'require' } }),
    );
    expect(binding.event_id).toEqual({ from: 'require' });
  });

  it('does NOT mark a non-require event_id source as the strict opt-in', () => {
    const binding = expectParsed(
      parseIngressBinding({ ...validWebhookRaw, event_id: { from: 'content_hash' } }),
    );
    expect(binding.event_id.from).not.toBe('require');
  });

  it('preserves a valid JSON-path substrate projection on the parsed binding', () => {
    const binding = expectParsed(
      parseIngressBinding({
        ...validWebhookRaw,
        substrate: { subject: '$.issue.title', body: '$.issue.body' },
      }),
    );
    expect(binding.substrate).toEqual({ subject: '$.issue.title', body: '$.issue.body' });
  });

  it('returns a typed error (does not throw) for an unknown ingress type', () => {
    let result: ReturnType<typeof parseIngressBinding> | undefined;
    expect(() => {
      result = parseIngressBinding({ ...validWebhookRaw, type: 'carrier-pigeon' });
    }).not.toThrow();
    expect(expectParseError(result!).code).toBe('UNKNOWN_INGRESS_TYPE');
  });

  it('rejects a binding that declares no event_id source', () => {
    const error = expectParseError(
      parseIngressBinding({ type: 'webhook', route: '/x', auth: { type: 'hmac' } }),
    );
    expect(error.code).toBe('MISSING_EVENT_ID_SOURCE');
  });

  it.each([
    ['header source missing its name', { from: 'header' }],
    ['json_path source missing its path', { from: 'json_path' }],
    ['an unknown source kind', { from: 'cookie' }],
    ['a non-object source', 'X-Event-Id'],
  ])('rejects a malformed event_id source: %s', (_label, source) => {
    const error = expectParseError(parseIngressBinding({ ...validWebhookRaw, event_id: source }));
    expect(error.code).toBe('INVALID_EVENT_ID_SOURCE');
  });

  it.each([
    ['a bare string instead of a projection object', 'subject=$.title'],
    ['a projection value that is not a JSON-path string', { subject: 42 }],
  ])('rejects a substrate mapping that is not a JSON-path projection: %s', (_label, substrate) => {
    const error = expectParseError(parseIngressBinding({ ...validWebhookRaw, substrate }));
    expect(error.code).toBe('INVALID_SUBSTRATE_MAPPING');
  });

  it.each([
    ['null', null],
    ['a bare string', 'webhook'],
    ['a number', 7],
    ['an empty object', {}],
  ])('returns a typed error (never throws) for malformed raw input: %s', (_label, raw) => {
    let result: ReturnType<typeof parseIngressBinding> | undefined;
    expect(() => {
      result = parseIngressBinding(raw);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
  });
});

describe('validateIngressBindings', () => {
  it('returns ok when every flow binding is well-formed', () => {
    const result = validateIngressBindings([
      decl('github-sync', validWebhookRaw),
      decl('cli-intake', { type: 'cli', event_id: { from: 'content_hash' } }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('returns ok for an empty set of bindings', () => {
    expect(validateIngressBindings([]).ok).toBe(true);
  });

  it('rejects a webhook binding with no route, naming the offending flow', () => {
    const errors = expectValidationErrors(
      validateIngressBindings([
        decl('github-sync', {
          type: 'webhook',
          auth: { type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' },
          event_id: { from: 'header', name: 'X-Id' },
        }),
      ]),
    );
    const routeErr = errors.find((e) => e.code === 'MISSING_WEBHOOK_ROUTE');
    expect(routeErr).toBeDefined();
    expect(routeErr!.message).toContain('github-sync');
  });

  it('rejects a webhook binding with no auth, naming the offending flow', () => {
    const errors = expectValidationErrors(
      validateIngressBindings([
        decl('github-sync', {
          type: 'webhook',
          route: '/hooks/gh',
          event_id: { from: 'header', name: 'X-Id' },
        }),
      ]),
    );
    const authErr = errors.find((e) => e.code === 'MISSING_AUTH');
    expect(authErr).toBeDefined();
    expect(authErr!.message).toContain('github-sync');
  });

  it.each([
    ['secret_env missing entirely', { type: 'hmac' }],
    ['secret_env an empty string', { type: 'hmac', secret_env: '' }],
    ['secret_env whitespace-only', { type: 'hmac', secret_env: '   ' }],
    ['secret_env not a string', { type: 'hmac', secret_env: 42 }],
  ])(
    'rejects a webhook hmac auth with %s — boot must fail loud, not fail-close at runtime',
    (_label, auth) => {
      const errors = expectValidationErrors(
        validateIngressBindings([
          decl('github-sync', {
            type: 'webhook',
            route: '/hooks/gh',
            auth,
            event_id: { from: 'header', name: 'X-Id' },
          }),
        ]),
      );
      const secretErr = errors.find((e) => e.code === 'MISSING_AUTH_SECRET');
      expect(secretErr).toBeDefined();
      expect(secretErr!.message).toContain('github-sync');
    },
  );

  it('exempts slack signing auth from the per-binding secret_env requirement (uses app-global signing secret)', () => {
    const result = validateIngressBindings([
      decl('slack-intake', {
        type: 'slack',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('detects a webhook route collision between two active flows and names both (FR-9)', () => {
    const errors = expectValidationErrors(
      validateIngressBindings([
        decl('flow-alpha', {
          type: 'webhook',
          route: '/hooks/shared',
          auth: { type: 'hmac', secret_env: 'ALPHA_SECRET' },
          event_id: { from: 'content_hash' },
        }),
        decl('flow-beta', {
          type: 'webhook',
          route: '/hooks/shared',
          auth: { type: 'hmac', secret_env: 'BETA_SECRET' },
          event_id: { from: 'content_hash' },
        }),
      ]),
    );
    const collision = errors.find((e) => e.code === 'ROUTE_COLLISION');
    expect(collision).toBeDefined();
    expect(collision!.message).toContain('flow-alpha');
    expect(collision!.message).toContain('flow-beta');
  });

  it('does NOT flag a collision when active flows declare distinct routes', () => {
    const result = validateIngressBindings([
      decl('flow-alpha', {
        type: 'webhook',
        route: '/hooks/alpha',
        auth: { type: 'hmac', secret_env: 'ALPHA_SECRET' },
        event_id: { from: 'content_hash' },
      }),
      decl('flow-beta', {
        type: 'webhook',
        route: '/hooks/beta',
        auth: { type: 'hmac', secret_env: 'BETA_SECRET' },
        event_id: { from: 'content_hash' },
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('does NOT treat route-less bindings (two cli flows) as colliding', () => {
    const result = validateIngressBindings([
      decl('cli-a', { type: 'cli', event_id: { from: 'content_hash' } }),
      decl('cli-b', { type: 'cli', event_id: { from: 'content_hash' } }),
    ]);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Slack transport: 'events' (default, webhook) vs 'socket' (Socket Mode, Socket Mode work)
// ===========================================================================

const validSocketRaw = {
  type: 'slack',
  transport: 'socket',
  app_token_env: 'SLACK_APP_TOKEN',
  event_id: { from: 'json_path', path: '$.event_id' },
};

describe('slack transport parsing (the original Slack Socket Mode work)', () => {
  it('parses a socket-transport slack binding with its app_token_env', () => {
    const binding = expectParsed(parseIngressBinding(validSocketRaw));
    expect(binding.type).toBe('slack');
    expect(binding.transport).toBe('socket');
    expect(binding.app_token_env).toBe('SLACK_APP_TOKEN');
  });

  it('parses an explicit events transport on a slack binding', () => {
    const binding = expectParsed(
      parseIngressBinding({
        type: 'slack',
        transport: 'events',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
      }),
    );
    expect(binding.transport).toBe('events');
  });

  it('leaves transport undefined when not declared (treated as events downstream)', () => {
    const binding = expectParsed(
      parseIngressBinding({
        type: 'slack',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
      }),
    );
    expect(binding.transport).toBeUndefined();
  });

  it('rejects an unknown transport value with INVALID_TRANSPORT', () => {
    const error = expectParseError(
      parseIngressBinding({ ...validSocketRaw, transport: 'carrier-pigeon' }),
    );
    expect(error.code).toBe('INVALID_TRANSPORT');
  });

  it.each([
    ['webhook', { type: 'webhook', route: '/x', auth: { type: 'hmac', secret_env: 'S' } }],
    ['cli', { type: 'cli' }],
  ])('rejects transport declared on a non-slack binding (%s)', (_label, base) => {
    const error = expectParseError(
      parseIngressBinding({ ...base, transport: 'socket', event_id: { from: 'content_hash' } }),
    );
    expect(error.code).toBe('INVALID_TRANSPORT');
  });

  it('rejects app_token_env on an events-transport slack binding (mixed shape)', () => {
    const error = expectParseError(
      parseIngressBinding({
        type: 'slack',
        transport: 'events',
        app_token_env: 'SLACK_APP_TOKEN',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
      }),
    );
    expect(error.code).toBe('INVALID_TRANSPORT');
  });

  it('rejects app_token_env on a default-transport (events) slack binding', () => {
    const error = expectParseError(
      parseIngressBinding({
        type: 'slack',
        app_token_env: 'SLACK_APP_TOKEN',
        auth: { type: 'signing' },
        event_id: { from: 'json_path', path: '$.event_id' },
      }),
    );
    expect(error.code).toBe('INVALID_TRANSPORT');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace-only', '   '],
    ['a non-string', 42],
  ])('rejects a malformed app_token_env (%s) with MISSING_APP_TOKEN', (_label, value) => {
    const error = expectParseError(
      parseIngressBinding({ ...validSocketRaw, app_token_env: value }),
    );
    expect(error.code).toBe('MISSING_APP_TOKEN');
  });
});

describe('slack transport boot validation (the original Slack Socket Mode work)', () => {
  it('accepts a socket binding without auth — the wss connection is the auth', () => {
    const result = validateIngressBindings([decl('studio', validSocketRaw)]);
    expect(result.ok).toBe(true);
  });

  it('rejects a socket binding missing app_token_env, naming the offending flow', () => {
    const errors = expectValidationErrors(
      validateIngressBindings([
        decl('studio', {
          type: 'slack',
          transport: 'socket',
          event_id: { from: 'json_path', path: '$.event_id' },
        }),
      ]),
    );
    const tokenErr = errors.find((e) => e.code === 'MISSING_APP_TOKEN');
    expect(tokenErr).toBeDefined();
    expect(tokenErr!.message).toContain('studio');
  });

  it('does NOT require auth on socket transport but still requires it on events transport', () => {
    const errors = expectValidationErrors(
      validateIngressBindings([
        decl('socket-flow', validSocketRaw),
        decl('events-flow', {
          type: 'slack',
          transport: 'events',
          event_id: { from: 'json_path', path: '$.event_id' },
        }),
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('MISSING_AUTH');
    expect(errors[0]!.message).toContain('events-flow');
  });
});
