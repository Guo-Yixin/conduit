/**
 * Binding-stamp extension: harness adapter identity in checkpoint soundness (WI-572).
 *
 * Makes resume sound for the most expensive stations (FR-6, OQ-5, "resume is
 * sound"). A harness station's binding stamp incorporates the ADAPTER NAME (in
 * addition to model id + prompt version), so changing any of them invalidates
 * the checkpoint and cascades downstream; an unchanged station is skipped
 * without re-invoking the harness. The harness BINARY version is deliberately
 * EXCLUDED — the operator owns harness upgrades.
 *
 * This file pins the CHECKPOINT-level contract (all within checkpoint.ts's
 * control) end to end via the pure/DB functions:
 *   AC1  computeBindingStamp incorporates adapterName — two stations differing
 *        only by adapter name produce different stamps.
 *   AC2  the harness binary version is NOT part of the stamp.
 *   AC3  a matching stamp → decideResume 'reuse' (skip, no re-bill).
 *   AC4  a changed adapter / model / prompt → decideResume 'stamp_mismatch'
 *        (re-execute), and cascadeInvalidation carries it downstream.
 *
 * ── Contract decision this test pins (CRITICAL, read before implementing) ─────
 *
 *   adapterName is an OPTIONAL field on BindingStampInputs and MUST be folded
 *   into the hash ONLY WHEN PRESENT. A transform / deterministic station passes
 *   no adapterName and MUST get the exact same stamp as before this change —
 *   otherwise every existing non-harness checkpoint silently invalidates on the
 *   next resume (a mass re-bill regression). The "unchanged legacy stamp" test
 *   below is that regression guard: the no-adapterName stamp must be BYTE-
 *   IDENTICAL to the pre-WI-572 four-input canonical.
 *
 * The executor-level end-to-end resume proof (WI-565's harness path threading
 * adapterName into this call site, then a real resume skipping / re-invoking)
 * lives at the bottom of this file and additionally depends on WI-565.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import {
  computeBindingStamp,
  ensureCheckpointSchema,
  writeCheckpoint,
  decideResume,
  cascadeInvalidation,
  type BindingStampInputs,
  type CheckpointKey,
} from './checkpoint';
import type { StationOutput } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessRegistry,
  type ProducedOutput,
} from '../worker/harness-adapter';

// ---------------------------------------------------------------------------
// Shared inputs — everything held constant so the ONLY varying axis in each
// test is the one under test (adapter name, model, prompt, or a rogue field).
// ---------------------------------------------------------------------------

const BASE: BindingStampInputs = {
  modelId: 'sonnet',
  promptTemplateVersion: 'v1',
  inputArtifactHashes: ['hash-a', 'hash-b'],
  flowVersion: 1,
};

/** The pre-WI-572 four-input canonical stamp, computed independently. */
function legacyStamp(inputs: BindingStampInputs): string {
  const canonical = JSON.stringify([
    inputs.modelId,
    inputs.promptTemplateVersion,
    [...inputs.inputArtifactHashes].sort(),
    inputs.flowVersion,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function withAdapter(name: string, over: Partial<BindingStampInputs> = {}): BindingStampInputs {
  return { ...BASE, ...over, adapterName: name } as BindingStampInputs;
}

// ---------------------------------------------------------------------------
// AC1 — adapter name participates in the stamp.
// ---------------------------------------------------------------------------

describe('WI-572 AC1 — adapter name participates in the binding stamp', () => {
  it('two stations differing only by adapter name produce different stamps', () => {
    const a = computeBindingStamp(withAdapter('claude-headless'));
    const b = computeBindingStamp(withAdapter('codex-headless'));
    expect(a).not.toBe(b);
  });

  it('the same adapter name (all else equal) produces a stable, identical stamp', () => {
    expect(computeBindingStamp(withAdapter('claude-headless'))).toBe(
      computeBindingStamp(withAdapter('claude-headless')),
    );
  });

  it('adding an adapter name changes the stamp vs the same inputs without one', () => {
    expect(computeBindingStamp(withAdapter('claude-headless'))).not.toBe(computeBindingStamp(BASE));
  });
});

// ---------------------------------------------------------------------------
// Regression guard — a non-harness stamp (no adapterName) is UNCHANGED.
// ---------------------------------------------------------------------------

describe('WI-572 backward-compat — non-harness stamps must not change', () => {
  it('omitting adapterName yields the exact pre-WI-572 four-input canonical stamp', () => {
    // If adapterName is folded in unconditionally (e.g. as null/undefined), this
    // fails — and every existing transform/deterministic checkpoint would
    // silently invalidate on resume. adapterName MUST be conditional.
    expect(computeBindingStamp(BASE)).toBe(legacyStamp(BASE));
  });

  it('model / prompt / input-set changes still move a no-adapter stamp (unchanged behavior)', () => {
    expect(computeBindingStamp({ ...BASE, modelId: 'opus' })).not.toBe(computeBindingStamp(BASE));
    expect(computeBindingStamp({ ...BASE, promptTemplateVersion: 'v2' })).not.toBe(computeBindingStamp(BASE));
    expect(computeBindingStamp({ ...BASE, inputArtifactHashes: ['x'] })).not.toBe(computeBindingStamp(BASE));
    // Input-hash ORDER is still irrelevant (sorted before hashing).
    expect(computeBindingStamp({ ...BASE, inputArtifactHashes: ['hash-b', 'hash-a'] })).toBe(
      computeBindingStamp(BASE),
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — the harness binary version is NOT part of the stamp.
// ---------------------------------------------------------------------------

describe('WI-572 AC2 — binary version is excluded from the stamp', () => {
  it('a rogue binary-version field does not change the stamp (operator owns upgrades)', () => {
    const base = withAdapter('claude-headless');
    // A hypothetical binaryVersion must not be hashed — the stamp is a pure
    // function of {adapterName, model, promptVersion, inputs, flowVersion} only.
    const withBinary = { ...base, binaryVersion: '9.9.9' } as unknown as BindingStampInputs;
    expect(computeBindingStamp(withBinary)).toBe(computeBindingStamp(base));
  });

  it('two identical harness configs on different binary versions share one stamp', () => {
    const v1 = { ...withAdapter('claude-headless'), binaryVersion: '1.0.0' } as unknown as BindingStampInputs;
    const v2 = { ...withAdapter('claude-headless'), binaryVersion: '2.0.0' } as unknown as BindingStampInputs;
    expect(computeBindingStamp(v1)).toBe(computeBindingStamp(v2));
  });
});

// ---------------------------------------------------------------------------
// AC3 / AC4 — skip on match, re-execute on any identity change (via decideResume).
// ---------------------------------------------------------------------------

function minimalOutput(): StationOutput<unknown> {
  return {
    payload: { summary: 'done' },
    findings_hash: 'fh',
    return_to: null,
    usage: { tokens: 0, cost: 0 },
  } as StationOutput<unknown>;
}

const KEY: CheckpointKey = { run: DEFAULT_RUN_ID, flow: '1', card: 'entry', station: 'coder', attempt: 0 };

describe('WI-572 AC3/AC4 — resume decision on the stored harness stamp', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureCheckpointSchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it('AC3: an unchanged adapter (matching stamp) is REUSED — skip, no re-bill', () => {
    const stamp = computeBindingStamp(withAdapter('claude-headless'));
    writeCheckpoint(db, KEY, { stamp, output: minimalOutput() });

    const decision = decideResume(db, KEY, computeBindingStamp(withAdapter('claude-headless')));
    expect(decision.action).toBe('reuse');
  });

  it('AC4: a changed ADAPTER NAME invalidates — stamp_mismatch → re-execute', () => {
    writeCheckpoint(db, KEY, {
      stamp: computeBindingStamp(withAdapter('claude-headless')),
      output: minimalOutput(),
    });

    const decision = decideResume(db, KEY, computeBindingStamp(withAdapter('codex-headless')));
    expect(decision.action).toBe('reexecute');
    if (decision.action === 'reexecute') expect(decision.reason).toBe('stamp_mismatch');
  });

  it('AC4: a changed model or prompt version also invalidates the harness checkpoint', () => {
    writeCheckpoint(db, KEY, {
      stamp: computeBindingStamp(withAdapter('claude-headless')),
      output: minimalOutput(),
    });

    expect(decideResume(db, KEY, computeBindingStamp(withAdapter('claude-headless', { modelId: 'opus' }))).action).toBe('reexecute');
    expect(decideResume(db, KEY, computeBindingStamp(withAdapter('claude-headless', { promptTemplateVersion: 'v2' }))).action).toBe('reexecute');
  });
});

// ---------------------------------------------------------------------------
// AC4 — a harness station's invalidation cascades downstream (pre-existing
// cascadeInvalidation, exercised for the harness case).
// ---------------------------------------------------------------------------

describe('WI-572 AC4 — invalidation cascades along artifact edges', () => {
  it('invalidating the harness station carries to the stations consuming its output', () => {
    const graph = {
      stations: [
        { id: 'coder', inputs: ['task.json'], outputs: ['result.json'] },
        { id: 'review', inputs: ['result.json'], outputs: ['review.json'] },
        { id: 'publish', inputs: ['review.json'], outputs: ['out.json'] },
        { id: 'unrelated', inputs: ['other.json'], outputs: ['nope.json'] },
      ],
    };
    const invalidated = cascadeInvalidation(graph, ['coder']);
    // The harness station + every transitive consumer of its output are dirty.
    expect(new Set(invalidated)).toEqual(new Set(['coder', 'review', 'publish']));
    // A station that never touches the harness output is spared.
    expect(invalidated).not.toContain('unrelated');
  });
});

// ---------------------------------------------------------------------------
// Executor-level resume proof (DEPENDS ON WI-565's harness execution path AND
// its C2 wiring that threads station.harness into the computeBindingStamp call
// site). This is the end-to-end integration: an unchanged adapter is skipped on
// resume; a changed adapter name is re-invoked. If RED after the checkpoint.ts
// change, the gap is WI-565's call site not passing adapterName — escalate.
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

function makeIO(): { io: { out: (l: string) => void; err: (l: string) => void } } {
  return { io: { out: () => {}, err: () => {} } };
}

function makeThrowingModel(): ModelAdapter {
  return { async call() { throw new Error('ModelAdapter must not be called by a harness maker'); } };
}

function makeRecordingHarness(name: string): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name,
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      calls.push(call);
      const abs = join(process.cwd(), 'result.json');
      writeFileSync(abs, JSON.stringify({ summary: `by ${name}` }), 'utf-8');
      const outputs: ProducedOutput[] = [{ name: 'result.json', path: abs }];
      return { outputs, usage: { tokens: 100, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

function writeHarnessFlow(dir: string, harnessName: string, registry: HarnessRegistry) {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: harness-stamp-exec
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: ${harnessName}
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCoderCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
  });
}

function resetCardToStation(db: ConduitDB): void {
  db.getStateDb()
    .prepare("UPDATE cards SET lane = 'coder', status = 'ready' WHERE id = 'entry' AND run_id = 'default'")
    .run();
}

describe('WI-572 executor-level resume — adapter identity governs skip vs re-invoke', () => {
  let originalCwd: string;
  let projectDir: string;
  let cdb: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-stamp-'));
    process.chdir(projectDir);
    cdb = null;
  });
  afterEach(() => {
    if (cdb) {
      cdb.close();
      cdb = null;
    }
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('an UNCHANGED adapter is skipped on resume (matching stamp — not re-billed)', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const a = makeRecordingHarness('fake-a');
    const registry = createHarnessRegistry([a.adapter]);
    const flow = writeHarnessFlow(projectDir, 'fake-a', registry);
    seedCoderCard(cdb);
    const { io } = makeIO();

    await runExecutor({ db: cdb, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry } as RunEngineArgs);
    expect(a.calls).toHaveLength(1);

    resetCardToStation(cdb);
    await runExecutor({ db: cdb, flow, now: SECONDS(2000), adapter: makeThrowingModel(), io, harnessRegistry: registry } as RunEngineArgs);

    // Matching stamp (same adapter identity) → skipped, no second invocation.
    expect(a.calls).toHaveLength(1);
  });

  it('a CHANGED adapter name is re-invoked on resume (stamp mismatch → re-execute)', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const a = makeRecordingHarness('fake-a');
    const b = makeRecordingHarness('fake-b');
    // Both adapters are registered; only the flow's declared harness NAME changes
    // between runs — model, prompt, and inputs are byte-identical.
    const registry = createHarnessRegistry([a.adapter, b.adapter]);

    const flowA = writeHarnessFlow(projectDir, 'fake-a', registry);
    seedCoderCard(cdb);
    const { io } = makeIO();
    await runExecutor({ db: cdb, flow: flowA, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry } as RunEngineArgs);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);

    // Resume with the SAME station but a different adapter name.
    const flowB = writeHarnessFlow(projectDir, 'fake-b', registry);
    resetCardToStation(cdb);
    await runExecutor({ db: cdb, flow: flowB, now: SECONDS(2000), adapter: makeThrowingModel(), io, harnessRegistry: registry } as RunEngineArgs);

    // Adapter name is in the stamp → the checkpoint no longer matches → re-execute
    // under the new adapter (proving adapter identity governs resume soundness).
    expect(b.calls).toHaveLength(1);
  });
});
