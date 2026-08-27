/**
 * Fixture harness for WI-484 run-namespacing concurrency tests.
 *
 * Provides seeders, helpers, and the cappedClock termination guard used by
 * run-namespacing-concurrency.test.ts to drive two independent runs of the same
 * flow in one shared ConduitDB without cross-run interference.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema, writeCheckpoint, writePendingIntent } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import type { FlowConfig, Card } from '../types/kernel';
import type { ModelAdapter } from '../worker/adapter';

// Re-export DEFAULT_RUN_ID so tests don't need a separate db import.
export { DEFAULT_RUN_ID };

// ---------------------------------------------------------------------------
// IOCapture
// ---------------------------------------------------------------------------

export interface IOCapture {
  io: { out(l: string): void; err(l: string): void };
  lines: string[];
}

export function makeIO(): IOCapture {
  const lines: string[] = [];
  return {
    lines,
    io: {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`[err] ${l}`),
    },
  };
}

// ---------------------------------------------------------------------------
// stubAdapter
// ---------------------------------------------------------------------------

export const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

// ---------------------------------------------------------------------------
// Flow fixture
// ---------------------------------------------------------------------------

const FIXTURE_FLOW_YAML = `flow: two-station
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
  on_dep_scrap: scrap
security:
  bash:
    allow: ["true"]
stations:
  - id: a
    worker:
      kind: deterministic
      command: "true"
    inputs: []
    outputs: []
    next: b
  - id: b
    worker:
      kind: deterministic
      command: "true"
    inputs: []
    outputs: []
    next: done
`;

export function writeFixtureFlow(dir: string): string {
  const fp = join(dir, 'flow.yaml');
  writeFileSync(fp, FIXTURE_FLOW_YAML, 'utf-8');
  return fp;
}

export function loadFixtureFlow(flowPath: string): FlowConfig {
  const result = loadFlow(flowPath);
  if (!result.ok) {
    throw new Error(`fixture flow failed to load: ${result.errors.map((e) => e.message).join(', ')}`);
  }
  return result.flow;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function openTestDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

export function seedRun(db: ConduitDB, runId: string): void {
  db.insertRun({ run_id: runId, flow: 'two-station', input_fingerprint: runId, status: 'running' });
}

export function seedCard(
  db: ConduitDB,
  runId: string,
  over: Partial<Card> & { id: string; lane: string },
): void {
  db.insertCard({
    run_id: runId,
    parent_id: null,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
    ...over,
  });
}

export function seedCheckpoint(
  db: ConduitDB,
  runId: string,
  cardId: string,
  station: string,
  payloadValue: string,
): void {
  writeCheckpoint(
    db.getStateDb(),
    { run: runId, flow: 'two-station', card: cardId, station, attempt: 0 },
    {
      output: { value: payloadValue } as unknown as import('../checkpoint/checkpoint').CheckpointRecord['output'],
      stamp: `stamp-${runId}-${cardId}-${station}`,
    },
  );
}

export function seedPendingIntent(
  db: ConduitDB,
  runId: string,
  cardId: string,
  station: string,
  key: string,
): void {
  writePendingIntent(db.getStateDb(), {
    run: runId,
    flow: 'two-station',
    card: cardId,
    station,
    attempt: 0,
    idempotencyKey: key,
    intent: { kind: 'publish' },
  });
}

// ---------------------------------------------------------------------------
// Engine driver
// ---------------------------------------------------------------------------

export async function driveRun(
  db: ConduitDB,
  flow: FlowConfig,
  runId: string,
  io?: IOCapture,
): Promise<void> {
  const capture = io ?? makeIO();
  await runExecutor({
    db,
    flow,
    now: cappedClock(),
    adapter: stubAdapter,
    io: capture.io,
    runId,
  });
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

export type CardSnapshot = Map<string, { lane: string; status: string }>;

export function getRunCards(db: ConduitDB, runId: string): Map<string, Card> {
  const rows = db
    .getStateDb()
    .prepare('SELECT * FROM cards WHERE run_id = $r')
    .all({ $r: runId }) as Card[];
  const map = new Map<string, Card>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

export function laneCount(db: ConduitDB, runId: string): Record<string, number> {
  const rows = db
    .getStateDb()
    .prepare('SELECT lane, COUNT(*) AS n FROM cards WHERE run_id = $r GROUP BY lane')
    .all({ $r: runId }) as { lane: string; n: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) result[row.lane] = row.n;
  return result;
}

export function outboxStatus(
  db: ConduitDB,
  runId: string,
  idempotencyKey: string,
): 'pending' | 'committed' | 'none' {
  const row = db
    .getStateDb()
    .prepare('SELECT delivered_at FROM outbox WHERE run_id = $r AND idempotency_key = $k')
    .get({ $r: runId, $k: idempotencyKey }) as { delivered_at: number | null } | undefined;
  if (!row) return 'none';
  return row.delivered_at === null ? 'pending' : 'committed';
}

export function snapshotCards(db: ConduitDB, runId: string): CardSnapshot {
  const rows = db
    .getStateDb()
    .prepare('SELECT id, lane, status FROM cards WHERE run_id = $r')
    .all({ $r: runId }) as { id: string; lane: string; status: string }[];
  const map: CardSnapshot = new Map();
  for (const row of rows) map.set(row.id, { lane: row.lane, status: row.status });
  return map;
}

// ---------------------------------------------------------------------------
// cappedClock — termination guard
// ---------------------------------------------------------------------------

/**
 * Returns a clock function that returns `value` on every call but throws after
 * `maxTicks` reads. A correctly-scoped executor exits in a bounded number of
 * ticks; an unscoped one spins across multiple runs and trips the cap.
 */
export function cappedClock(maxTicks = 2000, value = 1000): () => number {
  let ticks = 0;
  return () => {
    if (++ticks > maxTicks) {
      throw new Error(
        `cappedClock: executor exceeded ${maxTicks} ticks — likely an unscoped loop spin across runs`,
      );
    }
    return value;
  };
}
