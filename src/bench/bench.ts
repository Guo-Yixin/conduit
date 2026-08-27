/**
 * Work Bench — single-station fixture runner / Skill Lab (WI-304, SPEC §14, FR-16).
 *
 * Runs ONE station (transform or deterministic) against a fixture input in
 * isolation: no kernel state DB, no tick, no neighbors.  Used by developers to:
 *   - observe a station's typed output on a fixture
 *   - A/B model candidates for a station
 *   - measure a candidate model's parse-miss rate before allowing it on a flow
 *
 * CRITICAL: wraps the REAL transform (WI-296) and deterministic (WI-297) runtimes
 * without divergence.  Any reimplementation would miss the coercive parser, the
 * Law-lite allowlist, and the attempt-cap logic — all of which the AC5 tests prove.
 *
 * The bench self-contains its journal by opening an in-memory ConduitDB on each
 * run so fixture runs touch NO on-disk kernel state.
 */

import { openConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { runTransformStation, type OutputSchema } from '../worker/transform';
import { runDeterministic, type DeterministicResult } from '../worker/deterministic';

// ---------------------------------------------------------------------------
// Transform bench
// ---------------------------------------------------------------------------

export interface TransformBenchSpec<T> {
  model: string;
  prompt: string;
  params?: Record<string, unknown>;
  schema: OutputSchema<T>;
  adapter: ModelAdapter;
  /**
   * Maximum execution attempts before reporting a parse-miss.
   * Defaults to 1 so the miss rate is measured per-fixture-response.
   */
  maxExecutionAttempts?: number;
}

export interface TransformBenchResult<T> {
  ok: boolean;
  /** The schema-validated typed payload on success. */
  output?: T;
  /** The validation or parse error on failure. */
  error?: string;
  attempts: number;
  /** True when all attempts were consumed without a successful parse+validate. */
  parseMiss: boolean;
}

/**
 * Run one transform fixture through the REAL runTransformStation runtime.
 *
 * Self-contains the journal with an in-memory ConduitDB so no kernel state is
 * touched.  On scrap (model-incompatible) the result resolves — it never throws.
 *
 * The bench's purpose is to diagnose WHY a parse missed, so result.error must be
 * the SPECIFIC reason — not a generic default.  The transform runtime only calls
 * schema.validate once the coercive parser succeeds, so two distinct failure
 * modes are surfaced:
 *   - SCHEMA failure   — the response parsed but failed validation → the schema's
 *                        own error message is surfaced.
 *   - PARSE failure    — the coercive parser could not recover any JSON from the
 *                        response (validate was never reached) → a parse-specific
 *                        message is surfaced instead of the schema's.
 * The generic default is only used if neither path is observable.
 */
export async function benchTransform<T>(
  spec: TransformBenchSpec<T>,
): Promise<TransformBenchResult<T>> {
  const maxExecutionAttempts = spec.maxExecutionAttempts ?? 1;

  // Wrap the schema to intercept the last validation error AND to observe whether
  // validate was ever reached. The transform runtime invokes validate ONLY after a
  // successful coercive parse, so "validate never ran on a scrap" ⇒ the coercive
  // parser failed to recover JSON — a distinct, more specific diagnosis.
  let lastValidationError: string | null = null;
  let validateInvoked = false;
  const wrappedSchema: OutputSchema<T> = {
    validate(value) {
      validateInvoked = true;
      const result = spec.schema.validate(value);
      if (!result.ok) lastValidationError = result.error;
      return result;
    },
  };

  // Self-contained in-memory journal — no on-disk state ever touched.
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  try {
    const result = await runTransformStation<T>({
      cardId: 'bench',
      station: 'bench',
      // The bench is a self-contained in-memory harness with no real run — the
      // default namespace is the honest attribution here (the original per-run usage-attribution work).
      runId: DEFAULT_RUN_ID,
      attempt: 0,
      maxExecutionAttempts,
      model: spec.model,
      prompt: spec.prompt,
      params: spec.params ?? {},
      schema: wrappedSchema,
      adapter: spec.adapter,
      db,
    });

    if (result.status === 'complete') {
      return {
        ok: true,
        output: result.output.payload,
        attempts: result.attempts,
        parseMiss: false,
      };
    }

    // Scrapped — model-incompatible (parse or schema exhausted all attempts).
    // Surface the MOST SPECIFIC reason available:
    //   1. schema's own error, if validation ran and rejected the parsed value;
    //   2. a parse-specific message, if the coercive parser never produced a value
    //      to validate (validate was never invoked);
    //   3. the generic default only if neither is observable.
    let error: string;
    if (validateInvoked && lastValidationError !== null) {
      error = lastValidationError;
    } else if (!validateInvoked) {
      error = 'coercive-parse failure: no JSON could be recovered from the model response';
    } else {
      error = 'model-incompatible: parse or schema failure';
    }

    return {
      ok: false,
      error,
      attempts: result.attempts,
      parseMiss: true,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Batch reporting
// ---------------------------------------------------------------------------

export interface BatchReport {
  total: number;
  parseMisses: number;
  parseMissRate: number;
}

/**
 * Run a batch of transform fixture specs and report the candidate model's
 * parse-miss rate.  Each spec is independent; failures resolve (never throw).
 */
export async function benchTransformBatch<T>(
  specs: TransformBenchSpec<T>[],
): Promise<BatchReport> {
  const results = await Promise.all(specs.map((s) => benchTransform(s)));
  const parseMisses = results.filter((r) => r.parseMiss).length;
  const total = specs.length;
  return {
    total,
    parseMisses,
    parseMissRate: total > 0 ? parseMisses / total : 0,
  };
}

// ---------------------------------------------------------------------------
// Deterministic bench
// ---------------------------------------------------------------------------

export interface DeterministicBenchSpec {
  command: string;
  args: string[];
  allowlist: readonly string[];
}

/**
 * Run one deterministic fixture through the REAL runDeterministic runtime.
 *
 * Propagates runDeterministic's throw on Law-lite refusal (non-allowlisted or
 * shell-metacharacter) — the caller sees the rejection, proving the real guard ran.
 */
export async function benchDeterministic(
  spec: DeterministicBenchSpec,
): Promise<DeterministicResult> {
  return runDeterministic(
    { command: spec.command, args: spec.args },
    { allowlist: spec.allowlist },
  );
}
