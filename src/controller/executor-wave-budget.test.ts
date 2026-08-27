/**
 * Executor wiring tests for the per-wave (parent_id subtree) budget — guard #4's
 * wave scope (SPEC §6/§8). `aggregateByWave`/`checkWaveBudget` were implemented
 * as library functions but never driven by runExecutor; these tests pin the
 * wiring through the REAL executor.
 *
 * Behavior:
 *   - A subtree (cards sharing a parent_id) whose accumulated token/dispatch
 *     spend exceeds `budgets.per_wave` is scrapped — but the run is NOT halted,
 *     so sibling subtrees under other parents keep running (blast-radius isolation).
 *   - With no `per_wave` cap declared the gate is inactive (legacy behavior).
 *
 * Timing note: the wave check runs at the top of the control loop (one tick
 * behind accrued spend), so a runaway card is scrapped only while still
 * non-terminal. The runaway path is therefore multi-station (burn1 → burn2) with
 * a cap below the first station's spend, so the subtree crosses the threshold
 * after burn1 and is scrapped before burn2.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';

/** Worker bills 18 tokens (12 in + 6 out) per call. */
function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return { text: JSON.stringify({ idea: 'x' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? [],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function terminalReasons(db: ConduitDB, cardId: string): string[] {
  return db
    .getCardLog(cardId)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

/**
 * Flow: burn1 → burn2 → done (transform stations, 18 tokens each) plus a cheap
 * deterministic station. `perWave` injects the optional per-wave cap.
 */
function setupFlow(dir: string, perWave: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'p.md'), 'Work from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: wave-budget
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
${perWave}
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
stations:
  - id: burn1
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/p.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [b1.json]
    next: burn2
  - id: burn2
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/p.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [b2.json]
    next: burn3
  - id: burn3
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/p.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [b3.json]
    next: done
  - id: cheap
    worker: { kind: deterministic, command: "true" }
    inputs: []
    outputs: []
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-wave-'));
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

describe('per-wave budget — subtree scrap with run isolation (SPEC §6/§8)', () => {
  it('scraps an over-budget subtree while a sibling subtree keeps running', async () => {
    // Cap 10 < burn1's 18-token spend → epicA crosses the threshold after burn1
    // and is scrapped before burn2. epicB's child is deterministic (0 tokens).
    const flow = setupFlow(projectDir, '  per_wave: { max_tokens: 10 }');
    db = openDb();
    seedCard(db, { id: 'a1', lane: 'burn1', parent_id: 'epicA' });
    seedCard(db, { id: 'b1', lane: 'cheap', parent_id: 'epicB' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    // epicA's runaway child is scrapped mid-flow with reason wave_budget...
    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('scrap');
    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.status).toBe('scrapped');
    expect(terminalReasons(db, 'a1')).toContain('wave_budget');
    // ...and it never reached burn2 (scrapped before the second station ran).
    expect(existsSync(join(projectDir, 'b1.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'b2.json'))).toBe(false);
    // The sibling subtree under a different parent is unaffected — the run did
    // NOT halt: epicB's child completes.
    expect(db.getCard(DEFAULT_RUN_ID, 'b1')?.lane).toBe('done');
  });

  it('does not scrap a subtree that stays under its wave budget', async () => {
    // Cap 1000 > the child's full 36-token spend (burn1 + burn2) → completes.
    const flow = setupFlow(projectDir, '  per_wave: { max_tokens: 1000 }');
    db = openDb();
    seedCard(db, { id: 'a1', lane: 'burn1', parent_id: 'epicA' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('done');
    expect(terminalReasons(db, 'a1')).not.toContain('wave_budget');
  });

  it('enforces the dispatch cap independently of the token cap', async () => {
    // max_dispatches: 1 → the wave exceeds its dispatch budget after burn2 (2
    // dispatches > 1) and is scrapped before burn3, even with tokens unbounded.
    const flow = setupFlow(projectDir, '  per_wave: { max_dispatches: 1 }');
    db = openDb();
    seedCard(db, { id: 'a1', lane: 'burn1', parent_id: 'epicA' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('scrap');
    expect(existsSync(join(projectDir, 'b3.json'))).toBe(false);
  });

  it('is inactive when no per_wave cap is declared (legacy behavior)', async () => {
    const flow = setupFlow(projectDir, ''); // no per_wave block
    db = openDb();
    seedCard(db, { id: 'a1', lane: 'burn1', parent_id: 'epicA' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    // Would have exceeded a tight cap, but with no cap the child runs to done.
    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('done');
  });
});
