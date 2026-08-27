/**
 * Tests for image-input declaration parsing + validation in the flow loader (WI-414).
 *
 * Implements FR-1 / Principle 10 — "config is validated, not trusted." A
 * transform/gate station may declare a BOUNDED list of image inputs as
 * statically-declared file paths, parsed onto StationConfig as a field distinct
 * from the existing text `inputs: string[]`. This item is config parse/validate
 * ONLY — carrying images to the adapter is WI-419, and vision capability is a
 * call-time concern (WI-421), explicitly NOT checked here (Resolved Q1).
 *
 * ── Contract this file pins for src/flow/load.ts + src/types/kernel.ts ──
 *
 * 1. RawStation (src/flow/load.ts) gains an optional `image_inputs` field; the
 *    YAML key is `image_inputs`, a list of OBJECTS (NOT bare strings) each
 *    carrying at least a `path`. The objects are extensible (a future
 *    `detail`/resolution hint is additive — Resolved Q4), so extra keys must
 *    not be rejected.
 *
 * 2. buildStationConfig parses `image_inputs` onto StationConfig as a field
 *    DISTINCT from `inputs: string[]`. Per the work item's Context, follow the
 *    existing optional-field pattern (next, prompt_file, output_schema): the
 *    field is ABSENT (undefined) when no image inputs are declared — never an
 *    empty array — so a text-only station is byte-for-byte unchanged (NFR-1).
 *    Add the parsed field + an image-input shape ({ path: string } extensible)
 *    to src/types/kernel.ts as OPTIONAL on StationConfig.
 *
 * 3. The declared `path` is stored VERBATIM (as-declared, relative). Path
 *    resolution is deferred to WI-419 / loadImageInput(projectRoot, declaredPath)
 *    — the loader must NOT join it to an absolute path the way prompt_file is.
 *
 * 4. src/flow/load.ts MUST export `MAX_IMAGE_INPUTS_PER_CALL` (a positive
 *    integer) — the single configured per-call image-input limit. The load-time
 *    bounded-list count check (AC3) and the WI-420 call-time payload guard share
 *    this one constant ("same configured count"). Declaring more than the limit
 *    is rejected at load with a clear error naming the station AND the limit.
 *
 * 5. An image input whose `path` equals a declared text input NAME is rejected
 *    at load (the two input kinds must stay distinct — Solution Approach).
 *
 * These tests exercise the REAL loadFlow() against inline flow.yaml documents.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig, StationConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';
import * as loadModule from './load';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/**
 * Write `yaml` to a throwaway temp file and load it through the REAL loader.
 * Mirrors the helper in load.test.ts so these tests stay self-contained.
 */
function loadInline(yaml: string): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-img-flow-'));
  const path = join(dir, 'flow.yaml');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml, 'utf-8');
    return loadFlow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Narrow to the success branch, failing the test (with detail) otherwise. */
function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

/** Narrow to the failure branch, failing the test otherwise. */
function expectErrors(result: LoadFlowResult): { code: string; message: string }[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors;
}

/** All error messages joined — used to assert an error "names" a given entity. */
function errorText(result: LoadFlowResult): string {
  return expectErrors(result)
    .map((e) => e.message)
    .join(' | ');
}

/** Fetch a station by id from a loaded flow, failing clearly if absent. */
function station(flow: FlowConfig, id: string): StationConfig {
  const s = flow.stations[id];
  if (s === undefined) {
    throw new Error(`station '${id}' missing from loaded flow (have: ${Object.keys(flow.stations).join(', ')})`);
  }
  return s;
}

/**
 * The parsed image-input shape, read structurally so this test file type-checks
 * before B.A. adds the field to StationConfig (the field is optional, and the
 * shape is extensible — at minimum a `path`).
 */
interface ParsedImageInput {
  path: string;
  [extra: string]: unknown;
}

/** Read the parsed image-input list off a StationConfig (undefined when absent). */
function imageInputsOf(s: StationConfig): ParsedImageInput[] | undefined {
  return (s as { image_inputs?: ParsedImageInput[] }).image_inputs;
}

/**
 * The single per-call image-input limit the loader must export. Read structurally
 * so this file type-checks before the export exists; `requireLimit()` turns an
 * absent/invalid export into a crisp RED for B.A.
 */
