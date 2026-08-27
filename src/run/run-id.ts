import { createHash } from 'node:crypto';
import { DEFAULT_RUN_ID } from '../persistence/db';

const VALID_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateRunId(id: string): string {
  if (!VALID_RUN_ID.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The stable back-compat run id used when a caller omits an explicit run.
 * Delegates to the canonical DEFAULT_RUN_ID from the persistence db module so
 * there is a single source of truth in TS code.
 */
export function defaultRunId(): string {
  return DEFAULT_RUN_ID;
}

/**
 * Derive a child run id for a subflow invocation (the original multi-flow engine work).
 *
 * Deterministic per (parent run, calling station, attempt index): a resumed
 * parent re-dispatching the same attempt derives the SAME child run id, so
 * the child's own run-lease/fingerprint machinery makes the re-invocation
 * idempotent instead of forking a duplicate child. A retry (next attempt
 * index) derives a fresh child run.
 *
 * Shape: `<parent>--<station>-a<idx>-<hash>`, sanitized and truncated to the
 * run-id budget; the sha256 prefix of the raw triple keeps distinct triples
 * distinct even when truncation collapses their readable stems.
 */
export function deriveSubflowRunId(
  parentRunId: string,
  stationId: string,
  attemptIndex: number,
): string {
  const hash = createHash('sha256')
    .update(`${parentRunId} ${stationId} ${attemptIndex}`)
    .digest('hex')
    .slice(0, 12);
  const suffix = `-a${attemptIndex}-${hash}`;
  const stem = `${parentRunId}--${stationId}`
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 128 - suffix.length);
  return `${stem}${suffix}`;
}
