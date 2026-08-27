/**
 * Tests for per-run filesystem workspaces (the original ingress-attribution work step 2).
 *
 * `defaults.workspace: per_run` binds each run's EFFECTIVE project root to
 * `<resolved_project_root>/.conduit/runs/<run-id>/`, materialized before the
 * run is registered. Everything that anchors at the per-run projectRoot —
 * seed staging, engine args, the recorded runs row (and therefore resume's
 * recorded-root re-anchoring, WI-593) — follows automatically through the
 * existing per-run projectRoot binding from project-root binding work/project-root binding work.
 *
 * Why: flow-declared paths (inputs/outputs, work/ files) are project-root-
 * relative and STATIC, so without a workspace two concurrent runs of one flow
 * clobber each other's files. Run namespacing partitions the DB, not the
 * filesystem. This is the second half of the ingress event-isolation work fix: step 1 (derived run
 * ids) prevents the run-id collision; this prevents the file collision that
 * distinct run ids would otherwise expose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;
let tempRoot: string;
let flowRoot: string;
let flowPath: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  tempRoot = mkdtempSync(join(tmpdir(), 'conduit-workspace-'));
  flowRoot = join(tempRoot, 'flows');
  mkdirSync(flowRoot);
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
  flowPath = writeFlow('per_run');
});

afterEach(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeFlow(workspace: string | undefined, fileName = 'flow.yaml'): string {
  const defaultsBlock =
    workspace === undefined
      ? `defaults:
  cap_policy: scrap`
      : `defaults:
  cap_policy: scrap
  workspace: ${workspace}`;
  const yaml = `flow: workspace-test
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
${defaultsBlock}
stations:
  - id: only
    worker:
      kind: transform
      role: writer
      model: test-model
      prompt_file: p.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: text, type: string, required: true }
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: done
`;
  const path = join(flowRoot, fileName);
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

function makeDeps(over: { runEngine?: (args: RunEngineArgs) => Promise<void> } = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {}),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

/** The workspace path the kernel must derive for (flowRoot, runId). */
function workspacePath(runId: string): string {
  return join(flowRoot, '.conduit', 'runs', runId);
}

function markDone(runId: string): void {
  db.getStateDb().prepare(`UPDATE cards SET lane = 'done' WHERE run_id = '${runId}'`).run();
}

describe('defaults.workspace: per_run', () => {
  it('binds the effective project root to .conduit/runs/<run-id>/ for seed, engine, and run record', async () => {
    let engineRoot: string | undefined;

    const code = await main(
      ['run', flowPath, '--run-id', 'ws-a', '--input-inline', '{"n":1}'],
      makeDeps({
        runEngine: async (args) => {
          engineRoot = args.projectRoot;
          markDone('ws-a');
        },
      }),
    );

    expect(code).toBe(0);
    const ws = workspacePath('ws-a');
    expect(engineRoot).toBe(ws);
    // The seed landed INSIDE the workspace, not at the shared root.
    expect(readFileSync(join(ws, 'work/in.json'), 'utf-8')).toBe('{"n":1}');
    expect(existsSync(join(flowRoot, 'work/in.json'))).toBe(false);
    // The runs row records the workspace, so resume re-anchors there (WI-593).
    expect(db.getRun('ws-a')?.project_root).toBe(ws);
  });

  it('keeps two CONCURRENT runs of one flow filesystem-disjoint (the ingress event-isolation work clobber case)', async () => {
    // Both engines are held open at once — genuinely concurrent runs, not
    // sequential: each must see only its own seeded input.
    let releaseA: () => void;
    const engineAGate = new Promise<void>((r) => { releaseA = r; });

    const runA = main(
      ['run', flowPath, '--run-id', 'ws-conc-a', '--input-inline', '{"photo":"a"}'],
      makeDeps({
        runEngine: async () => {
          await engineAGate; // hold run A in-flight while run B seeds + runs
          markDone('ws-conc-a');
        },
      }),
    );
    // Give run A's synchronous phase (seed + register) a turn to complete.
    await new Promise((r) => setTimeout(r, 10));

    const runB = await main(
      ['run', flowPath, '--run-id', 'ws-conc-b', '--input-inline', '{"photo":"b"}'],
      makeDeps({ runEngine: async () => markDone('ws-conc-b') }),
    );
    releaseA!();
    const runAResult = await runA;

    expect(runAResult).toBe(0);
    expect(runB).toBe(0);
    // Each run's input survived the other run — no clobbering.
    expect(readFileSync(join(workspacePath('ws-conc-a'), 'work/in.json'), 'utf-8')).toBe('{"photo":"a"}');
    expect(readFileSync(join(workspacePath('ws-conc-b'), 'work/in.json'), 'utf-8')).toBe('{"photo":"b"}');
  });

  it('re-running the same run id reuses its workspace idempotently (re-drive path)', async () => {
    const deps = makeDeps({ runEngine: async () => markDone('ws-redrive') });
    const first = await main(
      ['run', flowPath, '--run-id', 'ws-redrive', '--input-inline', '{"same":true}'],
      deps,
    );
    // Same event re-driven: same run id, same payload → 'existing' state report.
    const second = await main(
      ['run', flowPath, '--run-id', 'ws-redrive', '--input-inline', '{"same":true}'],
      makeDeps({ runEngine: async () => { throw new Error('must not re-run the engine'); } }),
    );

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(io.lines.join('\n')).toContain('ws-redrive');
  });
});

