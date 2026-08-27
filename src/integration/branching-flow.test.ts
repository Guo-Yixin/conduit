/**
 * Real branching example flow — Studio-style fan-out + rank + HITL (WI-399).
 *
 * PRD "Real branching example flow" + NFR1 (flow-is-config). This drives the
 * COMMITTED example flow at `examples/branching/flow.yaml` end-to-end through the
 * REAL runExecutor (the full WI-396 fan-out → WI-397 quorum fan-in → WI-398
 * rank+HITL chain), proving the production-line shape runs as CONFIG + PROMPT
 * TEMPLATES with zero kernel-code changes.
 *
 * ---------------------------------------------------------------------------
 * Example-flow contract this file pins for examples/branching/flow.yaml
 * ---------------------------------------------------------------------------
 * A loadable (fail-closed, zero errors) flow.yaml with this shape:
 *
 *   brief    — FAN-OUT station (transform). Declares fan_out: N (N>=2),
 *              child_entry, child_terminal, resume_at. Its worker output is the
 *              ArchitectProposal { children: [...] }.
 *   draft    — child station (transform; has a real prompt template).
 *   publish  — child station; the child sub-path is draft -> publish -> <child_terminal>.
 *   assemble — the resume_at station; carries the quorum fan_in policy
 *              ({ policy: quorum, k }).  next -> rank.
 *   rank     — RANK station (check.kind: rank, HITL enabled via an egress
 *              channel). next -> the post-rank delivery station.
 *   deliver  — post-rank delivery terminal station.
 *
 * Real prompt templates exist under examples/branching/prompts/ for at least the
 * brief, draft, and rank stations.
 *
 * The test reads the topology (fan-out station, fan_out count, rank station, its
 * critic model, the fan-out station's model) FROM THE LOADED FLOW, so it adapts
 * to the exact station ids / model names the example chooses — it pins SHAPE and
 * BEHAVIOUR, not arbitrary naming.
 *
 * TEST SEAMS (same as WI-398): the model boundary is a deterministic stub
 * adapter; the Slack network is observed via a mocked createSlackTransport
 * (postSpy = the real .post); getRecordedHitlSelection is mocked to inject the
 * human pick on resume. The loader, FSM, fan-out/fan-in, rank check, and outbox
 * all run for REAL.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, StationConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow, type LoadFlowResult } from '../flow/load';
import { runExecutor } from '../controller/executor';

// ── slack.ts seam: observe transport.post; control the recorded selection ──
import * as slackNs from '../channels/slack';
const realSlack: Record<string, unknown> = { ...slackNs };
const postSpy = mock(async (_req: { channel: string; text: string; correlationId?: string }) => ({
  ts: 'ts-branching-1',
}));
const createSlackTransportMock = mock((_config: { botToken: string }) => ({ post: postSpy }));
let recordedSelection: string | null = null;
const getRecordedHitlSelectionMock = mock((_db: unknown, _cardId: string) => recordedSelection);
mock.module('../channels/slack', () => ({
  ...realSlack,
  createSlackTransport: createSlackTransportMock,
  getRecordedHitlSelection: getRecordedHitlSelectionMock,
}));
afterAll(() => {
  mock.module('../channels/slack', () => realSlack);
});

// The committed example lives at examples/branching/; BRANCHING_FLOW_DIR overrides
// it (used only to validate the test harness against an identical scratch flow).
const FLOW_DIR = process.env.BRANCHING_FLOW_DIR ?? join(import.meta.dir, '..', '..', 'examples', 'branching');
const FLOW_YAML = join(FLOW_DIR, 'flow.yaml');
const SRC_DIR = join(import.meta.dir, '..');
const PARENT_ID = 'root';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected example flow to load, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

function loadExample(): FlowConfig {
  return expectOk(loadFlow(FLOW_YAML));
}

/** The fan-out station id = the station that declares child_entry (WI-393). */
function fanOutStationId(flow: FlowConfig): string {
  const entry = Object.entries(flow.stations).find(([, s]) => s.child_entry !== undefined);
  if (!entry) throw new Error('example flow declares no fan-out station (no child_entry)');
  return entry[0];
}

/** The rank station id = the station that carries rankCheck (WI-398). */
function rankStationId(flow: FlowConfig): string {
  const entry = Object.entries(flow.stations).find(([, s]) => s.rankCheck !== undefined);
  if (!entry) throw new Error('example flow declares no rank station (no rankCheck)');
  return entry[0];
}

