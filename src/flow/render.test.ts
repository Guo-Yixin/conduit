/**
 * Tests for the prompt-template renderer (WI-352).
 *
 * FR-4a — a versioned prompt template is assembled at runtime by substituting
 * each `{{<artifact>}}` placeholder with the on-disk contents of that artifact,
 * read from the project root. This is the exact string handed to the model
 * adapter as `ModelCall.prompt` (src/worker/adapter.ts). The loader (WI-351)
 * validates that templates only reference DECLARED inputs; this module performs
 * the runtime substitution and fails loudly on anything it cannot resolve.
 *
 * Contract this file pins for src/flow/render.ts:
 *
 *   export function renderPrompt(
 *     template: string,    // the raw prompt template, with {{name}} placeholders
 *     inputs: string[],    // declared input artifacts in scope, e.g. ['context.json','idea.json']
 *     projectRoot: string, // absolute dir the declared artifacts are read from
 *   ): string
 *
 * Behaviour:
 *   1. Each `{{<name>}}` where <name> ∈ inputs is replaced by the contents of
 *      join(projectRoot, name) — at EVERY occurrence.
 *   2. A template with no placeholders renders verbatim (and reads nothing).
 *   3. A placeholder whose <name> is NOT in `inputs` (out of scope) throws a
 *      clear error naming the artifact — it is never silently substituted nor
 *      left dangling in the output (FR-4a scope guard).
 *   4. A declared, referenced artifact whose file is missing on disk throws a
 *      clear error naming the artifact — NOT a raw ENOENT.
 *
 * renderPrompt is a pure function of (template, inputs, projectRoot): it reads
 * declared artifact files only and must not read process.env or other globals.
 *
 * The real dogfood prompts that motivate this (examples/tiktok-shoppable-ideas):
 *   - prompts/ideate.md renders against {{context.json}} (single input)
 *   - prompts/verify.md (the gate) renders against {{idea.json}} + {{context.json}}
 *     simultaneously — multi-input is required, not optional.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderPrompt } from './render';

// ---------------------------------------------------------------------------
// Fixtures: throwaway project roots on real disk (matches load.test.ts style).
// Reading from a real projectRoot is the highest-fidelity way to exercise both
// the happy path ("read from the project root") and the missing-file path
// ("file missing on disk"). All temp dirs are torn down after each test.
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a throwaway project root containing the given artifact files
 * (name → contents). Returns the absolute root path. Any artifact NOT listed
 * is genuinely absent on disk — used to exercise the missing-file error path.
 */
function makeProjectRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'conduit-render-'));
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

// ---------------------------------------------------------------------------
// AC1 — a single declared input placeholder is replaced with its file contents
//        read from the project root.
// ---------------------------------------------------------------------------

describe('renderPrompt — single declared input (AC1)', () => {
  it('replaces a {{context.json}} placeholder with the file contents read from the project root', () => {
    const contextContents = '{"product_id":"P-123","display_name":"Nebula"}';
    const root = makeProjectRoot({ 'context.json': contextContents });

    const template = 'Use this data:\n{{context.json}}\nEnd of data.';
    const result = renderPrompt(template, ['context.json'], root);

    expect(result).toBe(`Use this data:\n${contextContents}\nEnd of data.`);
  });

  it('substitutes the artifact contents verbatim, including newlines and braces', () => {
    // Artifact contents are inserted as-is — no escaping, trimming, or re-parsing.
    const contextContents = '{\n  "nested": { "k": "v" },\n  "list": [1, 2, 3]\n}';
    const root = makeProjectRoot({ 'context.json': contextContents });

    const result = renderPrompt('<<{{context.json}}>>', ['context.json'], root);

    expect(result).toBe(`<<${contextContents}>>`);
  });
});

// ---------------------------------------------------------------------------
// AC2 — two or more declared inputs render simultaneously, each placeholder
//        resolving to its OWN artifact's contents (the gate prompt case).
// ---------------------------------------------------------------------------

