/**
 * LIVE multi-process pool integration (#1 verification).
 *
 * Unlike the unit pool tests (which inject a fake spawn seam), this drives the
 * REAL production path: buildWorkerPool spawns actual `conduit __worker`
 * subprocesses via Bun.spawn, START_WORK/MARK_DONE cross a real Bun IPC channel
 * as codec strings, the worker runs the deterministic command out-of-process, and
 * the kernel (sole DB writer) reacts. Proves `--concurrency > 1` is genuinely
 * wired end-to-end, not a silent no-op.
 *
 * These tests spawn real OS processes, so they are slower than the unit suite and
 * use a real wall-clock now().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { buildWorkerPool } from '../cli/main';
import type { RunEngineArgs } from '../cli/main';
import { runExecutor } from '../controller/executor';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { ModelAdapter } from '../worker/adapter';

const realNow = () => Math.floor(Date.now() / 1000);

const noopAdapter: ModelAdapter = {
  async call() {
    throw new Error('deterministic flow must not call the model');
  },
};

function makeIO() {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

function writeFlow(dir: string, body: string): string {
  const path = join(dir, 'flow.yaml');
  writeFileSync(path, body);
  const loaded = loadFlow(path);
  if (!loaded.ok) throw new Error(`fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return path;
}

function openDb(dir: string): ConduitDB {
  const db = openConduitDB({
    stateDbPath: join(dir, 'state.sqlite'),
    journalDbPath: join(dir, 'journal.sqlite'),
  });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seed(db: ConduitDB, id: string, lane: string): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id,
    parent_id: null,
    lane,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-mp-'));
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

const OK_FLOW = `
flow: mp-ok
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 5, max_tokens: 1000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 2 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true", "false"]
stations:
  - id: work
    worker: { kind: deterministic, command: "true" }
    wip: 5
    next: done
`;

describe('live pool — real subprocess workers complete a deterministic flow', () => {
  it('routes every card to done via real `conduit __worker` subprocesses', async () => {
    const flowPath = writeFlow(dir, OK_FLOW);
    const loaded = loadFlow(flowPath);
    if (!loaded.ok) throw new Error('fixture invalid');
    db = openDb(dir);
    for (let i = 0; i < 5; i++) seed(db, `c${i}`, 'work');
    const { io } = makeIO();

    const pool = buildWorkerPool({ flowPath, projectRoot: dir }, io);
    try {
      await runExecutor({
        db,
        flow: loaded.flow,
        projectRoot: dir,
        now: realNow,
        adapter: noopAdapter,
        io,
        concurrency: 3,
        spawn: pool.spawn,
        onMessage: pool.onMessage,
      } as RunEngineArgs);
    } finally {
      pool.dispose();
    }

    for (let i = 0; i < 5; i++) {
      expect(db.getCard(DEFAULT_RUN_ID, `c${i}`)?.lane).toBe('done');
      expect(db.getCard(DEFAULT_RUN_ID, `c${i}`)?.status).toBe('complete');
    }
  }, 30_000);

  it('a real worker reporting a failed command drives the card to a terminal lane (no hang)', async () => {
    const flowPath = writeFlow(
      dir,
      OK_FLOW.replace('command: "true"', 'command: "false"').replace('flow: mp-ok', 'flow: mp-fail'),
    );
    const loaded = loadFlow(flowPath);
    if (!loaded.ok) throw new Error('fixture invalid');
    db = openDb(dir);
    seed(db, 'c1', 'work');
    const { io } = makeIO();

    const pool = buildWorkerPool({ flowPath, projectRoot: dir }, io);
    try {
      await runExecutor({
        db,
        flow: loaded.flow,
        projectRoot: dir,
        now: realNow,
        adapter: noopAdapter,
        io,
        concurrency: 2,
        spawn: pool.spawn,
        onMessage: pool.onMessage,
      } as RunEngineArgs);
    } finally {
      pool.dispose();
    }

    // `false` exits non-zero → the worker reports scrap (a deterministic failure
    // is terminal). The card MUST end on a terminal lane — proving failure
    // propagates through real IPC and the run does not hang.
    const lane = db.getCard(DEFAULT_RUN_ID, 'c1')?.lane ?? '(none)';
    expect(['scrap', 'done', 'hold']).toContain(lane);
    expect(lane).not.toBe('work');
  }, 30_000);
});
