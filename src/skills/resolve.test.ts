/**
 * Tests for local skill resolution + path safety (WI-553).
 *
 * Implements Skill Ingest PRD §4 (local skill resolution) / FR-6 — "config is
 * validated, not trusted" extended to skill bundles. Given a skill NAME and a
 * flow directory, the resolver locates <skills_dir>/<name>/SKILL.md, parses it
 * via the WI-552 parser, and rejects unsafe or mismatched bundles at load time.
 *
 * Contract this file pins for src/skills/resolve.ts:
 *
 *   export function resolveSkill(
 *     name: string,
 *     flowDir: string,
 *     options?: ResolveSkillOptions,
 *   ): ResolveSkillResult
 *   export interface ResolveSkillOptions {
 *     skillsDir?: string;   // relative to flowDir; defaults to 'skills'
 *   }
 *   export type ResolveSkillResult =
 *     | { ok: true;  skill: ParsedSkill }            // ParsedSkill is WI-552's type
 *     | { ok: false; error: SkillResolveError }
 *   export interface SkillResolveError {
 *     code: string; message: string; skill: string; entry?: string
 *   }
 *
 * Error codes pinned here (stable, actionable, per-invariant):
 *   MISSING_BUNDLE   — no SKILL.md at <skills_dir>/<name>/ (missing, not skipped)
 *   NAME_MISMATCH    — frontmatter `name` present but != directory name
 *   MISSING_NAME     — frontmatter `name` absent (bundle cannot be looked up)
 *   PATH_ESCAPE      — a references/ entry resolves outside the bundle directory
 *
 * IMPORTANT contract note: the WI-552 parser masks an absent frontmatter name by
 * falling back to the directory basename (parse.ts:
 * `name: String(frontmatter.name ?? basename(bundleDir))`). So the resolver MUST
 * inspect the raw `frontmatter.name` (via skill.frontmatter) for name agreement
 * (AC3) and name presence (AC4) — NOT the already-defaulted `skill.name`.
 *
 * Out of scope for THIS item (later items — not tested here): the worker.uses
 * schema, composition/merge, and the 64 KiB content cap.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkill } from './resolve';
import { loadFlow } from '../flow/load';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const FIXTURES = join(REPO_ROOT, 'fixtures');

/** Create a temp flow dir with skills/<name>/SKILL.md; returns the flow dir. */
function tempFlowWithSkill(name: string, skillMd: string): string {
  const flowDir = mkdtempSync(join(tmpdir(), 'skill-resolve-'));
  const bundleDir = join(flowDir, 'skills', name);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'SKILL.md'), skillMd, 'utf8');
  return flowDir;
}

