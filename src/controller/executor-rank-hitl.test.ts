/**
 * Rank check + HITL hold + resume-after-selection wired into runExecutor (WI-398).
 *
 * PRD FR6/FR7/FR9/FR10, NFR3 (no auto-pick, structurally). This is the final
 * piece of the fan-out → fan-in → rank chain. When a card reaches a RANK station
 * the executor:
 *   - runs the rank critic (quality/rank.ts::runRankCheck — WIRE, don't reimpl);
 *   - hitlEnabled → posts the ranked short-list to the egress channel through the
 *     EXISTING outbox (checkpoint.ts writePendingIntent/commitIntent) via
 *     slack.ts::postHitlHold, parks the card `held` with a surfaced correlation
 *     id, and the run loop exits cleanly (no remaining dispatchable work);
 *   - hitlEnabled=false → applies noSelectionPolicy: 'proceed_with_findings'
 *     advances the card; 'scrap' scraps it; 'escalate' (a hold-timeout value, not
 *     a RankDecision variant) maps to stay-held / needs-judgment;
 *   - NEVER auto-selects a candidate (RankDecision has no 'selected' variant).
 * On `conduit resume` after a human selection is recorded (slack.ts::
 * getRecordedHitlSelection returns non-null), the held-exit seam
 * (executor.ts::handleHeldExitFanOut, the WI-396 stub) un-holds the card and
 * advances it past the rank station to deliver the CHOSEN candidate to terminal.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins (authoritative schema from Hannibal, WI-398)
 * ---------------------------------------------------------------------------
 * A station is a RANK station iff `stationConfig.rankCheck !== undefined`
 * (StationRankConfig: { criticModel, criticPromptFile, criticPromptVersion,
 * hitlEnabled, noSelectionPolicy }). The executor:
 *   isRankStation(s) === (s.rankCheck !== undefined)
 *   - rankCheck.hitlEnabled === true  → await_selection → outbox-guarded post of
 *     the short-list (idempotent by a STABLE key) → held.
 *   - rankCheck.hitlEnabled === false → runRankCheck applies noSelectionPolicy.
 *
 * TEST SEAMS:
 *   - slack.ts::createSlackTransport     — mocked to return a RECORDING transport
 *                                         whose `.post` (postSpy) is the actual
 *                                         Slack network boundary. Observing
 *                                         transport.post — rather than postHitlHold
 *                                         — is robust to the post path: whether the
 *                                         executor sends via postHitlHold(real) or
 *                                         egressSend(real) directly, both call
 *                                         transport.post, so a crash-recovery
 *                                         re-post is always visible (AC2).
 *   - slack.ts::getRecordedHitlSelection — mocked to drive the resume path.
 *   - quality/rank.ts::runRankCheck, slack.ts::postHitlHold/egressSend, and the
 *     checkpoint.ts outbox — all REAL (the real idempotency discipline is under
 *     test; only the network transport + selection read are stubbed).
 *
 * FIXTURE NOTE: the FlowConfig is hand-built (not loadFlow'd). The loader's
 * YAML→rankCheck parsing is a complementary concern for load.ts; a rank station
 * that also declares `next` does not pass the current loader (MISSING_PROMPT_
 * TEMPLATE for a worker-less station with `next`), so building the FlowConfig
 * directly keeps these tests focused on the EXECUTOR wiring. The rank station
 * carries a deterministic `command: 'true'` body as a placeholder; the CORRECT
 * impl branches on `isRankStation` BEFORE the deterministic path.
 *
 * COVERAGE NOTE: AC5 covers the two noSelectionPolicy branches
 * (proceed_with_findings / scrap), and AC4/AC6 assert the resume path consults
 * the recorded selection and advances the held card to terminal. The hold-TIMEOUT
 * firing (scrap / proceed_with_findings / escalate applied through runExecutor's
 * pollHeldTimeouts when the human window elapses with no reply) is now wired and
 * covered by the "hold-timeout enforcement" suite at the bottom of this file —
 * the applyHoldTimeout primitive itself remains unit-covered in
 * src/channels/egress.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, StationConfig, StationRankConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, writePendingIntent, getIntentStatus } from '../checkpoint/checkpoint';
import { runExecutor } from './executor';

// ── slack.ts module seam: mock the HITL boundary, keep everything else real ──
import * as slackNs from '../channels/slack';

// Snapshot the REAL exports into a plain object NOW, before mock.module runs.
// `slackNs` is a LIVE namespace — once mock.module patches the module below,
// `slackNs.getRecordedHitlSelection` would point at the mock, so we cannot rely
// on `slackNs` for the restore. This frozen snapshot holds the originals.
const realSlack: Record<string, unknown> = { ...slackNs };

// Observe the ACTUAL Slack network boundary (`transport.post`), NOT postHitlHold.
// This survives the postHitlHold → egressSend refactor: whether the executor
// posts via postHitlHold(real) or egressSend(real) directly, both ultimately
// call transport.post. createSlackTransport (which the executor calls to build
// the transport) is mocked to return this recording transport, so a re-post on
// crash-recovery is observable as an extra postSpy call (AC2).
const postSpy = mock(async (_req: { channel: string; text: string; correlationId?: string }) => ({
  ts: 'ts-rank-1',
}));
// The original HITL reply-and-resume work: ask_attach rides the same transport — record uploads too.
const uploadSpy = mock(async (_req: { channel: string; filePath: string; threadTs?: string }) => ({
  ok: true as const,
  files: [{ id: 'F-attach-1' }],
}));
const createSlackTransportMock = mock((_config: { botToken: string }) => ({
  post: postSpy,
  uploadFile: uploadSpy,
}));

let recordedSelection: string | null = null;
const getRecordedHitlSelectionMock = mock((_db: unknown, _cardId: string) => recordedSelection);

mock.module('../channels/slack', () => ({
  ...realSlack,
  // postHitlHold + egressSend stay REAL (real outbox idempotency is under test);
  // only the transport (the Slack network) and the selection read are stubbed.
  createSlackTransport: createSlackTransportMock,
  getRecordedHitlSelection: getRecordedHitlSelectionMock,
}));

// Restore the REAL channels/slack exports after this file's tests finish.
// Without this, the module-scope mock.module above leaks into other suites
// (egress.test.ts, reply.test.ts) when `bun test` runs the full suite, where
// they would see the mocked getRecordedHitlSelection and fail. Restoring to the
// pre-mock snapshot (not the live `slackNs`) is what actually undoes the mock.
afterAll(() => {
  mock.module('../channels/slack', () => realSlack);
});

const CRITIC_MODEL = 'gpt-4o';
const RANK_STATION = 'select';
const DELIVER_STATION = 'deliver';
const CARD_ID = 'root';

// ---------------------------------------------------------------------------
// Hand-built fan-in→rank→deliver FlowConfig.
//   select  — the RANK station (rankCheck set; deterministic 'true' placeholder).
//   deliver — the post-rank delivery station the chosen candidate flows to.
// ---------------------------------------------------------------------------
function buildRankFlow(
  dir: string,
  opts: {
    hitlEnabled: boolean;
    noSelectionPolicy: StationRankConfig['noSelectionPolicy'];
    onTimeout?: 'scrap' | 'proceed_with_findings' | 'escalate';
  },
): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'select.md'), 'Rank the candidate variants by quality.');

  const rankCheck: StationRankConfig = {
    criticModel: CRITIC_MODEL,
    criticPromptFile: join(dir, 'prompts', 'select.md'),
    criticPromptVersion: '1',
    hitlEnabled: opts.hitlEnabled,
    noSelectionPolicy: opts.noSelectionPolicy,
  };

  const select: StationConfig = {
    kind: 'deterministic',
    effectful: false,
    wip: 1,
    inputs: [],
    outputs: [],
    command: 'true',
    rankCheck,
  };
  const deliver: StationConfig = {
    kind: 'deterministic',
    effectful: false,
    wip: 1,
    inputs: [],
    outputs: [],
    command: 'true',
  };

  const flow: FlowConfig = {
    version: 1,
    stations: { select, deliver },
    terminal_lanes: ['done', 'scrap', 'hold'],
    happyPathNext: { select: DELIVER_STATION, deliver: 'done' },
    budgets: {
      run: { wall_clock_minutes: 10, max_tokens: 100000 },
      per_card: { max_execution_attempts: 4 },
      liveness: { no_progress_minutes: 3 },
    },
    defaults: { capPolicy: 'scrap', onDepScrap: 'scrap', enforceOwnedPaths: false },
    project_root: dir,
    channels: opts.hitlEnabled
      ? {
          egress: [
            {
              type: 'slack',
              target: '#content-hitl',
              hold_timeout_seconds: 30,
              on_timeout: opts.onTimeout ?? 'scrap',
            },
          ],
        }
      : undefined,
  } as FlowConfig;

  return flow;
}

/** Adapter that returns a rank-critic verdict (the survivors, best-first). */
let adapterCalls: ModelCall[] = [];
function rankAdapter(): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      adapterCalls.push(req);
      return {
        text: JSON.stringify({ ranking: ['c1', 'c2'], findings: [] }),
        inputTokens: 10,
        outputTokens: 6,
        costUsd: 0.002,
      };
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-rank-hitl-'));
  process.chdir(projectDir);
  db = null;
  adapterCalls = [];
  recordedSelection = null;
  postSpy.mockClear();
  uploadSpy.mockClear();
  createSlackTransportMock.mockClear();
  getRecordedHitlSelectionMock.mockClear();
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
// Helpers
// ---------------------------------------------------------------------------

function openFreshDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}

/** Seed the post-fan-in card sitting at the rank station, ready to be ranked. */
function seedCardAtRank(database: ConduitDB, status: 'ready' | 'held' = 'ready'): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: CARD_ID,
    parent_id: null,
    lane: RANK_STATION,
    status,
    attempt: 0,
    wave: 0,
    owned_paths: ['final.zip'],
    rework_count: 0,
  });
}

async function run(flow: FlowConfig): Promise<void> {
  const { io } = makeIO();
  await runExecutor({
    db: db!,
    flow,
    now: SECONDS(1000),
    adapter: rankAdapter(),
    io,
  } as RunEngineArgs);
}

/** Run the executor with the clock pinned to a specific epoch-second (resume). */
async function runAt(flow: FlowConfig, t: number): Promise<void> {
  const { io } = makeIO();
  await runExecutor({
    db: db!,
    flow,
    now: SECONDS(t),
    adapter: rankAdapter(),
    io,
  } as RunEngineArgs);
}

/** True iff the card's card_log shows it departing FROM `lane` (it ran that station). */
function departedFromLane(database: ConduitDB, cardId: string, lane: string): boolean {
  return database
    .getCardLog(cardId)
    .some((e) => e.kind === 'entered_lane' && e.sourceLane === lane);
}

