/**
 * First controller-driven END-TO-END test (WI-358).
 *
 * The risk-mitigation oracle for Phase 3: drive a linear gated flow
 * (deterministic → transform → gate) from a seeded entry card to a terminal
 * lane through the REAL controller — planTick + transition matrix + atomic claim
 * + runExecutor (WI-356) — NOT the reference-flow harness. The ModelAdapter and
 * clock are stubbed for determinism; no real model call is ever made.
 *
 * Proves, before any real dogfood run (WI-359):
 *   - forward routing by declared `next` (happyPathNext), not YAML insertion order
 *   - deterministic entry station → transform → gate → done, artifact produced
 *   - a gate reject → bounded rework via the declared back-edge → pass → done
 *   - always-reject → rework cap exhausted → scrap (no infinite loop)
 *   - lane AND status transitions are correct (not just the final artifact)
 *   - no LLM enters the control loop (adapter called only by station workers)
 *   - resume is idempotent: completed/checkpointed stations are not re-executed
 *   - a consumption andon halts the run and surfaces the reason
 *
 * Drives runExecutor directly with an in-memory ConduitDB. Tests chdir into a
 * temp project dir so flow project_root '.' + artifact I/O resolve there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import { attemptClaim, beginWork, reclaimOrphanedWorkers } from '../dispatch/claim';

// ---------------------------------------------------------------------------
// Stub ModelAdapter — records calls; branches on req.model so one adapter serves
// the transform worker (gpt-4o-mini) and the gate critic (gpt-4o), exactly as
// the real wiring does (runGateCheck uses the injected adapter).
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gpt-4o-mini';
const CRITIC_MODEL = 'gpt-4o';

function makeStubAdapter(opts: { gateRejectsBeforePass?: number } = {}): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  let gateRejectsLeft = opts.gateRejectsBeforePass ?? 0;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        if (gateRejectsLeft > 0) {
          gateRejectsLeft--;
          return {
            text: JSON.stringify({ verdict: 'reject', findings: ['needs work'], return_to: 'ideate' }),
            inputTokens: 8,
            outputTokens: 4,
            costUsd: 0.002,
          };
        }
        return {
          text: JSON.stringify({ verdict: 'pass', findings: [] }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      }
      return {
        text: JSON.stringify({ idea: 'a shoppable widget idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

function callsTo(calls: ModelCall[], model: string): number {
  return calls.filter((c) => c.model === model).length;
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

// ---------------------------------------------------------------------------
// Flow fixtures (written into a temp project dir, loaded by the real loader).
// ---------------------------------------------------------------------------

/**
 * Linear gated flow: deterministic fetch_context (cp seed.json → context.json)
 * → transform ideate (gate-checked) → done. Mirrors the dogfood shape.
 */
function setupLinearGatedFlow(dir: string, opts: { maxTokens?: number } = {}): FlowConfig {
  const maxTokens = opts.maxTokens ?? 100000;
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ topic: 'widgets' }));

  const flowYaml = `
flow: real-run-e2e
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [cp]
stations:
  - id: fetch_context
    worker: { kind: deterministic, command: cp, args: [seed.json, context.json] }
    inputs: [seed.json]
    outputs: [context.json]
    next: ideate
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
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: ideate
      rework_cap: 2
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * Deterministic-only flow whose YAML insertion order is [a, b, c] but whose
 * `next` declares a → c → b → done. Reaching done proves routing follows the
 * declared topology, not insertion order (FR-2). Stations run `true`.
 */
function setupTopologyFlow(dir: string): FlowConfig {
  const flowYaml = `
