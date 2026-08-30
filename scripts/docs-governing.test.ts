/**
 * Tests for the drift reverse-lookup used by the pre-edit docs routing.
 *
 * NOT part of the required `tests` gate: `bun run test` is deliberately scoped
 * to `src/` (see .github/workflows/test.yml). The advisory Docs workflow runs
 * this file explicitly instead, so tooling coverage never widens the gate that
 * blocks merges.
 */
import { describe, it, expect } from 'bun:test';
import { parseBindings, targetGoverns, docsGoverning, governedFiles, parseInvocation } from './docs-governing';

const LOCK = `
version = 1

[[bindings]]
doc = "SPEC.md"
target = "src/quality/rework.ts#decideQcReject"
sig = "a93aaf0bb50316a3"

[[bindings]]
doc = "SPEC.md"
target = "src/law/contract.ts"
sig = "fd885d49d7e797aa"

[[bindings]]
doc = "CLAUDE.md"
target = "src/controller/executor.ts#runExecutor"
sig = "601686c1f9de5806"
origin = "github:fiberplane/drift"
`;

describe('parseBindings', () => {
  it('reads every binding table with its doc and target', () => {
    expect(parseBindings(LOCK)).toEqual([
      { doc: 'SPEC.md', target: 'src/quality/rework.ts#decideQcReject' },
      { doc: 'SPEC.md', target: 'src/law/contract.ts' },
      { doc: 'CLAUDE.md', target: 'src/controller/executor.ts#runExecutor' },
    ]);
  });

  it('keeps the final binding (no trailing [[bindings]] to flush it)', () => {
    expect(parseBindings(LOCK).at(-1)?.doc).toBe('CLAUDE.md');
  });

  it('tolerates extra keys like origin without mistaking them for fields', () => {
    expect(parseBindings(LOCK).every((b) => b.target.startsWith('src/'))).toBe(true);
  });

  it('returns nothing for a lockfile with no bindings', () => {
    expect(parseBindings('version = 1\n')).toEqual([]);
  });
});

describe('targetGoverns', () => {
  it('matches an exact file target', () => {
    expect(targetGoverns('src/law/contract.ts', 'src/law/contract.ts')).toBe(true);
  });

  it('matches a symbol target back to its file — the case drift refs misses', () => {
    expect(targetGoverns('src/quality/rework.ts#decideQcReject', 'src/quality/rework.ts')).toBe(true);
  });

  it('does not match a different file that merely shares a prefix', () => {
    // Without the '#' guard, a bare startsWith would match this.
    expect(targetGoverns('src/law/contract.ts.bak', 'src/law/contract.ts')).toBe(false);
    expect(targetGoverns('src/law/contract.test.ts', 'src/law/contract.ts')).toBe(false);
  });

  it('does not match an unrelated file', () => {
    expect(targetGoverns('src/quality/rework.ts#decideQcReject', 'src/quality/rank.ts')).toBe(false);
  });
});

describe('docsGoverning', () => {
  const bindings = parseBindings(LOCK);

  it('resolves a symbol-anchored file to its governing doc', () => {
    expect(docsGoverning(bindings, ['src/quality/rework.ts'])).toEqual(['SPEC.md']);
  });

  it('dedupes when one doc governs several of the changed files', () => {
    expect(docsGoverning(bindings, ['src/quality/rework.ts', 'src/law/contract.ts'])).toEqual(['SPEC.md']);
  });

  it('returns every distinct governing doc, sorted', () => {
    const docs = docsGoverning(bindings, ['src/quality/rework.ts', 'src/controller/executor.ts']);
    expect(docs).toEqual(['CLAUDE.md', 'SPEC.md']);
  });

  it('is silent for an unbound file — the common case must cost nothing', () => {
    expect(docsGoverning(bindings, ['src/ingress/event-id.ts'])).toEqual([]);
  });

  it('is silent for no files at all', () => {
    expect(docsGoverning(bindings, [])).toEqual([]);
  });
});

describe('governedFiles', () => {
  const bindings = parseBindings(LOCK);

  it('returns only the inputs some binding targets', () => {
    expect(
      governedFiles(bindings, ['src/quality/rework.ts', 'src/ingress/event-id.ts', 'src/law/contract.ts']),
    ).toEqual(['src/quality/rework.ts', 'src/law/contract.ts']);
  });

  it('preserves input order rather than lockfile order', () => {
    expect(governedFiles(bindings, ['src/law/contract.ts', 'src/quality/rework.ts'])).toEqual([
      'src/law/contract.ts',
      'src/quality/rework.ts',
    ]);
  });

  it('is empty when nothing changed is bound — the fast path docs-check.sh takes', () => {
    expect(governedFiles(bindings, ['src/ingress/event-id.ts', 'README.md'])).toEqual([]);
  });

  it('does not report a file that merely shares a prefix with a target', () => {
    expect(governedFiles(bindings, ['src/law/contract.test.ts'])).toEqual([]);
  });
});

describe('parseInvocation', () => {
  it('reads flags in either order', () => {
    expect(parseInvocation(['--files', '--print0', 'a.ts'])).toEqual({
      wantFiles: true,
      print0: true,
      files: ['a.ts'],
    });
    expect(parseInvocation(['--print0', '--files', 'a.ts'])).toEqual({
      wantFiles: true,
      print0: true,
      files: ['a.ts'],
    });
  });

  it('defaults to doc output with newline framing', () => {
    expect(parseInvocation(['a.ts'])).toEqual({ wantFiles: false, print0: false, files: ['a.ts'] });
  });

  it('stops parsing flags at `--`, so a path may look like one', () => {
    // docs-check.sh always passes `--` for this reason: a repo is free to
    // contain a file named `--files`, and git will hand it over verbatim.
    expect(parseInvocation(['--files', '--', '--print0']).files).toEqual(['--print0']);
    expect(parseInvocation(['--files', '--', '--print0']).print0).toBe(false);
  });

  it('keeps a leading-dash pathname intact after `--`', () => {
    expect(parseInvocation(['--', '-weird-name.ts'])).toEqual({
      wantFiles: false,
      print0: false,
      files: ['-weird-name.ts'],
    });
  });

  it('treats the first non-flag as the start of the paths', () => {
    expect(parseInvocation(['a.ts', '--files']).files).toEqual(['a.ts', '--files']);
  });
});

describe('lookup is lockfile-driven, not filesystem-driven', () => {
  const bindings = parseBindings(LOCK);

  it('still resolves a DELETED target — the case --diff-filter=ACM used to drop', () => {
    // Nothing here stats the path. That is what lets the hook pass deleted and
    // renamed paths through: drift reports a vanished binding target as
    // STALE (file not found), which is exactly the flag we want.
    expect(governedFiles(bindings, ['src/law/contract.ts'])).toEqual(['src/law/contract.ts']);
    expect(docsGoverning(bindings, ['src/law/contract.ts'])).toEqual(['SPEC.md']);
  });

  it('reports both sides of a rename when both are passed', () => {
    // --no-renames decomposes a rename into delete + add, so the old path
    // (bound, now missing) and the new path both reach the checker.
    expect(docsGoverning(bindings, ['src/law/contract.ts', 'src/law/contract-v2.ts'])).toEqual(['SPEC.md']);
  });
});
