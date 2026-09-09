/**
 * Parked runs under the ingress listener (issue #7).
 *
 * A run the consumption andon halts while every unfinished card waits on a
 * provider reset exits 1 — "did not complete" — and is recorded
 * `runs.status='halted', outcome='parked'` by the CLI (run/run-state.ts). To
 * the listener that exit looked like any other failure: the row went 'failed',
 * the channel was told "exited with code 1", and the boot sweep then
 * "re-drove" it with `conduit run --run-id <same>` — which, for an existing
 * run, only prints the run state and exits 0. The run was never resumed.
 *
 * A park is a RUN-level fact, so the ingress_events spawn_state machine stays
 * untouched: the row stays 'spawned' (its launch succeeded) and the ledger
 * keeps tracking launches. This module owns the two things the listener needs
 * on top of that:
 *
 *   - recognising a park at child exit (inspectParkedRun) and telling the
 *     channel ONCE per event that the run is waiting and will resume on its own
 *     (recordPark) — the MAX park cap chunks a long reset into several
 *     resume/park cycles, and the channel should not hear each chunk;
 *   - resuming what is due with `conduit resume` on every sweep
 *     (resumeDueParkedRuns), slot-gated WITHOUT the HITL bypass: a rate limit is
 *     precisely the wrong moment to let N parked runs stampede a saturated box.
 *
 * Attempts are never spent here: `spawn_attempts` bounds LAUNCH failures, and
 * neither a park nor its resume is one. Only a resume that ends with the run
 * neither complete nor parked is a failure, and it is reported exactly as a
 * dead re-driven child is: the row goes 'failed' and this sweep stops looking
 * at it — only 'spawned' events are resume candidates. That hand-off is what
 * bounds the loop: a resume can fail BEFORE it drives the run at all (a lease
 * conflict, a preflight failure, a missing flow file), leaving the run parked
 * with its gate in the past; re-resuming it every tick would spend nothing
 * and never end. A 'failed' row is the re-drive sweep's business, and that
 * sweep is attempt-capped — its `conduit run --run-id` re-drive of an
 * existing run is a no-op that flips the row back to 'spawned' while counting
 * an attempt, so the whole resume/fail/re-drive cycle is bounded by
 * `redriveCap`.
 */
import type { ConduitDB } from '../persistence/db';
import { formatReleaseAt, getRunParkedRelease } from '../run/run-state';
import type { HitlResumeSpawn } from './adapters/slack-events';
import {
  resolveAlertChannel,
  UNATTRIBUTED_FLOW_ID,
  type RedriveAlerting,
} from './alert-channel';
import { startGatedResume } from './gated-resume';
import type { RunSlots } from './run-slots';
import type { AlertSeam } from './spawn';

/** ingress_log source for the sweep-driven resumes. */
const PARKED_RESUME_SOURCE = 'parked-resume';

/** The gate a confirmed parked run is waiting on, epoch seconds. */
export interface ParkedRunGate {
  releaseAt: number;
}

/**
 * Is `runId` parked right now? The runs row must say so AND the cards must
 * still agree — the row keeps its stamp until the next exit, so a resume in
 * flight would otherwise still read as parked. `nowSeconds` is in the run
 * clock's frame (epoch seconds), which is what `release_at` was stamped in.
 */
export function inspectParkedRun(db: ConduitDB, runId: string, nowSeconds: number): ParkedRunGate | null {
  const run = db.getRun(runId);
  if (run === null || run.status !== 'halted' || run.outcome !== 'parked') return null;
  return getRunParkedRelease(db, runId, nowSeconds);
}

/**
 * The gate a run is parked behind, judged by its SHAPE rather than the clock:
 * the same predicate the CLI stamped the row with, evaluated as of the run's
 * own soonest gate. A run whose gate has already passed is exactly the one the
 * sweep must resume — but to the predicate at wall-clock `now` a past gate is
 * a stall, so the due check cannot ask it about `now` directly.
 */
