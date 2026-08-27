/**
 * Worker harness subprocess — SPEC §10A, NFR-3 / NFR-4.
 *
 * Receives a START_WORK, runs the station body via the injected `runStation`
 * seam, emits periodic HEARTBEATs while in flight, and reports exactly one
 * MARK_DONE when the body settles. Never throws — a body that throws is caught
 * and reported as a 'scrap' MARK_DONE.
 *
 * NFR-3: this module has NO ConduitDB import and NO DB I/O. All results flow
 * over the injected `send` seam.
 * NFR-4: MARK_DONE carries outcome + references only, never artifact bytes.
 */

import type { StartWorkMessage, WorkerMessage, WorkerUsage, WorkerFailureDetail } from './ipc-protocol';

// Lease is 600 s (LEASE_SECONDS in executor.ts); this heartbeat interval keeps
// the lease live with ~120× margin — tune both if either changes.
const DEFAULT_HEARTBEAT_MS = 5_000;

export interface StationRunResult {
  outcome: 'success' | 'rework' | 'scrap' | 'failed';
  attempt: number;
  /** Model spend to attribute to this card (NFR-4: counts only). Omit for deterministic stations. */
  usage?: WorkerUsage;
  /** Diagnostic detail for a 'failed' outcome (the original deterministic failure-reporting work) — forwarded verbatim in MARK_DONE. */
  failure?: WorkerFailureDetail;
}

export type StationRunner = (start: StartWorkMessage) => Promise<StationRunResult>;

export interface HarnessTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HarnessDeps {
  runStation: StationRunner;
  send: (msg: WorkerMessage) => void;
  timers: HarnessTimers;
  heartbeatMs?: number;
}

export async function handleStartWork(start: StartWorkMessage, deps: HarnessDeps): Promise<void> {
  const { runStation, send, timers, heartbeatMs } = deps;
  const cadence = heartbeatMs !== undefined && heartbeatMs > 0 ? heartbeatMs : DEFAULT_HEARTBEAT_MS;

  const handle = timers.setInterval(() => {
    send({ type: 'HEARTBEAT', cardId: start.cardId, station: start.station });
  }, cadence);

  let result: StationRunResult;
  try {
    result = await runStation(start);
  } catch {
    timers.clearInterval(handle);
    send({
      type: 'MARK_DONE',
      cardId: start.cardId,
      station: start.station,
      attempt: 0,
      outcome: 'scrap',
    });
    return;
  }

  timers.clearInterval(handle);
  const done: WorkerMessage = {
    type: 'MARK_DONE',
    cardId: start.cardId,
    station: start.station,
    attempt: result.attempt,
    outcome: result.outcome,
  };
  if (result.usage !== undefined) done.usage = result.usage;
  if (result.failure !== undefined) done.failure = result.failure;
  send(done);
}
