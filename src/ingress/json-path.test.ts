/**
 * Tests for the shared '$.'-rooted JSON-path resolver (The original JSON-path array-projection work).
 *
 * The resolver backs BOTH user-facing path dialects in a binding — the
 * `substrate:` projection (envelope.ts) and `event_id: { from: json_path }`
 * (event-id.ts) — so its contract is pinned once here:
 *
 *  - dot-segments address object keys;
 *  - when the current node is an ARRAY, a canonical non-negative integer
 *    segment (`0`, `1`, `12` — no leading zeros, no sign) indexes into it;
 *  - any unresolvable path returns null (never undefined, never throws).
 */
import { describe, it, expect } from 'bun:test';
import { resolveJsonPath } from './json-path';

// Slack file_share shape — the motivating real-world case from The original JSON-path array-projection work.
const slackBody = {
  event: {
    ts: '1720000000.000100',
    files: [
      { id: 'F111', url_private_download: 'https://files.slack.com/F111', mimetype: 'image/png' },
      { id: 'F222', url_private_download: 'https://files.slack.com/F222', mimetype: 'image/jpeg' },
    ],
  },
};

describe('resolveJsonPath — array indexing (The original JSON-path array-projection work)', () => {
  it('indexes into an array with a numeric segment', () => {
    expect(resolveJsonPath(slackBody, '$.event.files.0.url_private_download')).toBe(
      'https://files.slack.com/F111',
    );
    expect(resolveJsonPath(slackBody, '$.event.files.1.id')).toBe('F222');
  });

  it('resolves a leaf that IS an array element (no trailing object walk)', () => {
    expect(resolveJsonPath({ commits: ['abc', 'def'] }, '$.commits.1')).toBe('def');
  });

  it('resolves nested arrays (GitHub commits[].added[] shape)', () => {
    const body = { commits: [{ added: ['src/a.ts', 'src/b.ts'] }] };
    expect(resolveJsonPath(body, '$.commits.0.added.1')).toBe('src/b.ts');
  });

  it('yields null for an out-of-range index (present-with-null contract)', () => {
    expect(resolveJsonPath(slackBody, '$.event.files.2.id')).toBeNull();
  });

  it('yields null when indexing into an empty array', () => {
    expect(resolveJsonPath({ files: [] }, '$.files.0')).toBeNull();
  });

  it('yields null for a non-numeric segment on an array', () => {
    expect(resolveJsonPath(slackBody, '$.event.files.id')).toBeNull();
    // Array own-properties must not be reachable as path segments.
    expect(resolveJsonPath(slackBody, '$.event.files.length')).toBeNull();
  });

  it('yields null for non-canonical index segments (leading zero, sign, float)', () => {
    expect(resolveJsonPath(slackBody, '$.event.files.01.id')).toBeNull();
    expect(resolveJsonPath(slackBody, '$.event.files.-1.id')).toBeNull();
    expect(resolveJsonPath(slackBody, '$.event.files.1.5')).toBeNull();
  });

  it('still resolves numeric STRING keys on plain objects', () => {
    expect(resolveJsonPath({ '0': 'zero' }, '$.0')).toBe('zero');
  });
});

describe('resolveJsonPath — pre-existing contract', () => {
  it('resolves plain object dot-paths', () => {
    expect(resolveJsonPath({ a: { b: 42 } }, '$.a.b')).toBe(42);
  });

  it.each([
    ['not $.-rooted', 'a.b'],
    ['missing leaf', '$.a.nope'],
    ['missing intermediate', '$.nope.b'],
    ['walks into a primitive', '$.a.b.c'],
    ['empty segment (double dot)', '$.a..b'],
    ['bare root with empty segment', '$.'],
  ])('yields null when the path is unresolvable (%s)', (_label, path) => {
    expect(resolveJsonPath({ a: { b: 42 } }, path)).toBeNull();
  });

  it('normalizes an undefined leaf to null', () => {
    expect(resolveJsonPath({ a: undefined }, '$.a')).toBeNull();
  });

  it('is deterministic for identical input', () => {
    const first = resolveJsonPath(slackBody, '$.event.files.0');
    const second = resolveJsonPath(slackBody, '$.event.files.0');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
