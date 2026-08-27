/**
 * Tests for the Slack egress channel + outbox idempotency (WI-303 AC2-AC6,
 * SPEC §4A channels, SPEC §5 effectful outbox, FR-13/14).
 *
 * TRANSPORT layer. Every egress send is EFFECTFUL, so it goes through the
 * outbox (WI-298): write a pending intent with an idempotency key, post, then
 * mark committed. On resume the outbox is consulted so a delivery is never
 * re-posted and an approval is never re-asked. HITL holds carry a correlation
 * id that maps an async human reply back to the card (held → ready); a
 * hold_timeout applies the configured on_timeout and NEVER silently auto-picks
 * a rank winner (FR-14). Slack is a stub/recording transport in tests.
 *
 * Contract this file pins for src/channels/slack.ts:
 *
 *   interface SlackTransport { post(req: { channel: string; text: string; correlationId?: string }): Promise<{ ts: string }> }
 *   interface EgressMessage { channel: string; text: string; idempotencyKey: string; correlationId?: string }
 *   function egressSend(db: ConduitDB, transport: SlackTransport, msg: EgressMessage): Promise<{ posted: boolean }>
 *     // pending outbox row → post → commit; if already committed, skip (posted:false).
 *   function postHitlHold(db, transport, req: { cardId: string; channel: string; prompt: string }): Promise<{ correlationId: string }>
 *   function applyHitlReply(db, correlationId: string, selection: string): { resumed: boolean; cardId?: string; selection?: string }
 *   type OnTimeout = 'scrap' | 'proceed_with_findings' | 'escalate'
 *   function applyHoldTimeout(db, correlationId: string, onTimeout: OnTimeout): { applied: OnTimeout; cardId: string; autoSelected: boolean }
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { getIntentStatus, writePendingIntent } from '../checkpoint/checkpoint';
import {
  egressSend,
  postHitlHold,
  applyHitlReply,
  applyHoldTimeout,
  getRecordedHitlSelection,
  type SlackTransport,
} from './slack';

let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-egress-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
});
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    run_id: DEFAULT_RUN_ID,
    id: 'c1',
    parent_id: null,
    lane: 'select',
    status: 'held',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
    ...overrides,
  };
}

/** A recording Slack transport — captures every post instead of hitting Slack. */
function recordingTransport() {
  const posts: { channel: string; text: string; correlationId?: string }[] = [];
  const transport: SlackTransport = {
    post: async (req) => {
      posts.push(req);
      return { ts: `ts-${posts.length}` };
    },
  };
  return { posts, transport };
}

// ---------------------------------------------------------------------------
// AC5 — every send is outbox-guarded; resume never re-posts.
// ---------------------------------------------------------------------------

describe('egressSend — outbox idempotency (AC5)', () => {
  it('writes a pending outbox row, posts, then marks the intent committed', async () => {
    const { posts, transport } = recordingTransport();
    const result = await egressSend(db!, transport, {
      channel: '#content',
      text: 'delivery: final.zip',
      idempotencyKey: 'send-1',
    });

    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(getIntentStatus(db!.getStateDb(), 'send-1')).toBe('committed');
  });

  it('does NOT re-post a send whose idempotency key is already committed (resume safety)', async () => {
    const { posts, transport } = recordingTransport();
    await egressSend(db!, transport, { channel: '#content', text: 'delivery', idempotencyKey: 'send-1' });
    expect(posts).toHaveLength(1);

    // Simulated resume: same key again must be a no-op delivery.
    const second = await egressSend(db!, transport, { channel: '#content', text: 'delivery', idempotencyKey: 'send-1' });
    expect(second.posted).toBe(false);
    expect(posts).toHaveLength(1); // NOT posted twice
  });
});

// ---------------------------------------------------------------------------
// #2 — crash AFTER post, BEFORE commit: resume must reconcile, never throw,
//      never double-post. A pending row pre-exists for the idempotency key.
// ---------------------------------------------------------------------------

