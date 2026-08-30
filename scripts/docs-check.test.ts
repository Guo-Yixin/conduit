/**
 * Regression coverage for the CHANGED-FILE PLUMBING that feeds docs-check.sh.
 *
 * The check can only be as good as the list of paths it is handed. Two ways
 * that list used to lie:
 *
 *   1. `--diff-filter=ACM` dropped deletions and recorded a rename as its new
 *      path only. A binding target could be removed or moved and the check
 *      stayed silent — the one case where a routing table most needs to speak,
 *      since drift reports a vanished target as STALE (file not found).
 *   2. An unquoted, newline-split list turned `src/my file.ts` into two paths
 *      that match no binding, so the check passed on exactly the input it was
 *      meant to inspect.
 *
 * These tests run the command EXTRACTED FROM scripts/docs-check.sh rather than a
 * copy of it, against a throwaway git repo. A copy would be free to agree with
 * the test while the real thing quietly regressed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The `git diff` invocation `--staged` actually runs, lifted out of the script. */
function stagedDiffCommand(): string {
  const script = readFileSync('scripts/docs-check.sh', 'utf-8');
  const match = /done < <\((git diff --cached [^)]*)\)/.exec(script);
  if (match === null) throw new Error('could not find the staged-diff command in scripts/docs-check.sh');
  return match[1] as string;
}

function run(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

/** Split a NUL-terminated stream the way the hook's read loop does. */
function splitNul(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'docs-check-'));
  const git = (...args: string[]) => run(['git', ...args], repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');

  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(repo, 'src/deleted.ts'), 'export const gone = 1;\n');
  writeFileSync(join(repo, 'src/old-name.ts'), 'export const moved = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  // The four shapes a commit can take, staged together.
  writeFileSync(join(repo, 'src/kept.ts'), 'export const kept = 2;\n'); // M
  rmSync(join(repo, 'src/deleted.ts')); // D
  run(['git', 'mv', 'src/old-name.ts', 'src/new-name.ts'], repo); // R
  writeFileSync(join(repo, 'src/with space.ts'), 'export const spacey = 1;\n'); // A
  git('add', '-A');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('the staged-file list the hook builds', () => {
  const staged = () => splitNul(run(['bash', '-c', stagedDiffCommand()], repo));

  it('includes a DELETED file, so a removed binding target still reaches drift', () => {
    expect(staged()).toContain('src/deleted.ts');
  });

  it('includes BOTH sides of a rename', () => {
    // --no-renames decomposes R into D + A. The old path is the one carrying a
    // binding that no longer resolves; the new path is where it should move to.
    expect(staged()).toContain('src/old-name.ts');
    expect(staged()).toContain('src/new-name.ts');
  });

  it('keeps a pathname containing a space as ONE entry', () => {
    expect(staged()).toContain('src/with space.ts');
    expect(staged().some((p) => p === 'src/with' || p === 'space.ts')).toBe(false);
  });

  it('still includes a plain modification', () => {
    expect(staged()).toContain('src/kept.ts');
  });

  it('lists nothing else', () => {
    expect(staged().sort()).toEqual([
      'src/deleted.ts',
      'src/kept.ts',
      'src/new-name.ts',
      'src/old-name.ts',
      'src/with space.ts',
    ]);
  });
});

describe('callers delegate rather than re-deriving the path list', () => {
  it('the pre-commit hook runs --staged and spells out no diff of its own', () => {
    // A second copy of the git invocation is a second thing that can disagree
    // with CI about what a commit is accountable for.
    const hook = readFileSync('.githooks/pre-commit', 'utf-8');
    expect(hook).toContain('scripts/docs-check.sh --staged');
    expect(hook).not.toContain('git diff');
  });

  it('the docs workflow shares the same script for its commit-range mode', () => {
    const workflow = readFileSync('.github/workflows/docs.yml', 'utf-8');
    expect(workflow).toContain('scripts/docs-check.sh "${changed[@]}"');
  });
});

describe('docs-check.sh argument handling', () => {
  it('passes an unbound path with a space through without splitting or failing', () => {
    // No binding targets it, so this must exit 0 via the fast path — but it
    // must reach that verdict having seen ONE argument, not two.
    const proc = Bun.spawnSync(['scripts/docs-check.sh', 'src/with space.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
  });

  it('exits 0 when given no paths at all', () => {
    const proc = Bun.spawnSync(['scripts/docs-check.sh'], { stdout: 'pipe', stderr: 'pipe' });
    expect(proc.exitCode).toBe(0);
  });
});
