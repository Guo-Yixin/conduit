/**
 * Deterministic failure MUST count toward the attempt cap (found live,
 * arcane-flows studio: a QC gate that flagged an edit retried at attempt 0
 * FOREVER — edit + QC re-executing every dispatch cycle, never scrapping,
 * nothing journaled).
 *
 * Root cause: executeDeterministicStation's failure branches release the
 * worker slot and return WITHOUT incrementing the card's attempt or
 * consulting per_card.max_execution_attempts — so "fail closed" degrades to
 * "retry eternally, silently". The transform path already counts attempts;
 * this pins the same contract for deterministic stations:
 *
 *   - each nonzero exit increments the card's durable attempt counter
 *   - reaching the cap routes the card to scrap with a reason NAMING the
 *     station, the exit code, and a stderr tail (operator-diagnosable)
 *   - a success before the cap proceeds normally (flaky-command tolerance)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, StationConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runExecutor } from './executor';

let dir: string;
let db: ConduitDB | null;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-attempt-cap-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A Law-lite-safe script that logs each execution and exits per its script:
 * failN → always exit 1; flaky → exit 1 first run, exit 0 after.
 */
function buildFlow(
  script: 'always-fail' | 'flaky',
  maxAttempts: number,
  opts: { effectful?: boolean } = {},
): FlowConfig {
  const body =
    script === 'always-fail'
      ? "open('runs.log','a').write('run\\n')\nraise SystemExit(1)\n"
      : [
          "import os",
          "open('runs.log','a').write('run\\n')",
          "n = sum(1 for l in open('runs.log') if l.strip())",
          "open('out.json','w').write('{}')",
          "raise SystemExit(0 if n >= 2 else 1)",
        ].join('\n') + '\n';
  writeFileSync(join(dir, 'job.py'), body);

  const qc: StationConfig = {
    kind: 'deterministic',
    effectful: opts.effectful ?? false,
    wip: 1,
    inputs: [],
    outputs: script === 'flaky' ? ['out.json'] : [],
    command: 'python3',
    args: ['job.py'],
    next: 'done',
  };
  return {
    version: 1,
    stations: { qc },
    terminal_lanes: ['done', 'scrap', 'hold'],
    happyPathNext: { qc: 'done' },
    budgets: {
      run: { wall_clock_minutes: 5, max_tokens: 1000 },
      per_card: { max_execution_attempts: maxAttempts },
      liveness: { no_progress_minutes: 5 },
    },
    defaults: { capPolicy: 'scrap', onDepScrap: 'scrap', enforceOwnedPaths: false },
    project_root: dir,
    security: { bash: { allow: ['python3'], deny_shell_metachars: true } },
  } as unknown as FlowConfig;
}

function seed(database: ConduitDB): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null,
    lane: 'qc', status: 'ready', attempt: 0, wave: 0, owned_paths: [],
  });
}

function runs(): number {
  return existsSync(join(dir, 'runs.log'))
    ? readFileSync(join(dir, 'runs.log'), 'utf-8').split('\n').filter((l) => l === 'run').length
    : 0;
}

async function drive(flow: FlowConfig, extra: Record<string, unknown> = {}): Promise<string[]> {
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  let t = 1000;
  await Promise.race([
    runExecutor({ db: db!, flow, now: () => (t += 3), io, ...extra } as unknown as RunEngineArgs),
    new Promise((r) => setTimeout(r, 8000)), // an infinite retry loop must not hang the suite
  ]);
  return lines;
}

