/**
 * WI-33 — a completed synchronous adapter call counts as liveness progress.
 *
 * Root cause: `currentNow` is sampled ONCE at the top of each tick (a documented
 * invariant — see the `runExecutor` doc comment), but the transform/gate model
 * calls dispatched THAT tick are awaited synchronously and can themselves run
 * for real wall-clock minutes. When the station completes, `lastLaneChangeAt`
 * is stamped with that STALE pre-call `currentNow`, not the real completion
 * time. If a single tick's draft+critic model calls together take longer than
 * `no_progress_minutes`, the very NEXT tick's fresh `currentNow` already looks
 * `no_progress_minutes`-or-more past the stale `lastLaneChangeAt` stamp — so the
 * liveness watchdog declares a stall immediately after a tick that was, in
 * fact, continuously busy and completed successfully.
 *
 * The fix (src/controller/executor.ts `trackingAdapter` + src/control/
 * watchdog.ts `checkLiveness`) stamps `lastAdapterActivityAt` with a FRESH
 * `now()` sample the instant each synchronous adapter call completes, and
 * liveness is judged on `max(lastLaneChangeAt, lastAdapterActivityAt)`.
 *
 * This test drives the REAL `runExecutor` with a scripted clock that mimics
 * production: tick-start bookkeeping is instantaneous, but each transform/gate
 * model call "costs" 240s of wall-clock time (comfortably longer than the
 * flow's 180s `no_progress_minutes` window) — exactly the shape of the
 * draft↔gate rework cycle described in the issue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';
const CRITIC_MODEL = 'gpt-4o';

/**
 * A worker+gate ("draft↔gate") station, back-edge to itself on reject — the
 * same shape as the issue's report (one station whose worker AND critic are
 * both model calls, rejecting back into itself for bounded rework).
 */
function setupDraftGateFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: executor-liveness-adapter-activity
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 60, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
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

