/**
 * WI-479 — Executor scoping: drive only the active run's cards.
 *
 * A run's executor must promote, dispatch, complete, count, and evaluate
 * liveness/terminal SOLELY over its own run's cards, ignoring every other run in
 * the same database. Today the executor's aggregate/sweep SQL over
 * cards/active_workers (held count, non-terminal count, ready-lane GROUP BY,
 * orphan-subtree scan, fan-in/held sweeps, liveness, wave budget) is unscoped —
 * it sweeps the whole DB. This file pins the run-scoped behavior.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/controller/executor.ts + RunEngineArgs
 * ---------------------------------------------------------------------------
 *
 *   // RunEngineArgs (src/cli/main.ts) gains an OPTIONAL run id, threaded down
 *   // into runExecutor. Omitted ⇒ DEFAULT_RUN_ID, so existing single-run
 *   // callers and the full existing executor test suite behave unchanged.
 *   export interface RunEngineArgs { ...; runId?: string }
 *
 *   // Every aggregate / sweep / liveness query over cards|active_workers in
 *   // executor.ts gains a `run_id = <args.runId ?? DEFAULT_RUN_ID>` predicate.
 *   // A second run in the same DB is invisible to this run's executor.
 *
 * ---------------------------------------------------------------------------
 * Scope boundary (WI-479 vs WI-479b)
 * ---------------------------------------------------------------------------
 * WI-479 scopes the AGGREGATE / SWEEP / liveness queries. The by-PK card
 * lookups in the dispatch / MARK_DONE path (db.getCard(...)) are WI-479b's job.
 * So these tests use DEFAULT_RUN_ID as the ACTIVE run (its by-PK lookups already
 * work) and a SEPARATE non-default run ("other-run") whose cards must be
 * INVISIBLE to the active run's sweeps. The observable WI-479 contract is:
 *   1. the active run's executor TERMINATES PROMPTLY — its non-terminal /
 *      liveness / held sweeps count only its own cards, so once its own cards
 *      reach a terminal lane the loop exits. With unscoped sweeps it would spin
 *      forever (or trip the andon) because the other run's cards keep the
 *      non-terminal count above zero.
 *   2. the other run's cards are never moved, promoted, or escalated.
 *
 * Termination is enforced by `cappedClock()`: a static-valued injected clock
 * (so dispatch/lease timing matches the existing executor.test.ts harness) that
 * THROWS once it is read more than `maxTicks` times. A correctly-scoped executor
 * exits in a handful of reads; an unscoped one spins and trips the cap, turning
 * a would-be infinite synchronous loop into a clean, fast assertion failure.
 *
 * Harness mirrors executor.test.ts: in-memory ConduitDB, stub adapter (no
 * network), minimal real-loaded flow, temp project dir chdir'd for renderPrompt.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// The active run is DEFAULT_RUN_ID; OTHER is a second run sharing the same DB.
const OTHER = 'other-run';

// A trivial deterministic-only flow: entry station `a` runs `true` and routes to
// done. No artifacts, no model calls — pure dispatch + routing, so two runs of
// the SAME flow can coexist in one DB and we observe scheduling in isolation.
function setupDoneFlow(dir: string): FlowConfig {
  const flowYaml = `
flow: run-scoping
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
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedRun(db: ConduitDB, runId: string): void {
  db.insertRun({ run_id: runId, flow: 'run-scoping', input_fingerprint: 'fp', status: 'running' });
}

function seedCard(
  db: ConduitDB,
  runId: string,
  over: Partial<Card> & { id: string; lane: string },
): void {
  db.insertCard({
    run_id: runId,
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

/**
 * A static-valued clock that THROWS once read more than `maxTicks` times. The
 * value is constant (like SECONDS(n) in executor.test.ts) so dispatch and lease
 * timing behave normally — the cap only bounds the loop so an unscoped executor
 * (which would spin forever counting the other run's cards) fails fast and
 * clearly instead of hanging the whole suite. A correctly-scoped executor reads
 * the clock only a handful of times before exiting.
 */
function cappedClock(maxTicks = 1000, value = 1000): () => number {
  let reads = 0;
  return () => {
    reads += 1;
    if (reads > maxTicks) {
      throw new Error(
        `cappedClock: executor read the clock ${reads} times without terminating — ` +
          `its non-terminal/liveness sweeps are not run-scoped (counting the other run's cards).`,
      );
    }
    return value;
  };
}

const SECONDS = (n: number) => () => n;

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-run-scoping-'));
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
// AC1 — the active run promotes/dispatches only its own cards; the other run's
// cards are never moved out of their state by the active run's executor.
// ===========================================================================

describe('WI-479 — dispatch/promote isolation', () => {
  it('drives only the active run\'s card to done and leaves the other run\'s ready card untouched', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedRun(db, OTHER);
    seedCard(db, DEFAULT_RUN_ID, { id: 'active-card', lane: 'a', status: 'ready' });
    seedCard(db, OTHER, { id: 'other-card', lane: 'a', status: 'ready' });
    const { io } = makeIO();

    await runExecutor({
      db,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    // Active run's card was dispatched and routed to its terminal.
    expect(db.getCard(DEFAULT_RUN_ID, 'active-card')?.lane).toBe('done');
    // The other run's card was NEVER promoted or dispatched — still ready in lane 'a'.
    expect(db.getCard(OTHER, 'other-card')?.lane).toBe('a');
    expect(db.getCard(OTHER, 'other-card')?.status).toBe('ready');
  });

  it('does not promote the other run\'s waiting card (waiting→ready is run-scoped)', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedRun(db, OTHER);
    seedCard(db, DEFAULT_RUN_ID, { id: 'active-card', lane: 'a', status: 'ready' });
    // The other run has a WAITING card. The unscoped promote UPDATE (waiting→ready)
    // would flip it; a run-scoped promote must leave it waiting.
    seedCard(db, OTHER, { id: 'other-waiting', lane: 'a', status: 'waiting' });
    const { io } = makeIO();

    await runExecutor({
      db,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'active-card')?.lane).toBe('done');
    // The other run's card must remain WAITING — never promoted by this executor.
    expect(db.getCard(OTHER, 'other-waiting')?.status).toBe('waiting');
    expect(db.getCard(OTHER, 'other-waiting')?.lane).toBe('a');
  });
});

