/**
 * Cross-run HITL correlation-id disjointness (the pre-public ingress-deduplication review Fix 1).
 *
 * The rank/HITL station derives a STABLE correlation id that is BOTH the outbox
 * idempotency key AND the card_log reason findRunForHitlCorrelation keys on.
 * Before the fix the id was `hitl::<cardId>::<stationId>::<attempt>` — with no
 * run id. Because card ids repeat across runs, two runs reaching the same
 * card/station/attempt computed an IDENTICAL id, with two consequences:
 *   (a) egressSend consults the outbox by that key (under a single default run),
 *       so run B saw run A's committed row and NEVER posted its ask; and
 *   (b) findRunForHitlCorrelation (ORDER BY id DESC) resolved a button tap to the
 *       NEWEST run, so run A's human could flip run B's card.
 *
 * The fix leads the id with runId: `hitl::<runId>::<cardId>::<stationId>::<attempt>`.
 * These tests pin both halves against the REAL egressSend / applyHitlReply /
 * findRunForHitlCorrelation against an in-memory DB with a fake transport.
 */
import { test, expect } from 'bun:test';
import { openConduitDB } from '../persistence/db';
import { egressSend, applyHitlReply } from '../channels/slack';

const CARD_ID = 'root';
const STATION = 'select';
const RUN_A = 'run-a';
const RUN_B = 'run-b';

/** The run-scoped correlation id the executor derives (the pre-public ingress-deduplication review Fix 1). */
function correlation(runId: string): string {
  return `hitl::${runId}::${CARD_ID}::${STATION}::0`;
}

function seedHeldCard(db: ReturnType<typeof openConduitDB>, runId: string): void {
  db.insertCard({
    run_id: runId,
    id: CARD_ID,
    parent_id: null,
    lane: STATION,
    status: 'held',
    attempt: 0,
    wave: 0,
    owned_paths: ['final.zip'],
    rework_count: 0,
  });
}

test('two runs with identical card/station/attempt each post their ask (no cross-run outbox skip)', async () => {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  const posts: string[] = [];
  const transport = {
    post: async (m: { text: string }) => {
      posts.push(m.text);
      return { ts: `${posts.length}.0` };
    },
  } as never;

  const corrA = correlation(RUN_A);
  const corrB = correlation(RUN_B);
  // The ids MUST differ now — that disjointness is the whole fix.
  expect(corrA).not.toBe(corrB);

  const a = await egressSend(db, transport, { channel: 'C1', text: 'ASK from run A', idempotencyKey: corrA, correlationId: corrA });
  const b = await egressSend(db, transport, { channel: 'C1', text: 'ASK from run B', idempotencyKey: corrB, correlationId: corrB });

  expect(a.posted).toBe(true);
  expect(b.posted).toBe(true); // before the fix run B silently skipped
  expect(posts).toEqual(['ASK from run A', 'ASK from run B']);
  db.close();
});

test('a reply resolves to the correct run and never flips the same-id card in another run', async () => {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  seedHeldCard(db, RUN_A);
  seedHeldCard(db, RUN_B);

  const corrA = correlation(RUN_A);
  const corrB = correlation(RUN_B);

  // Both runs surface their correlation id on the card_log (as the executor does
  // before parking the card held) — run B's row is appended LAST.
  db.appendCardLog({ runId: RUN_A, kind: 'terminal', cardId: CARD_ID, station: STATION, attempt: 0, reason: corrA });
  db.appendCardLog({ runId: RUN_B, kind: 'terminal', cardId: CARD_ID, station: STATION, attempt: 0, reason: corrB });

  // findRunForHitlCorrelation resolves EACH id to its own run — not the newest.
  expect(db.findRunForHitlCorrelation(corrA)).toBe(RUN_A);
  expect(db.findRunForHitlCorrelation(corrB)).toBe(RUN_B);

  // Replying for run A flips ONLY run A's card; run B stays held.
  const replyA = applyHitlReply(db, corrA, 'pick-a', db.findRunForHitlCorrelation(corrA)!);
  expect(replyA.resumed).toBe(true);
  expect(replyA.cardId).toBe(CARD_ID);
  expect(db.getCard(RUN_A, CARD_ID)?.status).toBe('ready');
  expect(db.getCard(RUN_B, CARD_ID)?.status).toBe('held');
  db.close();
});
