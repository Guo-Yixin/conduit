/**
 * Acceptance suite — per-run projectRoot binding & containment (WI-591).
 *
 * TEST-FORWARD item: this suite IS the deliverable. It pins the per-run
 * containment guarantees the PRD requires be acceptance-tested rather than
 * assumed. Production changes land in src/worker/harness-runner.ts ONLY if a
 * test here exposes a confinement gap.
 *
 * Drives REAL confinement — no fake runner:
 *   - a real POSIX "echo-claude" harness (writes its declared output into cwd,
 *     encoding the cwd, then prints a claude `--output-format json` success
 *     envelope) run through the REAL runHarnessProcess (WI-561), so the child's
 *     cwd confinement is genuinely exercised;
 *   - real `git worktree` roots;
 *   - AC1 uses REAL concurrent `conduit run` SUBPROCESSES against one shared
 *     file-backed SQLite DB (the process-level model of docs/single-host-
 *     concurrency.md — distinct run ids on a shared DB, safe via WAL + the
 *     bounded SQLITE_BUSY retry), NOT the in-process shared-registry invariant
 *     WI-587 AC3 covers.
 *
 * Covered ACs (FR-4, FR-5):
 *   AC1 — two concurrent run processes, distinct --project-root A/B, one DB:
 *         each harness invocation confines to its own root, neither leaks.
 *   AC2 — a git-worktree project root anchors the runner's cwd confinement.
 *   AC3 — for a worktree root, owned_paths + the MARK_DONE integrity gate both
 *         anchor at the worktree (a within-worktree declared write is owned;
 *         a within-worktree UNDECLARED write is a breach -> hold).
 *   AC4 — worktree deleted mid-run: the runner fails NAMING the missing root
 *         (never a silent success), and the executor routes that named attempt
 *         failure down the attempt-cap path (never a silent pass to done).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runHarnessProcess } from '../worker/harness-runner';
import { createClaudeHarnessAdapter } from '../worker/harness-adapter-claude';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessRegistry,
} from '../worker/harness-adapter';
import { runExecutor } from '../controller/executor';
import { loadFlow } from '../flow/load';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import type { FlowConfig } from '../types/kernel';

const SECONDS = (n: number) => () => n;
const io = { out: (_l: string) => {}, err: (_l: string) => {} };
const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

// ---------------------------------------------------------------------------
// A real POSIX "echo-claude": writes result.json into its cwd (encoding the cwd
// so confinement is observable), optionally drops an UNDECLARED rogue file, then
// prints a claude success envelope. Args are ignored.
// ---------------------------------------------------------------------------

function echoClaudeSource(opts: { rogue?: boolean } = {}): string {
  const rogueLine = opts.rogue ? "printf 'undeclared' > rogue.txt\n" : '';
  return (
    '#!/bin/sh\n' +
    `printf '{"summary":"%s"}\\n' "$(pwd)" > result.json\n` +
    rogueLine +
    `printf '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}\\n'\n`
  );
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `conduit-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

function writeEchoScript(opts: { rogue?: boolean } = {}): string {
  const p = join(mkTmp('echo'), 'echo-claude.sh');
  writeFileSync(p, echoClaudeSource(opts));
  chmodSync(p, 0o755);
  return p;
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

/** Create a repo with one commit and a detached worktree; return the worktree path. */
function makeWorktree(): string {
  const repo = mkTmp('wt-repo');
  git(['init', '-q'], repo);
  writeFileSync(join(repo, 'seed.txt'), 'seed');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const worktree = join(mkTmp('wt-parent'), 'worktree');
  git(['worktree', 'add', '--detach', '-q', worktree], repo);
  return worktree;
}

const HARNESS_ADAPTER = 'claude-headless';

/** Write a harness flow + its prompt into `dir`; return the flow.yaml path. */
function writeHarnessFlow(dir: string, opts: { enforceOwnedPaths?: boolean } = {}): string {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'Do the task.');
  const enforceLine = opts.enforceOwnedPaths ? '\ndefaults: { enforce_owned_paths: true }' : '';
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: projectroot-binding
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]${enforceLine}
stations:
  - id: coder
    worker:
      kind: harness
      harness: ${HARNESS_ADAPTER}
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.md]
    outputs: [result.json]
    next: done