// ===========================================================================
// AC2 / AC3 — the active run reaches terminal/exit based solely on its own
// cards. A non-terminal card in the other run must NOT keep the active run's
// executor alive (else the unscoped non-terminal count spins the loop).
// ===========================================================================

describe('WI-479 — terminal/exit independence', () => {
  it('the active run completes promptly even though the other run has a ready (non-terminal) card', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedRun(db, OTHER);
    seedCard(db, DEFAULT_RUN_ID, { id: 'active-card', lane: 'a', status: 'ready' });
    seedCard(db, OTHER, { id: 'other-card', lane: 'a', status: 'ready' });
    const { io } = makeIO();

    // cappedClock throws if the loop spins — proving the non-terminal count
    // (executor.ts ~L553) is run-scoped: once active-card → done, the active run
    // has zero non-terminal cards and the loop exits.
    await runExecutor({
      db,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'active-card')?.lane).toBe('done');
    expect(db.getCard(OTHER, 'other-card')?.lane).toBe('a');
  });

  it('the active run\'s exit does not depend on the other run finishing (other run still mid-flight)', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedRun(db, OTHER);
    seedCard(db, DEFAULT_RUN_ID, { id: 'active-card', lane: 'a', status: 'ready' });
    // The other run has TWO ready cards still to process. The active run must
    // exit as soon as ITS card is done — its non-terminal count must not include
    // the other run's two outstanding cards (else cappedClock trips).
    seedCard(db, OTHER, { id: 'other-1', lane: 'a', status: 'ready' });
    seedCard(db, OTHER, { id: 'other-2', lane: 'a', status: 'ready' });
    const { io } = makeIO();

    await runExecutor({
      db,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'active-card')?.lane).toBe('done');
    // Both of the other run's cards remain ready in lane 'a' — never dispatched.
    expect(db.getCard(OTHER, 'other-1')?.lane).toBe('a');
    expect(db.getCard(OTHER, 'other-1')?.status).toBe('ready');
    expect(db.getCard(OTHER, 'other-2')?.lane).toBe('a');
    expect(db.getCard(OTHER, 'other-2')?.status).toBe('ready');
  });
});

// ===========================================================================
// AC4 — liveness/held/stuck counts evaluated by the active run's executor count
// only the active run's cards. The other run's busy cards must not keep the
// active run's loop alive, and the active run must not emit a stall/liveness
// diagnostic caused by the other run's cards.
// ===========================================================================

describe('WI-479 — liveness/held counts are run-scoped', () => {
  it('the other run\'s non-terminal cards do not trip the active run\'s liveness/stall diagnostic', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedRun(db, OTHER);
    seedCard(db, DEFAULT_RUN_ID, { id: 'active-card', lane: 'a', status: 'ready' });
    // A ready (busy) card in the other run. With unscoped non-terminal/stuck
    // counts the active executor would either spin (cappedClock trips) or emit a
    // stall diagnostic about a card that isn't its own.
    seedCard(db, OTHER, { id: 'other-card', lane: 'a', status: 'ready' });
    const { io, lines } = makeIO();

    await runExecutor({
      db,
      flow,
      now: cappedClock(),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    // The active run finished cleanly and promptly (cappedClock did not trip)...
    expect(db.getCard(DEFAULT_RUN_ID, 'active-card')?.lane).toBe('done');
    // ...the other run's card is untouched...
    expect(db.getCard(OTHER, 'other-card')?.lane).toBe('a');
    expect(db.getCard(OTHER, 'other-card')?.status).toBe('ready');
    // ...and no stall/liveness/deadlock diagnostic was emitted for a non-own card.
    expect(lines.some((l) => /stall|liveness|deadlock/i.test(l))).toBe(false);
  });
});

// ===========================================================================
// AC6 — back-compat: a single run with no other run present, under the default
// run id, behaves identically to today (uses the same static SECONDS clock the
// existing executor.test.ts suite uses). The full existing executor.test.ts
// suite is the primary regression guard; this pins the default-run path here.
// ===========================================================================

describe('WI-479 — default-run back-compat', () => {
  it('a single DEFAULT_RUN_ID run drives its card to done when runId is omitted', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedCard(db, DEFAULT_RUN_ID, { id: 'entry', lane: 'a', status: 'ready' });
    const { io } = makeIO();

    // No runId in args — must default to DEFAULT_RUN_ID and behave as today.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: stubAdapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
  });

  it('an explicit runId: DEFAULT_RUN_ID behaves identically to omitting it', async () => {
    const flow = setupDoneFlow(projectDir);
    db = openDb();
    seedRun(db, DEFAULT_RUN_ID);
    seedCard(db, DEFAULT_RUN_ID, { id: 'entry', lane: 'a', status: 'ready' });
    const { io } = makeIO();

    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: stubAdapter,
      io,
      runId: DEFAULT_RUN_ID,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
  });
});
