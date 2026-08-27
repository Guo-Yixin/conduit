/**
 * Executor file-delivery SIZE-LIMIT regression (WI-599, Amy FLAG): the Slack
 * upload size limit (maxUploadBytes, WI-597) must be THREADED into the production
 * createSlackTransport call inside performStationDelivery — otherwise an oversized
 * artifact is silently uploaded with Slack's limit unenforced.
 *
 * This file deliberately does NOT mock createSlackTransport (unlike
 * executor-file-delivery.test.ts, whose recording transport bypasses the real
 * size check). It drives the REAL transport so the whole chain is exercised end
 * to end: SLACK_MAX_UPLOAD_BYTES → resolveSlackMaxUploadBytes() →
 * createSlackTransport({ maxUploadBytes }) → uploadFile's pre-network size check.
 *
 * globalThis.fetch is stubbed to a distinctive NON-size rejection and asserted to
 * be NEVER called: the WI-597 size check rejects BEFORE any network call, so with
 * the limit threaded no fetch happens. Without the fix the 1 GiB default leaves
 * the small file under-limit → the transport would reach fetch → the card would
 * hold on a network error, not a size error. So the assertions (card held on a
 * size-named reason + fetch never called) both flip red if the threading regresses.
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

const SECONDS = (n: number) => () => n;
const STATION = 'deliver-station';

function noopAdapter(): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      return { text: '{}', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
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

function setupDeliverFlow(dir: string): FlowConfig {
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: file-delivery-size
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
channels:
  egress:
    - type: slack
      target: "#deliveries"
      uses: [delivery]
stations:
  - id: ${STATION}
    worker: { kind: deterministic, command: "true" }
    inputs: []
    outputs: []
    deliver:
      files: [work/big.jpg]
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function committedOutboxCount(db: ConduitDB): number {
  return (
    db.getStateDb().prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NOT NULL').get() as { n: number }
  ).n;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;
let realFetch: typeof globalThis.fetch;
let fetchCalled = false;
const prevMax = process.env.SLACK_MAX_UPLOAD_BYTES;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-delivery-size-'));
  process.chdir(projectDir);
  db = null;
  // A tiny limit so a small staged file is "oversized" without a huge fixture.
  process.env.SLACK_MAX_UPLOAD_BYTES = '10';
  // Guard against any real network: if the size gate is bypassed, the transport
  // would reach fetch — this stub makes that a fast, distinctive NON-size failure.
  fetchCalled = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.reject(new Error('NETWORK-STUB: fetch must not be reached when the size gate fires'));
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevMax === undefined) delete process.env.SLACK_MAX_UPLOAD_BYTES;
  else process.env.SLACK_MAX_UPLOAD_BYTES = prevMax;
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executor file delivery — Slack size limit is enforced end-to-end (Amy regression)', () => {
  it('holds the card with a diagnosable size error when a declared file exceeds the configured limit, without any upload', async () => {
    const flow = setupDeliverFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    // 100 bytes > the configured 10-byte limit → the real transport's pre-network
    // size check must reject it (WI-597), and performStationDelivery holds the card.
    mkdirSync(join(projectDir, 'work'), { recursive: true });
    writeFileSync(join(projectDir, 'work', 'big.jpg'), 'x'.repeat(100));
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    // The card hard-paused to hold on the delivery failure…
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    // …with a diagnosable, size-naming reason (NOT a raw API/network error).
    const terminal = db.getCardLog('c').find((e) => e.kind === 'terminal');
    expect(terminal).toBeDefined();
    expect((terminal as { reason: string }).reason).toMatch(/size|too large|exceed|limit/i);
    // Nothing was delivered, and the size gate fired BEFORE any network call —
    // proving maxUploadBytes was actually threaded into the transport.
    expect(committedOutboxCount(db)).toBe(0);
    expect(fetchCalled).toBe(false);
  });
});