/** Count committed outbox intents (delivered_at set). */
function committedOutboxCount(database: ConduitDB): number {
  const row = database
    .getStateDb()
    .prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NOT NULL')
    .get() as { n: number };
  return row.n;
}

// ===========================================================================
// AC1 — rank + HITL enabled → posts the short-list, parks the card held with a
//        correlation id, and the run exits cleanly (no dispatchable work left).
// ===========================================================================

describe('runExecutor rank+HITL — posts short-list and holds the card (WI-398 AC1)', () => {
  it('runs the rank critic, posts the HITL short-list, and moves the card to held', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' }));

    // The rank critic actually ran (adapter called with the rank critic model).
    expect(adapterCalls.some((c) => c.model === CRITIC_MODEL)).toBe(true);
    // The ranked short-list was posted to the egress channel exactly once.
    expect(postSpy).toHaveBeenCalledTimes(1);
    // The card is parked held — NOT advanced past the rank station, NOT auto-picked.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe(RANK_STATION);
    // It did NOT proceed to the post-rank delivery station.
    expect(departedFromLane(db, CARD_ID, RANK_STATION)).toBe(false);
  });

  it('surfaces the HITL correlation id on the card log when it holds', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' }));

    // The correlation id returned by postHitlHold is surfaced (recorded) so a
    // human reply can key on it. It must appear somewhere on the card_log.
    const logBlob = JSON.stringify(db.getCardLog(CARD_ID));
    // Run-scoped correlation id (Fix 1): runId leads so card ids repeating across
    // runs never collide in the outbox or the card_log correlation surface.
    expect(logBlob).toContain(`hitl::${DEFAULT_RUN_ID}::${CARD_ID}::`);
  });
});

