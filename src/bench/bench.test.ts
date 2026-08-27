/**
 * Tests for the Work Bench — single-station fixture runner / Skill Lab
 * (WI-304, SPEC §14, FR-16).
 *
 * The Bench runs ONE station (transform OR deterministic) against a fixture
 * input in isolation — a Unix filter (input → typed output), with NO kernel
 * state DB and NO tick/dispatch involvement. Crucially it wraps the REAL
 * transform (WI-296) and deterministic (WI-297) runtimes — no divergent
 * test-only logic.
 *
 * Contract this file pins for src/bench/bench.ts:
 *
 *   interface TransformBenchSpec<T> {
 *     model: string; prompt: string; params?: Record<string, unknown>;
 *     schema: OutputSchema<T>;          // the real WI-296 OutputSchema
 *     adapter: ModelAdapter;            // injected candidate model (stub in tests)
 *     maxExecutionAttempts?: number;    // default 1 (deterministic parse-miss measurement)
 *   }
 *   interface TransformBenchResult<T> {
 *     ok: boolean; output?: T; error?: string; attempts: number; parseMiss: boolean;
 *   }
 *   function benchTransform<T>(spec: TransformBenchSpec<T>): Promise<TransformBenchResult<T>>
 *
 *   interface BatchReport { total: number; parseMisses: number; parseMissRate: number }
 *   function benchTransformBatch<T>(specs: TransformBenchSpec<T>[]): Promise<BatchReport>
 *
 *   interface DeterministicBenchSpec { command: string; args: string[]; allowlist: readonly string[] }
 *   function benchDeterministic(spec: DeterministicBenchSpec): Promise<DeterministicResult>
 *
 * The Bench must NOT require the caller to supply a ConduitDB — it self-contains
 * any journal sink (e.g. an in-memory db) so a fixture run touches no kernel state.
 */
import { describe, it, expect } from 'bun:test';
import type { OutputSchema } from '../worker/transform';
import type { ModelAdapter } from '../worker/adapter';
import { benchTransform, benchTransformBatch, benchDeterministic, type TransformBenchSpec } from './bench';

interface Greeting {
  greeting: string;
}

/** A schema that accepts { greeting: string } and rejects everything else. */
const greetingSchema: OutputSchema<Greeting> = {
  validate(value: unknown) {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).greeting === 'string') {
      return { ok: true, value: { greeting: (value as Record<string, unknown>).greeting as string } };
    }
    return { ok: false, error: 'greeting (string) is required' };
  },
};

/** A stub kernel adapter that returns a fixed text response (no network). */
function stubAdapter(text: string): ModelAdapter {
  return {
    call: async () => ({ text, inputTokens: 12, outputTokens: 4, costUsd: 0.001 }),
  };
}

function transformSpec(text: string, overrides: Partial<TransformBenchSpec<Greeting>> = {}): TransformBenchSpec<Greeting> {
  return {
    model: 'candidate-x',
    prompt: 'say hi',
    params: {},
    schema: greetingSchema,
    adapter: stubAdapter(text),
    maxExecutionAttempts: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — transform station vs fixture → coercively-parsed, schema-validated
//        typed output, with no DB / no tick.
// ---------------------------------------------------------------------------

describe('benchTransform — typed output (AC1)', () => {
  it('returns the schema-validated typed payload for a valid response', async () => {
    const result = await benchTransform(transformSpec('{"greeting":"hello"}'));
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ greeting: 'hello' });
    expect(result.parseMiss).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — schema-validation failure surfaced as a Bench failure WITH the error,
//        not a crash.
// ---------------------------------------------------------------------------

describe('benchTransform — schema failure surfaced, not thrown (AC4)', () => {
  it('returns ok:false with the validation error and does not throw', async () => {
    // Parseable JSON, but wrong shape → schema.validate fails on every attempt.
    const result = await benchTransform(transformSpec('{"wrong":true}'));
    expect(result.ok).toBe(false);
    expect(result.parseMiss).toBe(true);
    expect(result.error ?? '').toContain('greeting'); // the schema's own message, surfaced
  });

  it('distinguishes a PARSE failure from the generic default — unparseable input', async () => {
    // The coercive parser cannot recover any JSON, so schema.validate is NEVER
    // reached. The bench must diagnose this as a PARSE miss, not the generic
    // 'model-incompatible: parse or schema failure' default — that default would
    // defeat the bench's "explain WHY the parse missed" purpose (explain-renderer work).
    const result = await benchTransform(transformSpec('not even json at all'));
    expect(result.ok).toBe(false);
    expect(result.parseMiss).toBe(true);
    // More specific than the generic default, and points at the parse stage.
    expect(result.error).not.toBe('model-incompatible: parse or schema failure');
    expect(result.error ?? '').toContain('parse');
    // Crucially NOT the schema's own message — validation never ran.
    expect(result.error ?? '').not.toContain('greeting');
  });
});

// ---------------------------------------------------------------------------
// AC5 — the Bench uses the REAL runtime code paths (behavioral proof).
//        A markdown-fenced response is only parsed by the real transform
//        coercive parser; a non-allowlisted command is only refused by the
//        real deterministic Law-lite. A divergent reimplementation would have
//        to copy both — which is exactly what AC5 forbids.
// ---------------------------------------------------------------------------

describe('benchTransform — real coercive parser (AC5)', () => {
  it('extracts JSON from a markdown-fenced response via the real transform runtime', async () => {
    const fenced = '```json\n{"greeting":"fenced"}\n```';
    const result = await benchTransform(transformSpec(fenced));
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ greeting: 'fenced' });
  });
});

// ---------------------------------------------------------------------------
// AC2 — deterministic station vs fixture → spawn allowlisted command,
//        return stdout + exit code.
// ---------------------------------------------------------------------------

describe('benchDeterministic — execution (AC2)', () => {
  it('spawns the allowlisted command and returns stdout + exit code', async () => {
    const result = await benchDeterministic({ command: 'bun', args: ['--version'], allowlist: ['bun'] });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('benchDeterministic — real Law-lite (AC5)', () => {
  it('refuses a non-allowlisted command through the real deterministic runtime', async () => {
    // Only the real runDeterministic Law-lite would refuse this before spawning.
    await expect(
      benchDeterministic({ command: 'rm', args: ['-rf', '/'], allowlist: ['bun'] }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3 — parse-miss rate across a fixture batch.
// ---------------------------------------------------------------------------

describe('benchTransformBatch — parse-miss rate (AC3)', () => {
  it('reports the candidate model parse-miss rate over a batch', async () => {
    const specs: TransformBenchSpec<Greeting>[] = [
      transformSpec('{"greeting":"a"}'), // hit
      transformSpec('{"greeting":"b"}'), // hit
      transformSpec('{"greeting":"c"}'), // hit
      transformSpec('not even json at all'), // miss (unparseable → scrap at maxAttempts=1)
    ];

    const report = await benchTransformBatch(specs);

    expect(report.total).toBe(4);
    expect(report.parseMisses).toBe(1);
    expect(report.parseMissRate).toBeCloseTo(0.25);
  });
});