function parkedGateByShape(db: ConduitDB, runId: string): number | null {
  const { soonest } = db
    .getStateDb()
    .prepare(
      `SELECT MIN(release_at) AS soonest FROM cards
       WHERE run_id = $r AND status = 'ready' AND release_at IS NOT NULL`,
    )
    .get({ $r: runId }) as { soonest: number | null };
  if (soonest === null) return null;
  return getRunParkedRelease(db, runId, soonest - 1)?.releaseAt ?? null;
}

export interface ParkNotice {
  source: string;
  eventId: string;
  flowId: string;
  channel: string;
  runId: string;
  releaseAt: number;
}

/**
 * Record a park: an ingress_log 'parked' entry EVERY time, the alert ONCE per
 * event. "Once" is keyed on the log itself, so it survives a listener restart
 * and needs no state of its own. Informational — it never marks the event
 * failed, and a dead alert transport never throws past here. A caller with no
 * alert seam (a unit-level re-drive driver) just gets the log entry.
 */
export async function recordPark(db: ConduitDB, alert: AlertSeam | undefined, notice: ParkNotice): Promise<void> {
  const { source, eventId, flowId, channel, runId, releaseAt } = notice;
  const gate = formatReleaseAt(releaseAt);
  const alreadyTold = db.getIngressLog({ outcome: 'parked', eventId, limit: 1 }).length > 0;
  db.appendIngressLog({
    source,
    eventId,
    outcome: 'parked',
    reason: `run '${runId}' parked behind a provider rate limit until ${gate} — the listener resumes it once the gate passes`,
  });
  if (alreadyTold || alert === undefined) return;
  try {
    await alert({
      flowId,
      channel,
      eventId,
      reason: `parked: run '${runId}' is waiting on a provider rate limit until ${gate} and will resume on its own`,
    });
  } catch {
    // Best effort — the log entry above is the durable record.
  }
}

/** A parked ingress run whose gate has passed, with what the resume needs. */
export interface DueParkedRun {
  runId: string;
  eventId: string;
  /** Null on a pre-v9 row — the alert then goes to the global channel. */
  flowId: string | null;
  flowPath: string;
  releaseAt: number;
}

/**
 * Which parked ingress runs may be resumed now? Candidates come from the runs
 * table joined to their ingress attribution (a CLI-triggered run has none and
 * is not the listener's to resume — a wrong flow path would re-anchor its
 * workspace), restricted to events still 'spawned' (a 'failed' row is the
 * attempt-capped re-drive sweep's — see the header); each is confirmed against
 * its cards, and is due once its soonest gate is at or before `nowSeconds`.
 * Soonest gate first.
 */
export function listDueParkedRuns(db: ConduitDB, nowSeconds: number): DueParkedRun[] {
  const candidates = db
    .getStateDb()
    .prepare(
      `SELECT r.run_id, e.event_id, e.flow_id, e.flow_path, e.received_at
       FROM runs r
       JOIN ingress_events e ON e.run_id = r.run_id AND e.flow_path IS NOT NULL
       WHERE r.status = 'halted' AND r.outcome = 'parked' AND e.spawn_state = 'spawned'
       ORDER BY e.received_at DESC`,
    )
    .all() as Array<{ run_id: string; event_id: string; flow_id: string | null; flow_path: string }>;

  const due: DueParkedRun[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    // One run per sweep, attributed to its LATEST accepting event (the same
    // choice getFlowPathForRun makes).
    if (seen.has(row.run_id)) continue;
    seen.add(row.run_id);
    const releaseAt = parkedGateByShape(db, row.run_id);
    if (releaseAt === null || releaseAt > nowSeconds) continue;
    due.push({ runId: row.run_id, eventId: row.event_id, flowId: row.flow_id, flowPath: row.flow_path, releaseAt });
  }
  return due.sort((a, b) => a.releaseAt - b.releaseAt);
}

export interface ParkedResumeDeps {
  db: ConduitDB;
  slots: RunSlots;
  /** Spawns `conduit resume <flowPath> --run <runId>` and settles on the child's exit. */
  resumeSpawn: HitlResumeSpawn;
  /** Failure + park alerting, resolved the way the re-drive path resolves it. */
  alerts?: RedriveAlerting;
  /** Listener clock, unix MILLISECONDS (the ingress frame). */
  now: () => number;
}