// ===========================================================================
// AC2 — the HITL prompt goes through the outbox and is idempotent by a STABLE
//        idempotency key. Two paths:
//   (a) committed → a re-run never re-posts (the held card is not re-dispatched);
//   (b) crash recovery (pending) → re-dispatch must NOT double-post. The HITL
//       idempotency key MUST be derived deterministically from
//       (cardId, stationId, attempt) — NOT a per-call random nonce — so a
//       pending outbox intent from a crash-before-commit is recognised and the
//       post is reconciled, never blindly re-fired.
// ===========================================================================

/** The stable HITL idempotency/correlation key the executor must derive. */
const STABLE_HITL_KEY = `hitl::${DEFAULT_RUN_ID}::${CARD_ID}::${RANK_STATION}::0`;

describe('runExecutor rank+HITL — HITL post is outbox-guarded and idempotent (WI-398 AC2)', () => {
  it('commits the HITL post and never re-posts on a second run (committed → skip)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' });

    await run(flow); // first run: posts + holds
    // A resume / second pass: the card is held and the outbox intent is committed,
    // so the prompt must NOT be posted again.
    await run(flow);

    expect(postSpy).toHaveBeenCalledTimes(1); // exactly once across both runs
    expect(committedOutboxCount(db)).toBeGreaterThanOrEqual(1); // the post was committed
  });

  it('does NOT re-post on crash recovery when a HITL intent is already pending', async () => {
    // Simulate a crash AFTER the HITL post wrote its pending outbox row but
    // BEFORE commit; the card was reclaimed back to 'ready' at the rank station.
    db = openFreshDb();
    seedCardAtRank(db, 'ready');

    // Pre-seed the outbox with the STABLE key as pending (delivered_at IS NULL).
    writePendingIntent(db.getStateDb(), {
      flow: 'rank-hitl',
      card: CARD_ID,
      station: RANK_STATION,
      attempt: 0,
      idempotencyKey: STABLE_HITL_KEY,
      intent: { kind: 'rank_hitl', cardId: CARD_ID, stationId: RANK_STATION },
    });
    expect(getIntentStatus(db.getStateDb(), STABLE_HITL_KEY)).toBe('pending'); // precondition

    await run(buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' }));

    // The pending intent must be RECONCILED (reconcileOnResume), never blindly
    // re-fired — so the Slack boundary is NOT hit a second time. This fails today
    // because postHitlHold mints a fresh random nonce, so the recovery post uses
    // a DIFFERENT key than the pending row and re-posts (double-post bug).
    expect(postSpy).toHaveBeenCalledTimes(0);
    // The card is parked held (escalated / awaiting human), never auto-advanced.
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');
  });
});

// ===========================================================================
// AC3 — no auto-pick: with no recorded human selection, the held card stays
//        held; the kernel never advances it by picking a candidate.
// ===========================================================================

describe('runExecutor rank+HITL — never auto-selects a candidate (WI-398 AC3, NFR-3)', () => {
  it('leaves the card held with no recorded selection and never reaches a terminal', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' });

    recordedSelection = null; // no human has replied
    await run(flow);
    await run(flow); // a resume with still-no-selection must not auto-advance it

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe(RANK_STATION);
    // The kernel never picked a candidate: the card never reached delivery/done.
    expect(departedFromLane(db, CARD_ID, RANK_STATION)).toBe(false);
    expect(card?.lane).not.toBe(DELIVER_STATION);
    expect(card?.lane).not.toBe('done');
  });
});

// ===========================================================================
// AC4 + AC6 — a recorded human selection (via conduit reply / getRecordedHitl-
//        Selection) lets resume advance the held card past the rank station to
//        deliver the chosen candidate to terminal.
// ===========================================================================

describe('runExecutor rank+HITL — resume after a recorded selection advances the card (WI-398 AC4, AC6)', () => {
  it('un-holds the card and delivers it to terminal once a selection is recorded', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' });

    // First run posts the hold and parks the card held (no selection yet).
    recordedSelection = null;
    await run(flow);
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held'); // precondition: it held

    // A human records a selection (via conduit reply / WI-394).
    recordedSelection = 'c2';

    // Resume: the held-exit path consults the recorded selection and advances.
    await run(flow);

    // The recorded selection was consulted (kernel used the human's pick)…
    expect(getRecordedHitlSelectionMock).toHaveBeenCalled();
    // …and the card advanced past the rank station to a terminal lane.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).not.toBe('held');
    expect(card?.lane).toBe('done');
    // It actually ran the rank station's successor (delivery), proving it
    // advanced through resume rather than being stuck.
    expect(departedFromLane(db, CARD_ID, DELIVER_STATION)).toBe(true);
  });
});

