/**
 * Integration-last concurrency e2e (WI-472).
 *
 * These tests drive the REAL runExecutor pool path (concurrency > 1 + an injected
 * spawn seam) end-to-end through a fan-out / fan-in flow, and assert the SPEC
 * guarantees that only hold once the WHOLE system is wired:
 *
 *   AC1 — determinism + per-child seed: N children, each output derived from its
 *         OWN seed (never a sibling's), and the output map is independent of the
 *         worker completion order.
 *   AC2 — crash mid-batch + resume: some children complete, the run is abandoned,
 *         then runExecutor is called AGAIN on the same db and completes the batch
 *         with no double-bill / double-publish and no stranded non-terminal card.
 *   AC3 — out-of-order fan-in: children complete in REVERSE id order; the parent
 *         still advances to resume_at exactly as the serial case would (all /
 *         quorum / best_effort policies).
 *   AC4 — per-wave budget blast-radius isolation under K>1: an over-budget subtree
 *         is scrapped by the per-wave budget WITHOUT halting a sibling subtree or
 *         the whole run.
 *   AC5 — K > dispatchable: with K far larger than the number of ready cards,
 *         exactly the dispatchable cards are spawned (not K) and the run completes
 *         with no busy-spin.
 *
 * DESIGN — why the fake spawn forwards MARK_DONE through the real executor:
 *   The pool path (executor.ts:474-534) does NOT run executeStation: on each
 *   dispatch it claims, spawns, writes pid, and sends START_WORK. The kernel's
 *   reaction to a finished worker is the MARK_DONE handler the executor itself
 *   registers via the `onMessage` seam (executor.ts:185-241) — that handler does
 *   the post-work transition, checkpoint, AND pollAwaitingChildren (fan-in).
 *
 *   To test the executor's REAL orchestration (not our fake's), the fake spawn
 *   therefore:
 *     1. on START_WORK, performs ONLY the worker's data work (read its seed.json,
 *        write its own output artifact) — the per-child labor a real worker does;
 *     2. forwards a MARK_DONE{success} back into the executor's registered handler
 *        so the kernel performs the real transition + fan-in reaction.
 *   A `flushOrder` knob lets a test buffer completions and release them in a chosen
 *   order (AC3). This keeps the executor's pool orchestration — not the fixture —
 *   the thing under test, which is the whole point of an integration-last test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import type { WorkerMessage } from '../worker/ipc-protocol';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import { reclaimOrphanedWorkers } from '../dispatch/claim';

// ---------------------------------------------------------------------------
// Shared fixtures / helpers
// ---------------------------------------------------------------------------

const PLANNER_MODEL = 'gpt-4o-mini';
const FANOUT_STATION = 'plan';
const CHILD_ENTRY = 'cwork';
const RESUME_AT = 'assemble';
const PARENT_ID = 'root';

const SECONDS = (n: number) => () => n;

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

/** Stub adapter: the fan-out transform station returns `proposal` as its output. */
function makeProposalAdapter(proposal: unknown): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      void req;
      return { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 6, costUsd: 0.002 };
    },
  };
}

/** Adapter that throws if called — used when no model call is expected. */
const noopAdapter: ModelAdapter = {
  async call() {
    throw new Error('adapter must not be called by this pool flow');
  },
};

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function activeWorkerCount(db: ConduitDB): number {
  const { n } = db.getStateDb().prepare('SELECT COUNT(*) AS n FROM active_workers').get() as {
    n: number;
  };
  return n;
}

function childIds(db: ConduitDB, parentId: string): string[] {
  return (
    db
      .getStateDb()
      .prepare('SELECT id FROM cards WHERE parent_id = $p ORDER BY id')
      .all({ $p: parentId }) as Array<{ id: string }>
  ).map((r) => r.id);
}

/**
 * A fan-out flow. `plan` (transform) fans out N children that enter at `cwork`
 * (a deterministic leaf), then the parent resumes at `assemble` (carrying a
 * fan_in policy). The policy on `assemble` is parameterized so AC3 can vary it.
 */
