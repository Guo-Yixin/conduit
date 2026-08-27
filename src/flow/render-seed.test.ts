/**
 * Per-child seed exposed to child_entry prompt rendering (WI-468, depends on WI-464).
 *
 * WI-464 made commitFanOut write each child its own seed.json inside the child's
 * first owned_paths entry. This item wires that on-disk seed into renderPrompt so a
 * child_entry station's template can reference `{{seed.json}}` and receive THAT
 * child's seed content — turning one parameterized station into a per-product lane
 * instead of N stochastic variants of a shared input.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/flow/render.ts
 * ---------------------------------------------------------------------------
 *
 *   // renderPrompt gains an optional 6th parameter carrying the card's owned
 *   // paths so the reserved synthetic input `seed.json` can be resolved from
 *   //   <firstEntryOf(ownedPaths)>/seed.json
 *   // rather than from projectRoot. This mirrors how `feedback` (render.ts:43,
 *   // FEEDBACK_INPUT) is a reserved synthetic input — except seed is read from
 *   // the CHILD's owned dir on disk, not from a runtime string argument.
 *   //
 *   renderPrompt(
 *     template: string,
 *     inputs: string[],
 *     projectRoot: string,
 *     feedback?: string,
 *     imageInputs?: string[],
 *     ownedPaths?: string[],     // NEW (WI-468) — card scope for {{seed.json}}
 *   ): string
 *
 * Invariants pinned here:
 *   - `{{seed.json}}`, when DECLARED + referenced, resolves to the bytes of
 *     <firstOwnedDir>/seed.json (card-scoped), NOT join(projectRoot,'seed.json').
 *   - Two siblings whose owned dirs hold different seed.json render to different
 *     prompts through the SAME template (per-product, not N variants).
 *   - A station that does NOT reference {{seed.json}} renders exactly as before —
 *     the new ownedPaths param is purely additive (omit/undefined => unchanged).
 *   - The scope guard is honored: an undeclared {{seed.json}} throws the existing
 *     undeclared-input error; a declared+referenced {{seed.json}} that cannot be
 *     resolved (no owned scope, or no seed.json on disk) throws the existing
 *     unreadable-input error — never silently renders empty.
 *
 * The seed lives in the child's owned dir on REAL disk (matches render.test.ts
 * fixture style). owned_paths are resolved as ABSOLUTE temp dirs, matching the
 * integrity hook convention (src/worker/integrity.ts) that owned_paths may be
 * absolute.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderPrompt } from './render';

// ---------------------------------------------------------------------------
// Typed reference pinning the TARGET signature (arity widened to 6). This does
// NOT reimplement or mock the subject — the real renderPrompt is still under
// test; the cast only makes the new optional `ownedPaths` param visible to the
// compiler before B.A. widens the real signature.
// ---------------------------------------------------------------------------
const renderWithSeed = renderPrompt as (
  template: string,
  inputs: string[],
  projectRoot: string,
  feedback?: string,
  imageInputs?: string[],
  ownedPaths?: string[],
) => string;

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway project root (the shared-parent-input source). */
function makeProjectRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-render-seed-root-'));
  createdDirs.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents, 'utf-8');
  }
  return root;
}

/**
 * A throwaway CHILD owned directory. When `seed` is provided, seed.json is
 * written inside it (modeling what commitFanOut materialized in WI-464).
 * Returns the absolute owned-dir path (the child's first owned_paths entry).
 */