// ===========================================================================
// AC5 — no HITL: noSelectionPolicy='proceed_with_findings' advances the card;
//        'scrap' scraps it. (escalate→stay-held is a hold-timeout mapping
//        covered by egress.test.ts; see header COVERAGE NOTE.)
// ===========================================================================

describe('runExecutor rank — no-HITL noSelectionPolicy branches (WI-398 AC5)', () => {
  it('proceed_with_findings: advances the card past the rank station (no hold, no post)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildRankFlow(projectDir, { hitlEnabled: false, noSelectionPolicy: 'proceed_with_findings' }));

    // The rank critic ran, but with no HITL the policy proceeds.
    expect(adapterCalls.some((c) => c.model === CRITIC_MODEL)).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).not.toBe('held');
    expect(card?.lane).toBe('done');
    expect(departedFromLane(db, CARD_ID, DELIVER_STATION)).toBe(true);
  });

  it('scrap: routes the card to the scrap terminal (no hold, no post)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildRankFlow(projectDir, { hitlEnabled: false, noSelectionPolicy: 'scrap' }));

    expect(adapterCalls.some((c) => c.model === CRITIC_MODEL)).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
  });
});

// ===========================================================================
// AC5 (hold-timeout) — a held HITL card whose human-decision window elapses with
//   NO recorded selection is resolved by the egress channel's on_timeout policy
//   (FR-14, SPEC §4A). The synchronous executor holds-then-exits, so the timeout
//   is enforced opportunistically on the next run/resume past the deadline. The
//   kernel NEVER auto-picks a winner.
// ===========================================================================

describe('runExecutor rank+HITL — hold-timeout enforcement (WI-398 AC5 / FR-14)', () => {
  it('scrap: a resume past hold_timeout_seconds with no reply scraps the held card', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap', onTimeout: 'scrap' });

    await run(flow); // t=1000: posts the short-list, parks the card held
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');

    recordedSelection = null; // human never replied
    await runAt(flow, 1031); // 31s elapsed >= 30s window → timeout fires

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    // The timeout never re-posts to Slack (the prompt was committed on run 1).
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire while still inside the hold window (resume before the deadline)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap', onTimeout: 'scrap' });

    await run(flow); // t=1000: held
    recordedSelection = null;
    await runAt(flow, 1010); // only 10s elapsed < 30s window

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held'); // still awaiting the human
    expect(card?.lane).toBe(RANK_STATION);
  });

  it('a recorded reply beats the timeout (selection wins even past the deadline)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap', onTimeout: 'scrap' });

    await run(flow); // t=1000: held
    recordedSelection = 'c1'; // the human replied (via `conduit reply`)
    await runAt(flow, 1031); // past the deadline, but a selection exists

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).toBe('done'); // advanced via the chosen candidate, NOT scrapped
    expect(card?.status).not.toBe('scrapped');
    expect(departedFromLane(db, CARD_ID, RANK_STATION)).toBe(true);
  });

  it('proceed_with_findings: a timeout advances the card PAST the rank station (no winner picked)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, {
      hitlEnabled: true,
      noSelectionPolicy: 'scrap',
      onTimeout: 'proceed_with_findings',
    });

    await run(flow); // t=1000: held
    recordedSelection = null;
    await runAt(flow, 1031); // timeout → proceed past the rank station

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).toBe('done'); // flowed through deliver → done
    expect(card?.status).not.toBe('held');
    expect(departedFromLane(db, CARD_ID, RANK_STATION)).toBe(true);
    // It must NOT re-run the critic and re-hold — exactly one post across both runs.
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('escalate: a timeout parks the card on the hold terminal lane for a human', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildRankFlow(projectDir, {
      hitlEnabled: true,
      noSelectionPolicy: 'scrap',
      onTimeout: 'escalate',
    });

    await run(flow); // t=1000: held
    recordedSelection = null;
    await runAt(flow, 1031); // timeout → escalate

    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).toBe('hold'); // routed to the hold terminal lane
    expect(card?.status).toBe('held'); // stays held, awaiting manual intervention
  });
});

