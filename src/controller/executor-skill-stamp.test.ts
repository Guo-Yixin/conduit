/**
 * Executor wiring tests for skill-content-aware binding stamps (WI-557).
 *
 * Skill Ingest PRD FR-4 — the release contract for replay-safety. A
 * `worker.uses:` station's checkpoint binding stamp must be *honest* about the
 * skill content it injects: the stamp's promptTemplateVersion input becomes a
 * hash combining the declared prompt_version with the SHA-256 of each injected
 * skill's content, in worker.uses order. So:
 *   - editing a skill's body OR a references/ file changes the dependent
 *     station's stamp → on resume its checkpoint is invalidated and the existing
 *     cascadeInvalidation path drops downstream checkpoints (AC1);
 *   - with no edit, the stamp is unchanged and skip-on-resume is preserved (AC2);
 *   - a station that does not use the edited skill is unaffected (AC3);
 *   - a station WITHOUT worker.uses computes its stamp exactly as today —
 *     prompt_version only, no skill influence (AC4 second half).
 *
 * Contract pinned for src/controller/executor.ts (impl by B.A. — do NOT write it):
 *   at the computeBindingStamp call (~executor.ts:1503-1505), for a station with
 *   worker.uses the `promptTemplateVersion` input is the COMBINED hash above
 *   instead of the bare `stationConfig.prompt_version`. A non-uses station keeps
 *   `prompt_version ?? ''`. Deterministic (NFR-2).
 *
 * How these tests observe the stamp: they drive the REAL runExecutor over
 * loader-built flows (WI-555 resolves worker.uses into prompt_content) and read
 * the persisted `binding_stamp` column back out of the checkpoints table — the
 * same seam executor-integrity-cascade.test.ts uses. They assert PROPERTIES of
 * the stamp (folded-in, ordered, combined-with-prompt_version, deterministic,
 * non-uses-invariant) rather than reconstructing the exact hash bytes on purpose:
 * asserting exact bytes would couple the test to the full four-input stamp
 * construction (modelId, input-artifact hashes, flowVersion), which is not what
 * this item changes. The properties fully constrain FR-4's intent.
 *
 * RED-until-implemented: today executor.ts:1505 feeds prompt_version ONLY, so
 * skill content is absent from the stamp — the edit/order/reference tests below
 * are red and go green once the combined hash is wired in.
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

const WORKER_MODEL = 'gpt-4o-mini';

/** Stub adapter: the transform worker always returns a valid {idea} payload. */
function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return { text: JSON.stringify({ idea: 'an idea' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
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

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function checkpointCount(db: ConduitDB, station: string): number {
  return (
    db.getStateDb().prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE station = $s').get({ $s: station }) as {
      n: number;
    }
  ).n;
}

/** Read the persisted binding stamp the executor computed for a station. */
function stampOf(db: ConduitDB, station: string): string {
  const row = db
    .getStateDb()
    .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
    .get({ $s: station }) as { binding_stamp: string } | undefined;
  if (!row) throw new Error(`no checkpoint (and thus no stamp) recorded for station '${station}'`);
  return row.binding_stamp;
}

function loadOk(dir: string): FlowConfig {
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

const SECONDS = (n: number) => () => n;

/** Author a SKILL.md bundle under <dir>/skills/<name> with optional references/. */
function writeSkill(dir: string, name: string, body: string, references: Record<string, string> = {}): void {
  const bundle = join(dir, 'skills', name);
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`, 'utf-8');
  const refNames = Object.keys(references);
  if (refNames.length > 0) {
    mkdirSync(join(bundle, 'references'), { recursive: true });
    for (const [refName, content] of Object.entries(references)) {
      writeFileSync(join(bundle, 'references', refName), content, 'utf-8');
    }
  }
}

/**
 * A single transform station with a CONSTANT local prompt_file (the loader
 * requires one) plus an optional worker.uses list. Holding the local prompt and
 * prompt_version fixed makes the injected skill content the only variable, so
 * any stamp change is attributable to the skill.
 */
function writeSingleStationFlow(dir: string, opts: { uses?: string[]; promptVersion?: string }): void {
  const pv = opts.promptVersion ?? '1';
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'a.md'), 'Constant local prompt, no placeholders.', 'utf-8');
  const usesLine = opts.uses && opts.uses.length > 0 ? `\n      uses: [${opts.uses.join(', ')}]` : '';
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: skill-stamp-single
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_version: "${pv}"
      prompt_file: prompts/a.md${usesLine}
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: []
    outputs: [idea.json]
    next: done
`,
    'utf-8',
  );
}

/** a[uses house-style] → b[plain]; b consumes a's output so the cascade can be observed. */
function writeTwoStageSkillFlow(dir: string, maxTokens: number): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'a.md'), 'Constant local prompt for stage A.', 'utf-8');
  writeFileSync(join(dir, 'prompts', 'b.md'), 'Stage B from {{mid.json}}', 'utf-8');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }), 'utf-8');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: skill-cascade
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_version: "1"
      prompt_file: prompts/a.md
      uses: [house-style]
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [mid.json]
    next: b
  - id: b
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/b.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [mid.json]
    outputs: [final.json]
    next: done
