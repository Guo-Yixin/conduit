/**
 * The original silent deterministic-failure work — a run that halts (a card scrapped/held, or stuck in a
 * non-terminal lane) exits 1 with NO diagnostic output: the operator sees
 * only `conduit run failed (exit 1)` and has to go spelunking through
 * `journal inspect` card-by-card to find out why. cmdRun now prints a concise
 * per-card summary to stderr (id, ending lane, station, attempt, and the
 * last card_log 'terminal' reason when one was recorded) before returning 1.
 * A completed (exit 0) run must print nothing new.
 *
 * Harness mirrors main-sql-injection.test.ts: in-memory ConduitDB, captured
 * IO, and an injected `runEngine` that drives the seeded card to whatever
 * terminal state each test wants (bypassing the real executor, which is
 * being edited concurrently by another agent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { main, buildHaltedRunSummary, type CliDeps, type CliIO, type RunEngineArgs } from './main';

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
});

afterEach(() => {
  db.close();
});

function makeDeps(runEngine: (args: RunEngineArgs) => Promise<void>): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine,
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

const flowYaml = `
flow: cli-run-summary-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [request.json]
    outputs: [idea.json]
    next: done
`;

function setupRunProject(): { dir: string; flowPath: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-run-summary-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{request.json}}');
  const flowPath = join(dir, 'flow.yaml');
  writeFileSync(flowPath, flowYaml);
  const prevCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    flowPath,
    restore: () => {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('cmdRun halted-run summary (the original silent deterministic-failure work)', () => {
  it('prints card id, terminal lane, station, attempt, and reason to stderr when a seeded card lands in scrap', async () => {
    const proj = setupRunProject();
    try {
      const runEngine = async (args: RunEngineArgs) => {
        const stateDb = args.db.getStateDb();
        stateDb
          .prepare("UPDATE cards SET lane = 'scrap', status = 'scrapped', attempt = 3 WHERE id = 'conduit-run-entry'")
          .run();
        args.db.appendCardLog({
          runId: DEFAULT_RUN_ID,
          kind: 'terminal',
          cardId: 'conduit-run-entry',
          station: 'ideate',
          attempt: 3,
          reason: 'per-card rework cap exceeded',
        });
      };

      const code = await main(['run', proj.flowPath, '--input-inline', '{}'], makeDeps(runEngine));

      expect(code).not.toBe(0);
      const stderr = io.errors.join('\n');
      expect(stderr).toContain('conduit-run-entry');
      expect(stderr).toContain('lane=scrap');
      expect(stderr).toContain('station=ideate');
      expect(stderr).toContain('attempt=3');
      expect(stderr).toContain('per-card rework cap exceeded');
    } finally {
      proj.restore();
    }
  });

  it('prints card id, lane, and station for a card held with no terminal reason recorded', async () => {
    const proj = setupRunProject();
    try {
      const runEngine = async (args: RunEngineArgs) => {
        args.db
          .getStateDb()
          .prepare("UPDATE cards SET lane = 'hold', status = 'held' WHERE id = 'conduit-run-entry'")
          .run();
      };

      const code = await main(['run', proj.flowPath, '--input-inline', '{}'], makeDeps(runEngine));

      expect(code).not.toBe(0);
      const stderr = io.errors.join('\n');
      expect(stderr).toContain('conduit-run-entry');
      expect(stderr).toContain('lane=hold');
      // No card_log 'terminal' entry was recorded — station falls back to the
      // card's own lane (still identifies where it ended up).
      expect(stderr).toContain('station=hold');
    } finally {
      proj.restore();
    }
  });

  it('prints nothing new when the run completes (exit 0)', async () => {
    const proj = setupRunProject();
    try {
      const runEngine = async (args: RunEngineArgs) => {
        args.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete'").run();
      };

      const code = await main(['run', proj.flowPath, '--input-inline', '{}'], makeDeps(runEngine));

      expect(code).toBe(0);
      expect(io.errors.join('\n')).not.toMatch(/halted/i);
    } finally {
      proj.restore();
    }
  });
});

describe('buildHaltedRunSummary (the original silent deterministic-failure work)', () => {
  it('lists only non-done cards, preferring the card_log terminal station/reason over the raw lane', () => {
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'done-card',
      parent_id: null,
      lane: 'done',
      status: 'complete',
      attempt: 1,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'scrapped-card',
      parent_id: null,
      lane: 'scrap',
      status: 'scrapped',
      attempt: 2,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });
    db.appendCardLog({
      runId: DEFAULT_RUN_ID,
      kind: 'terminal',
      cardId: 'scrapped-card',
      station: 'review',
      attempt: 2,
      reason: 'gate rejected twice',
    });

    const lines = buildHaltedRunSummary(db, DEFAULT_RUN_ID);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('scrapped-card');
    expect(lines[0]).toContain('lane=scrap');
    expect(lines[0]).toContain('station=review');
    expect(lines[0]).toContain('attempt=2');
    expect(lines[0]).toContain('gate rejected twice');
    expect(lines.join('\n')).not.toContain('done-card');
  });
});