/** Proposal the fan-out worker "returns": N variant children with disjoint paths. */
function proposalFor(n: number): { children: Array<{ id: string; depends_on: string[]; owned_paths: string[] }> } {
  return {
    children: Array.from({ length: n }, (_v, i) => ({
      id: `v${i + 1}`,
      depends_on: [],
      owned_paths: [`out/v${i + 1}.md`],
    })),
  };
}

/**
 * Deterministic stub adapter, keyed on the LOADED flow's model ids:
 *   - the fan-out station's model      → the ArchitectProposal (N children);
 *   - the rank station's critic model  → a RankCriticVerdict (ranking + findings);
 *   - any other transform model        → an object satisfying that station's
 *                                        output_schema (so the transform validates).
 */
function buildStudioAdapter(flow: FlowConfig): ModelAdapter {
  const fanOutId = fanOutStationId(flow);
  const rankId = rankStationId(flow);
  const fanOutModel = flow.stations[fanOutId]!.model;
  const rankModel = flow.stations[rankId]!.rankCheck!.criticModel;
  const n = flow.stations[fanOutId]!.fan_out ?? 0;
  const proposal = proposalFor(n);

  const modelToStation: Record<string, string> = {};
  for (const [id, s] of Object.entries(flow.stations)) {
    if (s.model) modelToStation[s.model] = id;
  }

  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      let payload: unknown;
      if (req.model === fanOutModel) {
        payload = proposal;
      } else if (req.model === rankModel) {
        payload = { ranking: proposal.children.map((c) => c.id), findings: [] };
      } else {
        // Satisfy the calling station's declared output_schema.
        const stationId = modelToStation[req.model];
        const fields = (stationId && flow.stations[stationId]?.output_schema?.fields) || [];
        const obj: Record<string, unknown> = {};
        for (const f of fields) obj[f.name] = f.type === 'object' ? {} : f.type === 'number' ? 1 : 'x';
        payload = obj;
      }
      return { text: JSON.stringify(payload), inputTokens: 10, outputTokens: 6, costUsd: 0.001 };
    },
  };
}

function recursiveFileSizes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[p] = statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let workspace: string;
let db: ConduitDB | null;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'conduit-branching-'));
  db = null;
  recordedSelection = null;
  postSpy.mockClear();
  createSlackTransportMock.mockClear();
  getRecordedHitlSelectionMock.mockClear();
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  rmSync(workspace, { recursive: true, force: true });
});

function openFreshDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}

/** Drive the example flow once through the REAL runExecutor (artifacts → workspace). */
async function drive(flow: FlowConfig): Promise<void> {
  await runExecutor({
    db: db!,
    flow,
    now: () => 1000,
    adapter: buildStudioAdapter(flow),
    io: { out: () => {}, err: () => {} },
    projectRoot: workspace,
  } as RunEngineArgs);
}

function childCards(database: ConduitDB, parentId: string): Array<{ id: string; owned_paths: string[] }> {
  const rows = database
    .getStateDb()
    .prepare('SELECT id FROM cards WHERE parent_id = $p ORDER BY id')
    .all({ $p: parentId }) as Array<{ id: string }>;
  return rows.map((r) => ({ id: r.id, owned_paths: database.getCard(DEFAULT_RUN_ID, r.id)?.owned_paths ?? [] }));
}

// ===========================================================================
// AC1 — the example flow.yaml loads fail-closed with ZERO validation errors and
//        declares the full branching shape (fan-out topology, quorum fan-in,
//        rank+HITL).
// ===========================================================================

describe('branching example — flow.yaml loads and declares the full shape (WI-399 AC1)', () => {
  it('loads examples/branching/flow.yaml with zero validation errors', () => {
    const result = loadFlow(FLOW_YAML);
    expect(result.ok).toBe(true);
  });

  it('declares a fan-out station with child_entry/child_terminal/resume_at, a quorum fan-in, and a rank+HITL station', () => {
    const flow = loadExample();

    const fanOutId = fanOutStationId(flow);
    const fanOut = flow.stations[fanOutId]!;
    expect(fanOut.fan_out).toBeGreaterThanOrEqual(2);
    expect(fanOut.child_entry).toBeDefined();
    expect(fanOut.child_terminal).toBeDefined();
    expect(fanOut.resume_at).toBeDefined();

    // The resume_at station carries the quorum fan-in policy (WI-397).
    const resumeStation = flow.stations[fanOut.resume_at!]!;
    expect(resumeStation.fan_in).toEqual({ policy: 'quorum', k: expect.any(Number) });

    // A rank station with HITL enabled (WI-398).
    const rank = flow.stations[rankStationId(flow)]!;
    expect(rank.rankCheck!.hitlEnabled).toBe(true);
  });
});