describe('deterministic failure counts toward the attempt cap', () => {
  it('an always-failing command scraps at the cap — NEVER retries forever at attempt 0', async () => {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    seed(db);

    await drive(buildFlow('always-fail', 2));

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    // The command executed exactly cap times — not once, not forever.
    expect(runs()).toBe(2);
    // The scrap reason NAMES the failure for the operator.
    const terminal = db.getCardLog('entry').find((e) => e.kind === 'terminal');
    const reason = (terminal as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('qc');
    expect(reason).toContain('exit');
  });

  it('a flaky command that succeeds on retry proceeds normally (attempts are tolerance, not a trap)', async () => {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    seed(db);

    await drive(buildFlow('flaky', 3));

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    expect(runs()).toBe(2); // failed once, succeeded once
  });
});

// ---------------------------------------------------------------------------
// the pre-public deterministic failure-reporting review #1 — the EFFECTFUL branch must stay fail-closed, not count-and-retry
// ---------------------------------------------------------------------------

describe('effectful deterministic failure stays fail-closed (outbox discipline)', () => {
  it('holds with the intent left pending — the side effect is NEVER re-fired', async () => {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    seed(db);

    await drive(buildFlow('always-fail', 4, { effectful: true }));

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    // Hard-pause, not scrap-after-retries: a nonzero exit does not prove the
    // side effect never escaped, and a retry would recompute the idempotency
    // key at the bumped attempt and blind-re-FIRE it (SPEC §5).
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe('qc'); // parked at the station, not moved
    // The command ran exactly ONCE — count-and-retry never re-fired it,
    // despite ample cap headroom (cap 4).
    expect(runs()).toBe(1);
    // The PENDING outbox intent survives for manual reconciliation.
    const pending = db
      .getStateDb()
      .prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL')
      .get() as { n: number };
    expect(pending.n).toBe(1);
    // The hold reason names the failure for the operator (escalateToHold
    // writes the detail on its 'terminal' card_log entry).
    const terminal = db.getCardLog('entry').find((e) => e.kind === 'terminal');
    const reason = (terminal as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('qc');
    expect(reason).toContain('pending');
  });
});

// ---------------------------------------------------------------------------
// the pre-public deterministic failure-reporting review #3 — pooled deterministic failures get the SAME count-and-retry
// ---------------------------------------------------------------------------

describe('pooled deterministic failures count toward the same cap', () => {
  /**
   * A scripted pool driver (mirrors executor-markdone.test.ts): captures the
   * kernel's onMessage handler, and answers every START_WORK synchronously
   * with a scripted MARK_DONE — 'failed' (with diagnostic detail) or
   * 'success' — WITHOUT touching the DB (single-writer: only the kernel does).
   */
  function makeDriver(verdictFor: (attempt: number) => 'fail' | 'success') {
    let handler: ((msg: unknown) => void) | null = null;
    const startWorkAttempts: number[] = [];

    const onMessage = (h: (msg: unknown) => void) => {
      handler = h;
    };
    const spawn = (args: { cardId: string; station: string }) => ({
      pid: 4242,
      send: (msg: { type: string; cardId: string; station: string; attempt: number }) => {
        if (msg.type !== 'START_WORK') return;
        startWorkAttempts.push(msg.attempt);
        if (!handler) throw new Error('kernel did not register an onMessage handler');
        const verdict = verdictFor(msg.attempt);
        handler({
          type: 'MARK_DONE',
          cardId: msg.cardId,
          station: args.station,
          attempt: msg.attempt,
          outcome: verdict === 'success' ? 'success' : 'failed',
          usage: { tokens: 0 },
          ...(verdict === 'fail' && {
            // Control chars smuggled past a (hypothetically) lax worker — the
            // kernel's reason construction must sanitize them regardless.
            failure: { exitCode: 1, stderrTail: 'boom from\x1b[2K\n pooled worker' },
          }),
        });
      },
    });

    return { onMessage, spawn, startWorkAttempts };
  }

  it('an always-failing pooled command scraps at the cap — same boundary as the sync path', async () => {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    seed(db);
    const driver = makeDriver(() => 'fail');

    await drive(buildFlow('always-fail', 2), {
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    });

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    // Dispatched exactly cap times, at bumped attempts — not once, not forever.
    expect(driver.startWorkAttempts).toEqual([0, 1]);
    // The scrap reason carries the worker's reported diagnostic detail, with
    // control characters sanitized (log-injection guard, the pre-public deterministic failure-reporting review):
    // ESC/newline collapse to spaces before persistence.
    const terminal = db.getCardLog('entry').find((e) => e.kind === 'terminal');
    const reason = (terminal as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('exit 1');
    expect(reason).toContain('boom from');
    expect(reason).toContain('pooled worker');
    expect(reason).not.toContain('\x1b');
    expect(reason).not.toContain('\n');
  });

  it('a flaky pooled command that succeeds on retry proceeds normally', async () => {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    seed(db);
    const driver = makeDriver((attempt) => (attempt === 0 ? 'fail' : 'success'));

    await drive(buildFlow('always-fail', 3), {
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    });

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    // One failure counted, one retry at the bumped attempt, then success.
    expect(driver.startWorkAttempts).toEqual([0, 1]);
  });
});