describe('egressSend — crash-after-post-before-commit recovery (#2)', () => {
  function seedPendingIntent(key: string) {
    // Simulate the pre-crash state: the intent was written PENDING and the post
    // fired, but the process died before commit. delivered_at stays NULL.
    writePendingIntent(db!.getStateDb(), {
      flow: 'egress',
      card: '#content',
      station: 'slack',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'slack_post', channel: '#content', text: 'delivery' },
    });
  }

  it('does NOT throw on the duplicate idempotency_key and does NOT blind re-post (escalates to hold without a reconciler)', async () => {
    seedPendingIntent('send-crash');
    const { posts, transport } = recordingTransport();

    // Must NOT throw on the duplicate idempotency_key (the old code did a plain
    // INSERT against the UNIQUE column and wedged the card).
    const result = await egressSend(db!, transport, {
      channel: '#content',
      text: 'delivery',
      idempotencyKey: 'send-crash',
    });

    // No reconciler → cannot prove the post landed → escalate to hold, never re-post.
    expect(result.posted).toBe(false);
    expect(result.escalatedToHold).toBe(true);
    expect(posts).toHaveLength(0); // never blind re-posted
    // Still pending — NOT auto-committed, NOT blind-fired.
    expect(getIntentStatus(db!.getStateDb(), 'send-crash')).toBe('pending');
  });

  it('skips (no re-post) when a reconciler confirms the prior post already landed', async () => {
    seedPendingIntent('send-landed');
    const { posts, transport } = recordingTransport();

    const result = await egressSend(
      db!,
      transport,
      { channel: '#content', text: 'delivery', idempotencyKey: 'send-landed' },
      () => 'landed',
    );

    expect(result.posted).toBe(false);
    expect(posts).toHaveLength(0); // already landed → no double-post
  });

  it('re-posts exactly once (reusing the pending row) when a reconciler confirms the prior post did NOT land', async () => {
    seedPendingIntent('send-missed');
    const { posts, transport } = recordingTransport();

    const result = await egressSend(
      db!,
      transport,
      { channel: '#content', text: 'delivery', idempotencyKey: 'send-missed' },
      () => 'not_landed',
    );

    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1); // posted once; the existing pending row was committed, not re-inserted
    expect(getIntentStatus(db!.getStateDb(), 'send-missed')).toBe('committed');
  });
});

// ---------------------------------------------------------------------------
// AC2 — status egress mirrors a journal event to the configured thread.
// ---------------------------------------------------------------------------

