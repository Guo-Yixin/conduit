/**
 * Tests for rejecting image-input names used as text prompt placeholders (WI-416).
 *
 * FR-5 / Edge "prompt references an image name as {{image}}". Images are ATTACHED
 * parts (carried on ModelCall.images, WI-413/WI-414), not substituted strings. A
 * prompt template that references a declared IMAGE input as a `{{placeholder}}`
 * must be rejected with a CLEAR, image-specific error — so an author can never
 * accidentally substitute binary image bytes into the text prompt. Text
 * placeholders and unreferenced image inputs keep working exactly as today.
 *
 * ── Contract this file pins for src/flow/render.ts ─────────────────────────
 *
 * renderPrompt gains an OPTIONAL, additive 5th parameter carrying the declared
 * IMAGE-input names (their declared paths, per WI-414's { path } shape — the
 * executor passes `station.image_inputs.map(i => i.path)`):
 *
 *   export function renderPrompt(
 *     template: string,
 *     inputs: string[],        // declared TEXT input names (substitutable)
 *     projectRoot: string,
 *     feedback?: string,       // WI-379 synthetic input (unchanged)
 *     imageInputs?: string[],  // WI-416 declared IMAGE-input names (NOT substitutable)
 *   ): string
 *
 * Resolution order for a referenced `{{name}}`:
 *   1. name ∈ inputs (text)        → substitute its on-disk contents (as today).
 *   2. name ∈ imageInputs (image)  → THROW a clear error stating an image input
 *                                    cannot be used as a text placeholder
 *                                    (images are attached, not substituted).
 *   3. name ∈ neither              → THROW the existing scope-guard error
 *                                    (UNDECLARED_PROMPT_INPUT — unchanged, AC4).
 *
 * The new parameter is purely additive (arity widens 4 → 5); existing callers
 * and the feedback path are unaffected. The cast below pins the TARGET signature
 * so this file compiles against the current arity-4 export while exercising the
 * REAL renderPrompt — it does not reimplement or mock the subject (same pattern
 * render.test.ts uses for the WI-379 `feedback` parameter).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderPrompt } from './render';

// ---------------------------------------------------------------------------
// Target signature (WI-416). renderPrompt is widened with an optional 5th
// `imageInputs` parameter. Casting to the target type keeps this file
// type-checking against the current arity-4 export while the real function is
// still the subject under test.
// ---------------------------------------------------------------------------
const renderWithImages = renderPrompt as (
  template: string,
  inputs: string[],
  projectRoot: string,
  feedback?: string,
  imageInputs?: string[],
) => string;

// ---------------------------------------------------------------------------
// Fixtures: throwaway project roots on real disk (mirrors render.test.ts).
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a throwaway project root containing the given text artifact files
 * (name → contents). Any name NOT listed is genuinely absent on disk — used to
 * prove that image inputs are never read as text artifacts.
 */
function makeProjectRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-img-placeholder-'));
  createdDirs.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents, 'utf-8');
  }
  return root;
}

