/**
 * Tests for the declared-output-schema validator builder (WI-353).
 *
 * FR-4 — a transform/agentic station declares its output shape in config
 * (output_schema.fields = [{name, type, required}], parsed by WI-351). This
 * builder turns that declared shape into an OutputSchema<T> matching the
 * transform worker's validate() contract (src/worker/transform.ts), so a
 * station validates REAL model output against the config-declared shape. The
 * executor (WI-356) calls buildOutputSchema and passes the result as
 * TransformContext.schema.
 *
 * Contract this file pins for src/flow/schema.ts:
 *
 *   import type { StationOutputField } from '../types/kernel';   // {name,type,required}
 *   import type { OutputSchema } from '../worker/transform';
 *
 *   export function buildOutputSchema(
 *     fields: StationOutputField[],
 *   ): OutputSchema<Record<string, unknown>>
 *
 * where the produced schema's
 *   validate(value: unknown):
 *     | { ok: true;  value: Record<string, unknown> }   // narrowed, conforming object
 *     | { ok: false; error: string }                    // descriptive, names the offending field
 *
 * Type support: at least 'string', 'number', and 'boolean' (the real ideate
 * station declares string + number; boolean is exercised here so the type
 * dispatch is built to handle it, not bolted on later).
 */
import { describe, it, expect } from 'bun:test';
import type { StationOutputField } from '../types/kernel';
import { buildOutputSchema } from './schema';

// ---------------------------------------------------------------------------
// Discriminated-union narrowing helpers (fail the test on the wrong branch,
// with detail — no silent fallbacks).
// ---------------------------------------------------------------------------

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error}`);
  }
  return result.value;
}

function expectErr<T>(result: { ok: true; value: T } | { ok: false; error: string }): string {
  if (result.ok) {
    throw new Error(`expected validation error, but validate succeeded: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

// ---------------------------------------------------------------------------
// Fixtures — the real ideate station's declared schema, plus a mixed schema
// that adds a boolean field and an optional field.
// ---------------------------------------------------------------------------

/** The real example ideate station's declared output schema (string + number). */
const ideateFields: StationOutputField[] = [
  { name: 'filming_idea', type: 'string', required: true },
  { name: 'hook_type', type: 'string', required: true },
  { name: 'confidence_score', type: 'number', required: true },
];

/** Adds a required boolean field and an OPTIONAL string field. */
const mixedFields: StationOutputField[] = [
  { name: 'filming_idea', type: 'string', required: true },
  { name: 'confidence_score', type: 'number', required: true },
  { name: 'is_featured', type: 'boolean', required: true },
  { name: 'note', type: 'string', required: false },
];

// ---------------------------------------------------------------------------
// AC1 — a conforming object validates ok:true with the narrowed value carrying
//        all declared fields.
// ---------------------------------------------------------------------------

describe('buildOutputSchema — accepts a conforming object (AC1)', () => {
  it('validates the real 3-field ideate output and narrows all three fields', () => {
    const schema = buildOutputSchema(ideateFields);

    const value = expectOk(
      schema.validate({ filming_idea: 'x', hook_type: 'unboxing', confidence_score: 0.8 }),
    );

    expect(value).toEqual({ filming_idea: 'x', hook_type: 'unboxing', confidence_score: 0.8 });
  });
});

// ---------------------------------------------------------------------------
// AC2 — a missing required field is rejected with a descriptive error that
//        NAMES the missing field (and names the SPECIFIC one, not always the
//        first).
// ---------------------------------------------------------------------------

describe('buildOutputSchema — rejects a missing required field, naming it (AC2)', () => {
  it('returns ok:false naming confidence_score when it is absent', () => {
    const schema = buildOutputSchema(ideateFields);

    const error = expectErr(schema.validate({ filming_idea: 'x', hook_type: 'unboxing' }));

    expect(error).toContain('confidence_score');
  });

  it('names the SPECIFIC missing field (filming_idea), not a fixed/first one', () => {
    const schema = buildOutputSchema(ideateFields);

    const error = expectErr(schema.validate({ hook_type: 'unboxing', confidence_score: 0.5 }));

    expect(error).toContain('filming_idea');
  });
});

