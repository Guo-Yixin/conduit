import type { ConduitDB } from '../persistence/db';

export type RunStateResult =
  | { status: 'not_found' }
  | { status: 'running' }
  | { status: 'held'; heldCards: Array<{ cardId: string; reason: string }> }
  | { status: 'terminal'; outcome: string };

const TERMINAL_STATUSES = new Set(['complete', 'scrapped', 'held']);

export function getRunState(db: ConduitDB, runId: string): RunStateResult {
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

  const hasActive = cards.some((c) => !TERMINAL_STATUSES.has(c.status));
  if (hasActive) return { status: 'running' };

  return { status: 'terminal', outcome: run.outcome ?? 'unknown' };
}
