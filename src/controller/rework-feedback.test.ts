/**
 * Tests for rework-feedback rendering + binding-stamp fold (WI-383).
 *
 * This closes the quality loop. On rework re-entry (the card's persisted
 * rework_count > 0), executeTransformStation must:
 *
 *   1. Read ALL prior gate_verdict reject findings for the card from the card_log
 *      via getCardLog(cardId), filtered to verdict='reject', in chronological
 *      (id ASC) order — ACCUMULATED, not latest-only — concatenate/structure them,
 *      truncate to a bounded max length, and pass that as the `feedback` argument
 *      to renderPrompt (WI-379). On first entry (rework_count === 0) no feedback
 *      is supplied and the {{feedback}} block renders empty (FR-5).
 *   2. Fold the rendered feedback into the checkpoint binding stamp (hash it and
 *      append to inputArtifactHashes), so a resume cannot skip-replay a stale
 *      pre-feedback output (FR-6).
 *
 * Observables (no impl internals touched):
 *   - feedback rendering: the WORKER model call's `ModelCall.prompt` (recorded by
 *     the stub adapter); the prompt template wraps {{feedback}} in [[FB]]…[[/FB]]
 *     markers so the rendered feedback region can be isolated.
 *   - stamp fold: the checkpoints table binding_stamp, plus decideResume().
 *
 * The accumulated reject history is SEEDED directly via appendCardLog at distinct
 * attempts (so the WI-378 idempotency key doesn't collide), isolating WI-383's
 * read→render→fold logic from how the history is produced upstream.
 *
 * Depends on WI-378 (getCardLog), WI-379 (renderPrompt feedback), WI-380 (the
 * feedback-back-edge loader rule — the fixture's ideate self-gate satisfies it),
 * and WI-382 (gate findings) — all landed.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB  } from '../persistence/db';
import { ensureCheckpointSchema, decideResume, type CheckpointKey } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Harness.
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
          return { text: JSON.stringify({ verdict: 'reject', findings: ['x'], return_to: 'ideate' }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
        }
        return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      return { text: JSON.stringify({ idea: 'a shoppable widget idea' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter, calls };
}

const IO = { out: () => {}, err: () => {} };
const SECONDS = (n: number) => () => n;

/**
 * ideate transform whose prompt references {{feedback}} (wrapped in markers) and
 * declares it as an input; a gate self-loop (on_reject: ideate) makes ideate a
 * back-edge target so the WI-380 loader accepts the {{feedback}} reference.
 * context.json content is FIXED so input-artifact hashes are identical run-to-run.
 */
function setupFeedbackFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'TASK: idea from {{context.json}}\n[[FB]]{{feedback}}[[/FB]]\nEND');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), '{"ctx":"data"}');

  const flowYaml = `
flow: rework-feedback
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
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
    inputs: [context.json, feedback]
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

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, reworkCount: number): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'ideate',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['context.json', 'idea.json'],
    rework_count: reworkCount,
  });
}

/** Seed a prior gate_verdict reject entry at a distinct attempt (so keys don't collide). */
function seedReject(db: ConduitDB, attempt: number, findings: string[]): void {
  db.appendCardLog({
      runId: DEFAULT_RUN_ID, cardId: 'entry', station: 'ideate', attempt, kind: 'gate_verdict', verdict: 'reject', findings, returnTo: 'ideate' });
}

/** Pull the rendered feedback out of the worker prompt (between the markers). */
function extractFeedback(prompt: string): string {
  const m = prompt.match(/\[\[FB\]\]([\s\S]*?)\[\[\/FB\]\]/);
  if (!m) throw new Error(`worker prompt missing [[FB]] markers:\n${prompt}`);
  return m[1]!;
}

function checkpointStamps(db: ConduitDB, station: string): string[] {
  return (
    db.getStateDb().prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s').all({ $s: station }) as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

/** Run one ideate dispatch in a fresh project dir; return the rendered worker feedback. */
async function renderWorkerFeedback(opts: { reworkCount: number; rejectFindings: string[][] }): Promise<string> {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'conduit-rf-'));
  process.chdir(dir);
  const db = openDb();
  try {
    const flow = setupFeedbackFlow(dir);
    seedCard(db, opts.reworkCount);
    opts.rejectFindings.forEach((f, i) => seedReject(db, i, f));
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    await runExecutor({ db, flow, projectRoot: dir, now: SECONDS(1000), adapter, io: IO } as RunEngineArgs);
    const workerCall = calls.find((c) => c.model === WORKER_MODEL);
    if (!workerCall) throw new Error('no worker model call was recorded');
    return extractFeedback(workerCall.prompt);
  } finally {
    db.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run one ideate dispatch in a fresh dir; return the ideate checkpoint binding stamp. */
async function runForStamp(opts: { reworkCount: number; rejectFindings: string[][] }): Promise<string> {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'conduit-rf-stamp-'));
  process.chdir(dir);
  const db = openDb();
  try {
    const flow = setupFeedbackFlow(dir);
    seedCard(db, opts.reworkCount);
    opts.rejectFindings.forEach((f, i) => seedReject(db, i, f));
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    await runExecutor({ db, flow, projectRoot: dir, now: SECONDS(1000), adapter, io: IO } as RunEngineArgs);
    const stamps = checkpointStamps(db, 'ideate');
    if (stamps.length === 0) throw new Error('no ideate checkpoint was written');
    return stamps[0]!;
  } finally {
    db.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Like runForStamp but keeps the DB open so the caller can run decideResume against it. */
async function runForStampKeepDb(opts: { reworkCount: number; rejectFindings: string[][] }): Promise<{
  db: ConduitDB;
  stamp: string;
  cleanup: () => void;
}> {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'conduit-rf-keep-'));
  process.chdir(dir);
  const db = openDb();
  const flow = setupFeedbackFlow(dir);
  seedCard(db, opts.reworkCount);
  opts.rejectFindings.forEach((f, i) => seedReject(db, i, f));
  const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
  await runExecutor({ db, flow, projectRoot: dir, now: SECONDS(1000), adapter, io: IO } as RunEngineArgs);
  const stamps = checkpointStamps(db, 'ideate');
  process.chdir(cwd);
  if (stamps.length === 0) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw new Error('no ideate checkpoint was written');
  }
  return {
    db,
    stamp: stamps[0]!,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const IDEATE_KEY: CheckpointKey = { flow: '1', card: 'entry', station: 'ideate', attempt: 0 };

// ===========================================================================
// Feedback rendering into the maker prompt (FR-5, NFR-4).
// ===========================================================================

describe('rework feedback rendering into the maker prompt (WI-383)', () => {
  it('renders prior gate reject findings into the maker prompt on rework (rework_count > 0) (AC1)', async () => {
    const feedback = await renderWorkerFeedback({ reworkCount: 1, rejectFindings: [['needs work specifically here']] });
    expect(feedback).toContain('needs work specifically here');
  });

  it('renders NO feedback block on first entry (rework_count === 0, no prior reject) (AC2)', async () => {
    const feedback = await renderWorkerFeedback({ reworkCount: 0, rejectFindings: [] });
    expect(feedback.trim()).toBe('');
  });

  it('accumulates ALL prior rejection findings in chronological order, not latest-only (AC3)', async () => {
    const feedback = await renderWorkerFeedback({
      reworkCount: 2,
      rejectFindings: [['FIRST_REJECT_AAA'], ['SECOND_REJECT_BBB']],
    });
    expect(feedback).toContain('FIRST_REJECT_AAA');
    expect(feedback).toContain('SECOND_REJECT_BBB');
    // Chronological (id ASC): the earlier rejection precedes the later one.
    expect(feedback.indexOf('FIRST_REJECT_AAA')).toBeLessThan(feedback.indexOf('SECOND_REJECT_BBB'));
  });

  it('truncates the accumulated feedback to a bounded maximum length before substitution (AC4, NFR-4)', async () => {
    // Two histories of very different total size, each far exceeding any sane
    // feedback budget. A single fixed cap clamps both to the SAME length.
    const big = Array.from({ length: 100 }, () => ['A'.repeat(5000)]);
    const bigger = Array.from({ length: 200 }, () => ['B'.repeat(5000)]);

    const fbBig = await renderWorkerFeedback({ reworkCount: 1, rejectFindings: big });
    const fbBigger = await renderWorkerFeedback({ reworkCount: 1, rejectFindings: bigger });

    // A constant maximum exists (both clamp to the same length)...
    expect(fbBig.length).toBe(fbBigger.length);
    // ...well below the smaller history's raw size (truncation actually happened)...
    expect(fbBig.length).toBeLessThan(100 * 5000);
    // ...and non-empty (rework feedback was rendered).
    expect(fbBig.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Binding-stamp fold (FR-6, FR-10) — a rework execution must not reuse a
// pre-feedback checkpoint.
// ===========================================================================

describe('rework feedback folds into the binding stamp (WI-383)', () => {
  it('produces a DIFFERENT stamp for the rework execution than the first, with identical disk inputs (AC5, FR-6)', async () => {
    const stampFirst = await runForStamp({ reworkCount: 0, rejectFindings: [] });
    const stampRework = await runForStamp({ reworkCount: 1, rejectFindings: [['needs work']] });
    // Same context.json, prompt, model, version, flow — only the folded feedback differs.
    expect(stampFirst).not.toBe(stampRework);
  });

  it('resume of the rework execution against a first-execution checkpoint sees stamp_mismatch and re-executes (AC6, FR-6)', async () => {
    const stampRework = await runForStamp({ reworkCount: 1, rejectFindings: [['needs work']] });
    const first = await runForStampKeepDb({ reworkCount: 0, rejectFindings: [] });
    try {
      const stateDb = first.db.getStateDb();
      // Positive control: the first execution's own stamp reuses its checkpoint.
      expect(decideResume(stateDb, IDEATE_KEY, first.stamp).action).toBe('reuse');
      // The rework stamp does NOT match the stale pre-feedback checkpoint → re-execute.
      const decision = decideResume(stateDb, IDEATE_KEY, stampRework);
      expect(decision.action).toBe('reexecute');
      expect(decision).toMatchObject({ reason: 'stamp_mismatch' });
    } finally {
      first.cleanup();
    }
  });

  it('different accumulated findings → different stamps; identical findings → identical stamp (AC7, FR-10)', async () => {
    const a = await runForStamp({ reworkCount: 1, rejectFindings: [['needs work']] });
    const b = await runForStamp({ reworkCount: 1, rejectFindings: [['a completely different finding text']] });
    const aAgain = await runForStamp({ reworkCount: 1, rejectFindings: [['needs work']] });

    // Different accumulated findings distinguish the executions...
    expect(a).not.toBe(b);
    // ...while identical accumulated findings render identically (deterministic),
    // so it is the no-progress findings-hash guard — not the stamp — that
    // distinguishes a stuck rework from a productive one (FR-10).
    expect(a).toBe(aAgain);
  });
});
