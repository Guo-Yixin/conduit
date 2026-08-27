/**
 * Behavior tests for the deterministic-output work — deterministic stations silently dropping stdout.
 *
 * A `kind: deterministic` station declares `outputs: [...]`, but if the
 * command emits its result to stdout instead of writing the file, the
 * executor used to advance the card anyway with no artifact and no error.
 * This file pins the fix in `src/controller/executor.ts`
 * (`executeDeterministicStation`):
 *
 *   1. stdout → single declared output: when a station declares EXACTLY ONE
 *      `outputs:` entry, the command exits 0, no file exists at that path
 *      afterward, and stdout is non-empty → persist stdout to that path.
 *   2. Post-run declared-outputs safety net: after the run (and after fix 1's
 *      capture), any declared `outputs:` artifact still missing on disk is a
 *      hard failure — the card does NOT advance, and the reason
 *      `deterministic-output-missing: <name>` is recorded on the same
 *      hard-pause-to-hold path the executor already uses for an owned_paths
 *      integrity breach (see executor-integrity-cascade.test.ts).
 *
 * These drive the REAL `runExecutor` against an in-memory state DB + journal,
 * a stub ModelAdapter (unused by deterministic stations, but required by
 * RunEngineArgs), and minimal flows loaded by the REAL loader. Commands are
 * tiny POSIX shell scripts written to disk (same pattern as
 * effectful-outbox.test.ts) so the Law-lite allowlist sees a safe absolute
 * path with no shell metacharacters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Stub ModelAdapter — deterministic stations never call it, but RunEngineArgs
// requires one.
// ---------------------------------------------------------------------------

function makeStubAdapter(): { adapter: ModelAdapter } {
  const adapter: ModelAdapter = {
    async call(_req: ModelCall): Promise<ModelResponse> {
      throw new Error('adapter should not be called by a deterministic-only flow');
    },
  };
  return { adapter };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Write an executable POSIX sh script at `<dir>/<name>`; returns its absolute path. */
function writeScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** A single deterministic station `gen` → done, declaring the given `outputs:`. */
function setupDeterministicOutputsFlow(
  dir: string,
  opts: { command: string; outputs: string[] },
): FlowConfig {
  const outputsYaml = opts.outputs.map((o) => `      - ${o}`).join('\n');
  const flowYaml = `
flow: executor-det-outputs
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
    allow: ["${opts.command}"]
stations:
  - id: gen
    worker: { kind: deterministic, command: "${opts.command}" }
    inputs: []
    outputs:
${outputsYaml}
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`det-outputs fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedEntryCard(db: ConduitDB, ownedPaths: string[] = []): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'gen',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ownedPaths,
    rework_count: 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

/** The terminal reason(s) recorded in the card_log. */
function terminalReasons(db: ConduitDB, cardId: string): string[] {
  return db
    .getCardLog(cardId)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

const SECONDS = (n: number) => () => n;

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-det-outputs-'));
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

// ---------------------------------------------------------------------------
// Fix 1 — stdout persisted to the single declared output.
// ---------------------------------------------------------------------------

describe('runExecutor — deterministic stdout capture (the deterministic-output work fix 1)', () => {
  it('persists stdout to the single declared output and advances the card', async () => {
    const command = writeScript(projectDir, 'gen.sh', `printf '{"ok":true}'`);
    const flow = setupDeterministicOutputsFlow(projectDir, { command, outputs: ['out.json'] });
    db = openDb();
    seedEntryCard(db);
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(existsSync(join(projectDir, 'out.json'))).toBe(true);
    expect(readFileSync(join(projectDir, 'out.json'), 'utf-8')).toBe('{"ok":true}');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — post-run safety net for a declared output that never materializes.
// ---------------------------------------------------------------------------

describe('runExecutor — deterministic-output-missing safety net (the deterministic-output work fix 2)', () => {
  it('holds the card and records deterministic-output-missing when declared outputs never appear', async () => {
    // Multi-output station: fix 1's stdout capture is out of scope (ambiguous
    // which declared output the stdout belongs to), so both outputs stay
    // missing after the command exits 0 having written neither.
    const command = writeScript(projectDir, 'noop.sh', 'exit 0');
    const flow = setupDeterministicOutputsFlow(projectDir, { command, outputs: ['a.json', 'b.json'] });
    db = openDb();
    seedEntryCard(db);
    const { adapter } = makeStubAdapter();
    const { io, err } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Card does NOT advance to done — the run does not pretend success.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');

    // The reason is visible on the io.err channel...
    expect(err.join(' ')).toMatch(/deterministic-output-missing: a\.json, b\.json/);
    // ...and in the journal's terminal card_log entry.
    expect(terminalReasons(db, 'entry').join(' ')).toMatch(/deterministic-output-missing: a\.json, b\.json/);

    // Neither declared output was fabricated.
    expect(existsSync(join(projectDir, 'a.json'))).toBe(false);
    expect(existsSync(join(projectDir, 'b.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression — a station that legitimately writes its own declared output
// (e.g. a DuckDB `COPY ... TO`) is untouched by the stdout-capture fix.
// ---------------------------------------------------------------------------

describe('runExecutor — self-written declared output is unaffected (regression)', () => {
  it('advances normally and never lets stdout clobber a file the command wrote itself', async () => {
    // Writes the declared output ITSELF (via the arg path) and ALSO emits
    // unrelated stdout — proving the stdout capture never overwrites a file
    // that already exists after the command ran.
    const command = writeScript(
      projectDir,
      'self-write.sh',
      `printf '{"scriptWrote":true}' > "$1"\nprintf 'stdout-noise-should-be-ignored'`,
    );
    const flowYaml = `
flow: executor-det-outputs-selfwrite
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
  - id: gen
    worker: { kind: deterministic, command: "${command}", args: ["${join(projectDir, 'out.json')}"] }
    inputs: []
    outputs: [out.json]
    next: done
`;
    writeFileSync(join(projectDir, 'flow.yaml'), flowYaml);
    const loaded = loadFlow(join(projectDir, 'flow.yaml'));
    if (!loaded.ok) throw new Error(`self-write fixture invalid: ${JSON.stringify(loaded.errors)}`);
    const flow = loaded.flow;

    db = openDb();
    seedEntryCard(db);
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    // Content is exactly what the script wrote — not the stdout noise.
    expect(readFileSync(join(projectDir, 'out.json'), 'utf-8')).toBe('{"scriptWrote":true}');
  });
});
