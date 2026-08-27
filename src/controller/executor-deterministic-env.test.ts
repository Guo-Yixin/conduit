/**
 * Behavior test for market-flow parity PATCH 2 — per-card env injection into
 * deterministic stations.
 *
 * A `kind: deterministic` station is spawned as a bare command with no worker
 * IPC and no stdin payload, so — unlike transform/harness workers — it has no
 * channel through which to learn how many times its card has been reworked or
 * which attempt this is. The executor now injects that context as environment
 * variables sourced from the card it already holds:
 *
 *   CONDUIT_REWORK_COUNT — cards.rework_count for THIS card
 *   CONDUIT_ATTEMPT      — cards.attempt for THIS card
 *
 * This unblocks downstream flows (market-flow's verdict stations) that must
 * implement reviewer-flag-at-cap and no-progress-salt behaviours, which are
 * impossible without the station seeing its real rework count.
 *
 * This drives the REAL runExecutor against an in-memory state DB + journal and
 * the REAL flow loader (same pattern as executor-deterministic-outputs.test.ts).
 * The station command is a tiny POSIX sh script that echoes the injected env
 * vars to stdout; the executor's single-declared-output stdout capture persists
 * that to the declared artifact, which the test then reads back. The card is
 * seeded with a NON-ZERO, non-default rework_count so a hard-coded constant
 * could never pass — the value read back must be the real per-card count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

function makeStubAdapter(): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      throw new Error('adapter should not be called by a deterministic-only flow');
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Write an executable POSIX sh script at `<dir>/<name>`; returns its absolute path. */
function writeScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** A single deterministic station `gen` → done that emits its result to stdout. */
function setupFlow(dir: string, command: string): FlowConfig {
  const flowYaml = `
flow: executor-det-env
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
    worker: { kind: deterministic, command: "${command}" }
    inputs: []
    outputs: [seen.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`det-env fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, opts: { reworkCount: number; attempt: number }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'gen',
    status: 'ready',
    attempt: opts.attempt,
    wave: 0,
    owned_paths: [],
    rework_count: opts.reworkCount,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const SECONDS = (n: number) => () => n;

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-det-env-'));
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

describe('runExecutor — deterministic station per-card env injection (PATCH 2)', () => {
  it('injects the REAL rework_count and attempt from the card into the command env', async () => {
    // The station echoes the injected env vars as JSON to stdout; the executor's
    // single-declared-output stdout capture persists that to seen.json.
    const command = writeScript(
      projectDir,
      'echo-env.sh',
      `printf '{"rework":"%s","attempt":"%s"}' "$CONDUIT_REWORK_COUNT" "$CONDUIT_ATTEMPT"`,
    );
    const flow = setupFlow(projectDir, command);
    db = openDb();
    // Non-zero, non-default values a hard-coded constant could never fake.
    seedCard(db, { reworkCount: 3, attempt: 2 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: makeStubAdapter(), io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const seen = JSON.parse(readFileSync(join(projectDir, 'seen.json'), 'utf-8'));
    expect(seen.rework).toBe('3');
    expect(seen.attempt).toBe('2');
  });

  it('injects "0" for a fresh card (rework_count and attempt both 0)', async () => {
    const command = writeScript(
      projectDir,
      'echo-env.sh',
      `printf '{"rework":"%s","attempt":"%s"}' "$CONDUIT_REWORK_COUNT" "$CONDUIT_ATTEMPT"`,
    );
    const flow = setupFlow(projectDir, command);
    db = openDb();
    seedCard(db, { reworkCount: 0, attempt: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: makeStubAdapter(), io } as RunEngineArgs);

    const seen = JSON.parse(readFileSync(join(projectDir, 'seen.json'), 'utf-8'));
    expect(seen.rework).toBe('0');
    expect(seen.attempt).toBe('0');
  });

  it('still inherits the parent process env (injection layers on top, does not replace)', async () => {
    // A var present only in the parent process env must survive the injection —
    // proving we merge over process.env rather than replacing it (which would
    // strip PATH and break the command entirely).
    process.env.CONDUIT_DET_ENV_PROBE = 'inherited-value';
    try {
      const command = writeScript(
        projectDir,
        'echo-env.sh',
        `printf '{"probe":"%s","rework":"%s"}' "$CONDUIT_DET_ENV_PROBE" "$CONDUIT_REWORK_COUNT"`,
      );
      const flow = setupFlow(projectDir, command);
      db = openDb();
      seedCard(db, { reworkCount: 5, attempt: 0 });
      const { io } = makeIO();

      await runExecutor({ db, flow, now: SECONDS(1000), adapter: makeStubAdapter(), io } as RunEngineArgs);

      const seen = JSON.parse(readFileSync(join(projectDir, 'seen.json'), 'utf-8'));
      expect(seen.probe).toBe('inherited-value');
      expect(seen.rework).toBe('5');
    } finally {
      delete process.env.CONDUIT_DET_ENV_PROBE;
    }
  });
});