/** Capture the message of the error thrown by `fn`, or '' if it did not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

// ===========================================================================
// AC1 — a template referencing a declared IMAGE input as a {{placeholder}} is
//        rejected with a clear image-specific error (attached, not substituted).
// ===========================================================================

describe('renderPrompt — rejects a declared image input used as a text placeholder (AC1)', () => {
  it('throws a clear, image-specific error naming the placeholder', () => {
    // keyframe.png is a declared IMAGE input (not a text input). Referencing it as
    // {{keyframe.png}} must be rejected — images are attached parts, not text.
    const root = makeProjectRoot({});
    const render = () => renderWithImages('Describe {{keyframe.png}} in detail', [], root, undefined, ['keyframe.png']);

    expect(render).toThrow();
    const message = thrownMessage(render);
    // Names the offending placeholder...
    expect(message).toContain('keyframe.png');
    // ...and identifies it as an IMAGE input (distinguishes this from the generic
    // "undeclared input" scope-guard error in AC4).
    expect(message).toMatch(/image/i);
  });

  it('rejects even when the image input is referenced alongside a valid text input (AC1 × AC2)', () => {
    // A template mixing a substitutable text input and an image placeholder must
    // still be rejected for the image reference.
    const root = makeProjectRoot({ 'brief.txt': 'BRIEF_BODY' });
    const render = () =>
      renderWithImages('{{brief.txt}} then {{keyframe.png}}', ['brief.txt'], root, undefined, ['keyframe.png']);

    expect(render).toThrow();
    const message = thrownMessage(render);
    expect(message).toContain('keyframe.png');
    expect(message).toMatch(/image/i);
  });

  it('does not read the image file off disk when rejecting (no byte substitution attempted)', () => {
    // There is no file named keyframe.png on disk. If renderPrompt tried to read
    // the image as a text artifact, it would surface a "could not be read" message.
    // The image-specific rejection must fire first — proving no read is attempted.
    const root = makeProjectRoot({});
    const message = thrownMessage(() =>
      renderWithImages('{{keyframe.png}}', [], root, undefined, ['keyframe.png']),
    );
    expect(message).toMatch(/image/i);
    expect(message).not.toMatch(/could not be read/i);
  });
});

// ===========================================================================
// AC2 — a declared TEXT input placeholder substitutes exactly as today (no
//        regression to the renderPrompt scope guard or substitution).
// ===========================================================================

describe('renderPrompt — text placeholders substitute as today (AC2)', () => {
  it('substitutes a declared text input even when image inputs are also declared', () => {
    const root = makeProjectRoot({ 'brief.txt': 'BRIEF_BODY' });

    const result = renderWithImages('Use: {{brief.txt}}', ['brief.txt'], root, undefined, ['keyframe.png']);

    expect(result).toBe('Use: BRIEF_BODY');
  });

  it('is backward-compatible: omitting imageInputs renders text placeholders as before', () => {
    // The new parameter is purely additive — arity-4 calls behave exactly as today.
    const root = makeProjectRoot({ 'brief.txt': 'BRIEF_BODY' });

    expect(renderWithImages('{{brief.txt}}', ['brief.txt'], root)).toBe('BRIEF_BODY');
  });
});

// ===========================================================================
// AC3 — declared image inputs that are NOT referenced as placeholders pass, and
//        renderPrompt reads only the declared text inputs (images never read).
// ===========================================================================

describe('renderPrompt — unreferenced image inputs are never read as text (AC3)', () => {
  it('renders text-only and never reads an unreferenced image input from disk', () => {
    // keyframe.png is declared as an image input but NOT referenced in the template,
    // and NO file named keyframe.png exists on disk. If renderPrompt eagerly read
    // declared image inputs as text, it would throw a missing-artifact error.
    const root = makeProjectRoot({ 'brief.txt': 'BRIEF_BODY' });

    const result = renderWithImages('Only text: {{brief.txt}}', ['brief.txt'], root, undefined, ['keyframe.png']);

    expect(result).toBe('Only text: BRIEF_BODY');
  });

  it('renders verbatim when there are no placeholders, reading nothing (image inputs declared)', () => {
    const root = makeProjectRoot({});

    const result = renderWithImages('No placeholders at all.', [], root, undefined, ['keyframe.png']);

    expect(result).toBe('No placeholders at all.');
  });
});

// ===========================================================================
// AC4 — the existing UNDECLARED_PROMPT_INPUT scope guard is unchanged: a name
//        that is neither a text input nor an image input still throws the
//        generic "undeclared" error (NOT the image-specific one).
// ===========================================================================

describe('renderPrompt — undeclared placeholders still rejected by the scope guard (AC4)', () => {
  it('throws naming the undeclared artifact, with the generic (non-image) message', () => {
    // rogue.json is neither a declared text input nor a declared image input.
    const root = makeProjectRoot({});
    const render = () => renderWithImages('{{rogue.json}}', [], root, undefined, ['keyframe.png']);

    expect(render).toThrow();
    const message = thrownMessage(render);
    // Names the undeclared artifact...
    expect(message).toContain('rogue.json');
    // ...and is the existing scope-guard error, NOT relabelled as an image error.
    expect(message).not.toMatch(/image/i);
  });

  it('keeps throwing for an undeclared name even when no image inputs are declared (guard unchanged)', () => {
    const root = makeProjectRoot({});

    expect(() => renderWithImages('{{rogue.json}}', [], root)).toThrow(/rogue\.json/);
  });
});
