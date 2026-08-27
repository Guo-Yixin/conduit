/**
 * SKILL.md bundle parser (WI-552).
 *
 * A Conduit skill IS a Claude Code skill: this module turns a SKILL.md
 * bundle directory into a parsed structure and assembles its injectable
 * instruction content, with no Conduit-specific dialect required.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ParsedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  references: ReadonlyArray<{ name: string; content: string }>;
  injectedContent: string;
}

export interface SkillParseError {
  code: string;
  message: string;
  bundle: string;
}

export type ParseSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; error: SkillParseError };

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

type AssembleReferencesResult =
  | { ok: true; references: Array<{ name: string; content: string }> }
  | { ok: false; error: SkillParseError };

function assembleReferences(bundleDir: string): AssembleReferencesResult {
  const referencesDir = join(bundleDir, 'references');
  if (!existsSync(referencesDir)) return { ok: true, references: [] };

  const references: Array<{ name: string; content: string }> = [];
  for (const name of readdirSync(referencesDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entryPath = join(referencesDir, name);
    try {
      if (!statSync(entryPath).isFile()) continue;
      references.push({ name, content: readFileSync(entryPath, 'utf8') });
    } catch (err) {
      // A dangling or circular symlink (or any other unreadable entry) must
      // not crash the parser — every failure mode returns through the
      // discriminated ParseSkillResult union, never an uncaught exception.
      return {
        ok: false,
        error: {
          code: 'UNREADABLE_REFERENCE',
          message: `references/${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
          bundle: bundleDir,
        },
      };
    }
  }
  return { ok: true, references };
}

function assembleInjectedContent(
  body: string,
  references: ReadonlyArray<{ name: string; content: string }>,
): string {
  let injected = body;
  for (const ref of references) {
    injected += `\n--- references/${ref.name} ---\n${ref.content}`;
  }
  return injected;
}

export function parseSkillBundle(bundleDir: string): ParseSkillResult {
  const skillMdPath = join(bundleDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    return {
      ok: false,
      error: {
        code: 'MISSING_BUNDLE',
        message: `SKILL.md not found in bundle directory: ${bundleDir}`,
        bundle: bundleDir,
      },
    };
  }

  const raw = readFileSync(skillMdPath, 'utf8');
  const match = raw.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {
      ok: false,
      error: {
        code: 'INVALID_FRONTMATTER',
        message: `SKILL.md is missing a valid frontmatter block: ${skillMdPath}`,
        bundle: bundleDir,
      },
    };
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_FRONTMATTER',
        message: `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
        bundle: bundleDir,
      },
    };
  }

  const body = raw.slice(match[0].length).replace(/^\n/, '');
  const referencesResult = assembleReferences(bundleDir);
  if (!referencesResult.ok) return referencesResult;
  const { references } = referencesResult;

  return {
    ok: true,
    skill: {
      name: String(frontmatter.name ?? basename(bundleDir)),
      description: String(frontmatter.description ?? ''),
      frontmatter,
      body,
      references,
      injectedContent: assembleInjectedContent(body, references),
    },
  };
}