/** Rejects once (routes back to `ideate`), then passes. */
function makeOneRejectThenPassAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  let rejected = false;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        if (!rejected) {
          rejected = true;
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

/**
 * A scripted clock: returns the next value from `script` on each call, then
 * sticks on the last value once exhausted (mirrors drain-wiring.test.ts's
 * `makeClock`). Lets a test author an exact, deterministic wall-clock timeline
 * across the executor's precisely-ordered `now()` call sites.
 */
function makeScriptedClock(script: number[]): { now: () => number; calls: number[] } {
  let i = 0;
  const calls: number[] = [];
  const now = () => {
    const v = script[Math.min(i, script.length - 1)]!;
    i++;
    calls.push(v);
    return v;
  };
  return { now, calls };
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

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
    lines,
  };
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-executor-liveness-'));
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

describe('runExecutor — synchronous adapter activity counts as liveness progress (WI-33)', () => {
  it('does not trip the liveness watchdog when a draft<->gate rework cycle spends its whole no_progress window inside in-flight model calls', async () => {
    const flow = setupDraftGateFlow(projectDir); // no_progress_minutes: 3 → 180s
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeOneRejectThenPassAdapter();
    const { io, lines } = makeIO();

    // now() call order for this fixture (1 card, wip=1, worker+gate combo).
    // The original adapter-liveness work adds a START stamp immediately BEFORE each awaited model call
    // (in addition to the existing completion stamp), so each of the 4 model
    // calls below now consumes TWO now() samples instead of one:
    //   1.  runStartedAt                                  -> 0
    //   2.  tick1 currentNow (liveness check, dispatch)    -> 0
    //   3.  trackingAdapter START stamp, draft call #1     -> 0
    //   4.  trackingAdapter completion stamp, draft call #1-> 240  (4-minute call)
    //   5.  trackingAdapter START stamp, gate call #1      -> 240
    //   6.  trackingAdapter completion stamp, gate call #1 -> 480  (4-minute call; reject -> back to ideate)
    //   7.  tick2 currentNow (liveness check, dispatch)    -> 480  (immediately follows tick1's real completion)
    //   8.  trackingAdapter START stamp, draft call #2     -> 480
    //   9.  trackingAdapter completion stamp, draft call #2-> 720
    //   10. trackingAdapter START stamp, gate call #2      -> 720
    //   11. trackingAdapter completion stamp, gate call #2 -> 960  (pass -> done)
    //   12. tick3 currentNow (liveness check; then nonTerminalCount===0 -> break)
    //                                                       -> 960
    //
    // Without the completion-stamp fix (WI-33), `lastLaneChangeAt` is stamped
    // with the STALE pre-call currentNow (0 at tick1's end, 480 at tick2's
    // end), so tick2's and tick3's liveness checks see a 480s gap (>= 180s)
    // against no active workers and would incorrectly halt. With the fix,
    // `lastAdapterActivityAt` tracks the real completion instant (480, then
    // 960), so the gap stays 0. The START stamps added by the original adapter-liveness work are inert
    // here (each is immediately overwritten by its own call's completion stamp
    // before the tick loop ever re-reads `lastAdapterActivityAt`) — they exist
    // to keep the liveness clock fresh for any evaluation that happens WHILE a
    // call is still in flight (see the "the original adapter-liveness work" describe block below).
    const { now, calls: clockCalls } = makeScriptedClock([
      0, 0, 0, 240, 240, 480, 480, 480, 720, 720, 960, 960,
    ]);

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    // Sanity: the scripted cycle actually happened (2 draft calls, 2 gate calls).
    expect(calls.filter((c) => c.model === WORKER_MODEL)).toHaveLength(2);
    expect(calls.filter((c) => c.model === CRITIC_MODEL)).toHaveLength(2);
    // The watchdog must NOT have declared a stall anywhere in the run's output.
    expect(lines.join(' ')).not.toMatch(/liveness|stall|deadlock/i);
    // Confirms the clock was actually exercised across every documented call site.
    expect(clockCalls.length).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// The original adapter-liveness work — the tracking wrapper only stamped `lastAdapterActivityAt` on
// COMPLETION, never at the call's START. Every in-process model call is
// invisible to `active_workers`, so a single legitimate call whose own
// duration alone exceeds `no_progress_minutes` reads as "no progress + no
// active worker" for its ENTIRE duration — not just after it finishes — which
// would trip `checkLiveness` if evaluated at any point while the call is still
// in flight (seen in production: print-farm a pre-public review, ~200k-token reasoning
// calls). The fix stamps `lastAdapterActivityAt = now()` immediately BEFORE
// awaiting the call too, so the no-progress window restarts from the call's
// start rather than staying pinned to a stale prior value for the call's whole
// duration.
// ---------------------------------------------------------------------------

/** A single worker station (no gate) -> done — isolates ONE model call. */
function setupSingleStationFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  const flowYaml = `
flow: executor-liveness-call-start
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 60, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
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
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function makeSingleShotAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({ idea: 'a widget idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

describe('runExecutor — a call\'s own duration does not false-trip liveness (the original adapter-liveness work)', () => {
  it('does not trip when a single call\'s duration alone (start to finish) exceeds the no-progress window', async () => {
    const flow = setupSingleStationFlow(projectDir); // no_progress_minutes: 3 -> 180s
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeSingleShotAdapter();
    const { io, lines } = makeIO();

    // now() call order: runStartedAt -> 0; tick1 currentNow -> 0; trackingAdapter
    // START stamp -> 0; trackingAdapter completion stamp -> 600 (a full 10-minute
    // call, well past the 180s window); tick2 currentNow (nonTerminalCount===0
    // -> break) -> 600. Even though the call's OWN duration blows the window,
    // there is no stall: the completion stamp (and, for any future architecture
    // that can observe progress mid-call, the start stamp) keeps the run alive.
    const { now } = makeScriptedClock([0, 0, 0, 600, 600]);

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    expect(calls).toHaveLength(1);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(lines.join(' ')).not.toMatch(/liveness|stall|deadlock/i);
  });

  it('still trips on a genuine stall — no lane change and no adapter activity at all', async () => {
    // A card whose lane names no station in the flow can never be dispatched
    // (fail-closed) and is not terminal -> no progress is ever possible, and
    // the adapter is never called at all. The start-stamp fix must not mask a
    // stall where there was never any call to stamp progress from.
    const flow = setupSingleStationFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'stuck', lane: 'no_such_station' });
    const { adapter, calls } = makeSingleShotAdapter();
    const { io, lines } = makeIO();
    let t = 1000;
    const now = () => (t += 10_000); // advancing clock so the no-progress window elapses

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    expect(calls).toHaveLength(0); // the adapter was never reached
    expect(db.getCard(DEFAULT_RUN_ID, 'stuck')?.lane).not.toBe('done');
    expect(lines.join(' ')).toMatch(/progress|liveness|stall|watchdog|deadlock/i);
  });
});