// ---------------------------------------------------------------------------
// AC3 — a field whose runtime type does not match its declared type is
//        rejected, for each supported type (string, number, boolean).
// ---------------------------------------------------------------------------

describe('buildOutputSchema — rejects wrong runtime types (AC3)', () => {
  it.each([
    ['a number field given a string', { filming_idea: 'x', hook_type: 'unboxing', confidence_score: 'high' }, 'confidence_score'],
    ['a string field given a number', { filming_idea: 123, hook_type: 'unboxing', confidence_score: 0.8 }, 'filming_idea'],
  ])('rejects %s, naming the offending field', (_label, input, offendingField) => {
    const schema = buildOutputSchema(ideateFields);

    const error = expectErr(schema.validate(input));

    expect(error).toContain(offendingField);
  });

  it('rejects a boolean field given a non-boolean, naming it', () => {
    const schema = buildOutputSchema(mixedFields);

    const error = expectErr(
      schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: 'yes' }),
    );

    expect(error).toContain('is_featured');
  });
});

// ---------------------------------------------------------------------------
// Type acceptance — each supported type accepts its own valid value, including
// falsy-but-valid values (false, 0, "") which a naive truthiness presence
// check would wrongly treat as "missing".
// ---------------------------------------------------------------------------

describe('buildOutputSchema — accepts each declared type, including falsy-valid values', () => {
  it('accepts a valid boolean field for both true and false', () => {
    const schema = buildOutputSchema(mixedFields);

    expect(
      expectOk(schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: true })),
    ).toEqual({ filming_idea: 'x', confidence_score: 0.8, is_featured: true });

    expect(
      expectOk(schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: false })),
    ).toEqual({ filming_idea: 'x', confidence_score: 0.8, is_featured: false });
  });

  it('treats falsy-but-valid values (false, 0, "") as PRESENT for required fields', () => {
    const fields: StationOutputField[] = [
      { name: 'flag', type: 'boolean', required: true },
      { name: 'score', type: 'number', required: true },
      { name: 'label', type: 'string', required: true },
    ];
    const schema = buildOutputSchema(fields);

    const value = expectOk(schema.validate({ flag: false, score: 0, label: '' }));

    expect(value).toEqual({ flag: false, score: 0, label: '' });
  });
});

// ---------------------------------------------------------------------------
// AC4 — a non-object input (null, array, primitive, undefined) is rejected.
// ---------------------------------------------------------------------------

describe('buildOutputSchema — rejects non-object input (AC4)', () => {
  it.each([
    ['null', null],
    ['an array', ['filming_idea', 'hook_type']],
    ['a string primitive', 'filming_idea'],
    ['a number primitive', 42],
    ['a boolean primitive', true],
    ['undefined', undefined],
  ])('returns ok:false for %s', (_label, input) => {
    const schema = buildOutputSchema(ideateFields);

    const error = expectErr(schema.validate(input));

    // expectErr already pinned ok:false; the error must carry a real message.
    expect(typeof error).toBe('string');
    expect(error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — optional fields (required:false) may be absent and still validate
//        ok:true; when PRESENT they are still type-checked against the shape.
// ---------------------------------------------------------------------------

describe('buildOutputSchema — optional field enforcement (AC5)', () => {
  it('validates ok:true when an optional field is absent', () => {
    const schema = buildOutputSchema(mixedFields); // `note` is optional

    const value = expectOk(
      schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: true }),
    );

    expect(value).toEqual({ filming_idea: 'x', confidence_score: 0.8, is_featured: true });
  });

  it('validates ok:true when an optional field is present with the correct type', () => {
    const schema = buildOutputSchema(mixedFields);

    const value = expectOk(
      schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: true, note: 'extra' }),
    );

    expect(value.note).toBe('extra');
  });

  it('rejects an optional field that is PRESENT but the wrong type', () => {
    const schema = buildOutputSchema(mixedFields);

    const error = expectErr(
      schema.validate({ filming_idea: 'x', confidence_score: 0.8, is_featured: true, note: 999 }),
    );

    expect(error).toContain('note');
  });
});
