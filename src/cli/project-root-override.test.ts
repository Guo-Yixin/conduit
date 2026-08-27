import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, setPinnedFlowVersion, type CliDeps, type CliIO, type RunEngineArgs } from './main';

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
let projectA: string;
let projectB: string;
let flowPath: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  tempRoot = mkdtempSync(join(tmpdir(), 'conduit-project-root-'));
  flowRoot = join(tempRoot, 'flows');
  projectA = join(tempRoot, 'project-a');
  projectB = join(tempRoot, 'project-b');
  mkdirSync(flowRoot);
  mkdirSync(projectA);
  mkdirSync(projectB);
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
  flowPath = writeFlow();
});

afterEach(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeFlow(): string {
  const yaml = `flow: central-autocut
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
  on_dep_scrap: scrap
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
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
  const path = join(flowRoot, 'flow.yaml');
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

describe('conduit run --project-root', () => {
  it('uses the override for seeded artifacts, engine args, and the run record', async () => {
    let capturedProjectRoot: string | undefined;

    const code = await main(
      ['run', flowPath, '--run-id', 'job-root', '--project-root', projectA, '--input-inline', '{"ok":true}'],
      makeDeps({
        runEngine: async (args) => {
          capturedProjectRoot = args.projectRoot;
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-root'").run();
        },
      }),
    );

    expect(code).toBe(0);
    expect(capturedProjectRoot).toBe(projectA);
    expect(readFileSync(join(projectA, 'in.json'), 'utf-8')).toBe('{"ok":true}');
    expect(existsSync(join(flowRoot, 'in.json'))).toBe(false);
    expect(db.getRun('job-root')?.project_root).toBe(projectA);
  });

  it('treats the same run id with a different project root as a conflict', async () => {
    await main(
      ['run', flowPath, '--run-id', 'job-conflict', '--project-root', projectA, '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-conflict'").run();
        },
      }),
    );

    let engineCalled = false;
    const code = await main(
      ['run', flowPath, '--run-id', 'job-conflict', '--project-root', projectB, '--input-inline', '{}'],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
    expect(io.errors.join('\n')).toMatch(/conflict|already/i);
  });

  it('rejects a project root path that is not a directory', async () => {
    const filePath = join(tempRoot, 'not-a-dir');
    writeFileSync(filePath, 'not a directory', 'utf-8');

    let engineCalled = false;
    const code = await main(
      ['run', flowPath, '--run-id', 'job-bad-root', '--project-root', filePath, '--input-inline', '{}'],
      makeDeps({ runEngine: async () => { engineCalled = true; } }),
    );

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false);
    expect(io.errors.join('\n')).toMatch(/project-root|directory/i);
  });
});

describe('conduit resume project root selection', () => {
  it('uses the recorded project root for the resumed run', async () => {
    setPinnedFlowVersion(db, 1);
    db.insertRun({
      run_id: 'job-resume',
      flow: flowPath,
      project_root: projectA,
      input_fingerprint: 'fp',
      status: 'running',
    });

    let capturedProjectRoot: string | undefined;
    const code = await main(
      ['resume', flowPath, '--run', 'job-resume'],
      makeDeps({ runEngine: async (args) => { capturedProjectRoot = args.projectRoot; } }),
    );

    expect(code).toBe(0);
    expect(capturedProjectRoot).toBe(projectA);
  });

  it('lets --project-root override the recorded project root on resume', async () => {
    setPinnedFlowVersion(db, 1);
    db.insertRun({
      run_id: 'job-resume-override',
      flow: flowPath,
      project_root: projectA,
      input_fingerprint: 'fp',
      status: 'running',
    });

    let capturedProjectRoot: string | undefined;
    const code = await main(
      ['resume', flowPath, '--run', 'job-resume-override', '--project-root', projectB],
      makeDeps({ runEngine: async (args) => { capturedProjectRoot = args.projectRoot; } }),
    );

    expect(code).toBe(0);
    expect(capturedProjectRoot).toBe(projectB);
  });
});
