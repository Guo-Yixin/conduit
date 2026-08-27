/**
 * Ingress run-id derivation (the original ingress-attribution work, FR-1).
 *
 * Every ingress-spawned run gets a run id derived deterministically from its
 * event id, so:
 *   - two concurrent events never collide on the default run id (the ingress event-isolation work bug);
 *   - a re-drive of the same event reuses the same run id, making re-drive an
 *     idempotent resume (registerRun reports 'existing' for an identical
 *     fingerprint) rather than a duplicate run.
 *
 * Event ids come from arbitrary provider surfaces (Slack native ids, webhook
 * headers, JSON paths, content hashes) and may contain characters outside the
 * CLI's run-id charset (`[A-Za-z0-9_-]{1,128}`, validateRunId). Derivation
 * therefore sanitizes the event id for readability and appends a short content
 * hash of the RAW event id so distinct event ids that sanitize identically
 * (e.g. `ev:1` and `ev.1`) still map to distinct run ids.
 */
import { createHash } from 'node:crypto';

/** CLI run-id budget (validateRunId: `[A-Za-z0-9_-]{1,128}`). */
const RUN_ID_MAX_LENGTH = 128;

/** Marks ingress-derived runs; keeps them greppable in `runs` and journals. */
const INGRESS_RUN_ID_PREFIX = 'ig-';

/** Hex chars of sha256(eventId) appended for collision resistance. */
const HASH_SUFFIX_LENGTH = 12;

/**
 * Derive the run id for an ingress event.
 *
 * Shape: `ig-<sanitized event id, truncated>-<sha256 prefix>` — always within
 * the run-id charset and length budget, deterministic, and unique per distinct
 * raw event id (up to a 48-bit-plus hash prefix collision).
 */
export function deriveIngressRunId(eventId: string): string {
  const hash = createHash('sha256').update(eventId, 'utf8').digest('hex').slice(0, HASH_SUFFIX_LENGTH);

  const sanitized = eventId.replace(/[^A-Za-z0-9_-]/g, '-');
  const stemBudget = RUN_ID_MAX_LENGTH - INGRESS_RUN_ID_PREFIX.length - 1 - HASH_SUFFIX_LENGTH;
  const stem = sanitized.slice(0, stemBudget);

  return stem.length > 0
    ? `${INGRESS_RUN_ID_PREFIX}${stem}-${hash}`
    : `${INGRESS_RUN_ID_PREFIX}${hash}`;
}
