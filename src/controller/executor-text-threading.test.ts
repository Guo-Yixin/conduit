/**
 * Executor text-egress thread addressing (WI-600): the HITL rank-selection prompt
 * (executor.ts await_selection egressSend, ~line 3549) lands as a THREADED reply
 * on the triggering message when the run's ingress substrate supplies the
 * conventional `thread_ts` field, and unthreaded (+ journaled skip) otherwise.
 *
 * The thread address is resolved via the WI-599 helper resolveThreadAddress(db,
 * card, 'thread_ts') — substrate lives on ingress_events keyed by the run_id
 * (NOT on the card; signature corrected 2026-07-12). A CLI-triggered run has no
 * ingress event → absent → unthreaded + journaled (FR-8 degrade).
 *
 * Harness mirrors executor-rank-hitl.test.ts: createSlackTransport is mocked to a
 * recording transport (its `post` is the observable Slack boundary), everything
 * else — egressSend, the outbox, runRankCheck — is REAL.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, StationConfig, StationRankConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runExecutor } from './executor';

// ── slack.ts module seam: mock createSlackTransport, keep egressSend REAL ──
import * as slackNs from '../channels/slack';
const realSlack: Record<string, unknown> = { ...slackNs };

// The recording post — captures threadTs so we can assert the thread address.
const postSpy = mock(
  async (_req: { channel: string; text: string; correlationId?: string; threadTs?: string }) => ({
    ts: 'ts-hitl-1',
  }),
);
const createSlackTransportMock = mock((_config: { botToken: string }) => ({ post: postSpy }));

mock.module('../channels/slack', () => ({
  ...realSlack, // egressSend / resolveThreadAddress / outbox stay REAL
  createSlackTransport: createSlackTransportMock,
}));

afterAll(() => {
  mock.module('../channels/slack', () => realSlack);
});

const CRITIC_MODEL = 'gpt-4o';
const RANK_STATION = 'select';
const DELIVER_STATION = 'deliver';
const CARD_ID = 'root';
const HITL_CHANNEL = '#content-hitl';
const THREAD_TS = '1699999999.123456';

const SECONDS = (n: number) => () => n;

/** A hand-built fan-in→rank→deliver flow with a HITL-enabled rank station. */
function buildHitlRankFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'select.md'), 'Rank the candidate variants by quality.');

  const rankCheck: StationRankConfig = {
    criticModel: CRITIC_MODEL,
    criticPromptFile: join(dir, 'prompts', 'select.md'),
    criticPromptVersion: '1',
    hitlEnabled: true,
    noSelectionPolicy: 'scrap',
  };
  const select: StationConfig = { kind: 'deterministic', effectful: false, wip: 1, inputs: [], outputs: [], command: 'true', rankCheck };
  const deliver: StationConfig = { kind: 'deterministic', effectful: false, wip: 1, inputs: [], outputs: [], command: 'true' };

  return {
    version: 1,
    stations: { select, deliver },
    terminal_lanes: ['done', 'scrap', 'hold'],
    happyPathNext: { select: DELIVER_STATION, deliver: 'done' },
    budgets: {
      run: { wall_clock_minutes: 10, max_tokens: 100000 },
      per_card: { max_execution_attempts: 4 },
      liveness: { no_progress_minutes: 3 },
    },
    defaults: { capPolicy: 'scrap', onDepScrap: 'scrap', enforceOwnedPaths: false },
    project_root: dir,
    channels: { egress: [{ type: 'slack', target: HITL_CHANNEL, hold_timeout_seconds: 30, on_timeout: 'scrap' }] },
  } as FlowConfig;
}

/** Adapter that returns a rank-critic verdict (short-list, best-first). */
function rankAdapter(): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      return { text: JSON.stringify({ ranking: ['c1', 'c2'], findings: [] }), inputTokens: 10, outputTokens: 6, costUsd: 0.002 };
    },
  };
}

function openFreshDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}

function seedCardAtRank(database: ConduitDB): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: CARD_ID,
    parent_id: null,
    lane: RANK_STATION,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['final.zip'],
    rework_count: 0,
  });
}

/** Record an ingress event that projected `substrate` into the run's substrate. */
function seedSubstrate(database: ConduitDB, substrate: Record<string, unknown>): void {
  database.acceptIngressEvent('evt-1', 1000, {
    flowId: 'text-threading',
    flowPath: join(projectDir, 'flow.yaml'),
    runId: DEFAULT_RUN_ID,
    substrateJson: JSON.stringify(substrate),
  });
}

async function run(flow: FlowConfig): Promise<void> {
  const io = { out: (_l: string) => {}, err: (_l: string) => {} };
  await runExecutor({ db: db!, flow, now: SECONDS(1000), adapter: rankAdapter(), io } as RunEngineArgs);
}

/** The captured HITL post request (the await_selection egressSend → transport.post). */
function hitlPost(): { channel: string; text: string; correlationId?: string; threadTs?: string } {
  expect(postSpy).toHaveBeenCalledTimes(1);
  return postSpy.mock.calls[0]![0];
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-text-threading-'));
  process.chdir(projectDir);
  db = null;
  postSpy.mockClear();
  createSlackTransportMock.mockClear();
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ===========================================================================
// AC1 — the HITL rank prompt threads on the substrate thread_ts (FR-7)
// ===========================================================================

describe('executor text threading — HITL prompt threads on substrate thread_ts (AC1)', () => {
  it('carries the substrate thread_ts on the rank-selection egress text send', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    seedSubstrate(db, { thread_ts: THREAD_TS });

    await run(buildHitlRankFlow(projectDir));

    // The prompt lands as a threaded reply on the triggering message.
    expect(hitlPost().threadTs).toBe(THREAD_TS);
  });
});

// ===========================================================================
// AC2 — substrate present but no thread_ts → unthreaded + journaled skip (FR-8)
// ===========================================================================

describe('executor text threading — degrade to unthreaded + journal when no thread_ts (AC2)', () => {
  it('sends the prompt unthreaded and journals the skipped threading when the substrate lacks thread_ts', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    seedSubstrate(db, { some_other_field: 'x' }); // substrate exists but carries no thread_ts

    await run(buildHitlRankFlow(projectDir));

    // Not blocked — the prompt still goes out, just unthreaded.
    expect(hitlPost().threadTs).toBeUndefined();
    // …and the skipped threading is journaled (diagnosable in explain, FR-8).
    const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, CARD_ID);
    const skipJournaled = spans.some(
      (s) => /thread/i.test(JSON.stringify(s.attributes)) && /skip|unthread|absent|degrad/i.test(JSON.stringify(s.attributes)),
    );
    expect(skipJournaled).toBe(true);
  });
});

// ===========================================================================
// AC3 — a run with NO ingress substrate (CLI-triggered) sends byte-identical,
//       no regression to existing HITL behavior (FR-7/FR-8)
// ===========================================================================

describe('executor text threading — no ingress substrate is byte-identical (AC3)', () => {
  it('sends the HITL prompt exactly as before (unthreaded) for a run with no ingress event', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    // No ingress event recorded — a CLI-triggered run has no substrate.

    await run(buildHitlRankFlow(projectDir));

    const req = hitlPost();
    // Unchanged send: the existing channel, the rank prompt, a correlation id, no thread.
    expect(req.threadTs).toBeUndefined();
    expect(req.channel).toBe(HITL_CHANNEL);
    expect(req.text).toMatch(/select/i);
    expect(req.correlationId).toBeDefined();
  });
});
