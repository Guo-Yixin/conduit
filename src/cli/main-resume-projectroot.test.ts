/**
 * conduit resume — project-root override warning + recorded-root re-anchoring
 * (WI-593).
 *
 * `conduit resume` already prefers a run's RECORDED project_root:
 *   resumeProjectRoot = projectRootOverride ?? recordedRun.project_root ?? default
 * This item adds ONE thing: when an explicit --project-root override DIFFERS
 * from the recorded root, resume must warn on stderr naming BOTH paths before
 * proceeding with the override — re-anchoring containment is respected, but
 * never silent (FR-9).
 *
 * Observability: resume threads resumeProjectRoot into RunEngineArgs.projectRoot
 * (which the executor uses to anchor cwd confinement + owned_paths), so these
 * tests capture RunEngineArgs via an injected runEngine and read the stderr the
 * injected CliIO collects.
 *
 * Covered ACs (FR-9):
 *   AC1 — no --project-root reuses the recorded project_root (existing default).
 *   AC2 — --project-root DIFFERENT from recorded -> stderr warning naming BOTH,
 *         then proceeds with the override.
 *   AC3 — --project-root EQUAL to recorded -> no warning.
 *   AC4 — a worktree-rooted run resumed reusing its recorded root re-anchors at
 *         the worktree path (RunEngineArgs.projectRoot == the worktree).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  main,
  setPinnedFlowVersion,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from './main';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { ModelAdapter } from '../worker/adapter';

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
}

/** git command that MUST succeed, with a deterministic identity. */
function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
}

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;
let flowRoot: string;
let flowPath: string;
const cleanup: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `conduit-${prefix}-`));
  cleanup.push(d);
  return d;
}

/** A minimal, valid transform flow (no harness needed to test root threading). */
function writeFlow(): string {
  flowRoot = mkTmp('resume-flow');
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
  const fp = join(flowRoot, 'flow.yaml');
  writeFileSync(
    fp,
    `flow: minimal
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
stations:
  - id: only
    worker:
      kind: transform
      role: writer
      model: test-model
      prompt_file: p.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: text, type: string, required: true }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`,
    'utf-8',
  );
  return fp;
}

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
  flowPath = writeFlow();
  setPinnedFlowVersion(db, 1);
});

afterEach(() => {
  db.close();
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Captured {
  args?: RunEngineArgs;
}

function makeDeps(capture: Captured): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (args: RunEngineArgs) => {
      capture.args = args;
    },
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) } as PrereqProbe],
  };
}

/** Register a resumable run recorded at `recordedRoot`, plus a ready card. */
function seedRun(runId: string, recordedRoot: string): void {
  db.insertRun({ run_id: runId, flow: flowPath, project_root: recordedRoot, input_fingerprint: 'fp', status: 'running' });
  db.insertCard({
    run_id: runId,
    id: `card-${runId}`,
    parent_id: null,
    lane: 'only',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

/** A warning about project-root re-anchoring: mentions warn + both paths. */
function reAnchorWarning(recorded: string, override: string): string[] {
  return io.errors.filter(
    (l) => /warn/i.test(l) && l.includes(recorded) && l.includes(override),
  );
}

describe('conduit resume — recorded project_root is reused by default (AC1)', () => {
  it('reuses the run\'s recorded project_root when no --project-root is given', async () => {
    const recordedRoot = mkTmp('recorded');
    seedRun('job-A', recordedRoot);
    const capture: Captured = {};

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps(capture));

    expect(capture.args?.projectRoot).toBe(recordedRoot);
    // No override -> nothing to warn about.
    expect(io.errors.some((l) => /warn/i.test(l) && l.includes('project'))).toBe(false);
  });
});

describe('conduit resume — a differing --project-root override warns then proceeds (AC2)', () => {
  it('warns on stderr naming BOTH the recorded root and the override, then uses the override', async () => {
    const recordedRoot = mkTmp('recorded');
    const overrideRoot = mkTmp('override');
    seedRun('job-A', recordedRoot);
    const capture: Captured = {};

    await main(['resume', flowPath, '--run', 'job-A', '--project-root', overrideRoot], makeDeps(capture));

    // The re-anchoring is surfaced, naming BOTH paths (never silent).
    expect(reAnchorWarning(recordedRoot, overrideRoot).length).toBeGreaterThanOrEqual(1);
    // ...and resume proceeds with the OVERRIDE root.
    expect(capture.args?.projectRoot).toBe(overrideRoot);
  });
});

describe('conduit resume — an override equal to the recorded root does not warn (AC3)', () => {
  it('prints no re-anchoring warning when --project-root equals the recorded root', async () => {
    const recordedRoot = mkTmp('recorded');
    seedRun('job-A', recordedRoot);
    const capture: Captured = {};

    await main(['resume', flowPath, '--run', 'job-A', '--project-root', recordedRoot], makeDeps(capture));

    // Same path -> no re-anchoring, so no warning.
    expect(io.errors.some((l) => /warn/i.test(l) && l.includes('project'))).toBe(false);
    expect(capture.args?.projectRoot).toBe(recordedRoot);
  });
});

describe('conduit resume — a worktree-rooted run re-anchors at the recorded worktree (AC4)', () => {
  it('reuses a recorded git-worktree root, re-anchoring containment there', async () => {
    // Real git worktree as the recorded project root.
    const repo = mkTmp('wt-repo');
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    const worktree = join(mkTmp('wt-parent'), 'worktree');
    git(['worktree', 'add', '--detach', '-q', worktree], repo);

    seedRun('job-A', worktree);
    const capture: Captured = {};

    await main(['resume', flowPath, '--run', 'job-A'], makeDeps(capture));

    // Resume reuses the recorded worktree root -> the executor anchors cwd
    // confinement + owned_paths there (RunEngineArgs.projectRoot == worktree).
    expect(capture.args?.projectRoot).toBe(worktree);
    expect(io.errors.some((l) => /warn/i.test(l) && l.includes('project'))).toBe(false);
  });
});