function makeChildOwnedDir(seed?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-render-seed-child-'));
  createdDirs.push(dir);
  if (seed !== undefined) {
    writeFileSync(join(dir, 'seed.json'), seed, 'utf-8');
  }
  return dir;
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
// AC1 — a declared+referenced {{seed.json}} renders that child's seed content,
//        read from the CHILD's owned dir (not projectRoot).
// ===========================================================================

describe('renderPrompt — {{seed.json}} resolves to the child owned-dir seed (AC1)', () => {
  it('substitutes {{seed.json}} with the bytes of <firstOwnedDir>/seed.json', () => {
    const seed = '{"product_id":"P-1","display_name":"Nebula"}';
    const ownedDir = makeChildOwnedDir(seed);
    const root = makeProjectRoot();

    const result = renderWithSeed(
      'Build for:\n{{seed.json}}',
      ['seed.json'],
      root,
      undefined,
      undefined,
      [ownedDir],
    );

    expect(result).toBe(`Build for:\n${seed}`);
  });

  it('reads seed.json from the child owned dir, NOT from join(projectRoot, "seed.json")', () => {
    // A decoy seed.json sits at projectRoot. The child-scoped one must win.
    const root = makeProjectRoot({ 'seed.json': 'DECOY_FROM_PROJECT_ROOT' });
    const ownedDir = makeChildOwnedDir('{"real":"child-seed"}');

    const result = renderWithSeed(
      '{{seed.json}}',
      ['seed.json'],
      root,
      undefined,
      undefined,
      [ownedDir],
    );

    expect(result).toBe('{"real":"child-seed"}');
  });

  it('substitutes every occurrence of {{seed.json}}, not just the first', () => {
    const ownedDir = makeChildOwnedDir('S');
    const root = makeProjectRoot();

    const result = renderWithSeed(
      '{{seed.json}} / {{seed.json}} / {{seed.json}}',
      ['seed.json'],
      root,
      undefined,
      undefined,
      [ownedDir],
    );

    expect(result).toBe('S / S / S');
  });

  it('resolves seed.json from the FIRST owned_paths entry when several are declared', () => {
    const firstDir = makeChildOwnedDir('{"from":"first"}');
    const secondDir = makeChildOwnedDir('{"from":"second"}');
    const root = makeProjectRoot();

    const result = renderWithSeed(
      '{{seed.json}}',
      ['seed.json'],
      root,
      undefined,
      undefined,
      [firstDir, secondDir],
    );

    expect(result).toBe('{"from":"first"}');
  });
});

// ===========================================================================
// AC2 — two sibling children with DIFFERENT seeds render to DIFFERENT prompts
//        through the SAME template (per-product, not N variants of one input).
// ===========================================================================

describe('renderPrompt — sibling seeds produce distinct prompts (AC2)', () => {
  it('renders two different prompts from one template when the two children carry different seeds', () => {
    const template = 'Make an ad for: {{seed.json}}';
    const root = makeProjectRoot();

    const childA = makeChildOwnedDir('{"sku":"WIDGET-A"}');
    const childB = makeChildOwnedDir('{"sku":"WIDGET-B"}');

    const promptA = renderWithSeed(template, ['seed.json'], root, undefined, undefined, [childA]);
    const promptB = renderWithSeed(template, ['seed.json'], root, undefined, undefined, [childB]);

    expect(promptA).toBe('Make an ad for: {"sku":"WIDGET-A"}');
    expect(promptB).toBe('Make an ad for: {"sku":"WIDGET-B"}');
    expect(promptA).not.toBe(promptB);
  });

  it('combines the per-child seed with shared parent inputs in one prompt', () => {
    const root = makeProjectRoot({ 'brand.json': '{"brand":"Acme"}' });
    const ownedDir = makeChildOwnedDir('{"sku":"WIDGET-A"}');

    const result = renderWithSeed(
      'Brand {{brand.json}} / Product {{seed.json}}',
      ['brand.json', 'seed.json'],
      root,
      undefined,
      undefined,
      [ownedDir],
    );

    expect(result).toBe('Brand {"brand":"Acme"} / Product {"sku":"WIDGET-A"}');
  });
});

// ===========================================================================
// AC3 — a station that does NOT reference {{seed.json}} renders exactly as
//        before. The new ownedPaths param is purely additive.
// ===========================================================================

describe('renderPrompt — seed-less stations unchanged (AC3)', () => {
  it('renders a non-seed template identically whether or not ownedPaths is supplied', () => {
    const root = makeProjectRoot({ 'context.json': '{"k":"v"}' });
    const ownedDir = makeChildOwnedDir('{"sku":"IGNORED"}');

    const template = 'ctx: {{context.json}}';
    const withScope = renderWithSeed(template, ['context.json'], root, undefined, undefined, [ownedDir]);
    const withoutScope = renderWithSeed(template, ['context.json'], root);

    expect(withScope).toBe('ctx: {"k":"v"}');
    expect(withoutScope).toBe('ctx: {"k":"v"}');
    expect(withScope).toBe(withoutScope);
  });

  it('does not read the child seed.json when the template never references {{seed.json}}', () => {
    // No seed.json exists in the owned dir. A seed-less template must not attempt
    // to read it (placeholder-driven reads), so this must not throw.
    const root = makeProjectRoot({ 'context.json': 'X' });
    const ownedDirNoSeed = makeChildOwnedDir(); // no seed.json written

    expect(() =>
      renderWithSeed('{{context.json}}', ['context.json'], root, undefined, undefined, [ownedDirNoSeed]),
    ).not.toThrow();
  });
});

// ===========================================================================
// AC4 — scope guard honored: undeclared {{seed.json}} throws the existing
//        undeclared-input error; declared+referenced but unresolvable
//        {{seed.json}} throws the existing unreadable-input error (never empty).
// ===========================================================================

describe('renderPrompt — scope guard for {{seed.json}} (AC4)', () => {
  it('rejects an UNDECLARED {{seed.json}} with the existing undeclared-input error', () => {
    const root = makeProjectRoot();
    const ownedDir = makeChildOwnedDir('{"sku":"A"}');

    // 'seed.json' is NOT in the declared inputs list — scope guard must fire even
    // though a seed.json exists in the owned dir.
    const msg = thrownMessage(() =>
      renderWithSeed('{{seed.json}}', [], root, undefined, undefined, [ownedDir]),
    );

    expect(msg).toMatch(/seed\.json/);
    expect(msg).toMatch(/not declared as an input/i);
  });

  it('throws (does not render empty) when {{seed.json}} is declared+referenced but no owned scope is supplied', () => {
    // Declared and referenced, but the caller passed no ownedPaths (a non-fan-out
    // station). seed cannot be resolved — this must surface the unreadable-input
    // error, not silently render ''.
    const root = makeProjectRoot();

    expect(() => renderWithSeed('{{seed.json}}', ['seed.json'], root)).toThrow(/seed\.json/);
  });

  it('throws (does not render empty) when {{seed.json}} is declared but no seed.json exists in the owned dir', () => {
    const root = makeProjectRoot();
    const ownedDirNoSeed = makeChildOwnedDir(); // owned dir exists, but no seed.json

    const render = () =>
      renderWithSeed('{{seed.json}}', ['seed.json'], root, undefined, undefined, [ownedDirNoSeed]);

    expect(render).toThrow(/seed\.json/);
    // And it must NOT have silently rendered empty.
    expect(thrownMessage(render)).not.toBe('');
  });

  it('throws when {{seed.json}} is declared+referenced but ownedPaths is an empty array', () => {
    const root = makeProjectRoot();

    expect(() =>
      renderWithSeed('{{seed.json}}', ['seed.json'], root, undefined, undefined, []),
    ).toThrow(/seed\.json/);
  });
});

// ===========================================================================
// AC5 — backward-compatible arity: existing non-seed callers that omit or pass
//        undefined for the new ownedPaths param render identically.
// ===========================================================================

describe('renderPrompt — additive arity, existing callers unchanged (AC5)', () => {
  it('arity-3 caller (no feedback/images/ownedPaths) renders unchanged', () => {
    const root = makeProjectRoot({ 'context.json': 'hello' });

    expect(renderPrompt('{{context.json}}', ['context.json'], root)).toBe('hello');
  });

  it('explicitly-undefined ownedPaths behaves the same as omitting it', () => {
    const root = makeProjectRoot({ 'context.json': 'hello' });

    const omitted = renderWithSeed('{{context.json}}', ['context.json'], root);
    const explicitUndef = renderWithSeed(
      '{{context.json}}',
      ['context.json'],
      root,
      undefined,
      undefined,
      undefined,
    );

    expect(explicitUndef).toBe(omitted);
    expect(explicitUndef).toBe('hello');
  });

  it('the feedback synthetic input still works alongside the new ownedPaths param', () => {
    // seed (card-scoped, disk) and feedback (runtime string) coexist in one render.
    const root = makeProjectRoot();
    const ownedDir = makeChildOwnedDir('{"sku":"A"}');

    const result = renderWithSeed(
      'seed={{seed.json}} fb={{feedback}}',
      ['seed.json', 'feedback'],
      root,
      'REWORK_NOTE',
      undefined,
      [ownedDir],
    );

    expect(result).toBe('seed={"sku":"A"} fb=REWORK_NOTE');
  });
});

// ===========================================================================
// AC6 (BUG-2, Amy) — overlap guard: a name declared as BOTH a text input AND an
//        image input must throw, even seed.json. The earlier scope-guard loop
//        short-circuits on declaredInputs (text wins), so without an upfront
//        overlap guard a name in both lists would be silently read as text.
//        seed.json is the dangerous case: it would be read from the owned dir
//        and text-substituted, bypassing the image-input rejection entirely.
// ===========================================================================

describe('renderPrompt — seed.json declared as BOTH text and image input throws (AC6 / BUG-2)', () => {
  it('throws when seed.json is in both inputs and imageInputs (does not silently read as text)', () => {
    const ownedDir = makeChildOwnedDir('{"sku":"A"}');
    const root = makeProjectRoot();

    // seed.json is declared as a text input AND an image input. The overlap guard
    // must fire BEFORE the scope-guard loop — otherwise the text path (declaredInputs
    // wins) silently reads <ownedDir>/seed.json and substitutes it, never raising the
    // image-specific error.
    const msg = thrownMessage(() =>
      renderWithSeed(
        'Build for: {{seed.json}}',
        ['seed.json'],
        root,
        undefined,
        ['seed.json'],
        [ownedDir],
      ),
    );

    expect(msg).toMatch(/seed\.json/);
    expect(msg).toMatch(/both/i);
    // It must NOT have silently rendered the seed as text.
    expect(msg).not.toBe('');
  });

  it('fires the overlap guard even when the template never references {{seed.json}}', () => {
    // The overlap is a malformed declaration regardless of placeholder usage:
    // the guard runs before the placeholder scan, so a no-placeholder template
    // with the same name in both lists still throws.
    const root = makeProjectRoot();

    expect(() =>
      renderWithSeed('no placeholders here', ['seed.json'], root, undefined, ['seed.json'], []),
    ).toThrow(/seed\.json/);
  });
});