// ===========================================================================
// AC2 — the real prompt templates referenced by the brief/draft/rank stations
//        exist on disk under examples/branching/.
// ===========================================================================

describe('branching example — real prompt templates exist (WI-399 AC2)', () => {
  it('has the prompt files referenced by its model stations on disk', () => {
    const flow = loadExample();
    const referenced: string[] = [];
    for (const s of Object.values(flow.stations)) {
      if (s.prompt_file) referenced.push(s.prompt_file);
      if (s.rankCheck?.criticPromptFile) referenced.push(s.rankCheck.criticPromptFile);
    }
    // At least the brief, draft, and rank templates are referenced…
    expect(referenced.length).toBeGreaterThanOrEqual(3);
    // …and every referenced prompt file actually exists on disk.
    for (const f of referenced) {
      expect(existsSync(f)).toBe(true);
    }
  });
});

// ===========================================================================
// AC3 — driving the example fans out into the declared number of child cards,
//        each with a disjoint owned-path namespace, and reaches a HELD card at
//        the rank station awaiting a human pick.
// ===========================================================================

describe('branching example — fans out and holds at the rank station (WI-399 AC3)', () => {
  it('seeds N disjoint-path children and parks the parent held at the rank station', async () => {
    const flow = loadExample();
    const fanOutId = fanOutStationId(flow);
    const rankId = rankStationId(flow);
    const declaredN = flow.stations[fanOutId]!.fan_out!;

    db = openFreshDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: PARENT_ID,
      parent_id: null,
      lane: fanOutId,
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: ['plan.json'],
      rework_count: 0,
    });

    recordedSelection = null; // no human pick yet
    await drive(flow);

    // Fanned out into exactly the declared number of child cards…
    const kids = childCards(db, PARENT_ID);
    expect(kids).toHaveLength(declaredN);

    // …each owning a namespace disjoint from every sibling.
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const left = new Set(kids[i]!.owned_paths);
        for (const p of kids[j]!.owned_paths) expect(left.has(p)).toBe(false);
      }
    }

    // The HITL short-list was posted and the parent is held at the rank station.
    expect(postSpy).toHaveBeenCalled();
    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    expect(parent?.status).toBe('held');
    expect(parent?.lane).toBe(rankId);
  });
});

// ===========================================================================
// AC4 — after a human selection is injected (conduit reply / getRecordedHitl-
//        Selection), resuming delivers the selected variant to the post-rank
//        terminal.
// ===========================================================================

describe('branching example — resume after selection delivers to terminal (WI-399 AC4)', () => {
  it('un-holds the rank card on a recorded selection and reaches the post-rank terminal', async () => {
    const flow = loadExample();
    const fanOutId = fanOutStationId(flow);

    db = openFreshDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: PARENT_ID,
      parent_id: null,
      lane: fanOutId,
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: ['plan.json'],
      rework_count: 0,
    });

    // Run to the HITL hold.
    recordedSelection = null;
    await drive(flow);
    expect(db.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held'); // precondition

    // A human records a selection (via conduit reply / WI-394), then resume.
    recordedSelection = 'v2';
    await drive(flow);

    // The recorded selection was consulted and the card reached a terminal lane.
    expect(getRecordedHitlSelectionMock).toHaveBeenCalled();
    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    expect(parent?.status).not.toBe('held');
    expect(parent?.lane).toBe('done');
  });
});

// ===========================================================================
// AC5 + AC6 — flow-is-config: driving the example requires zero kernel-code
//        changes — running it does not create or modify any file under src/.
// ===========================================================================

describe('branching example — running it modifies no kernel source (WI-399 AC5, AC6)', () => {
  it('leaves the src/ tree byte-for-byte unchanged after a full run', async () => {
    const flow = loadExample();
    const fanOutId = fanOutStationId(flow);

    const before = recursiveFileSizes(SRC_DIR);

    db = openFreshDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: PARENT_ID,
      parent_id: null,
      lane: fanOutId,
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: ['plan.json'],
      rework_count: 0,
    });
    recordedSelection = 'v2';
    await drive(flow); // hold
    await drive(flow); // resume → deliver

    const after = recursiveFileSizes(SRC_DIR);
    // No src/ file was created, deleted, or resized by running the flow.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });
});