describe('renderPrompt — multiple declared inputs in scope simultaneously (AC2)', () => {
  it('resolves both {{idea.json}} and {{context.json}} to their own contents in one render', () => {
    const ideaContents = '{"featured_variant":"Sunset Fade","filming_idea":"open on the gap"}';
    const contextContents = '{"product_id":"P-9","sales":{"best_colorways":[]}}';
    const root = makeProjectRoot({
      'idea.json': ideaContents,
      'context.json': contextContents,
    });

    const template = '## The idea\n{{idea.json}}\n\n## The data\n{{context.json}}\n';
    const result = renderPrompt(template, ['idea.json', 'context.json'], root);

    expect(result).toBe(`## The idea\n${ideaContents}\n\n## The data\n${contextContents}\n`);
  });

  it('binds each placeholder to its OWN artifact (no cross-contamination, by name not position)', () => {
    // Template references context BEFORE idea, while idea is declared FIRST.
    // A correct renderer keys by placeholder name, not by declaration order.
    const root = makeProjectRoot({
      'idea.json': 'IDEA_PAYLOAD',
      'context.json': 'CONTEXT_PAYLOAD',
    });

    const result = renderPrompt('[{{context.json}}][{{idea.json}}]', ['idea.json', 'context.json'], root);

    expect(result).toBe('[CONTEXT_PAYLOAD][IDEA_PAYLOAD]');
  });
});

// ---------------------------------------------------------------------------
// AC4 — a placeholder appearing more than once is substituted at EVERY
//        occurrence (and AC4 × AC2: every occurrence across multiple inputs).
// ---------------------------------------------------------------------------

describe('renderPrompt — repeated placeholder substituted at every occurrence (AC4)', () => {
  it('substitutes a single repeated placeholder at every occurrence', () => {
    const root = makeProjectRoot({ 'context.json': 'CTX' });

    const result = renderPrompt('{{context.json}} ... {{context.json}} ... {{context.json}}', ['context.json'], root);

    expect(result).toBe('CTX ... CTX ... CTX');
  });

  it('substitutes every occurrence across multiple interleaved inputs (AC4 × AC2)', () => {
    const root = makeProjectRoot({ 'context.json': 'CTX', 'idea.json': 'IDEA' });

    const result = renderPrompt('{{context.json}}|{{idea.json}}|{{context.json}}', ['context.json', 'idea.json'], root);

    expect(result).toBe('CTX|IDEA|CTX');
  });
});

// ---------------------------------------------------------------------------
// AC5 — a template with no placeholders renders unchanged (verbatim) and
//        reads nothing (so an unreferenced declared input need not exist).
// ---------------------------------------------------------------------------

describe('renderPrompt — no placeholders renders verbatim (AC5)', () => {
  it('returns the template unchanged when it contains no placeholders', () => {
    const root = makeProjectRoot({ 'context.json': 'CTX' });

    const template = 'A plain prompt with no artifact references at all.\nSecond line stays put.';
    const result = renderPrompt(template, ['context.json'], root);

    expect(result).toBe(template);
  });

  it('does not require a declared artifact to exist on disk when it is never referenced', () => {
    // Empty project root: context.json is declared but absent. With no
    // placeholder referencing it, the render must still pass through verbatim
    // (reads are driven by placeholders, not eagerly over all declared inputs).
    const root = makeProjectRoot({});

    const result = renderPrompt('No refs here, nothing to read.', ['context.json'], root);

    expect(result).toBe('No refs here, nothing to read.');
  });
});

// ---------------------------------------------------------------------------
// AC3 — a referenced declared artifact missing on disk throws a clear error
//        NAMING the artifact, NOT a raw ENOENT.
// ---------------------------------------------------------------------------

