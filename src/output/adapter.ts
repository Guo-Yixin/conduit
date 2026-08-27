/**
 * Output adapter + asset tagging (WI-303 AC1, SPEC §4 output adapter, SPEC §13 FR-13).
 *
 * FORMAT layer only — transport is handled separately in src/channels/.
 *
 * Takes the fan-in AssembledResult (N child payloads gathered by the assembler)
 * and produces the flow's ReferenceArtifact: one TaggedAsset per child with a
 * STABLE, deterministic id that serves as the non-backfillable attribution key
 * for the Kaizen feedback loop (SPEC §13 F3).
 *
 * The id MUST be stable across re-runs on identical input — it cannot use
 * random values or timestamps.  We derive it as SHA-256(parentCardId:cardId:payload)
 * so it survives every downstream hop without diverging.
 *
 * The payload is serialized with a CANONICAL stable-stringify (object keys sorted
 * recursively at every level) before hashing.  Plain `JSON.stringify` preserves
 * insertion order, so the same payload with reordered keys would otherwise yield a
 * different id — silently fracturing the non-backfillable attribution key.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One assembled child card and its payload. */
export interface AssembledChild {
  cardId: string;
  payload: unknown;
}

/** The full fan-in result from the assembler station. */
export interface AssembledResult {
  parentCardId: string;
  children: AssembledChild[];
}

/** A single output asset, tagged with a stable attribution id. */
export interface TaggedAsset {
  /** Stable, deterministic attribution key (SPEC §13 F3 — non-backfillable). */
  id: string;
  /** The child card that produced this asset. */
  sourceCardId: string;
  payload: unknown;
}

/** The formatted reference artifact: one asset per assembled child. */
export interface ReferenceArtifact {
  parentCardId: string;
  assets: TaggedAsset[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Canonical, deterministic serialization of an arbitrary value.
 *
 * Object keys are sorted recursively at EVERY level so that two semantically
 * identical objects whose keys were inserted in a different order serialize to
 * the exact same string.  Arrays preserve their order (order is meaningful).
 * Primitives delegate to JSON.stringify; `undefined` (and function/symbol
 * values, which JSON omits) serialize to `null` to keep the encoding total.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Primitives, including the `undefined`-as-`null` normalization below via JSON.
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compute a stable, deterministic asset id from the parent, child, and payload.
 *
 * SHA-256 is used so the id is:
 *   - Deterministic: same input → same id across re-runs (SPEC §13 F3), and
 *     INVARIANT to object key insertion order (canonical stable-stringify).
 *   - Unique: different parent/child/payload combinations produce different ids
 *   - Non-guessable: safe to use as a non-backfillable attribution key
 */
function computeAssetId(parentCardId: string, cardId: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${parentCardId}:${cardId}:${stableStringify(payload)}`)
    .digest('hex');
}

/**
 * Format the fan-in result into the reference artifact, tagging each assembled
 * child with its stable attribution id.
 */
export function formatArtifact(result: AssembledResult): ReferenceArtifact {
  const assets: TaggedAsset[] = result.children.map((child) => ({
    id: computeAssetId(result.parentCardId, child.cardId, child.payload),
    sourceCardId: child.cardId,
    payload: child.payload,
  }));

  return {
    parentCardId: result.parentCardId,
    assets,
  };
}
