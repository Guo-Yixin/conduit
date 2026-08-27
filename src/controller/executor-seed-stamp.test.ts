/**
 * Executor binding-stamp wiring for the per-child seed (WI-468 BUG-1).
 *
 * WI-468 wired {{seed.json}} into renderPrompt so a child_entry station renders
 * THAT child's seed (read from `<card.owned_paths[0]>/seed.json`, NOT projectRoot).
 * The binding stamp (SPEC §5 skip-on-resume) must hash seed.json from the SAME
 * card-scoped location — otherwise:
 *
 *   - sibling children with different seeds would get IDENTICAL stamps, and
 *   - a child whose seed.json content changes between runs would skip-replay the
 *     stale checkpoint (because the stamp never saw the seed change), serving the
 *     OLD output instead of re-running with the new seed.
 *
 * The original bug: executor.ts hashed `readFileSync(join(projectRoot, 'seed.json'))`.
 * For a seed station that file does not exist at projectRoot → ENOENT → the catch
 * returns '' → every seed hashes to the same '' → stamps collide.
 *
 * These tests pin the fix through the REAL executor (in-memory DB, stub adapter,
 * loader-built flow). They are deliberately behavioral: they never recompute the
 * stamp by hand. Instead they observe the OBSERVABLE consequence of a correct
 * stamp — whether the model adapter is re-invoked when the seed content changes,
 * and whether two siblings with different seeds both execute rather than one
 * skip-replaying the other's checkpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';

/** Stub adapter: records every call so we can observe re-execution vs skip-replay. */
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

function loadOk(dir: string): FlowConfig {
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

const SECONDS = (n: number) => () => n;

/**
 * Single child_entry station that renders {{seed.json}}. The seed is card-scoped:
 * it lives in the card's owned dir, written by the test (modeling commitFanOut).
 */
function setupSeedStationFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'child.md'), 'Build for: {{seed.json}}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: seed-stamp
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: child_entry
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/child.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [seed.json]
    outputs: [out.json]
    next: done
`,
  );
  return loadOk(dir);
}

/** Make an owned dir for a child and write its seed.json. Returns the absolute dir. */
function makeOwnedDirWithSeed(parent: string, name: string, seed: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'seed.json'), seed, 'utf-8');
  return dir;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-seed-stamp-'));
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

describe('binding stamp — per-child seed content (WI-468 BUG-1)', () => {
  it('re-executes (does NOT skip-replay) when the child seed.json content changes between runs', async () => {
    // A correct stamp hashes seed.json from the card's owned dir. When the seed
    // content changes, the recomputed stamp differs from the checkpointed one, so
    // the station re-runs. With the bug (hash from projectRoot → ENOENT → ''),
    // the stamp is stable across seed changes and the second run skip-replays.
    const flow = setupSeedStationFlow(projectDir);
    db = openDb();
    const stateDb = db.getStateDb();

    const ownedDir = makeOwnedDirWithSeed(projectDir, 'child-c', '{"sku":"WIDGET-A"}');
    seedCard(db, { id: 'c', lane: 'child_entry', owned_paths: [ownedDir] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    // First run: child_entry executes once and checkpoints with a stamp derived
    // from the ORIGINAL seed content.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(calls.length).toBe(1);

    // The child's seed changes on disk (e.g. the parent re-materialized it).
    writeFileSync(join(ownedDir, 'seed.json'), '{"sku":"WIDGET-B"}', 'utf-8');

    // Reset the card to the station and run again. A correct, seed-aware stamp no
    // longer matches the stored checkpoint → the station MUST re-execute.
    stateDb.prepare("UPDATE cards SET lane = 'child_entry', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    // Re-executed: the second run made a NEW model call. With the projectRoot bug,
    // the stamp would have matched and calls.length would still be 1 (skip-replay).
    expect(calls.length).toBe(2);
    // And the re-execution rendered the NEW seed into the prompt.
    expect(calls[1]!.prompt).toBe('Build for: {"sku":"WIDGET-B"}');
  });

  it('two sibling children with different seeds both execute (neither skip-replays the other\'s stamp)', async () => {
    // Sibling children share the template but carry different seeds. A correct
    // seed-aware stamp is distinct per child, so BOTH execute. With the bug, both
    // seeds hash to '' → identical stamps; if their checkpoints ever collide the
    // second would skip-replay the first. We assert both billed a model call AND
    // each rendered its OWN seed.
    const flow = setupSeedStationFlow(projectDir);
    db = openDb();

    const dirA = makeOwnedDirWithSeed(projectDir, 'child-a', '{"sku":"WIDGET-A"}');
    const dirB = makeOwnedDirWithSeed(projectDir, 'child-b', '{"sku":"WIDGET-B"}');
    seedCard(db, { id: 'a', lane: 'child_entry', owned_paths: [dirA] });
    seedCard(db, { id: 'b', lane: 'child_entry', owned_paths: [dirB] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'b')?.lane).toBe('done');
    // Both children executed — neither reused the other's checkpoint.
    expect(calls.length).toBe(2);
    // Each rendered its OWN seed (proves per-child resolution, not a shared input).
    const prompts = calls.map((c) => c.prompt).sort();
    expect(prompts).toEqual([
      'Build for: {"sku":"WIDGET-A"}',
      'Build for: {"sku":"WIDGET-B"}',
    ]);
  });
});
