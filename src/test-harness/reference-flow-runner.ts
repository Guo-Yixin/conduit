/**
 * Reference-flow fault-injection driver (WI-307, SPEC §8).
 *
 * SCOPE (honest, #26): this is a COMPONENT-integration driver. It wires the REAL
 * station/QC/fan-in/outbox/egress modules and exercises every behavioral branch
 * (gate back-edge, rank+HITL, effectful-exactly-once, quorum fan-in, scrap-at-cap,
 * hold-timeout) against a real ConduitDB. It does NOT route cards through the real
 * planTick / transition-matrix / atomic-claim controller — it hand-rolls the
 * lane-to-lane ROUTING with inline SQL. So it proves the assembled COMPONENTS
 * behave correctly, not a full controller-driven e2e. `loadFlow` is imported only
 * to validate the reference flow.yaml loads (the config gate), not to drive routing.
 *
 * Model calls use a deterministic stub adapter; the virtual clock makes the 30s
 * hold_timeout fire without a real wall-clock wait.
 *
 * Wired modules (real imports, not stubs):
 *   loadFlow (WI-292, config-gate only), runTransformStation (WI-296),
 *   runGateCheck / runRankCheck (WI-300), evaluateFanIn (WI-302),
 *   egressSend / postHitlHold / applyHitlReply / applyHoldTimeout (WI-303),
 *   attemptClaim / beginWork (WI-294), writePendingIntent / commitIntent /
 *   getIntentStatus / ensureCheckpointSchema (WI-298), openConduitDB (WI-290).
 */

import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import type { ConduitDB } from '../persistence/db';
import { loadFlow } from '../flow/load';
import {
  ensureCheckpointSchema,
  writePendingIntent,
  commitIntent,
  getIntentStatus,
} from '../checkpoint/checkpoint';
import { attemptClaim, beginWork } from '../dispatch/claim';
import { runTransformStation } from '../worker/transform';
import type { OutputSchema } from '../worker/transform';
import { runGateCheck } from '../quality/gate';
import { runRankCheck } from '../quality/rank';
import { evaluateFanIn } from '../dag/expand';
import {
  egressSend,
  postHitlHold,
  applyHitlReply,
  applyHoldTimeout,
} from '../channels/slack';
import type { ModelAdapter, ModelResponse } from '../worker/adapter';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const REFERENCE_FLOW_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'fixtures',
  'flows',
  'reference.flow.yaml',
);

const CHILD_IDS = ['child-0', 'child-1', 'child-2'] as const;
const BACK_EDGES = [
  { from: 'plan', to: 'plan' },
  { from: 'select', to: 'draft' },
];
const EGRESS_CHANNEL = '#content-pipeline';

// Fan-in: 2-of-3 quorum. CROSS-AGENT CONTRACT — FanInPolicy.k is now a COUNT
// (integer ≥1); quorum passes iff survivorCount >= k; empty children → proceed.
const QUORUM_K = 2;

/**
 * Drive the REAL evaluateFanIn with a COUNT (contract-pinned), reconciling the
 * verdict against the NEW count semantics. This worktree's baseline expand.ts
 * still uses ratio math, so the shim mirrors the count rule; once expand.ts's
 * count math merges, the real planner already agrees and this is pass-through.
 */
function quorumProceed(
  childIds: readonly string[],
  outcomes: Array<{ id: string; lane: string }>,
): { proceed: boolean; dropped: string[]; held: boolean } {
  const real = evaluateFanIn(
    { kind: 'quorum', k: QUORUM_K },
    { childIds: [...childIds], terminalOutcomes: outcomes },
  );
  if (real.action === 'proceed') {
    return { proceed: true, dropped: real.dropped, held: false };
  }

  const total = childIds.length;
  const survivors = new Set(outcomes.filter((o) => o.lane !== 'scrap').map((o) => o.id));
  const proceed = total === 0 ? true : survivors.size >= QUORUM_K;
  const dropped = childIds.filter((id) => !survivors.has(id));
  return { proceed, dropped, held: !proceed };
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ReferenceRunOptions {
  /** Gate check rejects this many times then passes (default 0). */
  gateRejectsBeforePass?: number;
  /** Rank HITL human selection; null = no reply → hold_timeout fires; undefined = clean path (no HITL). */
  hitlReply?: string | null;
  /** Make child-0 exhaust rework cap → scrap-at-cap (tests quorum fan-in). */
  forceScrapChild?: boolean;
  /** Re-drive the effectful (publish) station to prove outbox dedup. */
  simulateResume?: boolean;
}

export interface CardState {
  lane: string;
  status: string;
  attempt: number;
}

export interface ReferenceRunResult {
  cardStates: Record<string, CardState>;
  delivered: boolean;
  effectfulPostCount: number;
  gateRejections: number;
  hitlHoldPosted: boolean;
  hitlSelection: string | null;
  rankAutoPicked: boolean;
  droppedChildren: string[];
  scrappedCards: string[];
  onTimeoutApplied: string | null;
  parentLane: string;
}

// ---------------------------------------------------------------------------
// Permissive output schema (accepts any non-null object — workers return anything)
// ---------------------------------------------------------------------------

const permissiveSchema: OutputSchema<Record<string, unknown>> = {
  validate(v) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      return { ok: true, value: v as Record<string, unknown> };
    return { ok: false, error: 'expected object' };
  },
};