export interface ParkedResumeReport {
  /** Run ids whose resume was started (it keeps its slot until the child exits). */
  resumed: string[];
  /** Run ids left for a later sweep: resume already in flight, or no free slot. */
  deferred: string[];
}

/**
 * Resume every due parked run — launch-only, like a re-drive sweep: each
 * resume is supervised detached so a sweep finishes in milliseconds rather
 * than as long as the runs it resumed. Slot-gated in gate order; the first
 * run to find no free slot ends the sweep (the release kick or the next tick
 * resumes the rest). Never rejects.
 */
export async function resumeDueParkedRuns(deps: ParkedResumeDeps): Promise<ParkedResumeReport> {
  const { db, slots } = deps;
  const report: ParkedResumeReport = { resumed: [], deferred: [] };
  const due = listDueParkedRuns(db, Math.floor(deps.now() / 1000));

  for (const [index, run] of due.entries()) {
    const started = startGatedResume(
      slots,
      db,
      {
        slotId: `parked-resume:${run.runId}`,
        runId: run.runId,
        source: PARKED_RESUME_SOURCE,
        bypassWhenSaturated: false,
      },
      () => superviseResume(deps, run),
    );
    if (started.outcome === 'duplicate') {
      report.deferred.push(run.runId);
      continue;
    }
    if (started.outcome === 'full') {
      report.deferred.push(...due.slice(index).map((r) => r.runId));
      break;
    }
    report.resumed.push(run.runId);
  }
  return report;
}

/**
 * Drive one resume to its exit and read what the run became. Three honest
 * endings, none of which is "the resume exited nonzero": `conduit resume`
 * exits 0 even for a halted run, so the runs row is the authority.
 */
async function superviseResume(deps: ParkedResumeDeps, run: DueParkedRun): Promise<void> {
  const { db, alerts } = deps;
  const { runId, eventId, flowId, flowPath } = run;
  try {
    let result: { ok: boolean; error?: string };
    try {
      result = await deps.resumeSpawn({ flowPath, runId });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const after = db.getRun(runId);
    if (after !== null && after.status === 'done') {
      db.appendIngressLog({
        source: PARKED_RESUME_SOURCE,
        eventId,
        outcome: 'accepted',
        reason: `conduit resume completed run '${runId}' after its rate-limit park`,
      });
      return;
    }

    const parkedAgain = inspectParkedRun(db, runId, Math.floor(deps.now() / 1000));
    if (parkedAgain !== null) {
      // The cap is still in force (or the MAX park cap split the wait). The
      // next due sweep picks it up; the channel already heard about this park,
      // but the log records every one — with or without an alert seam, as the
      // exit watchers do.
      await recordPark(db, alerts?.alert, {
        source: PARKED_RESUME_SOURCE,
        eventId,
        flowId: flowId ?? UNATTRIBUTED_FLOW_ID,
        channel: resolveAlertChannel(alerts, flowId),
        runId,
        releaseAt: parkedAgain.releaseAt,
      });
      return;
    }

    // Neither complete nor parked: NOW it is a failure, reported exactly as a
    // dead re-driven child is — mark, alert, log. Attempts stay untouched, and
    // the 'failed' row drops out of this sweep's candidates (see the header).
    const reason =
      `conduit resume of run '${runId}' did not complete: ` +
      (result.error ?? (result.ok ? 'the run halted' : 'unknown'));
    db.markIngressFailed(eventId);
    if (alerts !== undefined) {
      try {
        await alerts.alert({
          flowId: flowId ?? UNATTRIBUTED_FLOW_ID,
          channel: resolveAlertChannel(alerts, flowId),
          eventId,
          reason,
        });
      } catch {
        // Best effort — the log entry below is the durable record.
      }
    }
    db.appendIngressLog({ source: PARKED_RESUME_SOURCE, eventId, outcome: 'spawn_failed', reason });
  } catch {
    // Persistence failure in a detached supervisor — nothing left to report to.
  }
}
