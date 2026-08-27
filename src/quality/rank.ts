/**
 * Rank QC check — curate N candidates into a selection, NEVER auto-pick (WI-300,
 * SPEC §6, FR-6a, FR-14, SPEC §4A).
 *
 * A rank check runs a critic to produce an ordered short-list.  It then routes:
 *   - hitlEnabled → await_selection: defer to a human (egress hold); no candidate
 *     is picked by the kernel
 *   - noSelectionPolicy = 'proceed_with_findings' → proceed without a pick
 *   - noSelectionPolicy = 'scrap' → scrap with reason 'no_selection'
 *
 * The RankDecision type deliberately has NO 'selected' or 'auto_pick' variant.
 * This is the structural guarantee that no code path ever silently selects a
 * candidate — selection is always a conscious human or policy decision.
 */

import type { StationOutput } from '../types/kernel';
import { DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { runTransformStation, type OutputSchema } from '../worker/transform';
import { computeFindingsHash } from './gate';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The structured verdict the rank critic must return. */
export interface RankCriticVerdict {
  /** Candidate ids ordered from best to worst by the critic. */
  ranking: string[];
  /** Structured findings explaining the ranking (feeds the rework guard). */
  findings: string[];
}

/** Everything the rank check needs at runtime. */
export interface RankConfig {
  cardId: string;
  station: string;
  /**
   * Run that owns this check — threaded onto the critic's usage span so its
   * token/cost is attributed to the run, not the DEFAULT_RUN_ID sweep (issue
   * per-run usage-attribution work). REQUIRED: a critic call is a billed model call, and an omitted run
   * id is exactly the silent mis-attribution per-run usage-attribution work removes — a compile error
   * beats a wrong journal row.
   */
  runId: string;
  attempt: number;
  maxExecutionAttempts: number;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  adapter: ModelAdapter;
  db: ConduitDB;
  candidateIds: string[];
  /** True when a HITL egress channel (hold lane) is wired for this flow. */
  hitlEnabled: boolean;
  /** Policy applied when no HITL is available. */
  noSelectionPolicy: 'proceed_with_findings' | 'scrap';
}

/**
 * The rank decision — deliberately has NO 'selected' or 'auto_pick' variant.
 * Selection is always deferred (await_selection) or follows an explicit policy.
 */
export type RankDecision =
  | { action: 'await_selection'; shortList: string[]; output: StationOutput<RankCriticVerdict> }
  | { action: 'proceed_with_findings'; shortList: string[]; output: StationOutput<RankCriticVerdict> }
  | { action: 'scrap'; reason: 'no_selection' }
  | { action: 'scrapped'; reason: 'model-incompatible' };

// ---------------------------------------------------------------------------
// Output schema — validates the critic JSON into RankCriticVerdict
// ---------------------------------------------------------------------------

const rankCriticSchema: OutputSchema<RankCriticVerdict> = {
  validate(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected object' };
    }
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.ranking)) {
      return { ok: false, error: 'ranking must be an array' };
    }
    if (!Array.isArray(v.findings)) {
      return { ok: false, error: 'findings must be an array' };
    }
    return {
      ok: true,
      value: {
        ranking: v.ranking as string[],
        findings: v.findings as string[],
      },
    };
  },
};

// ---------------------------------------------------------------------------
// runRankCheck
// ---------------------------------------------------------------------------

/**
 * Run one rank QC check through the injected kernel adapter (pure station).
 *
 * Routing logic (NEVER picks a candidate):
 *   1. scrapped → propagate model-incompatible.
 *   2. complete:
 *      a. shortList = verdict.ranking
 *      b. Rebuild StationOutput with findings_hash(verdict.findings), return_to: null
 *      c. hitlEnabled → await_selection (defer to human)
 *      d. noSelectionPolicy='proceed_with_findings' → proceed_with_findings
 *      e. else → scrap(no_selection)
 */
export async function runRankCheck(config: RankConfig): Promise<RankDecision> {
  const result = await runTransformStation<RankCriticVerdict>({
    cardId: config.cardId,
    station: config.station,
    runId: config.runId,
    attempt: config.attempt,
    maxExecutionAttempts: config.maxExecutionAttempts,
    model: config.model,
    prompt: config.prompt,
    params: config.params,
    schema: rankCriticSchema,
    adapter: config.adapter,
    db: config.db,
  });

  if (result.status === 'scrapped') {
    return { action: 'scrapped', reason: 'model-incompatible' };
  }

  const { payload, usage } = result.output;
  const shortList = payload.ranking;

  const output: StationOutput<RankCriticVerdict> = {
    payload,
    findings_hash: computeFindingsHash(payload.findings),
    return_to: null, // rank never drives a back-edge itself
    usage,
  };

  if (config.hitlEnabled) {
    // Defer to a human via the egress hold lane — never pick.
    return { action: 'await_selection', shortList, output };
  }

  if (config.noSelectionPolicy === 'proceed_with_findings') {
    return { action: 'proceed_with_findings', shortList, output };
  }

  // No HITL, policy = scrap — cannot proceed without a human selection.
  return { action: 'scrap', reason: 'no_selection' };
}

