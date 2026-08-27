/**
 * Tests for the SKILL.md bundle parser (WI-552).
 *
 * Implements Skill Ingest PRD §2.3–§2.4 / FR-1 — a Conduit skill IS a Claude
 * Code skill. This parser turns a SKILL.md bundle *directory* into a parsed
 * structure and assembles its injectable instruction content (body, then the
 * bundle's references/ files) with NO Conduit-specific dialect required.
 *
 * Contract this file pins for src/skills/parse.ts:
 *
 *   export function parseSkillBundle(bundleDir: string): ParseSkillResult
 *   export type ParseSkillResult =
 *     | { ok: true;  skill: ParsedSkill }
 *     | { ok: false; error: SkillParseError }
 *   export interface ParsedSkill {
 *     name: string;                 // frontmatter name — used for lookup
 *     description: string;          // catalog metadata — NEVER injected (§2.4)
 *     frontmatter: Record<string, unknown>;  // full map, unknown fields preserved
 *     body: string;                 // markdown body, frontmatter stripped, verbatim
 *     references: ReadonlyArray<{ name: string; content: string }>;  // verbatim
 *     injectedContent: string;      // body, then references/ per §2.3
 *   }
 *   export interface SkillParseError { code: string; message: string; bundle: string }
 *
 * Injection rule (PRD §2.3, eager-concat): injectedContent is the body, then
 * every file under references/ concatenated in lexicographic filename order,
 * each preceded by a standalone delimiter line `--- references/<name> ---`.
 * description is catalog metadata and is deliberately excluded (§2.4).
 *
 * Out of scope for THIS item (covered by other work items — do not test here):
 *   - the 64 KiB skill_content_max_bytes cap (composition item)
 *   - skills_dir resolution / path-safety / symlink-escape (resolver item)
 * So the large-reference-corpus and path-escape fixtures are intentionally
 * not exercised here.
 *
 * Fixture ↔ PRD §4 corpus letter mapping (fixtures authored in WI-551):
 *   (a) minimal-notes        — minimal frontmatter + body, no references/
 *   (b) code-style-guide     — a bundle WITH references/ (01-, 02-)
 *   (c) repo-triage          — scripts/ + allowed-tools (inert-and-preserved)
 *   (e) unicode-style-notes  — unicode / formatting oddities (byte-faithful)
 *   (f) find-skills          — a real published Claude Code skill, vendored verbatim
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillBundle, type ParsedSkill, type ParseSkillResult } from './parse';

const SKILLS_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'skills');

function bundle(name: string): string {
  return join(SKILLS_DIR, name);
}

function raw(...segments: string[]): string {
  return readFileSync(join(SKILLS_DIR, ...segments), 'utf8');
}

/** Parse and narrow to the success payload, failing the test on a parse error. */
function parseOk(bundleDir: string): ParsedSkill {
  const result = parseSkillBundle(bundleDir);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected parse to succeed: ${result.error.code} ${result.error.message}`);
  }
  return result.skill;
}

describe('parseSkillBundle', () => {
  // AC1 — bundle (a): frontmatter fields + body + injected == body alone.
  it('parses a no-references bundle to frontmatter, body, and body-only injected content', () => {
    const skill = parseOk(bundle('minimal-notes'));

    // Frontmatter fields are returned.
    expect(skill.name).toBe('minimal-notes');
    expect(skill.description).toContain('Take structured notes');
    expect(skill.frontmatter.name).toBe('minimal-notes');

    // Body text is returned with the frontmatter block stripped.
    expect(skill.body).toContain('# Minimal Notes');
    expect(skill.body).toContain('minimal-frontmatter case');
    expect(skill.body).not.toContain('name: minimal-notes');
    expect(skill.body).not.toContain('description:');

    // No references → injected content equals the body alone, no delimiter emitted.
    expect(skill.references).toHaveLength(0);
    expect(skill.injectedContent).toBe(skill.body);
    expect(skill.injectedContent).not.toContain('--- references/');
  });

  // AC2 — bundle (b): body, then references/ in lexicographic order, each
  // preceded by a `--- references/<name> ---` delimiter line.
  it('assembles injected content as body then references/ in lexicographic order with delimiters', () => {
    const skill = parseOk(bundle('code-style-guide'));
    const injected = skill.injectedContent;

    const ref01 = raw('code-style-guide', 'references', '01-formatting.md');
    const ref02 = raw('code-style-guide', 'references', '02-naming.md');

    // References are parsed verbatim, in lexicographic filename order.
    expect(skill.references.map((r) => r.name)).toEqual(['01-formatting.md', '02-naming.md']);
    expect(skill.references[0].content).toBe(ref01);
    expect(skill.references[1].content).toBe(ref02);

    // Body comes first, verbatim.
    expect(injected.startsWith(skill.body)).toBe(true);

    // Each reference is preceded by a standalone delimiter LINE.
    expect(injected).toContain('\n--- references/01-formatting.md ---\n');
    expect(injected).toContain('\n--- references/02-naming.md ---\n');
    // Exactly one delimiter per reference file (no stray/duplicate delimiters).
    expect(injected.split('--- references/').length - 1).toBe(2);

    // Ordering + placement: 01 delimiter then 01 content, then 02 delimiter then 02 content.
    const i01 = injected.indexOf('--- references/01-formatting.md ---');
    const i02 = injected.indexOf('--- references/02-naming.md ---');
    const c01 = injected.indexOf(ref01);
    const c02 = injected.indexOf(ref02);
    expect(i01).toBeGreaterThanOrEqual(skill.body.length); // references come after the body
    expect(i02).toBeGreaterThan(i01); // lexicographic order
    expect(c01).toBeGreaterThan(i01); // 01 content follows its delimiter
    expect(c01).toBeLessThan(i02); //    ...and precedes the 02 delimiter
    expect(c02).toBeGreaterThan(i02); // 02 content follows its delimiter
  });

  // AC3 — description is catalog metadata (for discovery), name is for lookup;
  // description text must never appear in injected content.
  it('surfaces name for lookup and description as metadata but never injects the description', () => {
    const skill = parseOk(bundle('minimal-notes'));

    // name is the lookup key.
    expect(skill.name).toBe('minimal-notes');

    // description is captured as metadata...
    expect(skill.description).toContain('jot this down');

    // ...but a distinctive phrase unique to the description never leaks into injection.
    expect(skill.injectedContent).not.toContain('jot this down');
    expect(skill.injectedContent).not.toContain(skill.description);
  });

  // AC4 — bundle (c): unknown / execution-oriented frontmatter (allowed-tools)
  // is read and preserved, never required, never removed, never honored.
  it('reads and preserves unknown/execution-oriented frontmatter without honoring it', () => {
    const skill = parseOk(bundle('repo-triage'));

    // The execution-oriented field is preserved verbatim on the parsed structure.
    expect(skill.frontmatter['allowed-tools']).toBe('Bash(scripts/triage.sh:*)');

    // Standard catalog fields are still extracted alongside it.
    expect(skill.name).toBe('repo-triage');
    expect(skill.description).toContain('Triage incoming repository');

    // scripts/ is NOT references/: nothing under scripts/ is injected (consume, never execute).
    expect(skill.references).toHaveLength(0);
    expect(skill.injectedContent).toBe(skill.body);
    expect(skill.injectedContent).not.toContain('Triage checklist:'); // a line from scripts/triage.sh
    expect(skill.injectedContent).not.toContain('#!/usr/bin/env bash');
  });

  // AC5 — deterministic + byte-faithful: unicode/formatting oddities round-trip
  // unchanged, and identical bundle bytes yield an identical injected string.
  it('round-trips unicode and formatting oddities byte-for-byte in the body', () => {
    const skill = parseOk(bundle('unicode-style-notes'));

    expect(skill.name).toBe('unicode-style-notes');

    // Multi-byte scripts, emoji (incl. ZWJ), curly punctuation — verbatim.
    expect(skill.body).toContain('café');
    expect(skill.body).toContain('中文');
    expect(skill.body).toContain('مرحبا');
    expect(skill.body).toContain('🚀✨');
    expect(skill.body).toContain('“Curly double quotes”');
    expect(skill.body).toContain('— like this'); // em dash preserved

    // Whitespace edges preserved: trailing spaces and hard tabs are not stripped.
    expect(skill.body).toContain('trailing spaces here   ');
    expect(skill.body).toContain('Tabs\tbetween\twords\ton\tthis\tline.');

    // No references here → injected is exactly the body.
    expect(skill.injectedContent).toBe(skill.body);
  });

  it('is deterministic: identical bundle bytes yield an identical injected-content string', () => {
    // No references (body-only).
    const a = parseOk(bundle('unicode-style-notes'));
    const b = parseOk(bundle('unicode-style-notes'));
    expect(a.injectedContent).toBe(b.injectedContent);
    expect(a.body).toBe(b.body);

    // With references — proves the lexicographic ordering is stable across parses.
    const c = parseOk(bundle('code-style-guide'));
    const d = parseOk(bundle('code-style-guide'));
    expect(c.injectedContent).toBe(d.injectedContent);
    expect(c.references.map((r) => r.name)).toEqual(d.references.map((r) => r.name));
  });

  // AC6 — a bundle directory with no SKILL.md is a structured error naming the
  // bundle, never a silent empty result.
  it('returns a structured error identifying the bundle when SKILL.md is missing', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'skill-missing-'));
    try {
      const result = parseSkillBundle(emptyDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a missing-bundle parse error');

      expect(result.error.code).toBe('MISSING_BUNDLE');
      expect(result.error.bundle).toContain(basename(emptyDir));
      expect(result.error.message).toContain('SKILL.md');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // Regression (WI-552 rework) — malformed YAML inside otherwise-valid `---`
  // frontmatter delimiters must return a structured INVALID_FRONTMATTER result,
  // NEVER throw an uncaught YAMLParseError. Amy found parseSkillBundle() crashing
  // on this input; the guard in parse.ts (try/catch around the YAML parse) must
  // stay put so a future refactor can't silently reintroduce the crash.
  it('returns a structured INVALID_FRONTMATTER error (does not throw) on malformed frontmatter YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-badyaml-'));
    // Valid frontmatter delimiters present; the YAML between them is malformed
    // (an unterminated flow sequence), which the YAML parser rejects.
    const skillMd = ['---', 'name: broken-yaml', 'tags: [a, b', '---', '', '# Broken', 'body text', ''].join('\n');
    writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');

    try {
      let result: ParseSkillResult | undefined;
      // The crash-class bug: this call threw instead of returning a result.
      expect(() => {
        result = parseSkillBundle(dir);
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(result!.ok).toBe(false);
      if (result!.ok) throw new Error('expected an INVALID_FRONTMATTER parse error');

      expect(result!.error.code).toBe('INVALID_FRONTMATTER');
      // Distinguishes the malformed-YAML branch from the missing-delimiter branch.
      expect(result!.error.message).toMatch(/yaml/i);
      expect(result!.error.bundle).toContain(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression (WI-553 rework) — an unreadable references/ entry (dangling or
  // circular symlink) must return a structured UNREADABLE_REFERENCE result,
  // NEVER throw an uncaught ENOENT/ELOOP out of statSync/readFileSync. Lynch
  // found parseSkillBundle() crashing on this while resolving references; the
  // try/catch in assembleReferences must stay so a refactor can't reintroduce it.
  it('returns a structured UNREADABLE_REFERENCE error (does not throw) on a dangling references/ symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-dangling-'));
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'name: dangling-ref', 'description: has an unreadable reference.', '---', '', '# Dangling', 'body', ''].join('\n'),
      'utf8',
    );
    mkdirSync(join(dir, 'references'));
    // A symlink whose target does not exist → statSync/readFileSync throw ENOENT.
    symlinkSync('./no-such-target.md', join(dir, 'references', 'dangling.md'));

    try {
      let result: ParseSkillResult | undefined;
      // The crash-class bug: this call threw instead of returning a result.
      expect(() => {
        result = parseSkillBundle(dir);
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(result!.ok).toBe(false);
      if (result!.ok) throw new Error('expected an UNREADABLE_REFERENCE parse error');

      expect(result!.error.code).toBe('UNREADABLE_REFERENCE');
      // The offending entry is named so the author can find and fix it.
      expect(result!.error.message).toContain('dangling.md');
      expect(result!.error.bundle).toContain(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC7 — bundle (f): a real published Claude Code skill, vendored verbatim,
  // parses using only standard structure; no Conduit-specific field/file needed.
  it('parses a real published zero-dialect Claude Code skill with no Conduit-specific requirements', () => {
    const skill = parseOk(bundle('find-skills'));

    // Only standard Claude Code frontmatter (name + description) is present/needed.
    expect(skill.name).toBe('find-skills');
    expect(skill.description).toContain('Helps users discover and install agent skills');
    expect(Object.keys(skill.frontmatter).sort()).toEqual(['description', 'name']);

    // Body carries the instruction content; no references/ in this bundle.
    expect(skill.body).toContain('# Find Skills');
    expect(skill.references).toHaveLength(0);
    expect(skill.injectedContent).toBe(skill.body);

    // description stays out of the injected content even for the zero-dialect case.
    expect(skill.injectedContent).not.toContain(skill.description);
  });
});
