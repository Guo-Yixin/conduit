import type { ConduitDB } from '../persistence/db';
import type { Status } from '../types/kernel';

export type RunStateResult =
  | { status: 'not_found' }
  | { status: 'running' }
  | { status: 'held'; heldCards: Array<{ cardId: string; reason: string }> }
  /**
   * Halted with nothing wrong: every unfinished card is parked behind a
   * provider reset (issue #7), confirmed against the cards at read time.
   * `releaseAt` is the soonest gate, in the run clock's epoch seconds; `flow`
   * is the recorded flow path, so the resume command can be printed verbatim.
   */
  | { status: 'parked'; releaseAt: number; flow: string }
  | { status: 'terminal'; outcome: string };

const TERMINAL_STATUSES = new Set(['complete', 'scrapped', 'held']);

/** The soonest gate among a run's parked cards, when the run halted as parked. */
export interface ParkedRelease {
  releaseAt: number;
}

/**
 * Statuses that mean "blocked on another card": a dependent waiting on its
 * deps, a fan-out parent waiting on its children. Scheduling, not failure — if
 * the card they wait on is parked, so, transitively, are they.
 */
const WAITING_ON_OTHER_CARDS: ReadonlySet<Status> = new Set<Status>(['waiting', 'awaiting_children']);

/**
 * Is this run stopped ONLY because its cards are waiting on a provider reset?
 *
 * The single predicate behind `runs.outcome = 'parked'` (issue #7). A run
 * qualifies when at least one unfinished card is `ready` behind a `release_at`
 * still in the future, and every other unfinished card is either parked the
 * same way or waiting on other cards. Anything else — a scrap, a hold, work in
 * flight, a gate already in the past with the card still not dispatched — is a
 * failure or a stall, and must keep reading as a plain halt so the operator
 * looks at it rather than merely waiting. Waiting cards with NO parked card
 * anywhere are a stall too: a wait on nothing scheduled never ends.
 *
 * `now` is in the run clock's frame (epoch seconds in production), the same
 * frame `release_at` was stamped in.
 */
export function getRunParkedRelease(db: ConduitDB, runId: string, now: number): ParkedRelease | null {
  const unfinished = db
    .getStateDb()
    .prepare("SELECT status, release_at FROM cards WHERE run_id = $r AND lane != 'done'")
    .all({ $r: runId }) as Array<{ status: Status; release_at: number | null }>;

  let soonest = Infinity;
  for (const card of unfinished) {
    if (WAITING_ON_OTHER_CARDS.has(card.status)) continue;
    if (card.status !== 'ready' || card.release_at === null || card.release_at <= now) return null;
    soonest = Math.min(soonest, card.release_at);
  }
  return soonest === Infinity ? null : { releaseAt: soonest };
}

/**
 * The gate time as ISO-8601 UTC. `releaseAt` is epoch seconds in production;
 * an injected test clock renders as a 1970 timestamp, which is still exact.
 */
export function formatReleaseAt(releaseAt: number): string {
  return new Date(releaseAt * 1000).toISOString();
}

/**
 * What an operator needs when a run parks: when the provider lets it continue,
 * and the exact command that continues it. Shared by the run/resume exit paths
 * and `run status`, so the wording cannot drift between them. Callers prefix
 * the run id in their own house style.
 */
export function formatParkedRun(runId: string, flow: string, releaseAt: number): string {
  return (
    `parked behind a provider rate limit until ${formatReleaseAt(releaseAt)} — nothing was scrapped; ` +
    `resume with: conduit resume ${flow} --run ${runId}`
  );
}

/**
 * `now` is in the run clock's frame (epoch seconds), used only to confirm a
 * recorded park against the cards; the default is the production clock.
 */
export function getRunState(
  db: ConduitDB,
  runId: string,
  now: number = Math.floor(Date.now() / 1000),
): RunStateResult {
  const run = db.getRun(runId);
  if (!run) return { status: 'not_found' };

  const stateDb = db.getStateDb();
  const cards = stateDb
    .prepare('SELECT id, status, lane FROM cards WHERE run_id = $r')
    .all({ $r: runId }) as Array<{ id: string; status: string; lane: string }>;

  const heldCards = cards.filter((c) => c.status === 'held');
  if (heldCards.length > 0) {
    return {
      status: 'held',
      heldCards: heldCards.map((c) => {
        // O(held) queries — db.ts exposes no "latest log entry" accessor, so we
        // fetch the full per-card log and scan backwards for the last terminal
        // entry (iterate from the end, break on first match — no full reverse).
        // Acceptable at current scale (held cards are rare and small in number).
        const entries = db.getCardLogForRun(runId, c.id);
        let reason = '';
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!;
          if (entry.kind === 'terminal') {
            reason = entry.reason ?? '';
            break;
          }
        }
        return { cardId: c.id, reason };
      }),
    };
  }

  // A parked run's cards are all `ready` or waiting on each other, which would
  // otherwise read as running. The runs row says a park was observed at exit —
  // but it stays stamped until the NEXT exit, so a resume in flight (cards
  // working) or a gate that has since passed must not still read as parked:
  // confirm against the cards with the same predicate that stamped the row.
  if (run.status === 'halted' && run.outcome === 'parked') {
    const parked = getRunParkedRelease(db, runId, now);
    if (parked !== null) return { status: 'parked', releaseAt: parked.releaseAt, flow: run.flow };
  }

  const hasActive = cards.some((c) => !TERMINAL_STATUSES.has(c.status));
  if (hasActive) return { status: 'running' };

  return { status: 'terminal', outcome: run.outcome ?? 'unknown' };
}
