/**
 * CLI run-lifecycle cleanup tests — code-review findings on prd/run-namespacing.
 *
 * Covers four findings fixed in src/cli/main.ts:
 *   #2  runs.status advances past 'running' on completion (cmdRun + cmdResume),
 *       so bare `conduit resume` does not re-resume a finished run and
 *       getRunState reports a real outcome (not 'unknown').
 *   #4  `journal inspect`/`tail` accept --run and route to the run-scoped getters
 *       (getJournalSpansForRun / getCardLogForRun); default to DEFAULT_RUN_ID.
 *   #5  `conduit run delete --run <id>` and `conduit run status --run <id>`
 *       management subcommands.
 *   #11 the existing-run path prints a formatted line, not raw JSON.
 *
 * Uses the same injected-seam entry point as run-namespacing.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

// ---------------------------------------------------------------------------
// IO capture + stub adapter
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
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-rlc-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

function writeFlow(name = 'minimal'): string {
  const yaml = `flow: ${name}
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
  const flowPath = join(flowRoot, `${name}.yaml`);
  writeFileSync(flowPath, yaml, 'utf-8');
  return flowPath;
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

/** Read the runs row status/outcome for a run id. */
function runRow(runId: string): { status: string; outcome: string | null } | undefined {
  return db
    .getStateDb()
    .prepare('SELECT status, outcome FROM runs WHERE run_id = $r')
    .get({ $r: runId }) as { status: string; outcome: string | null } | undefined;
}

// ===========================================================================
// #2 — runs.status advances past 'running' on completion
// ===========================================================================

describe('#2 cmdRun persists terminal run status', () => {
  it('writes status=done / outcome=complete when the entry card reaches done', async () => {
    const flowPath = writeFlow();
    const code = await main(
      ['run', flowPath, '--run-id', 'job-done', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-done'").run();
        },
      }),
    );
    expect(code).toBe(0);
    const row = runRow('job-done');
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('complete');
  });

  it('writes status=halted / outcome=halted when the entry card does NOT reach done', async () => {
    const flowPath = writeFlow();
    const code = await main(
      ['run', flowPath, '--run-id', 'job-halt', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'hold' WHERE run_id = 'job-halt'").run();
        },
      }),
    );
    expect(code).toBe(1);
    const row = runRow('job-halt');
    expect(row?.status).toBe('halted');
    expect(row?.outcome).toBe('halted');
  });

  it('a completed run is EXCLUDED by the bare-resume selection query (not re-resumed)', async () => {
    const flowPath = writeFlow();
    await main(
      ['run', flowPath, '--run-id', 'job-x', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-x'").run();
        },
      }),
    );

    // Mirror the bare-resume selection query in cmdResume.
    const selectable = db
      .getStateDb()
      .prepare(`SELECT run_id FROM runs WHERE status NOT IN ('done', 'complete', 'terminal', 'scrapped')`)
      .all() as { run_id: string }[];
    expect(selectable.map((r) => r.run_id)).not.toContain('job-x');
  });

  it('a halted run REMAINS selectable by the bare-resume query (resumable)', async () => {
    const flowPath = writeFlow();
    await main(
      ['run', flowPath, '--run-id', 'job-h', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'hold' WHERE run_id = 'job-h'").run();
        },
      }),
    );
    const selectable = db
      .getStateDb()
      .prepare(`SELECT run_id FROM runs WHERE status NOT IN ('done', 'complete', 'terminal', 'scrapped')`)
      .all() as { run_id: string }[];
    expect(selectable.map((r) => r.run_id)).toContain('job-h');
  });
});

describe('#2 cmdResume persists terminal run status', () => {
  it('marks the resumed run done when all its cards are at done', async () => {
    const flowPath = writeFlow();
    // Seed a run that did not finish on first run.
    await main(
      ['run', flowPath, '--run-id', 'job-r', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'hold' WHERE run_id = 'job-r'").run();
        },
      }),
    );
    expect(runRow('job-r')?.status).toBe('halted');

    // Resume scoped to that run; engine drives it to done.
    await main(
      ['resume', '--run', 'job-r', flowPath],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-r'").run();
        },
      }),
    );
    const row = runRow('job-r');
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('complete');
  });
});

// ===========================================================================
// #4 — journal inspect/tail run-scoping with --run
// ===========================================================================