describe('status egress (AC2)', () => {
  it('mirrors a journal event to the configured Slack thread', async () => {
    const { posts, transport } = recordingTransport();
    await egressSend(db!, transport, {
      channel: '#content-status',
      text: 'STATUS card c1 lane=publish status=done_pending_ack',
      idempotencyKey: 'status-c1-1',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('#content-status');
    expect(posts[0]!.text).toContain('card c1');
  });
});

// ---------------------------------------------------------------------------
// AC6 — alert egress delivers andon/liveness/scrap notifications.
// ---------------------------------------------------------------------------

describe('alert egress (AC6)', () => {
  it('delivers an andon/scrap notification to the configured channel', async () => {
    const { posts, transport } = recordingTransport();
    await egressSend(db!, transport, {
      channel: '#content-alerts',
      text: 'ALERT andon tripped: token budget overshoot 200000',
      idempotencyKey: 'alert-1',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('#content-alerts');
    expect(posts[0]!.text).toContain('ALERT');
  });
});

// ---------------------------------------------------------------------------
// AC3 — HITL hold: prompt carries a correlation id; reply maps back and resumes.
// ---------------------------------------------------------------------------

describe('HITL hold + reply (AC3)', () => {
  it('posts a prompt with a correlation id, then a reply injects the selection and resumes the card', async () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'held', lane: 'select' }));
    const { posts, transport } = recordingTransport();

    const { correlationId } = await postHitlHold(db!, transport, {
      cardId: 'c1',
      channel: '#content-hitl',
      prompt: 'Pick the best variant: A, B, or C',
    });
    expect(correlationId.length).toBeGreaterThan(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.correlationId).toBe(correlationId);

    // Async human reply, mapped back by the correlation id.
    const reply = applyHitlReply(db!, correlationId, 'B');
    expect(reply.resumed).toBe(true);
    expect(reply.cardId).toBe('c1');
    expect(reply.selection).toBe('B');
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('ready'); // held → ready
  });

  it('ignores a reply whose correlation id maps to no held card', () => {
    const reply = applyHitlReply(db!, 'hitl::ghost-card::nonce', 'B');
    expect(reply.resumed).toBe(false);
  });

  // durable HITL-selection work — the human selection must be DURABLY recorded on resume (not just
  // returned locally), so the downstream station and the Kaizen HITL-preference
  // loop can read it (SPEC §4A / §13).
  it('durably records the human selection on the card journal when the reply resumes the card', () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'held', lane: 'select', attempt: 0 }));
    const { transport } = recordingTransport();
    return postHitlHold(db!, transport, { cardId: 'c1', channel: '#h', prompt: 'pick' }).then(
      ({ correlationId }) => {
        applyHitlReply(db!, correlationId, 'variant-B');

        // The selection is queryable after the held → ready transition.
        expect(getRecordedHitlSelection(db!, 'c1')).toBe('variant-B');

        const spans = db!.getJournalSpans('c1');
        const sel = spans.find((s) => s.name === 'hitl.selection');
        expect(sel).toBeDefined();
        expect(sel!.attributes.selection).toBe('variant-B');
      },
    );
  });

  it('does NOT record a selection when the reply is ignored (unknown card)', () => {
    applyHitlReply(db!, 'hitl::ghost::n', 'B');
    expect(getRecordedHitlSelection(db!, 'ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Run-scoping (#1) — the correlation id carries NO run id, so applyHitlReply
// must take an explicit runId and scope EVERY card read, UPDATE, and journal
// span to it. Otherwise a reply for a non-default run flips the wrong run's
// card (and the selection lands under `default`, invisible to a run-scoped
// getRecordedHitlSelection).
// ---------------------------------------------------------------------------

describe('HITL reply — run-scoping (#1)', () => {
  const RUN_A = 'run-A';

  it('transitions a held card in a NON-default run from held → ready', async () => {
    db!.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, {
      cardId: 'c1',
      channel: '#h',
      prompt: 'pick',
    });

    const reply = applyHitlReply(db!, correlationId, 'B', RUN_A);

    expect(reply.resumed).toBe(true);
    expect(reply.cardId).toBe('c1');
    expect(db!.getCard(RUN_A, 'c1')!.status).toBe('ready'); // held → ready in run-A
  });

  it('does NOT flip a same-id card in the default run when replying to a non-default run', async () => {
    // Same card id 'c1' exists held in BOTH runs.
    db!.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'c1', status: 'held', lane: 'select' }));
    db!.insertCard(makeCard({ run_id: DEFAULT_RUN_ID, id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, {
      cardId: 'c1',
      channel: '#h',
      prompt: 'pick',
    });

    const reply = applyHitlReply(db!, correlationId, 'B', RUN_A);

    expect(reply.resumed).toBe(true);
    // run-A's card advanced…
    expect(db!.getCard(RUN_A, 'c1')!.status).toBe('ready');
    // …but the default run's same-id card is UNTOUCHED.
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('held');
  });

  it('records the hitl.selection span scoped to the run so getRecordedHitlSelection(db, cardId, runId) finds it', async () => {
    db!.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, {
      cardId: 'c1',
      channel: '#h',
      prompt: 'pick',
    });

    applyHitlReply(db!, correlationId, 'variant-B', RUN_A);

    // Run-scoped read finds it…
    expect(getRecordedHitlSelection(db!, 'c1', RUN_A)).toBe('variant-B');
    // …and it did NOT land under the default run.
    expect(getRecordedHitlSelection(db!, 'c1', DEFAULT_RUN_ID)).toBeNull();
  });

  it('refuses a reply whose card is held only in a DIFFERENT run (run mismatch)', async () => {
    // Card is held in the default run, but the reply targets run-A.
    db!.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
    db!.insertCard(makeCard({ run_id: DEFAULT_RUN_ID, id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, {
      cardId: 'c1',
      channel: '#h',
      prompt: 'pick',
    });

    const reply = applyHitlReply(db!, correlationId, 'B', RUN_A);

    expect(reply.resumed).toBe(false);
    // The default run's card stays held — no cross-run flip.
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('held');
  });
});

// ---------------------------------------------------------------------------
// AC4 — hold_timeout applies on_timeout; rank winner NEVER auto-picked (FR-14).
// ---------------------------------------------------------------------------

describe('hold timeout (AC4 / FR-14)', () => {
  it('applies on_timeout=scrap without auto-picking any rank winner', async () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, { cardId: 'c1', channel: '#h', prompt: 'pick' });

    const out = applyHoldTimeout(db!, correlationId, 'scrap');

    expect(out.applied).toBe('scrap');
    expect(out.cardId).toBe('c1');
    expect(out.matched).toBe(true);
    expect(out.autoSelected).toBe(false); // FR-14: never silently pick a winner
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('scrapped');
  });

  it('applies on_timeout=escalate (to hold) without auto-picking a winner', async () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, { cardId: 'c1', channel: '#h', prompt: 'pick' });

    const out = applyHoldTimeout(db!, correlationId, 'escalate');
    expect(out.applied).toBe('escalate');
    expect(out.autoSelected).toBe(false);
  });

  it('applies on_timeout=proceed_with_findings and re-enqueues the card without auto-picking a winner', async () => {
    db!.insertCard(makeCard({ id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, { cardId: 'c1', channel: '#h', prompt: 'pick' });

    const out = applyHoldTimeout(db!, correlationId, 'proceed_with_findings');

    expect(out.applied).toBe('proceed_with_findings');
    expect(out.cardId).toBe('c1');
    expect(out.matched).toBe(true);
    expect(out.autoSelected).toBe(false); // FR-14: never silently pick a winner
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('ready'); // card re-enters the dispatch queue
  });

  // correlation-ID refusal work (security) — a crafted/unparseable correlation id must NOT be coerced
  // into a raw card id (it could otherwise scrap an arbitrary card).
  it('refuses an unparseable correlation id and does not scrap any card', () => {
    // A victim card that an attacker would try to scrap by id.
    db!.insertCard(makeCard({ id: 'victim', status: 'ready', lane: 'draft' }));

    // The crafted "correlation id" is literally the victim's card id.
    const out = applyHoldTimeout(db!, 'victim', 'scrap');

    expect(out.matched).toBe(false);
    expect(out.cardId).toBeNull();
    // The victim is untouched — NOT scrapped.
    expect(db!.getCard(DEFAULT_RUN_ID, 'victim')!.status).toBe('ready');
    expect(db!.getCard(DEFAULT_RUN_ID, 'victim')!.lane).toBe('draft');
  });

  // correlation-ID refusal work — a well-formed correlation id whose card does not exist is a no-op
  // reported as matched:false (not a silent fake success).
  it('reports matched:false when the correlation id is well-formed but the card does not exist', () => {
    const out = applyHoldTimeout(db!, 'hitl::no-such-card::nonce', 'scrap');
    expect(out.applied).toBe('scrap');
    expect(out.cardId).toBe('no-such-card');
    expect(out.matched).toBe(false);
  });

  // Run-scoping (#1) — the executor's timeout sweep iterates held rows already
  // scoped to a run, so applyHoldTimeout must scope its UPDATE to that run and
  // never scrap a same-id card in another run.
  it('scraps the held card in the targeted run only, leaving a same-id default card untouched', async () => {
    const RUN_A = 'run-A';
    db!.insertRun({ run_id: RUN_A, flow: 'f', input_fingerprint: 'fp', status: 'running' });
    db!.insertCard(makeCard({ run_id: RUN_A, id: 'c1', status: 'held', lane: 'select' }));
    db!.insertCard(makeCard({ run_id: DEFAULT_RUN_ID, id: 'c1', status: 'held', lane: 'select' }));
    const { transport } = recordingTransport();
    const { correlationId } = await postHitlHold(db!, transport, { cardId: 'c1', channel: '#h', prompt: 'pick' });

    const out = applyHoldTimeout(db!, correlationId, 'scrap', RUN_A);

    expect(out.matched).toBe(true);
    expect(db!.getCard(RUN_A, 'c1')!.status).toBe('scrapped');
    // The default run's same-id card is NOT scrapped.
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')!.status).toBe('held');
  });
});
