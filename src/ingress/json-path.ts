/**
 * The original JSON-path array-projection work — shared '$.'-rooted JSON-path resolver for ingress config surfaces.
 *
 * Used by both the substrate projection (envelope.ts `substrate:` mapping) and
 * event-id derivation (event-id.ts `from: json_path`) so the two user-facing
 * path dialects cannot drift apart.
 *
 * Dialect: dot-separated segments after '$.'. A segment addresses an object
 * key, or — when the current node is an array — a canonical non-negative
 * integer index (`0`, `1`, `12`; no leading zeros, no negatives). Array order
 * comes from the provider's payload, so resolution stays deterministic.
 * Any unresolvable path returns null (never undefined, never throws).
 */

/** Canonical non-negative integer — the only segments accepted as array indices. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Resolves a '$.'-rooted dot-path against a plain object/array tree.
 * Returns null (not undefined, not thrown) for any unresolvable path.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  if (!path.startsWith('$.')) {
    return null;
  }

  const segments = path.slice(2).split('.');
  let current: unknown = root;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) {
        return null;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return null;
      }
      current = current[index];
      continue;
    }
    const node = current as Record<string, unknown>;
    if (!(segment in node)) {
      return null;
    }
    current = node[segment];
  }

  // Normalize undefined leaf values to null for stable key presence.
  return current === undefined ? null : current;
}
