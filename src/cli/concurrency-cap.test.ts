/**
 * Run-level concurrency cap (WI-466, FR-2a).
 *
 * An operator caps the number of in-flight worker processes K via a flow.yaml
 * default or `conduit run --concurrency K`. The override beats the flow default;
 * absent both, K resolves to 1 — preserving today's single-in-flight behaviour
 * byte-for-byte. The resolved value is threaded into RunEngineArgs so a later
 * (separate) item can read min(K, station.wip) per station. This item covers the
 * config surface, CLI flag parsing, and the RunEngineArgs threading ONLY — not
 * the event-driven executor loop.
 *
 * Exercised through the injected-seam entrypoint (same as src/cli/cli.test.ts):
 *
 *   export function main(argv: string[], deps: CliDeps): Promise<number>
 *   export interface RunEngineArgs { ...; concurrency: number }   // NEW field
 *
 * The true observable for "the resolved cap reached the engine" is the
 * `concurrency` field on the RunEngineArgs captured from an injected runEngine —
 * so AC1/AC2/AC3/AC5 assert on that. AC4 (invalid value) asserts a usage error +
 * non-zero exit with the engine NEVER reached (rejected before dispatch).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins
 * ---------------------------------------------------------------------------
 *  - FlowDefaults gains an optional `concurrency` field; a flow.yaml declaring
 *    `defaults.concurrency: N` surfaces it as flow.defaults.concurrency === N.
 *  - cmdRun resolves the effective cap as: --concurrency flag (if valid) >
 *    flow.defaults.concurrency (if present) > 1. The resolved number is passed
 *    as RunEngineArgs.concurrency.
 *  - An invalid --concurrency (non-integer, or < 1) is rejected with a clear
 *    usage error on stderr and a non-zero exit, BEFORE any dispatch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { loadFlow } from '../flow/load';
import {
  main,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from './main';

// ---------------------------------------------------------------------------
// Captured IO + stub adapter
// ---------------------------------------------------------------------------

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
let flowRoot: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-conc-'));
  // Every flow needs the station prompt file present on disk (loadFlow checks).
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

/**
 * Write a minimal single-station flow.yaml into the temp root. When
 * `concurrencyDefault` is provided, it is emitted as `defaults.concurrency`.
 * Returns the absolute flow path.
 */
function writeFlow(concurrencyDefault?: number): string {
  const defaultsBlock = [
    'defaults:',
    '  cap_policy: scrap',
    '  on_dep_scrap: scrap',
    ...(concurrencyDefault !== undefined ? [`  concurrency: ${concurrencyDefault}`] : []),
  ].join('\n');

  const yaml = `flow: minimal
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
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
  const flowPath = join(flowRoot, 'flow.yaml');
  writeFileSync(flowPath, yaml, 'utf-8');
  return flowPath;
}

interface CaptureRun {
  args?: RunEngineArgs;
  called: boolean;
}

/** Build deps whose runEngine records the RunEngineArgs it was called with. */
function makeDeps(capture: CaptureRun): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (args) => {
      capture.called = true;
      capture.args = args;
    },
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

/** Deps whose runEngine THROWS if reached — used to prove "before any dispatch". */
function makeNoDispatchDeps(): CliDeps & { engineReached: () => boolean } {
  let reached = false;
  const deps: CliDeps = {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async () => {
      reached = true;
    },
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
  return Object.assign(deps, { engineReached: () => reached });
}

// ===========================================================================
// AC1 — FlowDefaults gains optional concurrency; loadFlow surfaces a declared
//        value, and defaults to 1 (resolved into the engine) when absent.
// ===========================================================================

describe('flow.yaml concurrency default (AC1)', () => {
  it('surfaces a declared defaults.concurrency on the loaded FlowConfig', () => {
    const flowPath = writeFlow(4);
    const loaded = loadFlow(flowPath);
    if (!loaded.ok) throw new Error(`flow should load: ${JSON.stringify(loaded.errors)}`);
    expect(loaded.flow.defaults?.concurrency).toBe(4);
  });

  it('resolves the flow default into RunEngineArgs.concurrency when no flag is given', async () => {
    const flowPath = writeFlow(4);
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--input-inline', '{}'], makeDeps(cap));

    expect(cap.called).toBe(true);
    expect(cap.args?.concurrency).toBe(4);
  });
});

// ===========================================================================
// AC2 — --concurrency overrides the flow default; the resolved value reaches
//        RunEngineArgs.
// ===========================================================================

describe('--concurrency override (AC2)', () => {
  it('passes the flag value (8) to RunEngineArgs, beating a flow default of 4', async () => {
    const flowPath = writeFlow(4);
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--concurrency', '8', '--input-inline', '{}'], makeDeps(cap));

    expect(cap.called).toBe(true);
    expect(cap.args?.concurrency).toBe(8);
  });

  it('honours the flag when the flow declares NO default', async () => {
    const flowPath = writeFlow(); // no defaults.concurrency
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--concurrency', '5', '--input-inline', '{}'], makeDeps(cap));

    expect(cap.args?.concurrency).toBe(5);
  });
});

// ===========================================================================
// AC3 — neither flag nor flow default → resolved concurrency is 1 (today's
//        single-in-flight behaviour preserved).
// ===========================================================================

describe('default when neither flag nor flow default present (AC3)', () => {
  it('resolves concurrency to 1', async () => {
    const flowPath = writeFlow(); // no defaults.concurrency, no flag
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--input-inline', '{}'], makeDeps(cap));

    expect(cap.called).toBe(true);
    expect(cap.args?.concurrency).toBe(1);
  });
});

// ===========================================================================
// AC4 — invalid --concurrency (non-integer, or < 1) → clear usage error +
//        non-zero exit, BEFORE any dispatch.
// ===========================================================================

describe('invalid --concurrency is rejected before dispatch (AC4)', () => {
  it.each([
    ['non-integer text', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '2.5'],
  ])('rejects %s (%j) with a usage error, non-zero exit, and no engine dispatch', async (_label, value) => {
    const flowPath = writeFlow();
    const deps = makeNoDispatchDeps();

    const code = await main(['run', flowPath, '--concurrency', value, '--input-inline', '{}'], deps);

    expect(code).not.toBe(0);
    expect(deps.engineReached()).toBe(false);
    // The error names the offending flag so the operator knows what to fix.
    expect(io.errors.join('\n')).toMatch(/concurrency/i);
  });

  it('a valid --concurrency value (1) is NOT rejected — exercises the accept boundary', async () => {
    const flowPath = writeFlow();
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--concurrency', '1', '--input-inline', '{}'], makeDeps(cap));

    expect(cap.called).toBe(true);
    expect(cap.args?.concurrency).toBe(1);
    expect(io.errors.join('\n')).not.toMatch(/concurrency/i);
  });
});

// ===========================================================================
// AC5 — RunEngineArgs carries the resolved concurrency (so the engine can read
//        min(K, station.wip) per station). Verified via the captured args above;
//        this test pins the field's presence and numeric type explicitly.
// ===========================================================================

describe('RunEngineArgs carries the resolved concurrency (AC5)', () => {
  it('always passes a numeric concurrency to the engine (override path)', async () => {
    const flowPath = writeFlow(2);
    const cap: CaptureRun = { called: false };

    await main(['run', flowPath, '--concurrency', '7', '--input-inline', '{}'], makeDeps(cap));

    expect(typeof cap.args?.concurrency).toBe('number');
    expect(cap.args?.concurrency).toBe(7);
  });
});
