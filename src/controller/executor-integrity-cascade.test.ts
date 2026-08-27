/**
 * Executor wiring tests for the MARK_DONE owned-paths integrity gate (SPEC §5/§6)
 * and binding-stamp cascade invalidation (SPEC §5).
 *
 * Both mechanisms were implemented-as-library but not driven by runExecutor;
 * these tests pin the wiring through the REAL executor (in-memory DB, stub
 * adapter, loader-built flows).
 *
 *   - Integrity gate: when a flow opts in (`defaults.enforce_owned_paths: true`),
 *     a station that writes outside the card's owned_paths is a containment
 *     breach → the executor hard-pauses the card to `hold`. With the gate OFF
 *     (the default), the same write is permitted (legacy project-root guard).
 *   - Cascade: when a station's checkpoint binding stamp no longer matches on
 *     resume, every downstream station that consumes its outputs has its
 *     checkpoint invalidated so it cannot skip-replay stale inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, writeCheckpoint } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';

/** Stub adapter: the transform worker always returns a valid {idea} payload. */
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

function checkpointCount(db: ConduitDB, station: string): number {
  return (
    db
      .getStateDb()
      .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE station = $s')
      .get({ $s: station }) as { n: number }
  ).n;
}

function loadOk(dir: string): FlowConfig {
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

const SECONDS = (n: number) => () => n;

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-integrity-'));
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

// ---------------------------------------------------------------------------
// Integrity gate — deterministic station writing outside owned_paths.
// ---------------------------------------------------------------------------

/**
 * Single deterministic station that `touch`es a file. The command writes
 * `escape.txt` at the project root; whether that is a violation depends on the
 * card's owned_paths and whether the flow opts the gate in.
 */
function setupTouchFlow(dir: string, enforce: boolean): FlowConfig {
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: integrity-touch
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold, enforce_owned_paths: ${enforce} }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["touch"]
stations:
  - id: write
    worker: { kind: deterministic, command: "touch", args: ["escape.txt"] }
    inputs: []
    outputs: []
    next: done
`,
  );
  return loadOk(dir);
}

describe('integrity gate — deterministic station (SPEC §5/§6)', () => {
  it('holds the card when a write escapes owned_paths and the flow opts in', async () => {
    const flow = setupTouchFlow(projectDir, true);
    db = openDb();
    // The card owns only `allowed.txt`; the command writes `escape.txt`.
    seedCard(db, { id: 'c', lane: 'write', owned_paths: ['allowed.txt'] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).not.toBe('done');
    expect(existsSync(join(projectDir, 'escape.txt'))).toBe(true); // the write did happen
  });

  it('permits the same write when the flow does NOT opt in (legacy behavior)', async () => {
    const flow = setupTouchFlow(projectDir, false);
    db = openDb();
    seedCard(db, { id: 'c', lane: 'write', owned_paths: ['allowed.txt'] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
  });

  it('permits a write INSIDE owned_paths even with the gate on', async () => {
    const flow = setupTouchFlow(projectDir, true);
    db = openDb();
    // The card owns escape.txt itself — the write is in-bounds.
    seedCard(db, { id: 'c', lane: 'write', owned_paths: ['escape.txt'] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Integrity gate — transform station writing outside owned_paths.
// ---------------------------------------------------------------------------

function setupTransformOutFlow(dir: string, enforce: boolean): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: integrity-transform
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold, enforce_owned_paths: ${enforce} }
terminal_lanes: [done, scrap, hold]
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
`,
  );
  return loadOk(dir);
}

describe('integrity gate — transform station (SPEC §5/§6)', () => {
  it('holds the card when the declared output escapes owned_paths (gate on)', async () => {
    const flow = setupTransformOutFlow(projectDir, true);
    db = openDb();
    // Owns the input but NOT the output idea.json → the write is out of bounds.
    seedCard(db, { id: 'c', lane: 'ideate', owned_paths: ['context.json'] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    // The checkpoint must be invalidated so a resume cannot skip-replay it.
    expect(checkpointCount(db, 'ideate')).toBe(0);
  });

  it('reaches done when the output is within owned_paths (gate on)', async () => {
    const flow = setupTransformOutFlow(projectDir, true);
    db = openDb();
    seedCard(db, { id: 'c', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Cascade invalidation — a stale upstream stamp invalidates downstream.
// ---------------------------------------------------------------------------

function setupTwoStageFlow(dir: string, maxTokens: number): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'a.md'), 'Stage A from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'b.md'), 'Stage B from {{mid.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: cascade-two-stage
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/a.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [mid.json]
    next: b
  - id: b
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/b.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [mid.json]
    outputs: [final.json]
    next: done
`,
  );
  return loadOk(dir);
}

describe('cascade invalidation — stale upstream stamp (SPEC §5)', () => {
  it('invalidates the downstream checkpoint when the upstream stamp no longer matches', async () => {
    // Tiny token budget so the consumption andon halts the run right after A
    // bills — BEFORE B re-runs — making the cascade's deletion directly observable.
    const flow = setupTwoStageFlow(projectDir, 1);
    db = openDb();
    const stateDb = db.getStateDb();

    // Pre-seed checkpoints as if a prior run completed A→B at attempt 0, but with
    // a STALE binding stamp on A (e.g. its model/prompt changed since). B's
    // checkpoint consumes A's output (mid.json), so the cascade must drop it.
    const flowKey = String(flow.version);
    writeCheckpoint(stateDb, { flow: flowKey, card: 'c', station: 'a', attempt: 0 }, {
      stamp: 'STALE-STAMP-A',
      output: { payload: { idea: 'old A' }, findings_hash: 'h', cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } as never,
    });
    writeCheckpoint(stateDb, { flow: flowKey, card: 'c', station: 'b', attempt: 0 }, {
      stamp: 'PRIOR-STAMP-B',
      output: { payload: { idea: 'old B' }, findings_hash: 'h', cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } as never,
    });
    expect(checkpointCount(db, 'b')).toBe(1); // precondition

    // Run with the card at A. A's recomputed stamp won't match 'STALE-STAMP-A',
    // so A re-executes — and the cascade invalidates B's checkpoint. The tiny
    // token budget (max_tokens: 1) trips the consumption andon right after A
    // bills, halting BEFORE B re-runs — so the deletion is directly observable.
    seedCard(db, { id: 'c', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // B never re-ran (andon halted the run), so its checkpoint stays gone:
    // the cascade — not B re-running — is what removed it.
    expect(checkpointCount(db, 'b')).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).not.toBe('done');
  });

  it('keeps the downstream checkpoint and does not re-run it when the stamp still matches', async () => {
    const flow = setupTwoStageFlow(projectDir, 100000);
    db = openDb();
    const stateDb = db.getStateDb();

    // First run completes A→B→done, checkpointing both with their real stamps.
    seedCard(db, { id: 'c', lane: 'a', owned_paths: [] });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(checkpointCount(db, 'a')).toBe(1);
    expect(checkpointCount(db, 'b')).toBe(1);
    const callsAfterFirstRun = calls.length;

    // Reset the card to A and run again with IDENTICAL config. A's stamp matches,
    // so it reuses its checkpoint — NO mismatch, NO cascade. Both A and B
    // skip-replay: zero new model calls, and B's checkpoint is untouched.
    stateDb.prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(checkpointCount(db, 'b')).toBe(1);
    expect(calls.length).toBe(callsAfterFirstRun); // no re-execution → cascade did not fire
  });
});