describe('#4 journal --run scoping', () => {
  beforeEach(() => {
    // Same cardId in two different runs — unscoped getters union both.
    db.appendJournalSpan({ runId: 'run-A', cardId: 'c1', station: 's', attempt: 0, name: 'span-A' });
    db.appendJournalSpan({ runId: 'run-B', cardId: 'c1', station: 's', attempt: 0, name: 'span-B' });
  });

  it('inspect --run run-A prints only run-A spans (not run-B)', async () => {
    const code = await main(['journal', 'inspect', 'c1', '--run', 'run-A'], makeDeps());
    expect(code).toBe(0);
    const out = io.lines.join('\n');
    expect(out).toContain('span-A');
    expect(out).not.toContain('span-B');
  });

  it('tail --run run-B prints only run-B spans (not run-A)', async () => {
    const code = await main(['journal', 'tail', 'c1', '--run', 'run-B'], makeDeps());
    expect(code).toBe(0);
    const out = io.lines.join('\n');
    expect(out).toContain('span-B');
    expect(out).not.toContain('span-A');
  });

  it('defaults to DEFAULT_RUN_ID when --run is absent (back-compat)', async () => {
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId: 'c1', station: 's', attempt: 0, name: 'span-default' });
    const code = await main(['journal', 'inspect', 'c1'], makeDeps());
    expect(code).toBe(0);
    const out = io.lines.join('\n');
    expect(out).toContain('span-default');
    expect(out).not.toContain('span-A');
    expect(out).not.toContain('span-B');
  });

  it('inspect --run scopes the card_log too', async () => {
    db.appendCardLog({ runId: 'run-A', cardId: 'c1', station: 's', attempt: 0, kind: 'terminal', reason: 'scrap-A' });
    db.appendCardLog({ runId: 'run-B', cardId: 'c1', station: 's', attempt: 0, kind: 'terminal', reason: 'scrap-B' });
    await main(['journal', 'inspect', 'c1', '--run', 'run-A'], makeDeps());
    const out = io.lines.join('\n');
    expect(out).toContain('scrap-A');
    expect(out).not.toContain('scrap-B');
  });

  it('rejects a malformed --run id (fail-closed)', async () => {
    const code = await main(['journal', 'inspect', 'c1', '--run', 'bad/id'], makeDeps());
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toMatch(/run.?id|invalid/i);
  });
});

// ===========================================================================
// #5 — run delete / run status management subcommands
// ===========================================================================

describe('#5 conduit run status', () => {
  it('prints a formatted terminal state for a finished run', async () => {
    const flowPath = writeFlow();
    await main(
      ['run', flowPath, '--run-id', 'job-s', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          db.getStateDb().prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'job-s'").run();
        },
      }),
    );
    io.lines.length = 0;
    const code = await main(['run', 'status', '--run', 'job-s'], makeDeps());
    expect(code).toBe(0);
    const out = io.lines.join('\n');
    expect(out).toContain('job-s');
    expect(out).not.toMatch(/[{}]/); // not raw JSON
  });

  it('exits non-zero for a not_found run', async () => {
    const code = await main(['run', 'status', '--run', 'nope'], makeDeps());
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toContain('not_found');
  });

  it('requires --run', async () => {
    const code = await main(['run', 'status'], makeDeps());
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toMatch(/usage|--run/);
  });
});

describe('#5 conduit run delete', () => {
  it('deletes every row owned by the run', async () => {
    const flowPath = writeFlow();
    await main(['run', flowPath, '--run-id', 'job-d', '--input-inline', '{}'], makeDeps());
    expect(db.getRun('job-d')).not.toBeNull();

    const code = await main(['run', 'delete', '--run', 'job-d'], makeDeps());
    expect(code).toBe(0);
    expect(db.getRun('job-d')).toBeNull();
    const cards = db
      .getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE run_id = 'job-d'")
      .get() as { n: number };
    expect(cards.n).toBe(0);
  });

  it('refuses to delete without an explicit --run', async () => {
    const code = await main(['run', 'delete'], makeDeps());
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toMatch(/usage|--run/);
  });

  it('rejects a malformed --run id (fail-closed)', async () => {
    const code = await main(['run', 'delete', '--run', 'bad/id'], makeDeps());
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toMatch(/run.?id|invalid/i);
  });

  it('does not collide with running a flow named like a non-keyword bareword', async () => {
    // `run <flow.yaml>` still drives a flow — only the exact keywords intercept.
    const flowPath = writeFlow();
    const code = await main(['run', flowPath, '--input-inline', '{}'], makeDeps());
    expect(code).not.toBe(null);
    // a real run registered under DEFAULT_RUN_ID
    expect(db.getRun(DEFAULT_RUN_ID)).not.toBeNull();
  });
});

// ===========================================================================
// #11 — existing-run path prints a formatted line, not raw JSON
// ===========================================================================

describe('#11 existing-run path formatting', () => {
  it('prints a human-readable line (no raw JSON braces) on idempotent re-submit', async () => {
    const flowPath = writeFlow();
    await main(['run', flowPath, '--run-id', 'job-f', '--input-inline', '{}'], makeDeps());
    io.lines.length = 0;

    const code = await main(['run', flowPath, '--run-id', 'job-f', '--input-inline', '{}'], makeDeps());
    expect(code).toBe(0);
    const out = io.lines.join('\n');
    expect(out).toContain('job-f');
    // The old behaviour dumped JSON.stringify(state) — assert no object braces.
    expect(out).not.toMatch(/[{}]/);
  });
});