flow: real-run-topo
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: a
    worker: { kind: deterministic, command: "true" }
    next: c
  - id: b
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: c
    worker: { kind: deterministic, command: "true" }
    next: b
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`topology fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
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
    owned_paths: over.owned_paths ?? ['context.json', 'idea.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function checkpointStamps(db: ConduitDB, station: string): string[] {
  return (
    db
      .getStateDb()
      .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s ORDER BY attempt')
      .all({ $s: station }) as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-e2e-'));
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

// ===========================================================================
// AC1 — happy path: deterministic entry → ideate → gate pass → done + artifact.
// ===========================================================================

describe('e2e — happy path to done (AC1)', () => {
  it('drives the seeded card through fetch_context → ideate → gate(pass) to lane=done with the artifact produced', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    // AC4: assert lane AND status transitions, not just the artifact.
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    // The deterministic station produced context.json; the transform produced idea.json.
    expect(existsSync(join(projectDir, 'idea.json'))).toBe(true);
    expect(statSync(join(projectDir, 'idea.json')).size).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AC2 — gate reject → declared back-edge rework → pass → done; rework count++1.
// ===========================================================================

describe('e2e — gate reject then rework then pass (AC2)', () => {
  it('routes back to ideate via the back-edge, re-runs, reaches done, and increments the durable rework count exactly once', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 1 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    // Exactly one rework cycle was recorded on the durable counter.
    expect(card?.rework_count).toBe(1);
    // The back-edge re-ran ideate: initial + one rework = 2 worker calls.
    expect(callsTo(calls, WORKER_MODEL)).toBe(2);
  });
});

// ===========================================================================
// AC3 — always reject → rework cap exhausted → scrap (no infinite loop).
// ===========================================================================

describe('e2e — rework cap exhaustion scraps (AC3)', () => {
  it('lands the card at lane=scrap once every gate attempt rejects (terminates, no infinite loop)', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 99 });
    const { io } = makeIO();

    // If this test completes at all, there was no infinite loop.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
  });
});

// ===========================================================================
// AC4 (cross-cutting) — routing flows through the REAL declared topology, not
//   YAML insertion order. (No reference-flow-runner import anywhere in this file.)
// ===========================================================================

describe('e2e — declared-topology routing through the real controller (AC4/FR-2)', () => {
  it('follows next a→c→b→done even though insertion order is [a, b, c]', async () => {
    const flow = setupTopologyFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done'); // insertion order would route a→b and never reach done this way
    expect(card?.status).toBe('complete');
  });
});

// ===========================================================================
// No LLM in the control loop — the adapter is invoked only by station workers
// (transform) + the gate critic, never by routing/dispatch.
// ===========================================================================

describe('e2e — no LLM in the control loop (NFR-3)', () => {
  it('invokes the adapter exactly once per station model call on the happy path (1 worker + 1 critic)', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    // The deterministic station makes ZERO model calls; ideate=1, critic=1, total=2.
    expect(callsTo(calls, WORKER_MODEL)).toBe(1);
    expect(callsTo(calls, CRITIC_MODEL)).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

// ===========================================================================
// Resume is idempotent — re-running the executor over a completed flow does NOT
// re-execute or re-bill checkpointed stations; the binding stamps are stable
// (bind-stamp match → reuse). (Deep stamp-mismatch behavior is unit-tested in
// checkpoint.test.ts; this is the e2e idempotency guard.)
// ===========================================================================

describe('e2e — resume does not re-execute checkpointed stations', () => {
  it('a second run over the completed flow makes no new model calls and keeps the binding stamps stable', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    // Run 1 — drive to done; checkpoints are written for the completed stations.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const callsAfterRun1 = calls.length;
    const ideateStampsAfterRun1 = checkpointStamps(db, 'ideate');
    expect(ideateStampsAfterRun1.length).toBeGreaterThan(0);

    // Run 2 (resume) — the card is terminal/checkpointed; nothing re-executes.
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(calls.length).toBe(callsAfterRun1); // no station re-billed
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(checkpointStamps(db, 'ideate')).toEqual(ideateStampsAfterRun1); // stamps stable
  });
});

// ===========================================================================
// Consumption andon — a tripped token budget halts the run before done and
// surfaces the reason. (Operator-facing exit codes are covered at the CLI layer
// in src/cli/cli.test.ts; here we assert the executor-level halt.)
// ===========================================================================

describe('e2e — consumption andon halts the run', () => {
  it('halts before done and surfaces a budget/token reason when the token andon trips', async () => {
    const flow = setupLinearGatedFlow(projectDir, { maxTokens: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
    expect(lines.join(' ')).toMatch(/token|budget|andon/i);
  });
});

// ===========================================================================
// Resume crash-recovery (finding #3) — a card crashed mid-work is left
// 'working' with a still-VALID (long) lease. Resume must reclaim it
// unconditionally (the owning process is dead) and drive it to terminal.
// The lease-based reconcile would no-op on an immediate resume and strand it.
// ===========================================================================

describe('e2e — resume recovers a crashed-mid-work card with a valid lease (finding #3)', () => {
  it('reclaims a working+valid-lease card and drives it to done (resume sequence: reclaim → run)', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    // Simulate: a worker claimed + began work, then the process crashed —
    // leaving 'working' with a long lease (lease_until = 1000 + 600 = 1600).
    attemptClaim(db, { cardId: 'entry', station: 'fetch_context', workerId: 'w1', wipCap: 10, now: 1000, leaseSeconds: 600 });
    beginWork(db, 'entry', 'fetch_context', 1000, 600);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('working');

    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    // Resume at t=1005 — WELL BEFORE the lease (1600) expires. This is the bug
    // scenario: a lease-based reconcile would not touch the card here.
    reclaimOrphanedWorkers(db, 1005);
    await runExecutor({ db, flow, now: SECONDS(1005), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    expect(existsSync(join(projectDir, 'idea.json'))).toBe(true);
  });

  it('proves the reclaim is load-bearing: the engine alone does NOT recover a valid-lease working card', async () => {
    const flow = setupLinearGatedFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'fetch_context' });
    attemptClaim(db, { cardId: 'entry', station: 'fetch_context', workerId: 'w1', wipCap: 10, now: 1000, leaseSeconds: 600 });
    beginWork(db, 'entry', 'fetch_context', 1000, 600);

    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    // Run the engine WITHOUT the reclaim step, before lease expiry.
    await runExecutor({ db, flow, now: SECONDS(1005), adapter, io } as RunEngineArgs);

    // Stuck: a valid-lease in-flight card is not reclaimed by the engine itself.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('working');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('fetch_context');
  });
});