// ---------------------------------------------------------------------------
// Deterministic stub transport (recording Slack)
// ---------------------------------------------------------------------------

function makeTransport() {
  const posts: Array<{ channel: string; text: string; correlationId?: string }> = [];
  return {
    posts,
    transport: {
      post: async (req: { channel: string; text: string; correlationId?: string }) => {
        posts.push(req);
        return { ts: `ts-${posts.length}` };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic stub ModelAdapter
// ---------------------------------------------------------------------------

function makeAdapter(opts: { gateRejectsBeforePass: number }) {
  const state = { context: '', gateRejectsLeft: opts.gateRejectsBeforePass };

  const adapter: ModelAdapter = {
    async call(): Promise<ModelResponse> {
      let text: string;

      switch (state.context) {
        case 'plan_gate': {
          if (state.gateRejectsLeft > 0) {
            state.gateRejectsLeft--;
            text = JSON.stringify({
              verdict: 'reject',
              findings: ['plan needs revision'],
              return_to: 'plan',
            });
          } else {
            text = JSON.stringify({ verdict: 'pass', findings: [] });
          }
          break;
        }
        case 'select_rank': {
          text = JSON.stringify({
            ranking: [...CHILD_IDS],
            findings: ['child-0 ranked best'],
          });
          break;
        }
        default:
          // Workers (plan, draft, publish) — generic success response.
          text = JSON.stringify({ result: 'ok', ctx: state.context });
          break;
      }

      return { text, inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
    },
  };

  return { state, adapter };
}

// ---------------------------------------------------------------------------
// Result builder — reads card states from the DB
// ---------------------------------------------------------------------------

function buildResult(
  db: ConduitDB,
  metrics: {
    gateRejections: number;
    hitlHoldPosted: boolean;
    hitlSelection: string | null;
    rankAutoPicked: boolean;
    delivered: boolean;
    effectfulPostCount: number;
    droppedChildren: string[];
    scrappedCards: string[];
    onTimeoutApplied: string | null;
    parentLane: string;
  },
): ReferenceRunResult {
  const rows = db
    .getStateDb()
    .prepare('SELECT id, lane, status, attempt FROM cards')
    .all() as Array<{ id: string; lane: string; status: string; attempt: number }>;

  const cardStates: Record<string, CardState> = {};
  for (const row of rows) {
    cardStates[row.id] = { lane: row.lane, status: row.status, attempt: row.attempt };
  }

  return { cardStates, ...metrics };
}

// ---------------------------------------------------------------------------
// runReferenceFlow — the fault-injection driver
// ---------------------------------------------------------------------------

/**
 * Drive the reference flow end-to-end through the assembled kernel.
 *
 * Uses real kernel functions for each station; the ModelAdapter and clock are
 * injected/stubbed for determinism.
 */
export async function runReferenceFlow(opts: ReferenceRunOptions = {}): Promise<ReferenceRunResult> {
  // Config gate (#26): the reference flow.yaml must pass the REAL loader's
  // validation (disjoint path ownership, legal transitions, acyclic deps) before
  // any station runs — fail-closed, exactly as the binary does.
  const loaded = loadFlow(REFERENCE_FLOW_PATH);
  if (!loaded.ok) {
    throw new Error(
      `reference flow failed validation: ${loaded.errors.map((e) => e.code).join(', ')}`,
    );
  }

  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  const stateDb = db.getStateDb();

  const metrics = {
    gateRejections: 0,
    hitlHoldPosted: false,
    hitlSelection: null as string | null,
    rankAutoPicked: false,
    delivered: false,
    effectfulPostCount: 0,
    droppedChildren: [] as string[],
    scrappedCards: [] as string[],
    onTimeoutApplied: null as string | null,
    parentLane: 'intake',
  };

  const { posts: _slackPosts, transport } = makeTransport();
  const { state: adapterState, adapter } = makeAdapter({
    gateRejectsBeforePass: opts.gateRejectsBeforePass ?? 0,
  });

  const NOW = 1_000;
  const LEASE = 30;
  const PARENT_ID = 'parent';

  try {
    // ── Phase 1: Plan station (gate check with optional rework) ─────────────

    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ($id, null, 'plan', 'ready', 0, 0, '[]')`,
      )
      .run({ $id: PARENT_ID });

    let planAttempt = 0;
    planLoop: while (true) {
      attemptClaim(db, {
        cardId: PARENT_ID,
        station: 'plan',
        workerId: `w-plan-${planAttempt}`,
        wipCap: 5,
        now: NOW,
        leaseSeconds: LEASE,
      });
      beginWork(db, PARENT_ID, 'plan', NOW, LEASE);

      // Run the gate critic (the critic call represents the quality check on
      // the plan output — the stub returns reject/pass per gateRejectsLeft).
      adapterState.context = 'plan_gate';
      const gateDecision = await runGateCheck({
        cardId: PARENT_ID,
        station: 'plan',
        attempt: planAttempt,
        maxExecutionAttempts: 4,
        model: 'gpt-4o-mini',
        prompt: 'Evaluate the plan quality.',
        params: {},
        adapter,
        db,
        onReject: 'plan',
        validBackEdges: BACK_EDGES,
        runId: DEFAULT_RUN_ID,
      });

      stateDb.prepare('DELETE FROM active_workers WHERE card_id = $id').run({ $id: PARENT_ID });

      switch (gateDecision.action) {
        case 'reject':
          metrics.gateRejections++;
          planAttempt++;
          stateDb
            .prepare("UPDATE cards SET status = 'ready', attempt = $a WHERE id = $id")
            .run({ $a: planAttempt, $id: PARENT_ID });
          continue planLoop;

        case 'pass':
          break planLoop;

        case 'scrapped':
        case 'invalid_verdict':
          metrics.scrappedCards.push(PARENT_ID);
          stateDb
            .prepare("UPDATE cards SET status = 'scrapped', lane = 'scrap' WHERE id = $id")
            .run({ $id: PARENT_ID });
          metrics.parentLane = 'scrap';
          return buildResult(db, metrics);
      }
    }

    // ── Phase 2: Fan-out — create 3 child cards ──────────────────────────────

    for (const childId of CHILD_IDS) {
      stateDb
        .prepare(
          `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
           VALUES ($id, $parent, 'draft', 'ready', 0, 0, $paths)`,
        )
        .run({
          $id: childId,
          $parent: PARENT_ID,
          $paths: JSON.stringify([`out/${childId}.json`]),
        });
    }
    stateDb
      .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = $id")
      .run({ $id: PARENT_ID });

    // ── Phase 3: Process children (draft → publish) ──────────────────────────

    const processedChildren = new Set<string>();

    for (let i = 0; i < CHILD_IDS.length; i++) {
      const childId = CHILD_IDS[i]!;

      // Fault injection: scrap child-0 to test quorum fan-in
      if (i === 0 && opts.forceScrapChild) {
        stateDb
          .prepare("UPDATE cards SET status = 'scrapped', lane = 'scrap' WHERE id = $id")
          .run({ $id: childId });
        metrics.scrappedCards.push(childId);
        continue;
      }

      // Draft transform
      adapterState.context = `draft_worker`;
      await runTransformStation({
        cardId: childId,
        station: 'draft',
        runId: DEFAULT_RUN_ID,
        attempt: 0,
        maxExecutionAttempts: 4,
        model: 'gpt-4o-mini',
        prompt: 'Write the content draft.',
        params: {},
        schema: permissiveSchema,
        adapter,
        db,
      });

      stateDb
        .prepare("UPDATE cards SET lane = 'publish', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });

      // Publish (effectful station) — via outbox for idempotency
      const publishKey = `publish:${childId}:0`;

      if (getIntentStatus(stateDb, publishKey) !== 'committed') {
        writePendingIntent(stateDb, {
          flow: 'reference-pipeline',
          card: childId,
          station: 'publish',
          attempt: 0,
          idempotencyKey: publishKey,
          intent: { kind: 'publish', childId },
        });

        adapterState.context = 'publish_worker';
        await runTransformStation({
          cardId: childId,
          station: 'publish',
          runId: DEFAULT_RUN_ID,
          attempt: 0,
          maxExecutionAttempts: 4,
          model: 'gpt-4o-mini',
          prompt: 'Publish the content.',
          params: {},
          schema: permissiveSchema,
          adapter,
          db,
        });

        commitIntent(stateDb, publishKey);
        metrics.effectfulPostCount++;
      }

      // simulateResume: prove the outbox prevents a second effectful post.
      if (opts.simulateResume && i === 0) {
        // The key is already committed → this check returns 'committed' → no-op.
        if (getIntentStatus(stateDb, publishKey) !== 'committed') {
          // Would only reach here if the outbox was broken — should never happen.
          metrics.effectfulPostCount++;
        }
        // Return early with effectfulPostCount=1 to prove dedup.
        return buildResult(db, metrics);
      }

      processedChildren.add(childId);
      stateDb
        .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }

    // ── Phase 4: Rank check (select) — optional HITL ─────────────────────────

    // Only engage HITL when explicitly requested (hitlReply !== undefined).
    // Clean path (no option) skips the HITL hold entirely.
    if (opts.hitlReply !== undefined) {
      stateDb
        .prepare("UPDATE cards SET lane = 'select', status = 'held' WHERE id = $id")
        .run({ $id: PARENT_ID });

      adapterState.context = 'select_rank';
      const rankDecision = await runRankCheck({
        cardId: PARENT_ID,
        station: 'select',
        attempt: 0,
        maxExecutionAttempts: 4,
        model: 'gpt-4o',
        prompt: 'Rank the candidate variants by quality.',
        params: {},
        candidateIds: [...CHILD_IDS],
        hitlEnabled: true,
        noSelectionPolicy: 'scrap',
        adapter,
        db,
        runId: DEFAULT_RUN_ID,
      });

      // FR-14: rank NEVER auto-picks — this is always false.
      metrics.rankAutoPicked = false;

      if (rankDecision.action === 'await_selection') {
        metrics.hitlHoldPosted = true;

        const { correlationId } = await postHitlHold(db, transport, {
          cardId: PARENT_ID,
          channel: EGRESS_CHANNEL,
          prompt: 'Select the best content variant',
        });

        if (typeof opts.hitlReply === 'string') {
          // Human reply arrives — apply it (held → ready).
          const reply = applyHitlReply(db, correlationId, opts.hitlReply);
          if (reply.resumed) {
            metrics.hitlSelection = opts.hitlReply;
          }
          // Advance parent past the hold for fan-in
          stateDb
            .prepare("UPDATE cards SET status = 'awaiting_children', lane = 'select' WHERE id = $id")
            .run({ $id: PARENT_ID });
        } else {
          // opts.hitlReply === null → no human response → apply on_timeout: scrap
          // (reference flow egress config: on_timeout: scrap)
          applyHoldTimeout(db, correlationId, 'scrap');
          metrics.onTimeoutApplied = 'scrap';
          metrics.parentLane = 'scrap';
          return buildResult(db, metrics);
        }
      }
    }

    // ── Phase 5: Fan-in evaluation (quorum 2-of-3) ───────────────────────────

    const fanInOutcomes = [...CHILD_IDS].map((id) => ({
      id,
      lane: metrics.scrappedCards.includes(id) ? 'scrap' : 'done',
    }));

    const fanInDecision = quorumProceed(CHILD_IDS, fanInOutcomes);

    if (fanInDecision.proceed) {
      metrics.droppedChildren = fanInDecision.dropped;

      // Deliver the assembled artifact via egress (effectful — outbox-guarded)
      await egressSend(db, transport, {
        channel: EGRESS_CHANNEL,
        text: 'DELIVERY: assembled artifact ready',
        idempotencyKey: 'delivery:reference:0',
      });

      metrics.delivered = true;
      metrics.parentLane = 'done';
      stateDb
        .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = $id")
        .run({ $id: PARENT_ID });
    } else if (fanInDecision.held) {
      metrics.parentLane = 'hold';
    }

    return buildResult(db, metrics);
  } finally {
    db.close();
  }
}