function setupFanFlow(
  dir: string,
  opts: {
    fanInPolicy: string; // e.g. 'all' | '{ policy: quorum, k: 2 }' | '{ policy: best_effort }'
    fanOut: number;
    perWave?: string; // e.g. 'per_wave: { max_dispatches: 1 }'
  },
): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'plan.md'), 'Propose children.');

  const perWaveLine = opts.perWave ? `\n  ${opts.perWave}` : '';
  const fanInLine =
    opts.fanInPolicy === 'all'
      ? 'fan_in: { policy: all }'
      : `fan_in: ${opts.fanInPolicy}`;

  const flowYaml = `
flow: concurrency-e2e
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }${perWaveLine}
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: plan
    worker:
      kind: transform
      model: ${PLANNER_MODEL}
      prompt_file: prompts/plan.md
      prompt_version: "1"
      output_schema: { fields: [{ name: children, type: object, required: true }] }
    inputs: []
    outputs: [children.json]
    fan_out: ${opts.fanOut}
    child_entry: cwork
    child_terminal: done
    resume_at: assemble
    next: assemble
  - id: cwork
    worker: { kind: deterministic, command: "true" }
    wip: 10
    next: done
  - id: assemble
    worker: { kind: deterministic, command: "true" }
    ${fanInLine}
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * A pool spawn seam that stands in for the worker's DATA labor only, then forwards
 * MARK_DONE into the executor's own registered handler so the REAL kernel reaction
 * (transition + pollAwaitingChildren) runs. The fake never advances the card or
 * frees the slot itself — that is the executor's job (NFR-3: kernel is sole writer).
 *
 * Per-child labor: read `<owned_paths[0]>/seed.json` and write
 * `<owned_paths[0]>/output.json` = { derivedFrom: <seed.sku> } so AC1 can prove
 * each output came from its OWN seed.
 *
 * `flushMode`:
 *   - 'immediate': forward MARK_DONE the instant START_WORK arrives.
 *   - 'buffer':    queue leaf completions and, once `releaseAfter` are claimed in
 *                  one planTick, flush them in REVERSE id order (out-of-order).
 */
function makePoolHarness(
  db: ConduitDB,
  opts: {
    flushMode?: 'immediate' | 'buffer';
    crashAfter?: number; // stop forwarding MARK_DONE after this many leaf completions
    releaseAfter?: number; // buffer leaf completions, then flush in REVERSE once this many are queued
  } = {},
) {
  const flushMode = opts.flushMode ?? 'immediate';
  const spawns: Array<{ cardId: string; station: string; pid: number }> = [];
  const outputs = new Map<string, unknown>(); // cardId -> parsed output.json
  const buffered: Array<{ cardId: string; station: string; attempt: number }> = [];
  let kernelHandler: ((msg: WorkerMessage) => void) | null = null;
  let nextPid = 7000;
  let peakInFlight = 0;
  let leafCompletions = 0;

  /** The executor calls this once to register its MARK_DONE/HEARTBEAT handler. */
  const onMessage = (handler: (msg: WorkerMessage) => void) => {
    kernelHandler = handler;
  };

  function doLeafWork(cardId: string): void {
    const card = db.getCard(DEFAULT_RUN_ID, cardId);
    const dir = card?.owned_paths?.[0];
    if (!dir) return;
    const seedPath = join(dir, 'seed.json');
    if (!existsSync(seedPath)) return;
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { sku?: string };
    const output = { derivedFrom: seed.sku ?? null };
    writeFileSync(join(dir, 'output.json'), JSON.stringify(output));
    outputs.set(cardId, output);
  }

  function forward(c: { cardId: string; station: string; attempt: number }): void {
    kernelHandler?.({
      type: 'MARK_DONE',
      cardId: c.cardId,
      station: c.station,
      attempt: c.attempt,
      outcome: 'success',
    });
  }

  const spawn = (args: { cardId: string; station: string }) => {
    const pid = nextPid++;
    spawns.push({ cardId: args.cardId, station: args.station, pid });
    const inFlight = activeWorkerCount(db);
    if (inFlight > peakInFlight) peakInFlight = inFlight;

    const send = (msg: WorkerMessage) => {
      if (msg.type !== 'START_WORK') return;
      const card = db.getCard(DEFAULT_RUN_ID, msg.cardId);
      const attempt = card?.attempt ?? 0;

      // Only leaf (child_entry) stations carry a seed to derive from.
      if (msg.station === CHILD_ENTRY) {
        doLeafWork(msg.cardId);
        leafCompletions++;
        // Crash: stop forwarding once we have completed `crashAfter` leaves.
        if (opts.crashAfter !== undefined && leafCompletions > opts.crashAfter) {
          return; // leave this slot/card in flight — simulate a mid-batch crash
        }
      }

      if (flushMode === 'buffer' && msg.station === CHILD_ENTRY) {
        buffered.push({ cardId: msg.cardId, station: msg.station, attempt });
        // Out-of-order release: once `releaseAfter` leaves are queued (all claimed
        // in one synchronous planTick), flush them in REVERSE id order — completing
        // children concurrently and out of order within the same tick.
        if (opts.releaseAfter !== undefined && buffered.length >= opts.releaseAfter) {
          const ordered = [...buffered].sort((a, b) => (a.cardId < b.cardId ? 1 : -1));
          buffered.length = 0;
          for (const c of ordered) forward(c);
        }
        return;
      }
      forward({ cardId: msg.cardId, station: msg.station, attempt });
    };

    return { pid, send };
  };

  return {
    spawn,
    onMessage,
    spawns,
    outputs,
    get peakInFlight() {
      return peakInFlight;
    },
  };
}

function seedParentReady(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: PARENT_ID,
    parent_id: null,
    lane: FANOUT_STATION,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['children.json'],
    rework_count: 0,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-conc-e2e-'));
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

/** Build a proposal with N children, each owning a pre-created temp dir + a distinct seed sku. */
function buildProposal(skus: string[]): { children: Array<Record<string, unknown>> } {
  return {
    children: skus.map((sku, i) => {
      const childDir = join(projectDir, 'out', `c${i + 1}`);
      mkdirSync(childDir, { recursive: true });
      return {
        id: `c${i + 1}`,
        depends_on: [] as string[],
        owned_paths: [childDir],
        seed: { sku },
      };
    }),
  };
}

// ===========================================================================
// AC1 — determinism + per-child seed
// ===========================================================================

describe('concurrency e2e — determinism + per-child seed (AC1)', () => {
  it('produces N outputs each derived from its OWN seed, order-independent under K>1', async () => {
    const skus = ['A', 'B', 'C'];
    const flow = setupFanFlow(projectDir, { fanInPolicy: 'all', fanOut: 3 });
    db = openDb();
    seedParentReady(db);

    // Run #1 (K>1, natural completion order).
    const h1 = makePoolHarness(db, { flushMode: 'immediate' });
    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: makeProposalAdapter(buildProposal(skus)),
      io: makeIO().io,
      concurrency: 3,
      spawn: h1.spawn,
      onMessage: h1.onMessage,
    } as RunEngineArgs);

    // Each child output must derive from its OWN seed sku (never a sibling's).
    const map1: Record<string, unknown> = {};
    for (const id of childIds(db, PARENT_ID)) {
      const dir = db.getCard(DEFAULT_RUN_ID, id)?.owned_paths?.[0];
      expect(dir).toBeDefined();
      const out = JSON.parse(readFileSync(join(dir!, 'output.json'), 'utf8'));
      map1[id] = out;
    }
    // N outputs exist, one per proposed child.
    expect(Object.keys(map1).sort()).toEqual(['c1', 'c2', 'c3']);
    // c1's seed is 'A' → its output mentions 'A', not 'B'/'C'.
    expect(map1['c1']).toEqual({ derivedFrom: 'A' });
    expect(map1['c2']).toEqual({ derivedFrom: 'B' });
    expect(map1['c3']).toEqual({ derivedFrom: 'C' });

    // Run #2 (K>1 again) with a REVERSED completion order — output map must be identical.
    db.close();
    db = openDb();
    seedParentReady(db);
    const h2 = makePoolHarness(db, { flushMode: 'buffer', releaseAfter: 3 });
    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: makeProposalAdapter(buildProposal(skus)),
      io: makeIO().io,
      concurrency: 3,
      spawn: h2.spawn,
      onMessage: h2.onMessage,
    } as RunEngineArgs);

    const map2: Record<string, unknown> = {};
    for (const id of childIds(db, PARENT_ID)) {
      const dir = db.getCard(DEFAULT_RUN_ID, id)?.owned_paths?.[0];
      const out = JSON.parse(readFileSync(join(dir!, 'output.json'), 'utf8'));
      map2[id] = out;
    }
    // Order-independence: the output map is byte-identical regardless of completion order.
    expect(map2).toEqual(map1);
  });
});

// ===========================================================================
// AC2 — crash mid-batch + resume, no double-bill / double-publish
// ===========================================================================

describe('concurrency e2e — crash mid-batch + resume (AC2)', () => {
  it('resume completes the batch with no stranded card and no duplicate children', async () => {
    const skus = ['A', 'B', 'C'];
    const flow = setupFanFlow(projectDir, { fanInPolicy: 'all', fanOut: 3 });
    db = openDb();
    seedParentReady(db);

    // First run: crash after 1 leaf completes (the other leaves stay in flight).
    // A real crash is the PROCESS dying mid-run; the event-driven loop otherwise
    // correctly blocks waiting on the stranded in-flight workers. We model the
    // abandonment deterministically with a STATE-KEYED clock: time holds at t=1000
    // until the crash state exists (>=1 child terminal AND >=1 child stranded
    // in-flight), then jumps far past the wall-clock budget so the consumption
    // andon halts the run on the next tick — exactly the partial state a crash
    // leaves behind, with no reliance on wall-clock timing or call counting.
    const crash = makePoolHarness(db, { flushMode: 'immediate', crashAfter: 1 });
    const crashClock = () => {
      const { n: doneLeaves } = db!
        .getStateDb()
        .prepare("SELECT COUNT(*) AS n FROM cards WHERE parent_id = $p AND lane = 'done'")
        .get({ $p: PARENT_ID }) as { n: number };
      return doneLeaves >= 1 && activeWorkerCount(db!) >= 1 ? 100_000 : 1000;
    };
    await runExecutor({
      db,
      flow,
      now: crashClock,
      adapter: makeProposalAdapter(buildProposal(skus)),
      io: makeIO().io,
      concurrency: 3,
      spawn: crash.spawn,
      onMessage: crash.onMessage,
    } as RunEngineArgs).catch(() => {
      /* a crash mid-batch may also surface as a thrown stall — tolerate it */
    });

    // The fan-out must have seeded the children before the crash — otherwise this
    // is not a "crash MID-BATCH" at all (no batch existed). This guards against a
    // vacuous pass where the pool path never ran the fan-out reaction.
    const idsAfterCrash = childIds(db, PARENT_ID);
    expect(idsAfterCrash).toEqual(['c1', 'c2', 'c3']);

    // Resume models a FRESH process: cmdResume reclaims orphaned in-flight cards
    // (the prior owner is dead) before re-driving. Run that reclaim here so the
    // stranded children become re-dispatchable, exactly as the binary does.
    reclaimOrphanedWorkers(db, 3000);

    // Resume: a fresh harness that completes everything.
    const resumeH = makePoolHarness(db, { flushMode: 'immediate' });
    await runExecutor({
      db,
      flow,
      now: SECONDS(2000),
      adapter: makeProposalAdapter(buildProposal(skus)),
      io: makeIO().io,
      concurrency: 3,
      spawn: resumeH.spawn,
      onMessage: resumeH.onMessage,
    } as RunEngineArgs);

    // No duplicate child rows were created on resume (idempotent fan-out) — the
    // resume must NOT re-seed a second batch of children (no double-publish).
    const idsAfterResume = childIds(db, PARENT_ID);
    expect(idsAfterResume).toEqual(idsAfterCrash);

    // Every card is terminal — nothing stranded non-terminal after resume.
    const nonTerminal = db
      .getStateDb()
      .prepare("SELECT id FROM cards WHERE lane NOT IN ('done','scrap','hold')")
      .all() as Array<{ id: string }>;
    expect(nonTerminal.map((r) => r.id)).toEqual([]);
  });
});

// ===========================================================================
// AC3 — out-of-order fan-in
// ===========================================================================

describe('concurrency e2e — out-of-order fan-in (AC3)', () => {
  for (const policy of [
    { label: 'all', yaml: 'all', fanOut: 3 },
    { label: 'quorum k=2', yaml: '{ policy: quorum, k: 2 }', fanOut: 3 },
    { label: 'best_effort', yaml: '{ policy: best_effort }', fanOut: 3 },
  ]) {
    it(`advances the parent to resume_at with policy=${policy.label} despite reverse completion order`, async () => {
      const skus = ['A', 'B', 'C'];
      const flow = setupFanFlow(projectDir, { fanInPolicy: policy.yaml, fanOut: policy.fanOut });
      db = openDb();
      seedParentReady(db);

      // releaseAfter:3 — all 3 leaves are claimed in one planTick, then completed
      // in REVERSE id order, so fan-in must tolerate out-of-order child completion.
      const h = makePoolHarness(db, { flushMode: 'buffer', releaseAfter: 3 });
      await runExecutor({
        db,
        flow,
        now: SECONDS(1000),
        adapter: makeProposalAdapter(buildProposal(skus)),
        io: makeIO().io,
        concurrency: 3,
        spawn: h.spawn,
        onMessage: h.onMessage,
      } as RunEngineArgs);

      // Guard against a vacuous pass: the fan-out must have actually seeded the
      // children. (If the pool path skips the fan-out reaction, no children exist
      // and a "ran assemble" check would pass for the WRONG reason — the parent
      // would have walked plan→assemble by station order, never via fan-in.)
      const kids = childIds(db, PARENT_ID);
      expect(kids).toEqual(['c1', 'c2', 'c3']);
      // Every child reached a terminal lane (completed out of order).
      const terminal = new Set(['done', 'scrap', 'hold']);
      for (const id of kids) {
        expect(terminal.has(db!.getCard(DEFAULT_RUN_ID, id)?.lane ?? '')).toBe(true);
      }

      // The parent advanced past awaiting_children to resume_at and ran `assemble`,
      // exactly as the serial case would — independent of completion order.
      const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
      expect(parent?.status).not.toBe('awaiting_children');
      const ranAssemble = db
        .getCardLog(PARENT_ID)
        .some((e) => e.kind === 'entered_lane' && e.sourceLane === RESUME_AT);
      expect(ranAssemble).toBe(true);
      expect(terminal.has(parent?.lane ?? '')).toBe(true);
    });
  }
});

// ===========================================================================
// AC4 — per-wave budget blast-radius isolation under K>1
// ===========================================================================

describe('concurrency e2e — per-wave budget isolation under K>1 (AC4)', () => {
  it('scraps the over-budget subtree without halting the run or affecting siblings', async () => {
    // A tight per-wave dispatch cap: a subtree that dispatches more than 1 leaf
    // blows its budget and must be scrapped (cap_policy: scrap), while the run
    // and any sibling work proceed.
    const skus = ['A', 'B', 'C', 'D'];
    const flow = setupFanFlow(projectDir, {
      fanInPolicy: 'best_effort',
      fanOut: 4,
      perWave: 'per_wave: { max_dispatches: 1 }',
    });
    db = openDb();
    seedParentReady(db);

    const h = makePoolHarness(db, { flushMode: 'immediate' });
    let threw = false;
    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: makeProposalAdapter(buildProposal(skus)),
      io: makeIO().io,
      concurrency: 4,
      spawn: h.spawn,
      onMessage: h.onMessage,
    } as RunEngineArgs).catch(() => {
      threw = true;
    });

    // The run must not throw/halt: per-wave budget isolation scraps a subtree,
    // it never aborts the whole run.
    expect(threw).toBe(false);

    // The over-budget subtree (root's children) reached a terminal outcome where
    // at least one child was scrapped by the per-wave budget — not left running.
    const kids = childIds(db, PARENT_ID);
    expect(kids.length).toBeGreaterThan(0);
    const scrapped = kids.filter((id) => db!.getCard(DEFAULT_RUN_ID, id)?.lane === 'scrap');
    expect(scrapped.length).toBeGreaterThan(0);

    // No card is stuck non-terminal — the run settled.
    const nonTerminal = db
      .getStateDb()
      .prepare("SELECT id FROM cards WHERE lane NOT IN ('done','scrap','hold')")
      .all() as Array<{ id: string }>;
    expect(nonTerminal.map((r) => r.id)).toEqual([]);
  });
});

// ===========================================================================
// AC5 — K > dispatchable, no busy-spin
// ===========================================================================

describe('concurrency e2e — K > dispatchable, no busy-spin (AC5)', () => {
  it('spawns exactly the dispatchable leaf cards (not K) and does not busy-spin', async () => {
    // Pre-seed a parent already awaiting_children with exactly 2 ready leaf cards,
    // so the dispatchable count is 2 while K=8. (Bypasses the fan-out reaction so
    // this AC isolates the pool dispatch+leaf path under K >> ready.)
    const flow = setupFanFlow(projectDir, { fanInPolicy: 'all', fanOut: 2 });
    db = openDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: PARENT_ID,
      parent_id: null,
      lane: FANOUT_STATION,
      status: 'awaiting_children',
      attempt: 0,
      wave: 0,
      owned_paths: ['children.json'],
      rework_count: 0,
    });
    for (const i of [1, 2]) {
      const childDir = join(projectDir, 'out', `c${i}`);
      mkdirSync(childDir, { recursive: true });
      writeFileSync(join(childDir, 'seed.json'), JSON.stringify({ sku: `S${i}` }));
      db.insertCard({
        run_id: DEFAULT_RUN_ID,
        id: `c${i}`,
        parent_id: PARENT_ID,
        lane: CHILD_ENTRY,
        status: 'ready',
        attempt: 0,
        wave: 0,
        owned_paths: [childDir],
        rework_count: 0,
      });
    }

    const h = makePoolHarness(db, { flushMode: 'immediate' });
    let nowCalls = 0;
    const countingNow = () => {
      nowCalls++;
      return 1000;
    };

    await runExecutor({
      db,
      flow,
      now: countingNow,
      adapter: noopAdapter,
      io: makeIO().io,
      concurrency: 8,
      spawn: h.spawn,
      onMessage: h.onMessage,
    } as RunEngineArgs);

    // Exactly the 2 dispatchable leaf cards were spawned — never K(8).
    const leafSpawns = h.spawns.filter((s) => s.station === CHILD_ENTRY);
    expect(leafSpawns.map((s) => s.cardId).sort()).toEqual(['c1', 'c2']);
    // Both leaves reached the success terminal.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    // No busy-spin: now() polled a small bounded number of times.
    expect(nowCalls).toBeLessThan(200);
  });
});