describe('renderPrompt — referenced artifact missing on disk throws a clear error (AC3)', () => {
  it('throws an error that names the missing artifact', () => {
    const root = makeProjectRoot({}); // context.json is declared but not written

    expect(() => renderPrompt('Data: {{context.json}}', ['context.json'], root)).toThrow(/context\.json/);
  });

  it('surfaces a human-actionable message, not a raw ENOENT', () => {
    const root = makeProjectRoot({});
    const render = () => renderPrompt('{{context.json}}', ['context.json'], root);

    // It throws, and the message names the artifact...
    expect(render).toThrow(/context\.json/);
    // ...and does not leak the raw fs error code at the user.
    const message = thrownMessage(render);
    expect(message).not.toMatch(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// FR-4a scope guard — a placeholder referencing an UNDECLARED input (not in
//        scope) is rejected, even if a same-named file happens to exist on
//        disk. renderPrompt may only read declared inputs; an unresolved
//        placeholder is never silently substituted nor left dangling.
// ---------------------------------------------------------------------------

describe('renderPrompt — undeclared input placeholder is rejected (FR-4a)', () => {
  it('throws naming the undeclared artifact when the template references an input not in scope', () => {
    // rogue.json EXISTS on disk but is NOT declared — must not be substituted.
    const root = makeProjectRoot({ 'context.json': 'CTX', 'rogue.json': 'SHOULD_NOT_BE_READ' });

    const render = () => renderPrompt('{{context.json}} {{rogue.json}}', ['context.json'], root);

    expect(render).toThrow(/rogue\.json/);
  });

  it('never leaks an undeclared artifact\'s contents, even when its file exists on disk', () => {
    const root = makeProjectRoot({ 'rogue.json': 'LEAKED_SECRET' });

    const render = () => renderPrompt('{{rogue.json}}', ['context.json'], root);

    expect(render).toThrow();
    // The out-of-scope file's contents must never reach the rendered output
    // nor the error message — it was never a legal input.
    expect(thrownMessage(render)).not.toContain('LEAKED_SECRET');
  });
});

// ===========================================================================
// WI-379 — optional `feedback` input present only on rework.
//
// renderPrompt gains an optional 4th parameter:
//
//   renderPrompt(template, inputs, projectRoot, feedback?): string
//
// `feedback` (a.k.a the gate-findings block) is a SYNTHETIC input: it is
// supplied by the caller (the executor on a back-edge re-entry), NOT read from
// disk. Contract pinned below:
//
//   AC1  A declared {{feedback}} placeholder is substituted with the supplied
//        feedback string when present.
//   AC2  When no feedback is supplied (first entry, undefined), a declared
//        {{feedback}} placeholder renders to '' — no disk read is attempted for
//        it and no error is thrown (FR-5: block absent on first entry).
//   AC3  EVERY occurrence of {{feedback}} is substituted, not just the first.
//   AC4  A {{feedback}} placeholder NOT in the declared inputs is still rejected
//        by the existing scope guard — feedback must be declared to be rendered;
//        supplying the runtime argument does not bypass the guard.
//   AC5  Disk-backed artifact placeholders ({{context.json}} etc.) render
//        exactly as before; the feedback parameter is purely additive.
//
// WI-379 widens renderPrompt's signature (currently arity 3). This typed
// reference pins the TARGET signature so these tests compile against the
// contract B.A. must implement; it remains valid once the real signature is
// widened to include `feedback?: string`. It does NOT reimplement or mock the
// subject — the real renderPrompt is still the function under test.
// ---------------------------------------------------------------------------
const renderWithFeedback = renderPrompt as (
  template: string,
  inputs: string[],
  projectRoot: string,
  feedback?: string,
) => string;

// ---------------------------------------------------------------------------
// AC1 — feedback present: a declared {{feedback}} is replaced by the supplied
//        string (resolved from the runtime argument).
// ---------------------------------------------------------------------------

describe('renderPrompt — feedback present substitutes the supplied string (AC1)', () => {
  it('substitutes a declared {{feedback}} placeholder with the supplied feedback string', () => {
    const root = makeProjectRoot({});
    const result = renderWithFeedback('Gate findings:\n{{feedback}}\nFix and resubmit.', ['feedback'], root, 'AC-2 has no failing test');

    expect(result).toBe('Gate findings:\nAC-2 has no failing test\nFix and resubmit.');
  });

  it('substitutes the feedback string verbatim, including newlines and braces', () => {
    // Feedback is inserted as-is — no escaping, trimming, or re-parsing (same
    // contract as a disk-backed artifact's contents).
    const feedback = 'line1\nline2 with { braces } and "quotes"';
    const root = makeProjectRoot({});

    const result = renderWithFeedback('<<{{feedback}}>>', ['feedback'], root, feedback);

    expect(result).toBe(`<<${feedback}>>`);
  });
});

// ---------------------------------------------------------------------------
// AC2 — feedback absent (first entry): a declared {{feedback}} renders to ''
//        with NO disk read attempted and NO error thrown.
// ---------------------------------------------------------------------------

describe('renderPrompt — feedback absent renders empty without reading disk (AC2)', () => {
  it('renders a declared {{feedback}} placeholder to empty string when no feedback is supplied', () => {
    const root = makeProjectRoot({});

    const result = renderWithFeedback('before[{{feedback}}]after', ['feedback'], root);

    expect(result).toBe('before[]after');
  });

  it('treats an explicitly-undefined feedback the same as an omitted argument', () => {
    const root = makeProjectRoot({});

    const result = renderWithFeedback('X{{feedback}}Y', ['feedback'], root, undefined);

    expect(result).toBe('XY');
  });

  it('does not throw and attempts no disk read for {{feedback}} when feedback is absent (no feedback file on disk)', () => {
    // No file named 'feedback' exists in root. A normal disk-backed artifact that
    // is declared+referenced but missing would throw the missing-artifact error.
    // Rendering empty without throwing proves feedback is runtime-resolved, not
    // disk-backed (FR-5: block absent on first entry).
    const root = makeProjectRoot({});

    expect(() => renderWithFeedback('{{feedback}}', ['feedback'], root)).not.toThrow();
    expect(renderWithFeedback('{{feedback}}', ['feedback'], root)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Context + AC2 — feedback is resolved from the runtime argument, NEVER from
//        disk. A same-named file on disk must never be read for {{feedback}}.
// ---------------------------------------------------------------------------

describe('renderPrompt — feedback resolved from runtime arg, never from disk (Context)', () => {
  it('uses the runtime feedback argument, not a same-named file that happens to exist on disk', () => {
    // A file literally named 'feedback' exists with decoy contents. The runtime
    // argument must win; the disk file must never be read.
    const root = makeProjectRoot({ feedback: 'DECOY_FROM_DISK' });

    const result = renderWithFeedback('{{feedback}}', ['feedback'], root, 'RUNTIME_VALUE');

    expect(result).toBe('RUNTIME_VALUE');
  });

  it('renders empty (not the on-disk contents) when feedback is absent but a feedback file exists on disk', () => {
    const root = makeProjectRoot({ feedback: 'DECOY_FROM_DISK' });

    const result = renderWithFeedback('{{feedback}}', ['feedback'], root);

    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// AC3 — every occurrence of {{feedback}} is substituted, not just the first
//        (in both the present and absent cases).
// ---------------------------------------------------------------------------

describe('renderPrompt — every {{feedback}} occurrence is substituted (AC3)', () => {
  it('substitutes every occurrence of {{feedback}} when feedback is supplied', () => {
    const root = makeProjectRoot({});

    const result = renderWithFeedback('{{feedback}} / {{feedback}} / {{feedback}}', ['feedback'], root, 'F');

    expect(result).toBe('F / F / F');
  });

  it('renders every occurrence of {{feedback}} as empty when feedback is absent (AC2 × AC3)', () => {
    const root = makeProjectRoot({});

    const result = renderWithFeedback('a{{feedback}}b{{feedback}}c', ['feedback'], root);

    expect(result).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// AC4 — a {{feedback}} placeholder not in the declared inputs is rejected by
//        the existing scope guard. Supplying the runtime argument does NOT
//        bypass the declaration requirement.
// ---------------------------------------------------------------------------

describe('renderPrompt — undeclared {{feedback}} is rejected by the scope guard (AC4)', () => {
  it.each([
    ['feedback absent', undefined],
    ['feedback supplied', 'SUPPLIED'],
  ])('rejects an undeclared {{feedback}} placeholder (%s) — it must be declared to render', (_label, fb) => {
    const root = makeProjectRoot({});

    expect(() => renderWithFeedback('{{feedback}}', [], root, fb as string | undefined)).toThrow(/feedback/);
  });

  it('rejects undeclared {{feedback}} alongside legitimately-declared inputs even when feedback is supplied', () => {
    // Cross-product: a supplied runtime argument must not auto-exempt feedback
    // from declaration. context.json is declared; feedback is not.
    const root = makeProjectRoot({ 'context.json': 'CTX' });

    expect(() => renderWithFeedback('{{context.json}} {{feedback}}', ['context.json'], root, 'SUPPLIED')).toThrow(/feedback/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — the feedback parameter is purely ADDITIVE: disk-backed artifacts render
//        exactly as before, with feedback present or absent, and the existing
//        missing-artifact guard for real disk inputs is unchanged.
// ---------------------------------------------------------------------------

describe('renderPrompt — feedback is additive; disk artifacts unchanged (AC5 regression)', () => {
  it('renders disk artifacts unchanged when a feedback argument is also supplied', () => {
    const root = makeProjectRoot({ 'context.json': 'CTX_DATA', 'idea.json': 'IDEA_DATA' });
    const template = '## data\n{{context.json}}\n## idea\n{{idea.json}}\n## findings\n{{feedback}}\n';

    const result = renderWithFeedback(template, ['context.json', 'idea.json', 'feedback'], root, 'GATE_NOTES');

    expect(result).toBe('## data\nCTX_DATA\n## idea\nIDEA_DATA\n## findings\nGATE_NOTES\n');
  });

  it('renders disk artifacts unchanged when feedback is absent (first-entry rework block empty)', () => {
    const root = makeProjectRoot({ 'context.json': 'CTX_DATA' });

    const result = renderWithFeedback('{{context.json}}::{{feedback}}', ['context.json', 'feedback'], root);

    expect(result).toBe('CTX_DATA::');
  });

  it('still throws for a missing referenced disk artifact even when feedback is supplied (guard not weakened)', () => {
    // The feedback feature must not suppress the existing missing-artifact error
    // path for genuine disk-backed inputs. context.json is declared+referenced
    // but absent on disk.
    const root = makeProjectRoot({});

    expect(() => renderWithFeedback('{{context.json}} {{feedback}}', ['context.json', 'feedback'], root, 'FB')).toThrow(/context\.json/);
  });

  it('keeps the verbatim passthrough: a template with no placeholders is unchanged even when feedback is supplied', () => {
    const root = makeProjectRoot({});
    const template = 'A plain prompt with no artifact references at all.';

    expect(renderWithFeedback(template, ['feedback'], root, 'IGNORED')).toBe(template);
  });
});

// ---------------------------------------------------------------------------
// AC1 × AC5 — feedback is literal CONTENT, not a template. A placeholder-like
//        substring inside the feedback string must be inserted verbatim and
//        never re-substituted (gate findings can legitimately contain '{{...}}').
// ---------------------------------------------------------------------------

describe('renderPrompt — feedback is literal content, not re-rendered (AC1 × AC5)', () => {
  it('inserts a placeholder-like substring in feedback verbatim, without re-substituting it', () => {
    const root = makeProjectRoot({ 'context.json': 'REAL_CONTEXT' });
    const feedback = 'see {{context.json}} for details';

    const result = renderWithFeedback('{{feedback}}', ['feedback', 'context.json'], root, feedback);

    // The literal '{{context.json}}' inside feedback must survive untouched —
    // feedback is data injected in a single pass, not a nested template.
    expect(result).toBe('see {{context.json}} for details');
  });
});
