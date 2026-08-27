/**
 * WI-475 — Run id validation and stable default.
 *
 * `validateRunId` accepts a caller-supplied run id only if it is within a safe,
 * bounded charset ([A-Za-z0-9_-], length 1..=128) and fails CLOSED (throws) on
 * anything else — path separators, whitespace, SQL metacharacters, control
 * characters, empty, or over-length. `defaultRunId` supplies one stable constant
 * id for back-compat single-run usage, and that default is itself a legal id.
 *
 * Pure string logic, no DB. Mirrors the fail-closed discipline pinned in
 * src/cli/main-sql-injection.test.ts.
 */
import { describe, it, expect } from 'bun:test';
import { validateRunId, defaultRunId } from './run-id';

describe('validateRunId — valid ids', () => {
  it('returns the normalized id for a valid mixed id (alphanumerics, dash, underscore)', () => {
    expect(validateRunId('job-123_AB')).toBe('job-123_AB');
  });

  it.each([
    ['all lowercase letters', 'abcdef'],
    ['all uppercase letters', 'ABCDEF'],
    ['digits only', '1234567890'],
    ['single character', 'a'],
    ['dashes and underscores mixed', 'a-b_c-d_e'],
    ['leading and trailing underscore', '_run_'],
    ['leading and trailing dash', '-run-'],
  ])('accepts and returns %s unchanged', (_label, id) => {
    expect(validateRunId(id)).toBe(id);
  });

  it('accepts an id at exactly the maximum length bound (128)', () => {
    const atBound = 'a'.repeat(128);
    expect(validateRunId(atBound)).toBe(atBound);
  });
});

describe('validateRunId — fails closed on unsafe input', () => {
  it.each([
    ['parent path traversal', '../x'],
    ['forward slash separator', 'a/b'],
    ['backslash separator', 'a\\b'],
    ['leading slash absolute path', '/etc/passwd'],
    ['single space', 'a b'],
    ['leading whitespace', ' run'],
    ['trailing whitespace', 'run '],
    ['tab whitespace', 'a\tb'],
    ['newline whitespace', 'a\nb'],
    ['single quote (SQL metachar)', "a'b"],
    ['double quote', 'a"b'],
    ['semicolon (SQL statement terminator)', 'a;b'],
    ['SQL injection payload', "x'); DROP TABLE runs;--"],
    ['percent wildcard', 'a%b'],
    ['null byte control char', 'a\x00b'],
    ['bell control char', 'a\x07b'],
    ['DEL control char', 'a\x7fb'],
    ['dot segment', '.'],
    ['unicode letter outside ASCII', 'café'],
    ['at sign', 'a@b'],
    ['dollar sign', 'a$b'],
  ])('throws for %s', (_label, id) => {
    expect(() => validateRunId(id)).toThrow();
  });
});

describe('validateRunId — length and emptiness bounds', () => {
  it('throws for an empty string', () => {
    expect(() => validateRunId('')).toThrow();
  });

  it('throws for an id exceeding the maximum length bound (129)', () => {
    const overBound = 'a'.repeat(129);
    expect(() => validateRunId(overBound)).toThrow();
  });
});

describe('defaultRunId — stable back-compat constant', () => {
  it('returns the same value on every call', () => {
    const first = defaultRunId();
    const second = defaultRunId();
    const third = defaultRunId();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('returns a non-empty string', () => {
    expect(defaultRunId().length).toBeGreaterThan(0);
  });

  it('produces a default that is itself a legal id (round-trips through validateRunId)', () => {
    const def = defaultRunId();
    expect(validateRunId(def)).toBe(def);
  });
});