describe('resolveSkill', () => {
  // AC1 — default skills_dir ('skills/' next to flow.yaml); resolved bundle
  // parses via the WI-552 parser.
  it('resolves <flowDir>/skills/<name>/SKILL.md by default and parses the bundle', () => {
    // FIXTURES acts as the flow dir: FIXTURES/skills/minimal-notes/SKILL.md.
    const result = resolveSkill('minimal-notes', FIXTURES);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected resolve to succeed: ${result.error.code}`);

    // The resolved value is the fully-parsed WI-552 skill structure.
    expect(result.skill.name).toBe('minimal-notes');
    expect(result.skill.body).toContain('# Minimal Notes');
    expect(result.skill.injectedContent).toBe(result.skill.body); // no references → body only
  });

  // AC1 — defaults.skills_dir override.
  it('honors an overridden skills_dir and still parses via the WI-552 parser', () => {
    // flowDir = repo root; skills_dir override points at the fixture corpus.
    const result = resolveSkill('code-style-guide', REPO_ROOT, { skillsDir: 'fixtures/skills' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected resolve to succeed: ${result.error.code}`);

    expect(result.skill.name).toBe('code-style-guide');
    // Proves the parser ran end-to-end: references/ were assembled.
    expect(result.skill.references.map((r) => r.name)).toEqual([
      '01-formatting.md',
      '02-naming.md',
    ]);
    expect(result.skill.injectedContent).toContain('--- references/01-formatting.md ---');
  });

  // AC2 — a skill directory lacking SKILL.md is a load-time error naming the
  // skill (missing bundle), never a silent skip.
  it('returns a MISSING_BUNDLE error naming the skill when the bundle is absent', () => {
    const result = resolveSkill('does-not-exist', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a missing-bundle error');

    expect(result.error.code).toBe('MISSING_BUNDLE');
    expect(result.error.skill).toBe('does-not-exist');
    expect(result.error.message).toContain('does-not-exist');
  });

  // AC3 — frontmatter `name` present but disagreeing with the directory name is
  // a load-time error naming BOTH.
  it('rejects a bundle whose frontmatter name differs from its directory name', () => {
    const flowDir = tempFlowWithSkill(
      'wrong-dir',
      ['---', 'name: different-name', 'description: mismatched name and directory.', '---', '', '# Wrong Dir', 'body', ''].join('\n'),
    );
    try {
      const result = resolveSkill('wrong-dir', flowDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a name-mismatch error');

      expect(result.error.code).toBe('NAME_MISMATCH');
      // Both the directory name and the frontmatter name are named.
      expect(result.error.message).toContain('wrong-dir');
      expect(result.error.message).toContain('different-name');
    } finally {
      rmSync(flowDir, { recursive: true, force: true });
    }
  });

  // AC4 — an absent frontmatter `name` is a load-time error identifying the
  // bundle. NOTE: the parser defaults skill.name to the directory basename, so a
  // naive resolver checking skill.name would WRONGLY see agreement here.
  it('rejects a bundle with no frontmatter name (cannot be looked up)', () => {
    const flowDir = tempFlowWithSkill(
      'nameless',
      ['---', 'description: a bundle with no name field.', '---', '', '# Nameless', 'body', ''].join('\n'),
    );
    try {
      const result = resolveSkill('nameless', flowDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a missing-name error');

      expect(result.error.code).toBe('MISSING_NAME');
      expect(result.error.skill).toBe('nameless');
      expect(result.error.message).toContain('nameless');
    } finally {
      rmSync(flowDir, { recursive: true, force: true });
    }
  });

  // AC5 — a references/ entry escaping the bundle directory via symlink
  // (symlink-resolved) is a load-time path-safety error naming the entry.
  // Fixture (h) path-escape: references/escaped-note.md is a real symlink to
  // ../../minimal-notes/SKILL.md — resolving OUTSIDE the bundle directory.
  it('rejects a references/ symlink that escapes the bundle directory (fixture h)', () => {
    const result = resolveSkill('path-escape', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a path-safety error');

    expect(result.error.code).toBe('PATH_ESCAPE');
    expect(result.error.skill).toBe('path-escape');
    // The offending entry is named so the author can find and fix it.
    expect(result.error.message).toContain('escaped-note.md');
  });

  // Regression — layer-1 containment: a skill NAME containing '../' traversal
  // must never resolve outside skillsRoot, even when the traversed target
  // does not exist. Caught lexically (path.resolve normalization), before
  // anything is read from disk.
  it('rejects a skill name that traverses outside the skills directory', () => {
    const result = resolveSkill('../../etc/passwd', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a path-escape error');

    expect(result.error.code).toBe('PATH_ESCAPE');
    expect(result.error.message).toContain('outside the skills directory');
  });

  // Regression — layer-2 containment: the bundle DIRECTORY itself is a
  // symlink resolving outside skillsRoot. This is the exact class of bug
  // amy-1 found during WI-553 probing (bundleDir had no containment check at
  // all); a dedicated case pins it so a future refactor cannot silently drop
  // the bundleReal/skillsRootReal check without a test failing.
  it('rejects a bundle directory that is itself a symlink escaping the skills directory', () => {
    const flowDir = mkdtempSync(join(tmpdir(), 'skill-resolve-'));
    try {
      const outside = mkdtempSync(join(tmpdir(), 'skill-resolve-outside-'));
      writeFileSync(
        join(outside, 'SKILL.md'),
        ['---', 'name: escaped-bundle', 'description: bundle dir escapes via symlink.', '---', '', '# Escaped', 'body', ''].join('\n'),
        'utf8',
      );
      mkdirSync(join(flowDir, 'skills'), { recursive: true });
      symlinkSync(outside, join(flowDir, 'skills', 'escaped-bundle'));

      const result = resolveSkill('escaped-bundle', flowDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a path-escape error');

      expect(result.error.code).toBe('PATH_ESCAPE');
      expect(result.error.message).toContain('bundle directory resolves outside');

      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(flowDir, { recursive: true, force: true });
    }
  });

  // Regression — SKILL.md itself is a symlink escaping the bundle directory.
  // The bundle-dir and references/ checks do not cover this: the parser
  // unconditionally reads SKILL.md, so a symlinked SKILL.md pointing at an
  // arbitrary host file would have its contents injected into the prompt
  // with no containment check at all prior to this fix.
  it('rejects a SKILL.md that is itself a symlink escaping the bundle directory', () => {
    const flowDir = mkdtempSync(join(tmpdir(), 'skill-resolve-'));
    try {
      const outside = mkdtempSync(join(tmpdir(), 'skill-resolve-outside-'));
      const secretPath = join(outside, 'secret.md');
      writeFileSync(secretPath, 'TOP SECRET HOST FILE CONTENTS', 'utf8');

      const bundleDir = join(flowDir, 'skills', 'evil');
      mkdirSync(bundleDir, { recursive: true });
      symlinkSync(secretPath, join(bundleDir, 'SKILL.md'));

      const result = resolveSkill('evil', flowDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a path-escape error, not a leaked read');

      expect(result.error.code).toBe('PATH_ESCAPE');
      expect(result.error.message).toContain('SKILL.md resolves outside');

      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(flowDir, { recursive: true, force: true });
    }
  });

  // AC6 — a missing/absent skills_dir with no station declaring worker.uses is
  // dormant: the flow loads successfully, not an error. (aiteam.flow.yaml
  // declares no skills and has no skills/ dir beside it.)
  it('is dormant: a flow with no declared skills and no skills_dir loads successfully', () => {
    const flowPath = join(FIXTURES, 'flows', 'aiteam.flow.yaml');
    expect(existsSync(join(FIXTURES, 'flows', 'skills'))).toBe(false);

    const result = loadFlow(flowPath);
    expect(result.ok).toBe(true);
  });
});