// ---------------------------------------------------------------------------
// decideFromCandidates — flow-computed shortlist, no critic (the original HITL reply-and-resume work FR-1)
// ---------------------------------------------------------------------------

/** Everything the no-critic rank path needs: the flow already ranked. */
export interface CandidatesConfig {
  /** Ordered candidate labels, best first — parsed from `candidates_from`. */
  candidates: string[];
  /** True when a HITL egress channel (hold lane) is wired for this flow. */
  hitlEnabled: boolean;
  /** Policy applied when no HITL is available. */
  noSelectionPolicy: 'proceed_with_findings' | 'scrap';
}

/**
 * Rank decision for FLOW-COMPUTED candidates (the original HITL reply-and-resume work): the shortlist comes
 * from a station artifact (a deterministic merge, an upstream ranking), so no
 * critic model call runs — zero tokens, zero adapter dependency. Routing is
 * IDENTICAL to runRankCheck's post-critic logic, reusing the same RankDecision
 * type so the structural no-auto-pick guarantee holds: there is still no
 * 'selected' variant, and an empty candidate list follows the no-selection
 * policy rather than inventing a pick.
 */
export function decideFromCandidates(config: CandidatesConfig): RankDecision {
  const shortList = config.candidates;

  const output: StationOutput<RankCriticVerdict> = {
    payload: { ranking: shortList, findings: [] },
    // The shortlist IS the findings surface here — hashing it keeps the
    // rework progress guard meaningful if a reworked upstream artifact
    // produces a different board.
    findings_hash: computeFindingsHash(shortList),
    return_to: null, // rank never drives a back-edge itself
    usage: { tokens: 0, cost: 0 }, // no model call — honest accounting
  };

  if (shortList.length === 0) {
    // An empty board cannot be presented or picked from — policy decides,
    // exactly as if a critic had returned nothing rankable.
    return config.noSelectionPolicy === 'proceed_with_findings'
      ? { action: 'proceed_with_findings', shortList, output }
      : { action: 'scrap', reason: 'no_selection' };
  }

  if (config.hitlEnabled) {
    return { action: 'await_selection', shortList, output };
  }

  if (config.noSelectionPolicy === 'proceed_with_findings') {
    return { action: 'proceed_with_findings', shortList, output };
  }

  return { action: 'scrap', reason: 'no_selection' };
}

/**
 * Parse a `candidates_from` artifact into ordered labels (the original HITL reply-and-resume work FR-1).
 *
 * Accepted shapes, matching the issue's contract:
 *   ["Label One", "Label Two", ...]
 *   [{"id": "...", "label": "Label One"}, ...]   (label preferred, id fallback)
 *   {"names": [{"name": "..."}]} is NOT accepted — flows normalize their own
 *   board shape into one of the two above (keep the kernel contract narrow).
 *
 * Returns null (never throws) on anything else — the caller escalates the
 * card to hold with a named reason (fail-closed: never present a garbled
 * board to a human).
 */
/**
 * Upper bound on candidates in a single board (Fix 6). A board larger than this
 * would join into one unwieldy ask message and defeats the point of a curated
 * short-list, so an over-cap artifact is treated as malformed → hold.
 */
const MAX_CANDIDATES = 50;

export function parseCandidatesArtifact(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Over-cap boards are malformed — never present a giant joined ask (Fix 6).
  if (parsed.length > MAX_CANDIDATES) return null;

  const labels: string[] = [];
  // Case-folded seen-set: a duplicate label makes a name reply inherently
  // ambiguous (which "Berry Fizz" did the human mean?), so treat duplicates as
  // malformed → hold rather than silently matching the first (fail-closed).
  // Simple toLowerCase() case folding — no unicode normalization by design.
  const seen = new Set<string>();
  for (const entry of parsed) {
    let label: string;
    if (typeof entry === 'string') {
      if (entry.trim().length === 0) return null;
      label = entry.trim();
    } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const resolved = typeof e.label === 'string' && e.label.trim().length > 0
        ? e.label.trim()
        : typeof e.id === 'string' && e.id.trim().length > 0
          ? e.id.trim()
          : null;
      if (resolved === null) return null;
      label = resolved;
    } else {
      return null;
    }
    const folded = label.toLowerCase();
    if (seen.has(folded)) return null;
    seen.add(folded);
    labels.push(label);
  }
  return labels;
}