// ===========================================================================
// Code-review fix #5 — the HITL prompt must post to the channel that declares
// `uses: [hitl]`, NOT merely the first egress channel. A delivery-only channel
// listed first must not receive the human-selection prompt.
// ===========================================================================

describe('runExecutor rank+HITL — posts to the uses:[hitl] channel, not egress[0] (fix #5)', () => {
  it('selects the hitl channel even when a delivery-only channel is listed first', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    const flow = buildRankFlow(projectDir, { hitlEnabled: true, noSelectionPolicy: 'scrap' });
    // Delivery-only channel FIRST, the human-gate channel SECOND.
    flow.channels = {
      egress: [
        { type: 'slack', target: '#delivery', uses: ['delivery'] },
        { type: 'slack', target: '#content-hitl', uses: ['hitl'], hold_timeout_seconds: 30, on_timeout: 'scrap' },
      ],
    };

    await run(flow);

    expect(postSpy).toHaveBeenCalledTimes(1);
    // The post went to the hitl channel's target, NOT the first (delivery) one.
    const postedChannel = postSpy.mock.calls[0][0].channel;
    expect(postedChannel).toBe('#content-hitl');
  });
});


// ===========================================================================
// The original HITL reply-and-resume work — flow-computed candidates: candidates_from + ask_template +
// ask_attach + selection_out, wired through runExecutor.
// ===========================================================================

