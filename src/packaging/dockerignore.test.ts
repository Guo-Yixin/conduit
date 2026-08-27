/**
 * Tests for the repo-root .dockerignore (WI-436).
 *
 * The .dockerignore enforces secrets discipline at the Docker build-context
 * boundary: .env, the local conduit.sqlite* state files, node_modules, and the
 * .git directory must never be copied into an image layer (FR-5 — secrets are
 * runtime-injected only). The WI-435 engine Dockerfile COPYs the source tree,
 * so a build-essential file like package.json MUST remain in the context.
 *
 * These tests do NOT regex-match source code — .dockerignore is a config-data
 * file consumed by `docker build`. We parse it and assert on its EFFECTIVE
 * ignore decision for each sensitive path, using docker's documented semantics
 * (last matching line wins; a leading `!` re-includes). That makes the suite
 * behavioral: it fails if a required exclusion is missing OR if a stray `!`
 * pattern re-includes a secret — not merely if a literal string is absent.
 *
 * The .env exclusion is the critical security gate: its test must fail if the
 * exclusion ever regresses.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const DOCKERIGNORE_PATH = join(import.meta.dir, '..', '..', '.dockerignore');

/** Parse .dockerignore into its significant lines (drop blanks and comments). */
function readPatternLines(): string[] {
  const content = readFileSync(DOCKERIGNORE_PATH, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Normalize a single .dockerignore pattern (with any leading `!` already
 * stripped by the caller) into a form Bun.Glob can match against a repo-root
 * path: drop a leading context-root slash, a leading recursive-glob prefix
 * (two stars then a slash), and a trailing directory slash.
 */
function normalizePattern(pattern: string): string {
  let p = pattern;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.startsWith('**/')) p = p.slice(3);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Resolve the effective ignore decision for `path` under docker's rules:
 * evaluate every pattern in order; the LAST one that matches wins, and a
 * `!`-prefixed pattern re-includes (un-ignores) the path.
 */
function isIgnored(path: string, lines: string[] = readPatternLines()): boolean {
  let ignored = false;
  for (const line of lines) {
    const negate = line.startsWith('!');
    const pattern = normalizePattern(negate ? line.slice(1) : line);
    if (pattern.length === 0) continue;
    if (new Bun.Glob(pattern).match(path)) {
      ignored = !negate;
    }
  }
  return ignored;
}

describe('.dockerignore — build-context exclusions (WI-436)', () => {
  it('exists at the repo root and declares at least one pattern', () => {
    expect(existsSync(DOCKERIGNORE_PATH)).toBe(true);
    expect(readPatternLines().length).toBeGreaterThan(0);
  });

  // ── CRITICAL SECURITY GATE ────────────────────────────────────────────────
  // A regression that drops the .env exclusion (or re-includes it via `!.env`)
  // would leak the secret into an image layer. This must fail loudly.
  it('excludes .env from the build context (critical secrets gate)', () => {
    expect(isIgnored('.env')).toBe(true);
  });

  it.each([
    'conduit.sqlite',
    'conduit.sqlite-shm',
    'conduit.sqlite-wal',
    'conduit.journal.sqlite',
  ])('excludes local sqlite state file %s', (file) => {
    expect(isIgnored(file)).toBe(true);
  });

  it('excludes the node_modules directory', () => {
    expect(isIgnored('node_modules')).toBe(true);
  });

  it('excludes the .git directory', () => {
    expect(isIgnored('.git')).toBe(true);
  });

  // ── Discrimination / over-broad-pattern guard ─────────────────────────────
  // Proves the ignore check is not a tautology and that the patterns are not so
  // broad (e.g. a stray `*`) that they would strip the source tree the WI-435
  // Dockerfile must COPY. package.json must survive into the build context.
  it('does NOT exclude build-essential files like package.json', () => {
    expect(isIgnored('package.json')).toBe(false);
  });
});
