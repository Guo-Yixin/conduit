/**
 * Tests for `check:` gates on `kind: deterministic` stations (the original deterministic-gate work).
 *
 * Before this fix, `executeDeterministicStation` routed every successful
 * command straight to INTEGRITY_PASS through the FSM and never consulted
 * `stationConfig.gateCheck` at all — a deterministic station's `check:`
 * validated at load time (src/flow/load.ts) and rendered in `conduit explain`
 * (the `(check)` marker and `<~` back-edge), but the critic was NEVER invoked
 * and no `gate_verdict` card_log row was ever written. A run could complete
 * `done` with a known-rejected artifact and nothing in the journal would say
 * otherwise.
 *
 * The fix (option 1 from the issue) wires the deterministic completion path
 * through the SAME gate machinery a gated transform station already uses
 * (`runGateRework` / `src/controller/gate-rework.ts`) via a shared
 * `runGateCheckOrAdvance` helper extracted in executor.ts: pass → advance;
 * reject → back-edge rework, journaled gate_verdict rows, all four rework
 * guards intact. The gate machinery never cared whether the maker was an LLM
 * transform or a deterministic command — the critic reads the station's
 * declared inputs+outputs off disk either way, and the model call goes
 * through the SAME trackingAdapter every station already shares (now threaded
 * into DeterministicArgs).
 *
 * A gate-checked deterministic station is also excluded from the concurrency
 * pool (`poolEligible` in executor.ts) — the pool's MARK_DONE handler does a
 * "plain advance" with no critic call and no gate_verdict journaling, so a
 * pooled gated deterministic station would silently re-introduce the exact
 * bug this file guards against. The last test below pins that exclusion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs, SpawnedWorker } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, type StoredCardLogEntry, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, writePendingIntent, commitIntent } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRITIC_MODEL = 'gpt-4o';
const SECONDS = (n: number) => () => n;

type GateVerdictEntry = Extract<StoredCardLogEntry, { kind: 'gate_verdict' }>;

function gateVerdicts(db: ConduitDB, cardId: string): GateVerdictEntry[] {
  return db.getCardLog(cardId).filter((e): e is GateVerdictEntry => e.kind === 'gate_verdict');
}

function makeIO(): { io: { out(l: string): void; err(l: string): void } } {
  return { io: { out: () => {}, err: () => {} } };
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, id: string, lane: string): void {
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

/**
 * A critic-only adapter for a deterministic maker: there is no worker model at
 * all (the maker is `command: "true"`), so ANY model call reaching this
 * adapter must be the gate critic. Calling with any other model name is a
 * wiring bug and throws loudly rather than returning a plausible-looking
 * fake result.
 */
function criticAdapter(opts: { rejectsBeforePass?: number } = {}): ModelAdapter {
  let rejectsLeft = opts.rejectsBeforePass ?? 0;
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (req.model !== CRITIC_MODEL) {
        throw new Error(`unexpected model call for '${req.model}' — only the gate critic (${CRITIC_MODEL}) should ever call the model for a deterministic maker`);
      }
      if (rejectsLeft > 0) {
        rejectsLeft--;
        return {
          text: JSON.stringify({ verdict: 'reject', findings: ['known-bad artifact'], return_to: 'work' }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      }
      return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
    },
  };
}

/**
 * A single `work` station (`kind: deterministic`, `command: "true"`) → done,
 * optionally behind a `check:` gate critic. `on_reject: work` is a self-loop
 * back-edge (mirrors the `on_reject: ideate` self-loop pattern used by the
 * neighboring gate-verdict-log.test.ts transform fixture) so a reject reworks
 * the SAME station rather than requiring a second station in the fixture.
 *
 * `opts.effectful` + `opts.command` (default `"true"`) let the effectful
 * skip-on-resume tests below swap in a spawn-counting script so the outbox
 * discipline (never re-fire a committed intent) can be observed directly,
 * exactly like `effectful-outbox.test.ts`'s `setupDeterministicFlow`.
 */
function setupFlow(
  dir: string,
  opts: { gated: boolean; reworkCap?: number; effectful?: boolean; command?: string },
): FlowConfig {
  // No {{placeholders}} in the critic prompt — renderPrompt is placeholder-driven
  // (src/flow/render.ts), so declared inputs/outputs never need to exist on disk
  // for this fixture to exercise the gate wiring.
  writeFileSync(join(dir, 'critic.md'), 'Judge the artifact.');
  const checkBlock = opts.gated
    ? `
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: critic.md, prompt_version: "1" }
      on_reject: work
      rework_cap: ${opts.reworkCap ?? 2}`
    : '';
  const command = opts.command ?? 'true';
  const effectfulLine = opts.effectful ? '\n    effectful: true' : '';
  const flowYaml = `
flow: executor-deterministic-gate
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
    allow: ["${command}"]
stations:
  - id: work${effectfulLine}
    worker: { kind: deterministic, command: "${command}" }
    next: done${checkBlock}
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * Write an executable script at `<dir>/spawn.sh` that appends one line to
 * `<dir>/spawn-count.log` every time it runs, then exits 0. Mirrors
 * `effectful-outbox.test.ts`'s `makeSpawnCounter` — counting appended lines
 * counts spawns, which is how the tests below prove the effectful command did
 * NOT re-fire on a skip-on-resume.
 */
function makeSpawnCounter(dir: string): { scriptPath: string; spawnCount: () => number } {
  const scriptPath = join(dir, 'spawn.sh');
  const countLog = join(dir, 'spawn-count.log');
  writeFileSync(scriptPath, `#!/bin/sh\nprintf 'x\\n' >> "${countLog}"\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return {
    scriptPath,
    spawnCount: () => (existsSync(countLog) ? readFileSync(countLog, 'utf-8').split('\n').filter(Boolean).length : 0),
  };
}

