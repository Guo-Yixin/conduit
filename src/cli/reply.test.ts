/**
 * conduit reply CLI command — inject a human selection into a held card (WI-394).
 *
 * SPEC §4A, FR8/FR9. `conduit reply --correlation-id <id> --selection <choice>`
 * is the manual injection path that records a human's choice against a parked
 * HITL card so a subsequent `resume` can act on it. The command ONLY records the
 * selection (durably, via the existing applyHitlReply) — it does not itself
 * resume the run, and it refuses unknown or unparseable correlation ids.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/cli/reply.ts
 * ---------------------------------------------------------------------------
 *
 *   export function cmdReply(argv: string[], deps: CliDeps): Promise<number>;
 *
 *   - argv is the full sub-command vector, e.g.
 *       ['reply', '--correlation-id', '<id>', '--selection', '<choice>']
 *     (argv[0] === 'reply', mirroring how main() routes cmdRun / cmdResume).
 *   - Resolves to a process exit code: 0 on success, non-zero on any refusal.
 *   - On success it persists the selection via
 *       applyHitlReply(db, correlationId, selection)
 *     (the same durable journal-span store that resume reads back). It does NOT
 *     invent a new selection store.
 *   - Validation (all refusals exit non-zero and record NOTHING):
 *       * unparseable / malformed correlation id  → validation error
 *       * well-formed id that maps to no held card → "no matching held card"
 *       * empty / missing selection                → validation error
 *     Candidate-membership validation (is the selection in the ranked list?) is
 *     DELIBERATELY NOT enforced here — it is deferred to resume (WI-398).
 *
 * main.ts wiring (AC6): `case 'reply': return cmdReply(argv, deps)` must be added
 * to the main() command switch so `conduit reply ...` is reachable. The wiring
 * suite at the bottom exercises that path through main().
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { getRecordedHitlSelection } from '../channels/slack';
import type { ModelAdapter } from '../worker/adapter';
import { cmdReply } from './reply';
import { main, type CliDeps, type CliIO } from './main';

// ---------------------------------------------------------------------------
// Captured IO + stub adapter + deps factory (mirrors cli.test.ts seams)
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

function makeDeps(database: ConduitDB, io: CliIO): CliDeps {
  return {
    io,
    now: () => 1_000,
    db: database,
    adapter: stubAdapter,
    runEngine: async () => {},
    prereqs: [],
  };
}

/** Insert a card parked in the HITL hold (status='held'), as postHitlHold leaves it. */
function insertHeldCard(database: ConduitDB, id: string, runId: string = DEFAULT_RUN_ID): void {
  database.insertCard({
    run_id: runId,
    id,
    parent_id: null,
    lane: 'select',
    status: 'held',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

/** Build the correlation id the kernel encodes for a held card (hitl::<cardId>::<nonce>). */
function corr(cardId: string): string {
  return `hitl::${cardId}::nonce-7f3a`;
}

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// AC1 — a valid reply durably records the selection (via applyHitlReply), exit 0
// ===========================================================================

describe('conduit reply — valid reply records the selection (AC1)', () => {
  it('records the human selection against the matching held card and exits 0', async () => {
    insertHeldCard(db, 'card-1');

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).toBe(0);
    // Durably recorded via applyHitlReply's journal-span store — resume reads this.
    expect(getRecordedHitlSelection(db, 'card-1')).toBe('variant-b');
    // applyHitlReply was the mechanism: it transitions the held card held → ready.
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('ready');
  });

  it('records the exact selection text even when it contains spaces and punctuation', async () => {
    insertHeldCard(db, 'card-2');

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-2'), '--selection', 'option 3: the bold cut'],
      makeDeps(db, io),
    );

    expect(code).toBe(0);
    expect(getRecordedHitlSelection(db, 'card-2')).toBe('option 3: the bold cut');
  });
});

// ===========================================================================
// AC2 — a correlation id that matches no held card is refused, records nothing
// ===========================================================================

describe('conduit reply — no matching held card (AC2)', () => {
  it('exits non-zero with a "no matching held card" error when the id maps to no card', async () => {
    // 'ghost' was never inserted — the id is well-formed but resolves to no card.
    const code = await cmdReply(
      ['reply', '--correlation-id', corr('ghost'), '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/no matching held card/i);
    // Records nothing.
    expect(getRecordedHitlSelection(db, 'ghost')).toBeNull();
  });

  it('refuses (no matching held card) when the card exists but is NOT held, leaving it untouched', async () => {
    // A card in 'ready' (not parked at a HITL hold) must not accept a reply.
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'ready-card',
      parent_id: null,
      lane: 'select',
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('ready-card'), '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/no matching held card/i);
    // Nothing recorded and the card's status is unchanged (no partial mutation).
    expect(getRecordedHitlSelection(db, 'ready-card')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'ready-card')?.status).toBe('ready');
  });
});

// ===========================================================================
// AC3 — an unparseable / malformed correlation id is refused, records nothing
// ===========================================================================

describe('conduit reply — unparseable correlation id (AC3)', () => {
  it.each([
    ['no separator', 'plain-garbage-string'],
    ['too few segments', 'only::two'],
    ['wrong prefix', 'nothitl::card-1::nonce-7f3a'],
  ])('refuses a malformed correlation id (%s) with a validation error, distinct from "no matching held card"', async (_label, badId) => {
    // A real held card exists; the malformed id must NOT touch it.
    insertHeldCard(db, 'card-1');

    const code = await cmdReply(
      ['reply', '--correlation-id', badId, '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    const errText = io.errors.join('\n');
    // A validation error — the id itself is malformed, NOT a clean lookup miss.
    expect(errText).toMatch(/invalid|validation|malformed|unparseable|correlation/i);
    expect(errText).not.toMatch(/no matching held card/i);
    // Records nothing anywhere; the unrelated held card is untouched.
    expect(getRecordedHitlSelection(db, 'card-1')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('held');
  });
});

// ===========================================================================
// AC4 — selection must be a non-empty string; required flags are enforced
// ===========================================================================

describe('conduit reply — selection / flag validation (AC4)', () => {
  it('refuses an empty selection with a validation error and records nothing, leaving the card held', async () => {
    insertHeldCard(db, 'card-1');

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-1'), '--selection', ''],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/selection/i);
    // Validation happens BEFORE any side effect: nothing recorded, card still held.
    expect(getRecordedHitlSelection(db, 'card-1')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('held');
  });

  it.each([
    ['missing --selection', ['reply', '--correlation-id', corr('card-1')]],
    ['missing --correlation-id', ['reply', '--selection', 'variant-b']],
  ])('exits non-zero and records nothing when a required flag is absent (%s)', async (_label, argv) => {
    insertHeldCard(db, 'card-1');

    const code = await cmdReply(argv, makeDeps(db, io));

    expect(code).not.toBe(0);
    expect(getRecordedHitlSelection(db, 'card-1')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('held');
  });
});

// ===========================================================================
// AC5 — a recorded selection is durable: it survives process exit and is
//        readable by a subsequent (fresh-process) resume via
//        getRecordedHitlSelection(db, cardId).
// ===========================================================================

describe('conduit reply — recorded selection is durable across process exit (AC5)', () => {
  it('persists the selection to disk so a freshly-opened DB can read it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-reply-durable-'));
    const stateDbPath = join(dir, 'conduit.sqlite');
    const journalDbPath = join(dir, 'conduit.journal.sqlite');

    try {
      // ── "Process A": run `conduit reply` against an on-disk DB, then close it. ──
      const dbA = openConduitDB({ stateDbPath, journalDbPath });
      ensureCheckpointSchema(dbA.getStateDb());
      insertHeldCard(dbA, 'card-1');

      const ioA = makeIO();
      const code = await cmdReply(
        ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b'],
        makeDeps(dbA, ioA),
      );
      expect(code).toBe(0);
      dbA.close(); // simulate process exit

      // ── "Process B": a brand-new DB connection on the same files reads it back. ──
      const dbB = openConduitDB({ stateDbPath, journalDbPath });
      try {
        expect(getRecordedHitlSelection(dbB, 'card-1')).toBe('variant-b');
      } finally {
        dbB.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// #1 — `--run <id>` scopes the reply to a specific run. The correlation id
//       carries no run id, so without --run a reply for a non-default run is
//       broken (default-only). With --run, the matching run's held card is
//       resumed and the selection lands under that run.
// ===========================================================================

describe('conduit reply — --run scopes the reply to a non-default run (#1)', () => {
  const RUN_A = 'run-A';

  beforeEach(() => {
    db.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
  });

  it('resumes a held card in the targeted non-default run and records the selection under that run', async () => {
    insertHeldCard(db, 'card-1', RUN_A);

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b', '--run', RUN_A],
      makeDeps(db, io),
    );

    expect(code).toBe(0);
    expect(db.getCard(RUN_A, 'card-1')?.status).toBe('ready'); // held → ready in run-A
    expect(getRecordedHitlSelection(db, 'card-1', RUN_A)).toBe('variant-b');
  });

  it('does NOT touch a same-id card in the default run when --run targets another run', async () => {
    insertHeldCard(db, 'card-1', RUN_A);
    insertHeldCard(db, 'card-1', DEFAULT_RUN_ID);

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b', '--run', RUN_A],
      makeDeps(db, io),
    );

    expect(code).toBe(0);
    expect(db.getCard(RUN_A, 'card-1')?.status).toBe('ready');
    // The default run's same-id card is untouched.
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('held');
    expect(getRecordedHitlSelection(db, 'card-1', DEFAULT_RUN_ID)).toBeNull();
  });

  it('refuses (exit non-zero) when the card is held only in the default run but --run targets another run', async () => {
    insertHeldCard(db, 'card-1', DEFAULT_RUN_ID);

    const code = await cmdReply(
      ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b', '--run', RUN_A],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/no matching held card/i);
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.status).toBe('held');
  });
});

// ===========================================================================
// AC6 — `conduit reply` is registered in the main.ts command switch and is
//        reachable as `conduit reply ...` end-to-end (not an "unknown command").
// ===========================================================================

describe('conduit reply — wired into the main() command switch (AC6)', () => {
  it('routes `reply` through main() to cmdReply, records the selection, and exits 0', async () => {
    insertHeldCard(db, 'card-1');

    const code = await main(
      ['reply', '--correlation-id', corr('card-1'), '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).toBe(0);
    // The switch recognised 'reply' — it did NOT fall through to the default arm.
    expect(io.errors.join('\n')).not.toMatch(/unknown command/i);
    // And the full path actually recorded the selection.
    expect(getRecordedHitlSelection(db, 'card-1')).toBe('variant-b');
  });

  it('returns the refusal exit code through main() for an unknown correlation id', async () => {
    const code = await main(
      ['reply', '--correlation-id', corr('ghost'), '--selection', 'variant-b'],
      makeDeps(db, io),
    );

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).not.toMatch(/unknown command/i);
    expect(io.errors.join('\n')).toMatch(/no matching held card/i);
  });
});
