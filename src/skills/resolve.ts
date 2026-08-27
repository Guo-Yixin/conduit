/**
 * Local skill resolution + path safety (WI-553).
 *
 * Resolves a skill name to its bundle on local disk (<skills_dir>/<name>/SKILL.md,
 * skills_dir defaulting to 'skills' next to the flow), validates the load-time
 * safety invariants — no path traversal via the name, references/ confined to
 * the bundle directory after symlink resolution, directory/frontmatter name
 * agreement — and only then hands the bundle to the WI-552 parser. Path safety
 * is checked BEFORE parsing so a dangling/circular symlink is rejected here
 * rather than crashing the content parser. Extends "config is validated, not
 * trusted" to skill bundles.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { parseSkillBundle, type ParsedSkill, type ParseSkillResult } from './parse';

export interface ResolveSkillOptions {
  skillsDir?: string;
}

export interface SkillResolveError {
  code: string;
  message: string;
  skill: string;
  entry?: string;
}

export type ResolveSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; error: SkillResolveError };

/** True iff `candidate` is `root` itself or a path lexically/really nested under it. */
function isContainedIn(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pathEscape(skill: string, message: string, entry?: string): ResolveSkillResult {
  return { ok: false, error: { code: 'PATH_ESCAPE', message: `Skill "${skill}": ${message}`, skill, entry } };
}

function fromParseError(skill: string, parsed: Extract<ParseSkillResult, { ok: false }>): ResolveSkillResult {
  return {
    ok: false,
    error: { code: parsed.error.code, message: `Skill "${skill}": ${parsed.error.message}`, skill },
  };
}

export function resolveSkill(
  name: string,
  flowDir: string,
  options: ResolveSkillOptions = {},
): ResolveSkillResult {
  const skillsDir = options.skillsDir ?? 'skills';
  const skillsRoot = join(flowDir, skillsDir);
  const bundleDir = join(skillsRoot, name);

  // Path safety on the skill NAME itself: a name containing '../' traversal
  // must never be allowed to resolve outside skillsRoot, whether or not the
  // traversed target exists. Checked lexically (path.resolve normalization)
  // so it applies before anything is read from disk.
  const resolvedSkillsRoot = resolvePath(skillsRoot);
  if (!isContainedIn(resolvePath(bundleDir), resolvedSkillsRoot)) {
    return pathEscape(
      name,
      `name resolves outside the skills directory (${resolvePath(bundleDir)}, outside ${resolvedSkillsRoot}).`,
    );
  }

  // No bundle here at all — let the parser produce the canonical
  // MISSING_BUNDLE error; there is nothing on disk yet to path-check.
  if (!existsSync(join(bundleDir, 'SKILL.md'))) {
    const parsed = parseSkillBundle(bundleDir);
    if (!parsed.ok) return fromParseError(name, parsed);
    return { ok: true, skill: parsed.skill };
  }

  // Path safety on the bundle directory and its references/ entries,
  // validated BEFORE the content parser ever touches them — an
  // unresolvable (dangling/circular) symlink is rejected here instead of
  // propagating as an uncaught exception from the parser.
  let bundleReal: string;
  try {
    bundleReal = realpathSync(bundleDir);
  } catch (err) {
    return pathEscape(name, `bundle directory could not be resolved (${errorMessage(err)}).`);
  }
  const skillsRootReal = existsSync(skillsRoot) ? realpathSync(skillsRoot) : resolvedSkillsRoot;
  if (!isContainedIn(bundleReal, skillsRootReal)) {
    return pathEscape(
      name,
      `bundle directory resolves outside the skills directory (${bundleReal}, outside ${skillsRootReal}).`,
    );
  }

  // Path safety on SKILL.md itself. The bundle-directory check above does not
  // catch a SKILL.md that is ITSELF a symlink pointing outside the bundle —
  // the parser unconditionally reads this file, so it is the one path
  // guaranteed to be read on every resolve and must get the same
  // symlink-resolved containment guarantee as references/ entries.
  let skillMdReal: string;
  try {
    skillMdReal = realpathSync(join(bundleDir, 'SKILL.md'));
  } catch (err) {
    return pathEscape(name, `SKILL.md could not be resolved (${errorMessage(err)}).`);
  }
  if (!isContainedIn(skillMdReal, bundleReal)) {
    return pathEscape(name, `SKILL.md resolves outside the bundle directory (${skillMdReal}).`);
  }

  const referencesDir = join(bundleDir, 'references');
  if (existsSync(referencesDir)) {
    for (const entry of readdirSync(referencesDir)) {
      let entryReal: string;
      try {
        entryReal = realpathSync(join(referencesDir, entry));
      } catch (err) {
        // A dangling or circular symlink is just as unsafe as one that
        // resolves outside the bundle — it must not crash the resolver.
        return pathEscape(name, `references/ entry "${entry}" could not be resolved (${errorMessage(err)}).`, entry);
      }
      if (!isContainedIn(entryReal, bundleReal)) {
        return pathEscape(name, `references/ entry "${entry}" resolves outside the bundle directory (${entryReal}).`, entry);
      }
    }
  }

  const parsed = parseSkillBundle(bundleDir);
  if (!parsed.ok) return fromParseError(name, parsed);

  // The parser masks an absent frontmatter `name` by defaulting to the
  // directory basename — inspect the raw frontmatter, not skill.name.
  const frontmatterName = parsed.skill.frontmatter.name;
  if (frontmatterName === undefined || frontmatterName === null || frontmatterName === '') {
    return {
      ok: false,
      error: {
        code: 'MISSING_NAME',
        message: `Skill "${name}" has no frontmatter \`name\` field; a SKILL.md bundle must declare one to be looked up.`,
        skill: name,
      },
    };
  }
  if (String(frontmatterName) !== name) {
    return {
      ok: false,
      error: {
        code: 'NAME_MISMATCH',
        message: `Skill directory "${name}" does not match its frontmatter name "${String(frontmatterName)}".`,
        skill: name,
      },
    };
  }

  return { ok: true, skill: parsed.skill };
}