const PER_CALL_IMAGE_LIMIT: unknown = (
  loadModule as { MAX_IMAGE_INPUTS_PER_CALL?: unknown }
).MAX_IMAGE_INPUTS_PER_CALL;

function requireLimit(): number {
  if (
    typeof PER_CALL_IMAGE_LIMIT !== 'number' ||
    !Number.isInteger(PER_CALL_IMAGE_LIMIT) ||
    PER_CALL_IMAGE_LIMIT < 1
  ) {
    throw new Error(
      'src/flow/load.ts must export MAX_IMAGE_INPUTS_PER_CALL as a positive integer — ' +
        'the single per-call image-input limit shared with the WI-420 payload guard (AC3).',
    );
  }
  return PER_CALL_IMAGE_LIMIT;
}

/** Build a YAML inline list of `n` distinct `{ path }` image-input objects. */
function imageList(n: number): string {
  const items = Array.from({ length: n }, (_, i) => `{ path: img_${i}.png }`).join(', ');
  return `[${items}]`;
}

/** A single-station flow with one extra property line on a `vision-critic` transform. */
function singleStation(extraLine: string): string {
  return `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: vision-critic
    worker: { kind: transform }
    ${extraLine}
`;
}

// ---------------------------------------------------------------------------
// AC1 — image inputs parse onto StationConfig as a list of {path} objects,
//       distinct from the text `inputs` array (NOT a bare string).
// ---------------------------------------------------------------------------

