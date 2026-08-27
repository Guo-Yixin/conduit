/**
 * The original input-validation work — `terminal_lanes` string-interpolated into SQL.
 *
 * `runExecutor` used to build `NOT IN (${terminalSql})` clauses (the promote-
 * to-ready query, the non-terminal/stall-diagnostic COUNT queries, and
 * `scrapWaveSubtree`'s wave-budget query) by wrapping each lane name in
 * quotes and joining them into the SQL text directly. Lane names come from
 * `flow.yaml` (`terminal_lanes:`) with no charset restriction, so a lane name
 * containing a quote is a SQL-injection / malformed-config crash sink — the
 * same class of bug already fixed in `src/cli/main.ts`'s FR-9 count query
 * (see `src/cli/main-sql-injection.test.ts`).
 *
 * The fix binds every lane as a named parameter (`laneExclusionClause` in
 * executor.ts) instead of interpolating it into the SQL text. This test
 * drives the REAL `runExecutor` (not a unit test of the helper) with a
 * `terminal_lanes` entry containing SQL metacharacters and pins:
 *
 *   1. The run executes cleanly to completion — no thrown SQL error from the
 *      malicious lane name.
 *   2. The `cards` table survives (the injected `DROP TABLE` payload never
 *      reaches the database as executable SQL — it is a bound literal).
 *   3. Terminal-lane detection still works correctly with the malicious lane
 *      bound as a literal: a card already sitting in that lane is treated as
 *      terminal (never promoted to 'ready') exactly as a normal terminal lane
 *      would be.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';
const MALICIOUS_LANE = "x'); DROP TABLE cards;--";

function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({ idea: 'an idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function setupFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  // The terminal_lanes list includes a lane name laden with SQL metacharacters
  // (quote, parenthesis, semicolon, comment marker) — exactly the shape a
  // hostile or typo'd flow.yaml could supply.
  const lanesYaml = ['done', 'scrap', 'hold', MALICIOUS_LANE].map((l) => JSON.stringify(l)).join(', ');
  const flowYaml = `
flow: terminal-lanes-sql-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [${lanesYaml}]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, over: { id: string; lane: string; status: 'ready' | 'waiting' }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: null,
    lane: over.lane,
    status: over.status,
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function tableExists(db: ConduitDB, name: string): boolean {
  const row = db
    .getStateDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row?.name === name;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-terminal-lanes-sql-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('runExecutor — terminal_lanes bound as parameters, not interpolated (terminal-lane SQL-hardening work)', () => {
  it('runs cleanly, survives the injected DROP TABLE payload, and still treats the malicious lane as terminal', async () => {
    const flow = setupFlow(projectDir);
    db = openDb();
    expect(tableExists(db, 'cards')).toBe(true);

    // A normal runnable card — proves the promote-to-ready / dispatch queries
    // still function correctly alongside the malicious terminal lane.
    seedCard(db, { id: 'r1', lane: 'ideate', status: 'ready' });
    // A card already parked in the malicious lane with status 'waiting' — if
    // the lane were NOT correctly bound as a literal (e.g. the interpolated
    // clause were malformed or matched everything), the promote-to-ready query
    // would incorrectly flip this card to 'ready'. Terminal-lane detection
    // must exclude it exactly as it would any other terminal lane.
    seedCard(db, { id: 'stuck', lane: MALICIOUS_LANE, status: 'waiting' });

    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    // Must not throw a SQL error from the injected metacharacters.
    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    // The cards table was not dropped by the injected payload.
    expect(tableExists(db, 'cards')).toBe(true);

    // The normal card ran to completion.
    expect(db.getCard(DEFAULT_RUN_ID, 'r1')?.lane).toBe('done');

    // The card parked in the malicious lane was correctly recognized as
    // terminal — left untouched (never promoted to 'ready', never dispatched).
    const stuck = db.getCard(DEFAULT_RUN_ID, 'stuck');
    expect(stuck?.lane).toBe(MALICIOUS_LANE);
    expect(stuck?.status).toBe('waiting');
  });
});
