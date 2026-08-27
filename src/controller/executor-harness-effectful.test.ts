/**
 * Effectful harness stations use the outbox + idempotency discipline (WI-571,
 * Phase 3, FR-11).
 *
 * An effectful harness station (e.g. a committing coder) inherits the SAME
 * inherited-outbox discipline the effectful transform/deterministic paths use:
 * a PENDING intent (idempotency key) is written BEFORE the effectful invoke and
 * COMMITTED after success, so a crash-and-resume never blind-re-fires a completed
 * effect. A pending intent of unknown outcome escalates to hold (never a blind
 * retry). A pure (effectful=false) harness station never touches the outbox.
 *
 * Mirrors src/controller/effectful-outbox.test.ts (the transform/deterministic
 * template): reuses checkpoint.ts writePendingIntent / commitIntent /
 * writeCheckpoint / getIntentStatus to seed prior-run state and assert outcomes.
 * The idempotency key is `${flow.version}:${cardId}:${stationId}:${attempt}`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import {
  ensureCheckpointSchema,
  writeCheckpoint,
  writePendingIntent,
  commitIntent,
  getIntentStatus,
} from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig, StationOutput } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';

const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

/** The idempotency key the effectful path derives for (card, station, attempt). */
const idemKey = (cardId: string, station: string, attempt = 0) => `1:${cardId}:${station}:${attempt}`;

function makeHarnessMaker(): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'committed' }), 'utf-8');
      return { outputs: [], usage: { tokens: 10, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

function writeHarnessFlow(dir: string, registry: HarnessRegistry, opts: { effectful: boolean }): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');

  const flowYaml = `
flow: harness-effectful
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    effectful: ${opts.effectful}
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
  });
}

const getCard = (db: ConduitDB) => db.getCard(DEFAULT_RUN_ID, 'entry');

let originalCwd: string;
let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-effectful-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) { db.close(); db = null; }
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function run(flow: FlowConfig, registry: HarnessRegistry, at = 1000): Promise<void> {
  await runExecutor({ db: db!, flow, now: SECONDS(at), adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);
}

// ---------------------------------------------------------------------------
// AC1 — first run: pending intent written before the invoke, committed after.
// ---------------------------------------------------------------------------

describe('WI-571 AC1 — an effectful harness fires once and commits its outbox intent', () => {
  it('invokes the harness, commits the idempotency intent, and advances the card', async () => {
    db = openDb();
    const { adapter, calls } = makeHarnessMaker();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry, { effectful: true });
    seedCard(db);

    await run(flow, registry);

    expect(calls).toHaveLength(1);
    // The intent is COMMITTED (written pending before invoke, committed after success).
    expect(getIntentStatus(db.getStateDb(), idemKey('entry', 'coder'))).toBe('committed');
    expect(getCard(db)?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC2 — resume with a COMMITTED intent: the effect is NOT re-fired.
// ---------------------------------------------------------------------------

describe('WI-571 AC2 — a committed intent on resume skips the invoke (no re-fire)', () => {
  it('does not re-invoke the harness when a committed intent + checkpoint already exist', async () => {
    db = openDb();
    const { adapter, calls } = makeHarnessMaker();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry, { effectful: true });
    seedCard(db);

    // Pre-seed the prior run's committed checkpoint + committed outbox intent.
    const priorOutput: StationOutput<{ summary: string }> = {
      payload: { summary: 'committed' }, findings_hash: 'h', return_to: null, usage: { tokens: 10, cost: 0.01 },
    };
    writeCheckpoint(db.getStateDb(), { flow: '1', card: 'entry', station: 'coder', attempt: 0 }, { stamp: 'prior-stamp', output: priorOutput });
    const key = idemKey('entry', 'coder');
    writePendingIntent(db.getStateDb(), {
      flow: '1', card: 'entry', station: 'coder', attempt: 0, idempotencyKey: key,
      intent: { kind: 'harness', station: 'coder', outputs: ['result.json'] },
    });
    commitIntent(db.getStateDb(), key);
    // The declared output the prior (committed) attempt produced is on disk.
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary: 'committed' }), 'utf-8');

    await run(flow, registry);

    // The effect (harness invoke) was NOT re-fired.
    expect(calls).toHaveLength(0);
    expect(getCard(db)?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC3 — resume with a PENDING intent of unknown outcome: escalate to hold.
// ---------------------------------------------------------------------------

describe('WI-571 AC3 — a pending intent of unknown outcome escalates to hold (never blind-retry)', () => {
  it('holds the card and does NOT re-invoke the harness on a dangling pending intent', async () => {
    db = openDb();
    const { adapter, calls } = makeHarnessMaker();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry, { effectful: true });
    seedCard(db);

    // A PENDING intent, never committed — a crash mid-effect. Whether the effect
    // landed is indeterminate, so the kernel must NOT blind-retry it.
    writePendingIntent(db.getStateDb(), {
      flow: '1', card: 'entry', station: 'coder', attempt: 0, idempotencyKey: idemKey('entry', 'coder'),
      intent: { kind: 'harness', station: 'coder', outputs: ['result.json'] },
    });

    await run(flow, registry);

    // Escalated to hold, and the harness effect was NOT re-fired.
    expect(getCard(db)?.lane).toBe('hold');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — a pure (effectful=false) harness station never touches the outbox.
// ---------------------------------------------------------------------------

describe('WI-571 AC4 — a pure harness station is unaffected by the outbox', () => {
  it('advances a pure harness with NO outbox row written', async () => {
    db = openDb();
    const { adapter, calls } = makeHarnessMaker();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry, { effectful: false });
    seedCard(db);

    await run(flow, registry);

    expect(calls).toHaveLength(1);
    expect(getCard(db)?.lane).toBe('done');
    // A pure station leaves the outbox completely untouched.
    expect(getIntentStatus(db.getStateDb(), idemKey('entry', 'coder'))).toBe('none');
  });
});
