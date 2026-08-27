/**
 * `conduit run` orphan-reclaim on startup (market-flow parity PATCH 1).
 *
 * Symptom this guards against: an interrupted `conduit run` leaves an
 * `active_workers` row behind (the process died before releasing its slot).
 * The next `conduit run` that reuses the same state DB / run_id inherits that
 * orphaned slot. Because WIP is measured from active_workers (run-scoped), the
 * station is already at its cap on the very first tick and the run silently
 * stalls with no diagnostic.
 *
 * cmdResume already reclaims orphaned workers after acquiring the run lease;
 * cmdRun did not. These tests prove cmdRun now performs the same reclaim before
 * dispatching, unconditionally (the orphan's lease is deliberately UNEXPIRED, so
 * a lease-based reconcile would miss it — only the unconditional reclaim frees
 * it), scoped to the run being started, and with an operator-visible diagnostic.
 *
 * Uses the same injected-seam entry point as run-namespacing.test.ts:
 *   main(argv, deps) → exit code, with runEngine stubbed so the test can inspect
 *   DB state at the exact moment the engine would begin dispatching.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
let flowRoot: string;

// Injected clock. The orphan's lease is set FAR beyond this so that a
// lease-based reconcile (lease_until <= now) would never fire — proving the
// reclaim is unconditional, the only sound choice when the owning process is
// known dead.
const NOW = 1_000;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-orphan-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

/** Minimal valid single-station flow (station id: only, wip defaults to 1). */
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

/**
 * Strand an in-flight worker for `runId`: a card stuck in 'working' plus its
 * active_workers slot at `station`, exactly the shape a crashed process leaves
 * behind. Deliberately NO run-registry row — so the next `conduit run` registers
 * fresh (kind: 'created') and drives the engine, which is the path that would
 * inherit the orphaned slot. The lease is UNEXPIRED relative to NOW.
 */
function strandOrphan(runId: string, cardId: string, station: string): void {
  db.insertCard({
    run_id: runId,
    id: cardId,
    parent_id: null,
    lane: station,
    status: 'working',
    attempt: 0,
    wave: 0,
    owned_paths: ['in.json', 'out.json'],
    rework_count: 0,
  });
  db.getStateDb()
    .prepare(
      `INSERT INTO active_workers (run_id, card_id, station, worker_id, started_at, lease_until, pid)
       VALUES ($run_id, $card_id, $station, $worker_id, $started_at, $lease_until, $pid)`,
    )
    .run({
      $run_id: runId,
      $card_id: cardId,
      $station: station,
      $worker_id: 'dead-worker',
      $started_at: NOW - 500,
      $lease_until: NOW + 1_000_000, // far future: reconcile would NOT reclaim this
      $pid: 999_999,
    });
}

function activeWorkerCount(runId: string, station: string): number {
  return (
    db.getStateDb()
      .prepare('SELECT COUNT(*) AS n FROM active_workers WHERE run_id = $run_id AND station = $station')
      .get({ $run_id: runId, $station: station }) as { n: number }
  ).n;
}

function cardStatus(runId: string, cardId: string): string | undefined {
  return (
    db.getStateDb()
      .prepare('SELECT status FROM cards WHERE run_id = $run_id AND id = $id')
      .get({ $run_id: runId, $id: cardId }) as { status: string } | undefined
  )?.status;
}

function makeDeps(runEngine?: (args: RunEngineArgs) => Promise<void>): CliDeps {
  return {
    io,
    now: () => NOW,
    db,
    adapter: stubAdapter,
    runEngine: runEngine ?? (async () => {}),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

describe('conduit run reclaims orphaned in-flight workers on startup', () => {
  it('releases an orphaned active_workers slot BEFORE the engine dispatches', async () => {
    const flowPath = writeFlow();
    strandOrphan('job-A', 'orphan-1', 'only');
    expect(activeWorkerCount('job-A', 'only')).toBe(1); // orphan holds the slot

    let slotsAtDispatch = -1;
    let orphanStatusAtDispatch: string | undefined;
    await main(
      ['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'],
      makeDeps(async () => {
        // Snapshot the moment the engine would begin its first tick.
        slotsAtDispatch = activeWorkerCount('job-A', 'only');
        orphanStatusAtDispatch = cardStatus('job-A', 'orphan-1');
      }),
    );

    // The station slot was freed before dispatch — the run starts under the cap.
    expect(slotsAtDispatch).toBe(0);
    // The orphaned card was re-hydrated to 'interrupted' (the executor promote
    // step then re-readies it), never left stuck in 'working'.
    expect(orphanStatusAtDispatch).toBe('interrupted');
  });

  it('emits an operator-visible diagnostic naming the reclaimed run (no silent stall)', async () => {
    const flowPath = writeFlow();
    strandOrphan('job-A', 'orphan-1', 'only');

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps());

    const diagnostic = io.errors.join('\n');
    expect(diagnostic).toMatch(/reclaim/i);
    expect(diagnostic).toContain('job-A');
  });

  it('reclaims the orphan even though its lease has NOT expired (unconditional, not lease-based)', async () => {
    const flowPath = writeFlow();
    strandOrphan('job-A', 'orphan-1', 'only');

    // Sanity: the lease is far in the future relative to NOW, so a lease-based
    // reconcile could not be responsible for freeing it.
    const leaseUntil = (
      db.getStateDb()
        .prepare('SELECT lease_until AS l FROM active_workers WHERE card_id = ?')
        .get('orphan-1') as { l: number } | undefined
    )?.l;
    expect(leaseUntil).toBeGreaterThan(NOW);

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps());

    expect(activeWorkerCount('job-A', 'only')).toBe(0);
    expect(cardStatus('job-A', 'orphan-1')).toBe('interrupted');
  });

  it('does not touch orphaned slots belonging to OTHER runs sharing the state DB', async () => {
    const flowPath = writeFlow();
    strandOrphan('job-A', 'orphan-A', 'only');
    strandOrphan('job-OTHER', 'orphan-B', 'only');

    await main(['run', flowPath, '--run-id', 'job-A', '--input-inline', '{}'], makeDeps());

    // job-A's orphan is reclaimed; the unrelated run's orphan is left intact.
    expect(activeWorkerCount('job-A', 'only')).toBe(0);
    expect(activeWorkerCount('job-OTHER', 'only')).toBe(1);
    expect(cardStatus('job-OTHER', 'orphan-B')).toBe('working');
  });

  it('is a harmless no-op for a genuinely fresh run (no orphans, no diagnostic)', async () => {
    const flowPath = writeFlow();

    let engineRan = false;
    await main(
      ['run', flowPath, '--run-id', 'fresh', '--input-inline', '{}'],
      makeDeps(async () => {
        engineRan = true;
      }),
    );

    expect(engineRan).toBe(true);
    expect(io.errors.join('\n')).not.toMatch(/reclaim/i);
  });
});
