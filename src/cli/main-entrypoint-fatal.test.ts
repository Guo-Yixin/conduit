/**
 * Real-entrypoint boot-failure formatting (Amy FLAG on WI-594's harness work).
 *
 * buildProductionDeps() / buildReadOnlyProductionDeps() parse CONDUIT_HARNESS_*
 * and THROW SYNCHRONOUSLY on a malformed config. In the real binary those
 * builders are called in the `if (import.meta.main)` block, and were originally
 * OUTSIDE the `.catch()` that formats main()'s async errors — so a boot-failure
 * throw escaped as a raw uncaught Bun exception (internal stack trace, no clean
 * message). The fix wraps deps construction in a try/catch that writes a single
 * `fatal: <message>` line to stderr and exits 1 (deps.io does not exist yet).
 *
 * This test MUST drive the REAL entrypoint as an actual subprocess — the same
 * lesson as WI-588: calling buildProductionDeps()/main() in-process MASKS this
 * bug because `if (import.meta.main)` is false when the module is imported by
 * the test runner, so the entrypoint's try/catch never executes. We spawn
 * `bun src/cli/main.ts doctor` (doctor routes through buildProductionDeps) with
 * a malformed CONDUIT_HARNESS_* env and assert on the real process output.
 *
 * Covers all three boot-failure classes (mirrors the manual verification):
 * unshipped adapter name, missing required _ENV allowlist var, and a derived
 * env-prefix collision.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';

const MAIN_TS = join(import.meta.dir, 'main.ts');

function runDoctor(harnessEnv: Record<string, string>): { exitCode: number | null; stderr: string; stdout: string } {
  const proc = Bun.spawnSync([process.execPath, MAIN_TS, 'doctor'], {
    env: {
      ...process.env,
      CONDUIT_STATE_DB: ':memory:',
      CONDUIT_JOURNAL_DB: ':memory:',
      CONDUIT_API_KEY: 'x',
      CONDUIT_BASE_URL: 'x',
      // Clear any CONDUIT_HARNESS_* the harness inherited, so each case is clean.
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((k) => k.startsWith('CONDUIT_HARNESS_'))
          .map((k) => [k, undefined as unknown as string]),
      ),
      ...harnessEnv,
    },
  });
  return {
    exitCode: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
    stdout: new TextDecoder().decode(proc.stdout),
  };
}

/** A clean single `fatal:` line — never a raw Bun crash dump / stack trace. */
function expectCleanFatal(stderr: string): void {
  // A single line, starting with the `fatal: ` prefix.
  expect(stderr.trim().startsWith('fatal: ')).toBe(true);
  // No raw uncaught-exception markers: Bun's crash banner ('Bun v...') or ANY
  // stack frame ('at <fn> (<file>)'). None of the fatal messages contain 'at '.
  expect(stderr).not.toContain('Bun v');
  expect(stderr).not.toContain('at ');
  // One fatal: line (plus at most a trailing newline) — not a multi-line dump.
  expect(stderr.trim().split('\n').length).toBeLessThanOrEqual(2);
}

describe('real entrypoint: a DB-open failure names the path, env var, and a bare-metal hint (a pre-public engine review finding 4a)', () => {
  it('an uncreatable CONDUIT_STATE_DB path exits 1 with a clean fatal: line naming the path and env var', () => {
    const { exitCode, stderr } = runDoctor({
      CONDUIT_STATE_DB: '/nonexistent-dir-xyz/state.sqlite',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('/nonexistent-dir-xyz/state.sqlite');
    expect(stderr).toContain('CONDUIT_STATE_DB');
    expectCleanFatal(stderr);
  });

  it('an uncreatable CONDUIT_JOURNAL_DB path exits 1 with a clean fatal: line naming the path and env var', () => {
    const { exitCode, stderr } = runDoctor({
      CONDUIT_JOURNAL_DB: '/nonexistent-dir-xyz/journal.sqlite',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('/nonexistent-dir-xyz/journal.sqlite');
    expect(stderr).toContain('CONDUIT_JOURNAL_DB');
    expectCleanFatal(stderr);
  });
});

describe('real entrypoint: a CONDUIT_HARNESS_* boot-failure is fatal:-formatted, never a raw crash', () => {
  it('an unshipped adapter name exits 1 with a clean fatal: line', () => {
    const { exitCode, stderr } = runDoctor({
      CONDUIT_HARNESS_ADAPTERS: 'mystery-adapter',
      CONDUIT_HARNESS_MYSTERY_ADAPTER_ENV: 'HOME',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('fatal: harness registry: "mystery-adapter" is not an adapter this engine ships');
    expectCleanFatal(stderr);
  });

  it('a missing required _ENV allowlist var exits 1 with a clean fatal: line', () => {
    const { exitCode, stderr } = runDoctor({
      CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
      // no CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'fatal: harness config: adapter "claude-headless" is missing required env allowlist var CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV',
    );
    expectCleanFatal(stderr);
  });

  it('a derived env-prefix collision exits 1 with a clean fatal: line naming both adapters', () => {
    const { exitCode, stderr } = runDoctor({
      CONDUIT_HARNESS_ADAPTERS: 'claude-headless,claude_headless',
      CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('fatal: harness config: adapter names collide on the same derived env prefix');
    expect(stderr).toContain('claude-headless');
    expect(stderr).toContain('claude_headless');
    expectCleanFatal(stderr);
  });
});
