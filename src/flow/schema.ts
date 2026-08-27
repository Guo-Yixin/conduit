/**
 * Output schema validator builder (WI-353).
 *
 * FR-4 — a transform/agentic station declares its output shape in config
 * (`output_schema.fields = [{name, type, required}]`, parsed by WI-351).
 * This module turns that declared shape into an `OutputSchema<T>` matching
 * the transform worker's validate() contract, so a station validates REAL
 * model output against the config-declared shape at runtime.
 *
 * The executor (WI-356) calls `buildOutputSchema` and passes the result as
 * `TransformContext.schema`.
 *
 * Invariants enforced by `validate`:
 *   - Non-object inputs (null, array, primitives, undefined) → ok:false.
 *   - Missing REQUIRED field → ok:false naming the specific absent field.
 *   - Present field with wrong runtime type → ok:false naming the field.
 *   - Absent OPTIONAL field → ok:true (field is simply not in the output).
 *   - Present OPTIONAL field with wrong runtime type → ok:false naming it.
 *   - Presence check uses `in` (not truthiness), so falsy-but-valid values
 *     (false, 0, '') are correctly recognised as present.
 */

import type { StationOutputField } from '../types/kernel';
import type { OutputSchema } from '../worker/transform';

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build an `OutputSchema` from a station's declared `output_schema.fields`.
 *
 * The returned schema's `validate` method accepts an unknown runtime value
 * and returns a discriminated-union result:
 *   - `{ ok: true,  value: Record<string, unknown> }` — all declared fields
 *     are present and type-correct; value is the narrowed object.
 *   - `{ ok: false, error: string }` — descriptive error naming the
 *     offending field (or describing the non-object input).
 *
 * @param fields - Declared output fields from the station's config.
 */
export function buildOutputSchema(
  fields: StationOutputField[],
): OutputSchema<Record<string, unknown>> {
  return { validate: (value) => validateAgainstFields(value, fields) };
}

// ---------------------------------------------------------------------------
// Validation logic (pure, no I/O, no process.env)
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate `value` against the declared field list.
 *
 * Separated from the factory so it is independently unit-testable and keeps
 * the returned closure small.
 */
function validateAgainstFields(value: unknown, fields: StationOutputField[]): ValidationResult {
  // ── AC4: non-object guard ─────────────────────────────────────────────────
  // `typeof null === 'object'` and `typeof [] === 'object'` — both must be
  // explicitly excluded before treating the value as a plain object.
  if (value === null) {
    return { ok: false, error: 'Expected a plain object but received null' };
  }
  if (Array.isArray(value)) {
    return { ok: false, error: 'Expected a plain object but received an array' };
  }
  if (typeof value !== 'object') {
    return {
      ok: false,
      error: `Expected a plain object but received ${typeof value}`,
    };
  }

  const obj = value as Record<string, unknown>;

  // ── AC1 / AC2 / AC3 / AC5: field validation ───────────────────────────────
  for (const field of fields) {
    const isPresent = field.name in obj;

    if (!isPresent) {
      if (field.required) {
        // AC2: required field absent → name it explicitly.
        return {
          ok: false,
          error: `Required field "${field.name}" is missing from the output`,
        };
      }
      // AC5: optional field absent → valid, skip type check.
      continue;
    }

    // Field is present — check its runtime type (handles required AND optional).
    // AC3 / AC5: wrong type → name the offending field.
    const fieldValue = obj[field.name];
    if (typeof fieldValue !== field.type) {
      return {
        ok: false,
        error:
          `Field "${field.name}" has wrong type: expected ${field.type} but got ${typeof fieldValue}`,
      };
    }
  }

  // AC1: all fields pass → return narrowed value.
  return { ok: true, value: obj };
}
