/**
 * Security punch-list item #3 — parameterize the one string-interpolated SQL
 * query in src/cli/main.ts (the FR-9 fail-closed "is there a runnable card?"
 * count). Lane names come from flow.yaml `terminal_lanes` with no charset
 * restriction, so an interpolated `IN ('lane', ...)` clause is a SQL-injection
 * sink. These tests pin:
 *   1. correctness — the count of non-terminal, runnable cards is right for a
 *      normal flow (terminal cards excluded, runnable non-terminal cards counted).
 *   2. safety — a terminal lane name containing SQL metacharacters is treated as
 *      a bound literal: the query runs cleanly, the `cards` table survives, and
 *      the count stays sane.
 *
 * Harness mirrors cli.test.ts: in-memory ConduitDB, captured IO, injected
 * runEngine that records whether dispatch was reached, and a temp flow.yaml
 * (with a declared `next` topology so flow.happyPathNext is defined and the
 * FR-9 path at main.ts ~L220-240 is exercised).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB  } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

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

/** Captures whether dispatch was reached (cap.called === count>0 path). */
function makeCapturingEngine(): {
  runEngine: (args: RunEngineArgs) => Promise<void>;
  cap: { called: boolean };
} {
  const cap = { called: false };
  const runEngine = async (args: RunEngineArgs) => {
    cap.called = true;
    args.db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete'").run();
  };
  return { runEngine, cap };
}

/**
 * Build a temp project + flow.yaml with the given terminal_lanes. The entry
 * station 'ideate' declares `next: done`, giving the flow a happyPathNext map so
 * cmdRun takes the FR-9 fail-closed branch (the SQL count) when no --input and
 * no runnable card is present. chdir into the dir so project_root '.' resolves.
 */
function setupRunProject(terminalLanes: string[]): {
  dir: string;
  flowPath: string;
  restore: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-sqli-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{request.json}}');
  const lanesYaml = terminalLanes.map((l) => JSON.stringify(l)).join(', ');
  const flowYaml = `
flow: cli-sqli-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [${lanesYaml}]
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

function tableExists(d: ConduitDB, name: string): boolean {
  const row = d
    .getStateDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row?.name === name;
}

describe('cmdRun FR-9 count query — correctness (security punch-list #3)', () => {
  it('counts only non-terminal, runnable cards (terminal-lane cards excluded) → proceeds when one exists', async () => {
    const proj = setupRunProject(['done', 'scrap', 'hold']);
    try {
      // Terminal-lane cards: must NOT count toward "runnable".
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't1', parent_id: null, lane: 'done', status: 'complete', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't2', parent_id: null, lane: 'scrap', status: 'scrapped', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't3', parent_id: null, lane: 'hold', status: 'held', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
      // One genuine non-terminal runnable card → count must be 1 → engine runs.
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'r1', parent_id: null, lane: 'ideate', status: 'ready', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });

      const { runEngine, cap } = makeCapturingEngine();
      const code = await main(['run', proj.flowPath], makeDeps(runEngine));

      expect(cap.called).toBe(true); // count > 0 → dispatch reached
      expect(code).toBe(0);
    } finally {
      proj.restore();
    }
  });

  it('counts zero when every card sits in a terminal lane → fails closed', async () => {
    const proj = setupRunProject(['done', 'scrap', 'hold']);
    try {
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't1', parent_id: null, lane: 'done', status: 'complete', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't2', parent_id: null, lane: 'scrap', status: 'scrapped', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });

      const { runEngine, cap } = makeCapturingEngine();
      const code = await main(['run', proj.flowPath], makeDeps(runEngine));

      expect(cap.called).toBe(false); // count === 0 → fail closed, never dispatch
      expect(code).not.toBe(0);
      expect(io.errors.join('\n')).toMatch(/input|seed|no .*runnable|no .*card/i);
    } finally {
      proj.restore();
    }
  });

  it('honors the default terminal lanes [done, scrap, hold] when terminal_lanes is absent', async () => {
    // No terminal_lanes in the flow → main.ts falls back to the defaults.
    const dir = mkdtempSync(join(tmpdir(), 'conduit-sqli-def-'));
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'ideate.md'), 'x {{request.json}}');
    const flowYaml = `
flow: cli-sqli-default
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
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
    const flowPath = join(dir, 'flow.yaml');
    writeFileSync(flowPath, flowYaml);
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // A card parked in the default terminal lane 'done' must be excluded.
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't1', parent_id: null, lane: 'done', status: 'complete', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });
      const { runEngine, cap } = makeCapturingEngine();

      const code = await main(['run', flowPath], makeDeps(runEngine));

      expect(cap.called).toBe(false); // only terminal card → count 0 → fail closed
      expect(code).not.toBe(0);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cmdRun FR-9 count query — SQL-injection safety (security punch-list #3)', () => {
  it('treats a SQL-metacharacter terminal lane name as a bound literal (no DROP, table survives, count sane)', async () => {
    const malicious = "x'); DROP TABLE cards;--";
    const proj = setupRunProject(['done', 'scrap', 'hold', malicious]);
    try {
      expect(tableExists(db, 'cards')).toBe(true);

      // Seed a runnable non-terminal card so the query has something to count.
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'r1', parent_id: null, lane: 'ideate', status: 'ready', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });

      const { runEngine, cap } = makeCapturingEngine();

      // Must NOT throw a SQL error from the injected metacharacters.
      const code = await main(['run', proj.flowPath], makeDeps(runEngine));

      // The cards table was not dropped by the injected payload.
      expect(tableExists(db, 'cards')).toBe(true);
      // The count saw the runnable card → dispatch reached, clean exit.
      expect(cap.called).toBe(true);
      expect(code).toBe(0);
    } finally {
      proj.restore();
    }
  });

  it('an apostrophe-bearing terminal lane name is matched literally (card in that lane is excluded as terminal)', async () => {
    const apostropheLane = "joe's-done";
    const proj = setupRunProject(['done', 'scrap', 'hold', apostropheLane]);
    try {
      // A card sitting in the apostrophe terminal lane must be EXCLUDED (terminal),
      // so with no other runnable card the run fails closed — proving the value was
      // bound and compared literally rather than mangling the SQL.
      db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 't1', parent_id: null, lane: apostropheLane, status: 'working', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 });

      const { runEngine, cap } = makeCapturingEngine();
      const code = await main(['run', proj.flowPath], makeDeps(runEngine));

      expect(tableExists(db, 'cards')).toBe(true);
      expect(cap.called).toBe(false); // lane is terminal → count 0 → fail closed
      expect(code).not.toBe(0);
    } finally {
      proj.restore();
    }
  });
});
