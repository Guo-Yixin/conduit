/**
 * Tests for worker.uses prompt-render preference in the REAL executor
 * (WI-555, executor half — AC6).
 *
 * Skill Ingest PRD §2.2 / amended NFR-3, D1 carrier option A: the transform
 * prompt-render read at executor.ts:1594 must PREFER the loader-composed
 * `stationConfig.prompt_content` over `readFileSync(stationConfig.prompt_file)`.
 * This is verified against the real dispatch path — a seeded card driven through
 * `runExecutor` with a stub ModelAdapter that captures the rendered prompt — NOT
 * merely by inspecting the loader output (which load-worker-uses.test.ts covers).
 *
 * The load-bearing assertion: the captured prompt contains the SKILL body text.
 * That text lives only in the composed prompt_content; it is absent from the
 * station's prompt_file. So if the executor still read prompt_file (the pre-WI-555
 * behavior), the skill text could not appear — the test would fail. This makes it
 * a genuine regression guard for the one allowed executor touch.
 *
 * Mirrors the stub-adapter / temp-project recipe in src/integration/real-run.test.ts.
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
const SKILL_MARKER = 'HOUSE-STYLE-SKILL-BODY-MARKER';
const LOCAL_MARKER = 'LOCAL-PROMPT-MARKER';

/** Stub adapter that records every ModelCall and returns schema-valid JSON. */
function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return { text: JSON.stringify({ out: 'ok' }), inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

/**
 * A one-station transform flow whose station `uses:` a house-style skill (body =
 * SKILL_MARKER) and has a local prompt (LOCAL_MARKER). The composed prompt_content
 * is therefore skill-body then local-prompt. project_root '.' resolves to the
 * chdir'd temp dir; the station declares no inputs so the prompt has no
 * placeholders to resolve.
 */
function setupUsesFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'draft.md'), LOCAL_MARKER);

  const skillBundle = join(dir, 'skills', 'house-style');
  mkdirSync(skillBundle, { recursive: true });
  writeFileSync(
    join(skillBundle, 'SKILL.md'),
    ['---', 'name: house-style', 'description: house style marker skill.', '---', '', SKILL_MARKER, ''].join('\n'),
  );

  const flowYaml = `
flow: worker-uses-e2e
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: draft
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/draft.md
      prompt_version: "1"
      uses: [house-style]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const SECONDS = (n: number) => () => n;

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-uses-e2e-'));
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

describe('worker.uses prompt-render preference (real executor, AC6)', () => {
  it('renders the transform prompt from the composed prompt_content (skill then local prompt), not from prompt_file', async () => {
    const flow = setupUsesFlow(projectDir);
    db = openDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'entry',
      parent_id: null,
      lane: 'draft',
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: ['draft.json'],
      rework_count: 0,
    });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const workerCall = calls.find((c) => c.model === WORKER_MODEL);
    expect(workerCall).toBeDefined();

    const prompt = workerCall!.prompt;
    // The skill body only exists in prompt_content — its presence proves the
    // executor rendered from the composed content, not from prompt_file alone.
    expect(prompt).toContain(SKILL_MARKER);
    // The local prompt is still present, composed last.
    expect(prompt).toContain(LOCAL_MARKER);
    // Order: skill content before the local prompt.
    expect(prompt.indexOf(SKILL_MARKER)).toBeLessThan(prompt.indexOf(LOCAL_MARKER));
  });
});