describe('runExecutor rank+HITL — flow-computed candidates (the original HITL reply-and-resume work)', () => {
  const BOARD = ['Cotton Candy Reef', 'Bubblegum Beach', 'Berry Fizz'];

  /** buildRankFlow variant: candidates come from an artifact, no critic. */
  function buildCandidatesFlow(
    dir: string,
    opts: {
      askTemplate?: boolean;
      askAttach?: boolean;
      selectionOut?: boolean;
      boardContent?: string;
    } = {},
  ): FlowConfig {
    const flow = buildRankFlow(dir, { hitlEnabled: true, noSelectionPolicy: 'scrap' });
    const select = flow.stations[RANK_STATION]!;
    const rankCheck = select.rankCheck!;

    writeFileSync(join(dir, 'board.json'), opts.boardContent ?? JSON.stringify(BOARD));
    rankCheck.candidatesFrom = 'board.json';
    // No critic in this mode — the loader leaves these '' (never read).
    rankCheck.criticModel = '';
    rankCheck.criticPromptFile = '';

    if (opts.askTemplate) {
      writeFileSync(
        join(dir, 'prompts', 'ask.md'),
        'pick a name (raw board follows):\n{{board.json}}',
      );
      rankCheck.askTemplateFile = join(dir, 'prompts', 'ask.md');
      select.inputs = ['board.json'];
    }
    if (opts.askAttach) {
      writeFileSync(join(dir, 'edited.jpg'), 'jpeg-bytes-placeholder');
      rankCheck.askAttach = ['edited.jpg'];
    }
    if (opts.selectionOut) {
      rankCheck.selectionOut = 'work/selection.json';
    }
    return flow;
  }

  it('presents the artifact board WITHOUT any critic model call, holds the card', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildCandidatesFlow(projectDir));

    // The whole point: no model ran.
    expect(adapterCalls).toHaveLength(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
    // Default ask text carries the artifact candidates verbatim.
    expect(postSpy.mock.calls[0][0].text).toContain('Cotton Candy Reef');
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe(RANK_STATION);
  });

  it('renders ask_template through renderPrompt (artifact placeholders resolve) and journals hitl.ask with the THREAD ts + short_list', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    // Ingress-triggered run: the ask threads on the triggering message, and
    // REPLIES carry the thread ROOT's ts (found live) — the span must record
    // that, not the ask message's own ts.
    db.acceptIngressEvent('Ev-ask-1', 1, {
      flowId: 'rank77',
      flowPath: '/x/flow.yaml',
      runId: DEFAULT_RUN_ID,
      substrateJson: JSON.stringify({ thread_ts: 'thread-root-1' }),
    });

    await run(buildCandidatesFlow(projectDir, { askTemplate: true }));

    expect(postSpy).toHaveBeenCalledTimes(1);
    const askText = postSpy.mock.calls[0][0].text;
    expect(askText).toContain('pick a name');
    expect(askText).toContain('Bubblegum Beach'); // {{board.json}} substituted

    // The thread-reply routing surface (the original HITL reply-and-resume work FR-3b): the ask span keys on
    // the THREAD ROOT's ts (the triggering message) — what replies carry.
    const ask = db.findHitlAskByThreadTs('thread-root-1');
    expect(ask).not.toBeNull();
    // A single posted ask resolves unambiguously (Fix 4 discriminated union).
    if (ask === null || ask.ambiguous) throw new Error('expected a single unambiguous ask');
    expect(ask.correlationId).toBe(`hitl::${DEFAULT_RUN_ID}::${CARD_ID}::${RANK_STATION}::0`);
    expect(ask.shortList).toEqual(BOARD);
  });

  it('uploads ask_attach files through the outbox-guarded path BEFORE the ask text', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildCandidatesFlow(projectDir, { askAttach: true }));

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0].filePath).toBe(join(projectDir, 'edited.jpg'));
    expect(postSpy).toHaveBeenCalledTimes(1);
    // Both effects are outbox-committed (upload intent + ask intent).
    expect(committedOutboxCount(db)).toBe(2);
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');
  });

  it('an ask_attach path escaping the project root escalates to hold — nothing uploads (review: critical)', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildCandidatesFlow(projectDir);
    flow.stations[RANK_STATION]!.rankCheck!.askAttach = ['../../etc-passwd-like'];

    await run(flow);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    const reason = db.getCardLog(CARD_ID).find((e) => e.kind === 'terminal');
    expect((reason as { reason?: string } | undefined)?.reason ?? '').toContain('outside the project root');
  });

  it('a malformed candidates artifact escalates to hold NAMED — nothing posts, no critic runs', async () => {
    db = openFreshDb();
    seedCardAtRank(db);

    await run(buildCandidatesFlow(projectDir, { boardContent: '{"not": "an array"}' }));

    expect(adapterCalls).toHaveLength(0);
    expect(postSpy).not.toHaveBeenCalled();
    // escalateToHold's status-only convention: parked held AT the station.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe(RANK_STATION);
    // ... and the reason names the artifact, not a generic failure
    // (escalateToHold writes the detail as a terminal card_log entry).
    const holdReason = db
      .getCardLog(CARD_ID)
      .find((e) => e.kind === 'terminal');
    expect((holdReason as { reason?: string } | undefined)?.reason ?? '').toContain('board.json');
  });

  it('on resume with a recorded selection, selection_out is written for downstream stations, then the card advances', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const flow = buildCandidatesFlow(projectDir, { selectionOut: true });

    await run(flow); // ask posted, card held
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');

    // The human replied (thread reply / button / conduit reply — all converge
    // on the recorded selection this seam models).
    recordedSelection = 'Bubblegum Beach';
    db.getStateDb()
      .prepare("UPDATE cards SET status = 'ready' WHERE id = $id")
      .run({ $id: CARD_ID });
    await runAt(flow, 1010);

    const selectionPath = join(projectDir, 'work', 'selection.json');
    const rawBytes = readFileSync(selectionPath, 'utf-8');
    const written = JSON.parse(rawBytes) as { selection: string; correlation_id: string | null };
    expect(written.selection).toBe('Bubblegum Beach');
    // Fix 3: the bytes are deterministic — NO wall-clock stamp — so the artifact
    // hashes stably into downstream binding stamps. Re-entering the rank resume
    // path with the SAME recorded selection re-writes byte-identical content, even
    // under a different wall clock.
    expect(written).not.toHaveProperty('selected_at');
    rmSync(selectionPath);
    db.getStateDb()
      .prepare("UPDATE cards SET lane = $lane, status = 'ready' WHERE id = $id")
      .run({ $lane: RANK_STATION, $id: CARD_ID });
    await runAt(flow, 2020);
    expect(readFileSync(selectionPath, 'utf-8')).toBe(rawBytes);

    // The card advanced past the rank station toward delivery/terminal.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.lane).not.toBe(RANK_STATION);
    expect(card?.lane).not.toBe('hold');
  });

  // -------------------------------------------------------------------------
  // Fix 2 — symlink containment (SPEC §7). A bare lexical startsWith let a
  // symlink INSIDE the project root pointing OUT slip past all three rank sites
  // (candidates_from read, ask_attach upload, selection_out write). Each must
  // now resolve symlinks and escalate to hold — never read/write/upload outside.
  // -------------------------------------------------------------------------

  it('candidates_from via a symlink pointing outside the root escalates to hold — no post', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const outside = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    writeFileSync(join(outside, 'secret-board.json'), JSON.stringify(['leaked']));
    symlinkSync(join(outside, 'secret-board.json'), join(projectDir, 'board-link.json'));

    const flow = buildCandidatesFlow(projectDir);
    flow.stations[RANK_STATION]!.rankCheck!.candidatesFrom = 'board-link.json';

    await run(flow);

    expect(postSpy).not.toHaveBeenCalled();
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');
    const holdReason = db.getCardLog(CARD_ID).filter((e) => e.kind === 'terminal');
    expect(holdReason.some((e) => ((e as { reason?: string }).reason ?? '').includes('outside the project root'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('ask_attach via a symlink pointing outside the root escalates to hold — nothing uploads', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const outside = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'exfiltrate me');
    symlinkSync(join(outside, 'secret.txt'), join(projectDir, 'attach-link.jpg'));

    const flow = buildCandidatesFlow(projectDir);
    flow.stations[RANK_STATION]!.rankCheck!.askAttach = ['attach-link.jpg'];

    await run(flow);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');
    const holdReason = db.getCardLog(CARD_ID).filter((e) => e.kind === 'terminal');
    expect(holdReason.some((e) => ((e as { reason?: string }).reason ?? '').includes('outside the project root'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('selection_out under a symlinked parent dir escalates to hold — nothing is written outside the root', async () => {
    db = openFreshDb();
    seedCardAtRank(db);
    const outside = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    // A symlink INSIDE the root whose target is a real dir OUTSIDE it.
    symlinkSync(outside, join(projectDir, 'linkdir'));

    const flow = buildCandidatesFlow(projectDir, { selectionOut: true });
    flow.stations[RANK_STATION]!.rankCheck!.selectionOut = 'linkdir/sel.json';

    await run(flow); // posts the ask, holds the card
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');

    // The human replied — the resume path would write selection_out.
    recordedSelection = 'Bubblegum Beach';
    db.getStateDb().prepare("UPDATE cards SET status = 'ready' WHERE id = $id").run({ $id: CARD_ID });
    await runAt(flow, 1010);

    // Escalated to the terminal 'hold' lane (a contradictory selection_out is a
    // human dead-end, not a retryable park) and NOTHING landed at the symlink's
    // out-of-root target. Routing to 'hold' also breaks the pollHeldRankCards
    // re-arm livelock a status-only hold would cause here.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe('hold');
    expect(existsSync(join(outside, 'sel.json'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Fix 5 — selection_out honours the owned-paths integrity gate. A target
  // inside the project root but OUTSIDE the card's owned_paths must hold (like
  // deliver.files) when the flow opts into enforce_owned_paths — and leave no
  // artifact behind.
  // -------------------------------------------------------------------------

  it('selection_out outside the card owned_paths holds when enforce_owned_paths is on — no artifact persists', async () => {
    db = openFreshDb();
    seedCardAtRank(db); // owned_paths = ['final.zip']
    const flow = buildCandidatesFlow(projectDir, { selectionOut: true }); // selection_out = 'work/selection.json'
    flow.defaults!.enforceOwnedPaths = true;

    await run(flow); // posts the ask, holds the card
    expect(db.getCard(DEFAULT_RUN_ID, CARD_ID)?.status).toBe('held');

    recordedSelection = 'Bubblegum Beach';
    db.getStateDb().prepare("UPDATE cards SET status = 'ready' WHERE id = $id").run({ $id: CARD_ID });
    await runAt(flow, 1010);

    // Held (on the terminal 'hold' lane) on the owned_paths breach, and the
    // out-of-bounds artifact was removed so nothing outside owned_paths persists.
    const card = db.getCard(DEFAULT_RUN_ID, CARD_ID);
    expect(card?.status).toBe('held');
    expect(card?.lane).toBe('hold');
    expect(existsSync(join(projectDir, 'work', 'selection.json'))).toBe(false);
  });
});