`,
  );
  return join(dir, 'flow.yaml');
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCoderCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'coder',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['task.md', 'result.json'],
    rework_count: 0,
  });
}

/** Drive a single harness station in-process against a real-runner adapter. */
async function runInProcess(projectRoot: string, echoScript: string, registryAdapter?: HarnessAdapter, opts: { enforceOwnedPaths?: boolean } = {}): Promise<ConduitDB> {
  writeFileSync(join(projectRoot, 'task.md'), 'task');
  const flowPath = writeHarnessFlow(projectRoot, opts);
  const adapter =
    registryAdapter ??
    createClaudeHarnessAdapter({ projectRoot, envAllowlist: ['HOME', 'PATH'], command: echoScript });
  const registry = createHarnessRegistry([adapter]);
  const loaded = loadFlow(flowPath, { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  const db = openDb();
  seedCoderCard(db);
  await runExecutor({
    db,
    flow: loaded.flow as FlowConfig,
    now: SECONDS(1000),
    adapter: throwingModel,
    io,
    harnessRegistry: registry,
    projectRoot,
  } as RunEngineArgs);
  return db;
}

afterEach(() => {
  // Best-effort cleanup; worktrees leave metadata in their (temp) repo, which is
  // itself removed here.
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ===========================================================================
// AC1 — two concurrent conduit run PROCESSES, distinct roots, one shared DB.
// ===========================================================================

describe('AC1 — concurrent run processes each confine to their own project root (FR-4)', () => {
  it(
    'two conduit run processes with distinct --project-root each write only into their own root',
    async () => {
      const echoScript = writeEchoScript();
      const flowDir = mkTmp('flowdir');
      const flowPath = writeHarnessFlow(flowDir);
      const dbDir = mkTmp('sharedb');
      const stateDb = join(dbDir, 'state.sqlite');
      const journalDb = join(dbDir, 'journal.sqlite');
      const rootA = mkTmp('rootA');
      const rootB = mkTmp('rootB');
      const mainEntry = join(import.meta.dir, '../cli/main.ts');

      const baseEnv = {
        ...process.env,
        CONDUIT_STATE_DB: stateDb,
        CONDUIT_JOURNAL_DB: journalDb,
        CONDUIT_HARNESS_ADAPTERS: HARNESS_ADAPTER,
        CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
        CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND: echoScript,
        // The original pre-public hardening work: the child's doctor pre-flight requires these to be SET
        // (presence probe, no connection). All model work here goes through the
        // echo-script harness adapter, so dummies keep the test hermetic on
        // checkouts without the repo-local .env (fresh worktrees, CI, clones).
        CONDUIT_BASE_URL: process.env.CONDUIT_BASE_URL ?? 'http://conduit-test.invalid/v1',
        CONDUIT_API_KEY: process.env.CONDUIT_API_KEY ?? 'conduit-test-dummy-key',
      };

      // CONDUIT_PROJECT_ROOT satisfies the doctor pre-flight project-root probe
      // (the run itself is confined by the --project-root flag); each process
      // gets its OWN root, so the two runs bind independently.
      const spawnRun = (root: string, runId: string) =>
        Bun.spawn(
          [process.execPath, mainEntry, 'run', flowPath, '--project-root', root, '--run-id', runId, '--input-inline', '{}'],
          { env: { ...baseEnv, CONDUIT_PROJECT_ROOT: root }, stdout: 'pipe', stderr: 'pipe' },
        );

      const procA = spawnRun(rootA, 'runA');
      const procB = spawnRun(rootB, 'runB');
      const [codeA, codeB] = await Promise.all([procA.exited, procB.exited]);
      const errA = await new Response(procA.stderr).text();
      const errB = await new Response(procB.stderr).text();

      expect(codeA === 0 ? 'ok' : `A failed: ${errA}`).toBe('ok');
      expect(codeB === 0 ? 'ok' : `B failed: ${errB}`).toBe('ok');

      // Each run's harness ran confined to its OWN root — its output landed there.
      expect(existsSync(join(rootA, 'result.json'))).toBe(true);
      expect(existsSync(join(rootB, 'result.json'))).toBe(true);
      const outA = readFileSync(join(rootA, 'result.json'), 'utf-8');
      const outB = readFileSync(join(rootB, 'result.json'), 'utf-8');
      expect(outA).toContain(rootA);
      expect(outB).toContain(rootB);
      // No leakage across roots.
      expect(outA).not.toContain(rootB);
      expect(outB).not.toContain(rootA);
    },
    60_000,
  );
});

// ===========================================================================
// AC2 — a git-worktree project root anchors the runner's cwd confinement.
// ===========================================================================

describe('AC2 — a worktree project root anchors the runner cwd confinement (FR-5)', () => {
  it('confines the harness to the worktree: the declared output lands inside it and the card completes', async () => {
    const worktree = makeWorktree();
    const echoScript = writeEchoScript();
    const db = await runInProcess(worktree, echoScript);

    // Output written by the child at cwd=worktree -> lands in the worktree, and
    // the executor (anchored at the worktree) collects it and completes the card.
    expect(existsSync(join(worktree, 'result.json'))).toBe(true);
    expect(readFileSync(join(worktree, 'result.json'), 'utf-8')).toContain(worktree);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    db.close();
  });
});

// ===========================================================================
// AC3 — owned_paths + the integrity gate anchor at the worktree.
// ===========================================================================

describe('AC3 — owned_paths + integrity gate anchor at the worktree (FR-5)', () => {
  it('a within-worktree DECLARED write is owned — the card completes under enforce_owned_paths', async () => {
    const worktree = makeWorktree();
    const echoScript = writeEchoScript();
    const db = await runInProcess(worktree, echoScript, undefined, { enforceOwnedPaths: true });

    // owned_paths resolved against the worktree: result.json is inside it and
    // declared, so the integrity gate does NOT false-breach -> the card completes.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    db.close();
  });

  it('a within-worktree UNDECLARED write is a breach — the card hard-pauses to hold', async () => {
    const worktree = makeWorktree();
    const rogueEcho = writeEchoScript({ rogue: true });
    const db = await runInProcess(worktree, rogueEcho, undefined, { enforceOwnedPaths: true });

    // rogue.txt is inside the worktree but NOT in owned_paths — the gate,
    // anchored at the worktree, catches it and holds (never advances to done).
    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('hold');
    expect(existsSync(join(worktree, 'rogue.txt'))).toBe(true);
    db.close();
  });
});

// ===========================================================================
// AC4 — worktree deleted mid-run: named runner failure + attempt-cap routing.
// ===========================================================================

describe('AC4 — a deleted worktree fails named, never a silent pass', () => {
  it('the runner rejects, naming the missing project root, when the worktree is gone', async () => {
    const worktree = makeWorktree();
    const echoScript = writeEchoScript();
    // Delete the worktree directory out from under the run.
    rmSync(worktree, { recursive: true, force: true });

    let threw = false;
    let message = '';
    try {
      await runHarnessProcess(
        { command: echoScript, args: [] },
        { projectRoot: worktree, timeoutMs: 5_000, envAllowlist: ['HOME', 'PATH'] },
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }

    // Never a silent success...
    expect(threw).toBe(true);
    // ...and the failure must NAME the missing project root, so the diagnosis
    // points at the deleted worktree — not the (present) harness binary.
    expect(message).toContain(worktree);
  });

  it('a named confinement failure fails the attempt and the card follows the attempt-cap path (not done)', async () => {
    const dir = mkTmp('attemptcap');
    // A harness whose invoke ALWAYS fails with a named confinement error, as the
    // runner would when its project root is gone.
    const failing: HarnessAdapter = {
      name: HARNESS_ADAPTER,
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke() {
        throw new Error(`harness runner: project root '${dir}/gone' does not exist`);
      },
    };
    const db = await runInProcess(dir, writeEchoScript(), failing);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    // Never a silent pass to done...
    expect(card?.lane).not.toBe('done');
    // ...the attempt-cap (max_execution_attempts: 2) routes the card to scrap.
    expect(card?.lane).toBe('scrap');
    db.close();
  });
});