/** The idempotency key the executor builds for a card at attempt 0 under flow_version=1. */
function idemKey(cardId: string, stationId: string, attempt = 0): string {
  return `1:${cardId}:${stationId}:${attempt}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deterministic station behind a check: gate (the original deterministic-gate work)', () => {
  let projectDir: string;
  let originalCwd: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-det-gate-'));
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

  it('critic pass: the card advances to done and a gate_verdict pass row is journaled', async () => {
    const flow = setupFlow(projectDir, { gated: true });
    db = openDb();
    seedCard(db, 'entry', 'work');
    const adapter = criticAdapter({ rejectsBeforePass: 0 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const verdicts = gateVerdicts(db, 'entry');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.verdict).toBe('pass');
    expect(verdicts[0]!.findings).toEqual([]);
    expect(verdicts[0]!.returnTo).toBeNull();
  });

  it('critic reject: the card routes the on_reject back-edge (rework) and a gate_verdict reject row records the findings', async () => {
    const flow = setupFlow(projectDir, { gated: true });
    db = openDb();
    seedCard(db, 'entry', 'work');
    // Reject once, then pass — the card reworks back to `work` (rework_count
    // increments) before eventually landing on `done`.
    const adapter = criticAdapter({ rejectsBeforePass: 1 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.rework_count ?? 0).toBeGreaterThanOrEqual(1);

    const reject = gateVerdicts(db, 'entry').find((v) => v.verdict === 'reject');
    expect(reject).toBeDefined();
    expect(reject!.findings).toEqual(['known-bad artifact']);
    expect(reject!.returnTo).toBe('work');
  });

  it('a permanent reject exhausts the rework cap and scraps the card (guard #1 intact) instead of silently completing', async () => {
    const flow = setupFlow(projectDir, { gated: true, reworkCap: 2 });
    db = openDb();
    seedCard(db, 'entry', 'work');
    // Different findings every call so no_progress (guard #3) never trips first —
    // isolates the rework-cap guard (#1).
    let n = 0;
    const adapter: ModelAdapter = {
      async call(req: ModelCall): Promise<ModelResponse> {
        if (req.model !== CRITIC_MODEL) throw new Error(`unexpected model call for '${req.model}'`);
        n++;
        return {
          text: JSON.stringify({ verdict: 'reject', findings: [`bad-${n}`], return_to: 'work' }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      },
    };

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('scrap');
  });

  it('regression: a deterministic station WITHOUT a check gate is unaffected — advances via INTEGRITY_PASS with no gate_verdict row and no model call', async () => {
    const flow = setupFlow(projectDir, { gated: false });
    db = openDb();
    seedCard(db, 'entry', 'work');
    const adapter: ModelAdapter = {
      async call() {
        throw new Error('adapter must not be called — this station has no check: gate');
      },
    };

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(gateVerdicts(db, 'entry')).toHaveLength(0);
  });

  it('a gate-checked deterministic station stays on the synchronous in-process path even under concurrency>1 — never handed to the pool spawn seam', async () => {
    const flow = setupFlow(projectDir, { gated: true });
    db = openDb();
    seedCard(db, 'entry', 'work');
    const adapter = criticAdapter({ rejectsBeforePass: 0 });

    // If `poolEligible` did not exclude gate-checked stations, concurrency>1
    // plus this spawn seam would route `work` to the pool path instead — whose
    // MARK_DONE handler never calls the critic (the exact bug this file guards
    // against, resurfacing through a second code path).
    const spawns: Array<{ cardId: string; station: string }> = [];
    const spawn = (args: { cardId: string; station: string }): SpawnedWorker => {
      spawns.push(args);
      return { pid: 1234, send: () => {} };
    };

    await runExecutor({
      db,
      flow,
      projectRoot: projectDir,
      now: SECONDS(1000),
      adapter,
      io: makeIO().io,
      concurrency: 2,
      spawn,
    } as RunEngineArgs);

    expect(spawns).toHaveLength(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(gateVerdicts(db, 'entry')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Effectful skip-on-resume → gate seam (reviewer-flagged untested path)
//
// All three completion paths of `executeDeterministicStation` funnel through
// `runGateCheckOrAdvance` (executor.ts ~L1389/1446/1494): (a) effectful
// skip-on-resume when `reconcileOnResume` reports the outbox intent already
// committed on a prior run, (b) effectful fire-success, (c) plain pure
// success. The tests above only exercise (c) — a plain (non-effectful)
// gated station. This block pins (a): a pre-committed outbox intent must
// skip re-firing the command, yet still route through the SAME gate
// machinery (critic invoked, gate_verdict journaled, pass/reject routing).
// ---------------------------------------------------------------------------

describe('effectful deterministic station behind a check: gate — skip-on-resume still runs the gate (the original deterministic-gate work seam)', () => {
  let projectDir: string;
  let originalCwd: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-det-gate-eff-'));
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

  /** Wraps `criticAdapter` to also count how many times the critic was called. */
  function countingCriticAdapter(opts: { rejectsBeforePass?: number } = {}): { adapter: ModelAdapter; criticCalls: () => number } {
    const inner = criticAdapter(opts);
    let n = 0;
    return {
      adapter: {
        async call(req: ModelCall): Promise<ModelResponse> {
          n++;
          return inner.call(req);
        },
      },
      criticCalls: () => n,
    };
  }

  it('pre-committed outbox intent: the command is NOT re-executed, but the critic IS invoked and a pass verdict advances the card', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupFlow(projectDir, { gated: true, effectful: true, command: scriptPath });
    db = openDb();
    seedCard(db, 'entry', 'work');

    // Simulate a prior run that already fired + committed this exact intent
    // (mirrors effectful-outbox.test.ts Test 2's pre-seeding pattern).
    const key = idemKey('entry', 'work');
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'work',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'deterministic', station: 'work' },
    });
    commitIntent(db.getStateDb(), key);

    const { adapter, criticCalls } = countingCriticAdapter({ rejectsBeforePass: 0 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    // The effectful side effect must NOT re-fire on resume.
    expect(spawnCount()).toBe(0);

    // The gate critic on the OTHER hand must still run on the skip-on-resume
    // path — that's the exact seam this test pins (before the fix this file
    // documents, the deterministic completion path skipped gateCheck entirely).
    expect(criticCalls()).toBe(1);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    const verdicts = gateVerdicts(db, 'entry');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.verdict).toBe('pass');
    expect(verdicts[0]!.returnTo).toBeNull();
  });

  it('pre-committed outbox intent + critic reject: the FIRST (resumed) dispatch never re-fires the committed side effect, but the rework attempt that follows legitimately fires it once under its own (new-attempt) idempotency key', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupFlow(projectDir, { gated: true, effectful: true, command: scriptPath });
    db = openDb();
    seedCard(db, 'entry', 'work');

    const key = idemKey('entry', 'work');
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'work',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'deterministic', station: 'work' },
    });
    commitIntent(db.getStateDb(), key);

    // Reject once, then pass. `on_reject: work` is a self-loop back-edge.
    // Surprising finding: `advanceCard`'s rework branch (executor.ts,
    // `UPDATE cards SET ... attempt = attempt + 1` when reworkDelta > 0)
    // bumps the execution `attempt` on EVERY QC rework, not just on an
    // INTEGRITY_FAIL retry. So after the reject the idempotency key becomes
    // `1:entry:work:1` — distinct from the pre-seeded `1:entry:work:0` — and
    // `reconcileOnResume` reports 'fire' (not 'skip') for the reworked
    // dispatch. The outbox's exactly-once guarantee is scoped to a single
    // (card, station, attempt), not to the card's whole lifetime at a
    // station: a rework is a legitimately NEW attempt, so it is expected —
    // not a bug — for the effectful command to fire again here.
    const { adapter, criticCalls } = countingCriticAdapter({ rejectsBeforePass: 1 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    // Fires exactly once — for the reworked (attempt=1) dispatch — never for
    // the original resumed (attempt=0) dispatch whose intent was pre-committed.
    expect(spawnCount()).toBe(1);

    // The critic ran twice: once for the reject (skip-on-resume path, attempt
    // 0), once for the eventual pass (fire-success path, attempt 1) — pinning
    // that BOTH completion paths route through the gate.
    expect(criticCalls()).toBe(2);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.rework_count ?? 0).toBeGreaterThanOrEqual(1);
    expect(card?.attempt ?? 0).toBeGreaterThanOrEqual(1);

    const verdicts = gateVerdicts(db, 'entry');
    expect(verdicts).toHaveLength(2);
    const reject = verdicts.find((v) => v.verdict === 'reject');
    expect(reject).toBeDefined();
    expect(reject!.returnTo).toBe('work');
    const pass = verdicts.find((v) => v.verdict === 'pass');
    expect(pass).toBeDefined();
  });
});