`,
    'utf-8',
  );
  return loadOk(dir);
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-skillstamp-'));
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

/**
 * Build a single-skill-using station, run it to done in a throwaway DB, and
 * return the binding stamp the executor persisted. Isolates the stamp to
 * prompt_version + injected skill content (inputs: [] so no input-artifact noise).
 */
async function stampForSingleStation(opts: { uses?: string[]; promptVersion?: string }): Promise<string> {
  writeSingleStationFlow(projectDir, opts);
  const flow = loadOk(projectDir);
  const localDb = openDb();
  try {
    seedCard(localDb, { id: 's', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();
    await runExecutor({ db: localDb, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    if (localDb.getCard(DEFAULT_RUN_ID, 's')?.lane !== 'done') {
      throw new Error('single station did not reach done — flow/executor setup is wrong');
    }
    return stampOf(localDb, 'a');
  } finally {
    localDb.close();
  }
}

// ---------------------------------------------------------------------------
// AC4 — stamp composition: promptTemplateVersion = hash(prompt_version ⊕ each
// injected skill's SHA-256, in worker.uses order); non-uses stations unchanged.
// (Observed via the persisted binding_stamp; properties, not exact bytes.)
// ---------------------------------------------------------------------------

describe('WI-557 binding stamp — skill-content composition (AC4)', () => {
  it('folds injected skill content into the stamp: two different skill bodies yield different stamps', async () => {
    writeSkill(projectDir, 'house-style', 'Body ONE: prefer short sentences.');
    const s1 = await stampForSingleStation({ uses: ['house-style'] });

    writeSkill(projectDir, 'house-style', 'Body TWO: prefer active voice — different content.');
    const s2 = await stampForSingleStation({ uses: ['house-style'] });

    expect(s1).not.toBe(s2);
  });

  it('is deterministic: identical skill content yields an identical stamp (NFR-2)', async () => {
    writeSkill(projectDir, 'house-style', 'Stable body, byte-for-byte identical.');
    const a = await stampForSingleStation({ uses: ['house-style'] });
    const b = await stampForSingleStation({ uses: ['house-style'] });
    expect(a).toBe(b);
  });

  it('combines skill hashes WITH prompt_version (does not replace it): prompt_version still moves the stamp', async () => {
    writeSkill(projectDir, 'house-style', 'Constant skill body.');
    const v1 = await stampForSingleStation({ uses: ['house-style'], promptVersion: '1' });
    const v2 = await stampForSingleStation({ uses: ['house-style'], promptVersion: '2' });
    expect(v1).not.toBe(v2);
  });

  it('respects worker.uses order: the same two skills in swapped order yield different stamps', async () => {
    writeSkill(projectDir, 'skill-x', 'Content X.');
    writeSkill(projectDir, 'skill-y', 'Content Y — distinct.');
    const xy = await stampForSingleStation({ uses: ['skill-x', 'skill-y'] });
    const yx = await stampForSingleStation({ uses: ['skill-y', 'skill-x'] });
    expect(xy).not.toBe(yx);
  });

  it('leaves a NON-uses station stamp unchanged by skill edits — computed exactly as today', async () => {
    // The station uses a local prompt_file, no worker.uses. Editing an unrelated
    // bundle in skills/ must not perturb its stamp (prompt_version only).
    writeSkill(projectDir, 'unused-skill', 'Version one.');
    const before = await stampForSingleStation({});
    writeSkill(projectDir, 'unused-skill', 'Version two — changed, but nobody uses it.');
    const after = await stampForSingleStation({});
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a station using a DIFFERENT skill is unaffected by the edit.
// ---------------------------------------------------------------------------

describe('WI-557 binding stamp — unrelated skill edits do not leak (AC3)', () => {
  it('editing skill A changes only the A-using station stamp; the B-using station is unchanged', async () => {
    writeSkill(projectDir, 'skill-a', 'A body v1.');
    writeSkill(projectDir, 'skill-b', 'B body — constant.');
    const aBefore = await stampForSingleStation({ uses: ['skill-a'] });
    const bBefore = await stampForSingleStation({ uses: ['skill-b'] });

    writeSkill(projectDir, 'skill-a', 'A body v2 — edited.');
    const aAfter = await stampForSingleStation({ uses: ['skill-a'] });
    const bAfter = await stampForSingleStation({ uses: ['skill-b'] });

    expect(aAfter).not.toBe(aBefore); // the station using the edited skill changes
    expect(bAfter).toBe(bBefore); // the station using a different skill is unaffected
  });
});

// ---------------------------------------------------------------------------
// AC1 — a skill edit (body OR references/) invalidates the dependent station's
// checkpoint on resume and cascades to its downstream consumer.
// ---------------------------------------------------------------------------

describe('WI-557 binding stamp — skill edits invalidate + cascade on resume (AC1)', () => {
  it('editing a used skill body re-executes the dependent station AND its downstream consumer', async () => {
    writeSkill(projectDir, 'house-style', 'Original house style: prefer short sentences.');
    const flow1 = writeTwoStageSkillFlow(projectDir, 100000);
    db = openDb();
    seedCard(db, { id: 'c', lane: 'a', owned_paths: [] });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    // First run completes a→b→done and checkpoints both with their real stamps.
    await runExecutor({ db, flow: flow1, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(checkpointCount(db, 'a')).toBe(1);
    expect(checkpointCount(db, 'b')).toBe(1);
    const callsAfterFirst = calls.length;

    // Edit the skill body → a's composed prompt changes → its stamp must change.
    // Reload so the executor sees the re-resolved skill content.
    writeSkill(projectDir, 'house-style', 'REVISED house style: prefer active voice and short sentences.');
    const flow2 = loadOk(projectDir);

    // Reset the card to a and resume. a's stamp mismatch → a re-executes and the
    // cascade drops b's checkpoint → b re-executes too: exactly two new calls.
    db.getStateDb().prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow: flow2, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(calls.length).toBe(callsAfterFirst + 2);
  });

  it('editing a used skill isolates the cascade: the downstream checkpoint is dropped before it re-runs', async () => {
    writeSkill(projectDir, 'house-style', 'Original body.');
    // Phase 1: generous budget completes a→b→done with real checkpoints.
    const flowBig = writeTwoStageSkillFlow(projectDir, 100000);
    db = openDb();
    seedCard(db, { id: 'c', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();
    await runExecutor({ db, flow: flowBig, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(checkpointCount(db, 'a')).toBe(1);
    expect(checkpointCount(db, 'b')).toBe(1);

    // Phase 2: edit the skill and reload with a TINY token budget so the
    // consumption andon halts right after a re-bills, BEFORE b re-runs — making
    // the cascade deletion of b's checkpoint directly observable (mirrors the
    // executor-integrity-cascade template, but driven by a real skill edit).
    writeSkill(projectDir, 'house-style', 'EDITED body — different content changes the stamp.');
    const flowTiny = writeTwoStageSkillFlow(projectDir, 1);
    db.getStateDb().prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow: flowTiny, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    // The cascade — not b re-running — removed b's checkpoint; the andon halted
    // the run before b could execute, so it stays gone and the card is not done.
    expect(checkpointCount(db, 'b')).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).not.toBe('done');
  });

  it('editing a references/ file (not the body) also changes the stamp', async () => {
    writeSkill(projectDir, 'ref-skill', 'Body stays the same.', { '01-ref.md': 'reference ONE' });
    const before = await stampForSingleStation({ uses: ['ref-skill'] });

    writeSkill(projectDir, 'ref-skill', 'Body stays the same.', { '01-ref.md': 'reference TWO — changed' });
    const after = await stampForSingleStation({ uses: ['ref-skill'] });

    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC2 — no edit, no other input change → stamp unchanged, skip-on-resume kept.
// ---------------------------------------------------------------------------

describe('WI-557 binding stamp — unchanged skill preserves skip-on-resume (AC2)', () => {
  it('re-running with the identical skill re-uses both checkpoints (no re-execution)', async () => {
    writeSkill(projectDir, 'house-style', 'Stable body — never edited.');
    const flow = writeTwoStageSkillFlow(projectDir, 100000);
    db = openDb();
    seedCard(db, { id: 'c', lane: 'a', owned_paths: [] });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(checkpointCount(db, 'a')).toBe(1);
    expect(checkpointCount(db, 'b')).toBe(1);
    const callsAfterFirst = calls.length;

    // No edit. Reset to a and resume with identical skill + config: both a and b
    // stamps still match, so both skip-replay — zero new model calls.
    db.getStateDb().prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(calls.length).toBe(callsAfterFirst);
    expect(checkpointCount(db, 'b')).toBe(1);
  });
});