describe('workspace off (absent or shared)', () => {
  it('absent defaults.workspace preserves the shared-root behavior byte-identically', async () => {
    const sharedFlow = writeFlow(undefined, 'flow-shared.yaml');
    let engineRoot: string | undefined;

    const code = await main(
      ['run', sharedFlow, '--run-id', 'ws-off', '--input-inline', '{}'],
      makeDeps({
        runEngine: async (args) => {
          engineRoot = args.projectRoot;
          markDone('ws-off');
        },
      }),
    );

    expect(code).toBe(0);
    expect(engineRoot).toBe(flowRoot);
    expect(existsSync(join(flowRoot, 'work/in.json'))).toBe(true);
    expect(existsSync(join(flowRoot, '.conduit'))).toBe(false);
  });

  it("workspace: shared behaves the same as absent", async () => {
    const sharedFlow = writeFlow('shared', 'flow-shared2.yaml');
    let engineRoot: string | undefined;

    const code = await main(
      ['run', sharedFlow, '--run-id', 'ws-shared', '--input-inline', '{}'],
      makeDeps({
        runEngine: async (args) => {
          engineRoot = args.projectRoot;
          markDone('ws-shared');
        },
      }),
    );

    expect(code).toBe(0);
    expect(engineRoot).toBe(flowRoot);
  });
});

describe('caller-imposed --project-root wins over workspace derivation (the original multi-flow engine work interaction)', () => {
  it('an explicit --project-root suppresses per_run nesting — the caller decided the root', async () => {
    // The subflow composition case: a child flow that declares per_run for its
    // own standalone (e.g. ingress) runs is invoked by a parent that passes
    // --project-root. The child must run EXACTLY there, or its outputs land in
    // a nested .conduit/runs/ the parent's station contract can't see.
    const imposedRoot = join(tempRoot, 'parent-root');
    mkdirSync(imposedRoot);
    let engineRoot: string | undefined;

    const code = await main(
      ['run', flowPath, '--run-id', 'ws-imposed', '--project-root', imposedRoot, '--input-inline', '{"n":1}'],
      makeDeps({
        runEngine: async (args) => {
          engineRoot = args.projectRoot;
          markDone('ws-imposed');
        },
      }),
    );

    expect(code).toBe(0);
    expect(engineRoot).toBe(imposedRoot); // verbatim — no .conduit/runs nesting
    expect(existsSync(join(imposedRoot, '.conduit'))).toBe(false);
    expect(readFileSync(join(imposedRoot, 'work/in.json'), 'utf-8')).toBe('{"n":1}');
    expect(db.getRun('ws-imposed')?.project_root).toBe(imposedRoot);
  });
});

describe('load validation', () => {
  it('rejects an unknown defaults.workspace value at load (INVALID_WORKSPACE)', async () => {
    const badFlow = writeFlow('per-card', 'flow-bad.yaml'); // not a legal mode
    let engineCalled = false;

    const code = await main(
      ['run', badFlow, '--run-id', 'ws-bad', '--input-inline', '{}'],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
    expect(io.errors.join('\n')).toContain('INVALID_WORKSPACE');
  });
});
