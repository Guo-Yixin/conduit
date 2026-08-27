/**
 * WI-411 — Export the secret-filter (filterAttributes / isSensitiveKey) from db.ts.
 *
 * These functions are currently module-private in src/persistence/db.ts. Four
 * downstream Wave-0 ingress items (WI-403 envelope, WI-404 ingress_log,
 * WI-408 webhook adapter, WI-409 slack adapter) need to import the single
 * canonical secret-filter instead of reimplementing the regex (NFR-5 secret
 * hygiene). This suite pins the export contract and proves the internal callers
 * inside db.ts (appendJournalSpan, appendCardLog) keep filtering identically
 * after the `export` keyword is added — the bodies/signatures must not change.
 *
 * RED state before WI-411: `filterAttributes` and `isSensitiveKey` are not
 * exported, so the named imports below resolve to `undefined` and every direct
 * call throws "is not a function".
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openConduitDB,
  filterAttributes,
  isSensitiveKey,
  DEFAULT_RUN_ID,
  type ConduitDB,
} from './db';

// ---------------------------------------------------------------------------
// AC2 — isSensitiveKey is exported and classifies key NAMES (not values).
//       Returns true for a known-sensitive name, false for an ordinary one.
// ---------------------------------------------------------------------------
describe('isSensitiveKey (exported)', () => {
  it.each([
    ['authorization', 'authorization'],
    ['vendor-prefixed *_token', 'gh_token'],
    ['openai_api_key', 'openai_api_key'],
    ['x-api-key header', 'x-api-key'],
    ['aws_secret_access_key', 'aws_secret_access_key'],
    ['db_password', 'db_password'],
    ['client_secret', 'client_secret'],
    ['bare bearer', 'bearer'],
  ])('returns true for a known-sensitive key name (%s)', (_label, key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    ['model', 'model'],
    ['temperature', 'temperature'],
    ['otel-style request model', 'gen_ai.request.model'],
    ['station', 'station'],
  ])('returns false for an ordinary key name (%s)', (_label, key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC1 — filterAttributes is exported and, given an object containing a
//       sensitive key, returns a COPY with that key's subtree dropped.
// ---------------------------------------------------------------------------
describe('filterAttributes (exported)', () => {
  it('drops the authorization key (and its subtree) while keeping safe keys', () => {
    const result = filterAttributes({
      authorization: { token: 'Bearer super-secret', scheme: 'bearer' },
      model: 'gpt-4',
    });

    expect('authorization' in result).toBe(false);
    expect(result).toEqual({ model: 'gpt-4' });
  });

  it('drops a vendor-prefixed *_token key', () => {
    const result = filterAttributes({
      gh_token: 'ghp_live_credential',
      station: 'briefer',
    });

    expect('gh_token' in result).toBe(false);
    expect(result.station).toBe('briefer');
  });

  it('returns a new copy and does not mutate the input object', () => {
    const input = { api_key: 'sk-live-123', model: 'gpt-4' };
    const result = filterAttributes(input);

    // Original is untouched — the sensitive value still lives in the caller's object.
    expect(input).toEqual({ api_key: 'sk-live-123', model: 'gpt-4' });
    // The returned value is a distinct object with the secret removed.
    expect(result).not.toBe(input);
    expect(result).toEqual({ model: 'gpt-4' });
  });
});

// ---------------------------------------------------------------------------
// AC3 — Internal callers inside db.ts (appendJournalSpan) keep behaving
//       identically after the export. Adding `export` must not change the
//       function body, so a span with sensitive attributes still has those
//       keys filtered out before it is persisted to the journal.
//
//       This exercises the REAL ConduitDB against a real on-disk SQLite file
//       (mirroring db.test.ts) — only the filesystem is "mocked" via tmpdir.
// ---------------------------------------------------------------------------
describe('internal callers still filter secrets (appendJournalSpan)', () => {
  let dir: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-secret-filter-'));
    db = openConduitDB({
      stateDbPath: join(dir, 'state.sqlite'),
      journalDbPath: join(dir, 'journal.sqlite'),
    });
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a journal span with sensitive attributes filtered out', () => {
    db!.appendJournalSpan({
      runId: DEFAULT_RUN_ID,
      cardId: 'card-1',
      station: 'briefer',
      attempt: 0,
      name: 'llm.call',
      attributes: {
        authorization: 'Bearer sk-live-xyz',
        headers: { 'x-api-key': 'leak-me', 'content-type': 'application/json' },
        'gen_ai.request.model': 'gpt-4',
      },
    });

    const spans = db!.getJournalSpans('card-1');
    expect(spans).toHaveLength(1);

    const attrs = spans[0].attributes;
    // Sensitive top-level and nested keys are absent from what was stored.
    expect('authorization' in attrs).toBe(false);
    expect(attrs).toEqual({
      headers: { 'content-type': 'application/json' },
      'gen_ai.request.model': 'gpt-4',
    });
  });
});