describe('loadFlow — image inputs parse onto StationConfig (AC1)', () => {
  it('parses a list of {path} objects onto a field distinct from text inputs', () => {
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: vision-critic
    worker: { kind: transform }
    inputs: [brief]
    image_inputs: [{ path: keyframe.png }, { path: shot.png }]
`;
    const flow = expectOk(loadInline(yaml));
    const s = station(flow, 'vision-critic');
    expect(imageInputsOf(s)).toEqual([{ path: 'keyframe.png' }, { path: 'shot.png' }]);
    // Distinct surface: the text inputs array is unchanged by the image declaration.
    expect(s.inputs).toEqual(['brief']);
  });

  it('preserves the declared image path verbatim (does NOT resolve to absolute at load)', () => {
    const flow = expectOk(loadInline(singleStation('image_inputs: [{ path: frames/keyframe_001.png }]')));
    // Resolution is deferred to WI-419 / loadImageInput — the loader stores the
    // declared relative path as-is (unlike prompt_file, which IS resolved).
    expect(imageInputsOf(station(flow, 'vision-critic'))).toEqual([{ path: 'frames/keyframe_001.png' }]);
  });

  it('tolerates extra keys on an image-input object (extensible declaration — Resolved Q4)', () => {
    const flow = expectOk(loadInline(singleStation('image_inputs: [{ path: a.png, detail: high }]')));
    const imgs = imageInputsOf(station(flow, 'vision-critic'));
    expect(imgs?.[0]?.path).toBe('a.png');
  });

  it.each([
    ['a bare string', '[logo.png]'],
    ['an object without a path', '[{ detail: high }]'],
    ['a null entry', '[null]'],
    ['a numeric entry', '[5]'],
  ])('rejects %s as an image input (each entry must be an object carrying a path)', (_label, listYaml) => {
    const result = loadInline(singleStation(`image_inputs: ${listYaml}`));
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain('vision-critic');
  });
});

// ---------------------------------------------------------------------------
// AC2 / NFR-1 — a station with no image inputs is byte-for-byte unchanged.
// ---------------------------------------------------------------------------

describe('loadFlow — text-only stations are unaffected (AC2 / NFR-1)', () => {
  it('loads exactly as today: text inputs unchanged and the new field absent', () => {
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: briefer
    worker: { kind: transform }
    inputs: [brief, draft]
`;
    const flow = expectOk(loadInline(yaml));
    const s = station(flow, 'briefer');
    // Existing text inputs array is byte-for-byte unchanged.
    expect(s.inputs).toEqual(['brief', 'draft']);
    // New field is ABSENT (optional-field pattern: next / prompt_file / output_schema),
    // not an empty array.
    expect(imageInputsOf(s)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — bounded list: more image inputs than the configured per-call max count
//       is rejected at load, naming the station and the limit.
// ---------------------------------------------------------------------------

describe('loadFlow — bounded image-input list (AC3)', () => {
  it('exports MAX_IMAGE_INPUTS_PER_CALL as a positive integer (shared with WI-420)', () => {
    expect(typeof PER_CALL_IMAGE_LIMIT).toBe('number');
    expect(Number.isInteger(PER_CALL_IMAGE_LIMIT as number)).toBe(true);
    expect(PER_CALL_IMAGE_LIMIT as number).toBeGreaterThan(0);
  });

  it('rejects a station declaring more image inputs than the limit, naming station and limit', () => {
    const limit = requireLimit();
    const result = loadInline(singleStation(`image_inputs: ${imageList(limit + 1)}`));
    expect(result.ok).toBe(false);
    const text = errorText(result);
    expect(text).toContain('vision-critic'); // names the station
    expect(text).toContain(String(limit)); // names the limit
  });

  it('accepts a station declaring exactly the limit number of image inputs (boundary)', () => {
    const limit = requireLimit();
    expect(loadInline(singleStation(`image_inputs: ${imageList(limit)}`)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — an image path that collides with a declared text input name is rejected;
//       distinct names coexist.
// ---------------------------------------------------------------------------

describe('loadFlow — image path vs text input name collision (AC4)', () => {
  it('rejects an image path equal to a declared text input name, naming the station', () => {
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: vision-critic
    worker: { kind: transform }
    inputs: [keyframe]
    image_inputs: [{ path: keyframe }]
`;
    const result = loadInline(yaml);
    expect(result.ok).toBe(false);
    const text = errorText(result);
    expect(text).toContain('vision-critic'); // names the station
    expect(text).toContain('keyframe'); // names the colliding name
  });

  it('accepts image inputs and text inputs with distinct names', () => {
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: vision-critic
    worker: { kind: transform }
    inputs: [brief]
    image_inputs: [{ path: keyframe.png }]
`;
    expect(loadInline(yaml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5 — vision capability is NOT validated at load (Resolved Q1: call-time).
// ---------------------------------------------------------------------------

describe('loadFlow — capability is not checked at load (AC5)', () => {
  it('loads a station declaring image inputs regardless of the worker model', () => {
    // gpt-3.5-turbo is text-only, but capability is a call-time concern (WI-421);
    // the loader must NOT reject an image declaration on it.
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: vision-critic
    worker: { kind: transform, model: gpt-3.5-turbo }
    image_inputs: [{ path: keyframe.png }]
`;
    expect(loadInline(yaml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rework (WI-414, flagged by Amy, rejectionCount=1) — the `image_inputs` FIELD
// must be a LIST. A non-array value is malformed config and must be rejected
// through the structured-error contract, NEVER crash loadFlow().
//
// AC1's parametrised test covers bad LIST ELEMENTS ([null], [5], ...). This
// covers the distinct shape where the whole FIELD is a non-array value. Amy's
// flag: a scalar `image_inputs: null` slipped past the loader's `=== undefined`
// guard and reached `for (const entry of rawImageInputs)`, throwing a TypeError
// over a non-iterable. collectErrors is NOT wrapped in try/catch, so the throw
// escaped loadFlow's { ok, errors } contract entirely.
//
// The crash class is broader than null — every non-array value hits the same
// `for...of` over a non-iterable: a number, a bare string, a single unlisted
// object, a boolean, and a YAML `image_inputs:` with no value (which parses to
// null too). A null-only patch would leave the siblings crashing (a symmetry
// gap — see test-writing skill, "Coverage Holes from Symmetry"). The fix is one
// uniform Array.isArray guard pushing a structured error (config is validated,
// not trusted — Principle 10).
//
// Contract: image_inputs, when present, MUST be a list; any non-list value
// (scalar null / empty, number, string, single object, boolean) is rejected
// with a clear error naming the station. A station with genuinely no image
// inputs OMITS the key (the AC2/NFR-1 path above) — it does not set it to null.
// ---------------------------------------------------------------------------

describe('loadFlow — a non-list image_inputs field is rejected, never crashed (rework)', () => {
  it.each([
    ['scalar null', 'image_inputs: null'],
    ['an empty value (YAML null)', 'image_inputs:'],
    ['a number', 'image_inputs: 7'],
    ['a bare string (missing the list wrapper)', 'image_inputs: keyframe.png'],
    ['a single mapping object (missing the list wrapper)', 'image_inputs: { path: a.png }'],
    ['a boolean', 'image_inputs: true'],
  ])('rejects image_inputs declared as %s with a structured error, without throwing', (_label, line) => {
    // The bug: a non-array image_inputs reaches the validation loop and throws,
    // escaping loadFlow's { ok: false, errors } contract. The loader must return
    // a structured failure on every input instead of crashing.
    let result: LoadFlowResult | undefined;
    let threw = false;
    try {
      result = loadInline(singleStation(line));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // loadFlow must not crash on malformed config
    expect(result?.ok).toBe(false); // it returns a structured failure instead
    // The structured error names the offending station.
    expect(result ? errorText(result) : '').toContain('vision-critic');
  });
});

// ---------------------------------------------------------------------------
// Code-review fix #2 — image_inputs on a station that cannot consume them is
// rejected at load (fail-closed), not silently dropped at runtime.
//
// Only the transform worker (executeTransformStation) attaches image inputs to
// the model call. A check-only station (no worker), a deterministic station (no
// model call), and an agentic station (image attach not wired) would all load
// "successfully" yet drop the declared images at runtime — a config foot-gun.
// The loader must reject UNSUPPORTED_IMAGE_INPUTS_ON_STATION instead.
// ---------------------------------------------------------------------------

describe('loadFlow — image_inputs on a non-transform station is rejected (fix #2)', () => {
  it('rejects image_inputs on a deterministic station', () => {
    const result = loadInline(singleStation('image_inputs: [{ path: a.png }]')
      .replace('worker: { kind: transform }', 'worker: { kind: deterministic, run: { cmd: ["true"] } }'));
    const codes = expectErrors(result).map((e) => e.code);
    expect(codes).toContain('UNSUPPORTED_IMAGE_INPUTS_ON_STATION');
    expect(errorText(result)).toContain('vision-critic');
  });

  it('rejects image_inputs on a check-only station (no worker block)', () => {
    const yaml = `
flow: imgtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: gate
    check: { class: quality, critic: { prompt_file: x }, on_reject: gate }
    image_inputs: [{ path: a.png }]
`;
    const result = loadInline(yaml);
    const codes = expectErrors(result).map((e) => e.code);
    expect(codes).toContain('UNSUPPORTED_IMAGE_INPUTS_ON_STATION');
  });

  it('does NOT pile on an unsupported-station error when worker.kind is itself invalid', () => {
    // An invalid kind is reported by its own check; the image-input validator
    // must stay silent (resolvedKind === null) rather than emit a confusing
    // second error about image support.
    const result = loadInline(singleStation('image_inputs: [{ path: a.png }]')
      .replace('kind: transform', 'kind: bogus'));
    const codes = expectErrors(result).map((e) => e.code);
    expect(codes).not.toContain('UNSUPPORTED_IMAGE_INPUTS_ON_STATION');
  });

  it('still accepts image_inputs on a transform worker (regression guard)', () => {
    expect(loadInline(singleStation('image_inputs: [{ path: a.png }]')).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Code-review fix #3 — a path listed twice within one station is a config typo:
// it would be loaded, hashed (double binding-stamp contribution), and uploaded
// twice. The loader rejects DUPLICATE_IMAGE_INPUT.
// ---------------------------------------------------------------------------

describe('loadFlow — duplicate image_inputs paths are rejected (fix #3)', () => {
  it('rejects two image inputs with the same path', () => {
    const result = loadInline(singleStation('image_inputs: [{ path: a.png }, { path: a.png }]'));
    const codes = expectErrors(result).map((e) => e.code);
    expect(codes).toContain('DUPLICATE_IMAGE_INPUT');
    expect(errorText(result)).toContain('a.png');
  });

  it('accepts distinct paths that differ only by directory', () => {
    expect(loadInline(singleStation('image_inputs: [{ path: x/a.png }, { path: y/a.png }]')).ok).toBe(true);
  });
});
