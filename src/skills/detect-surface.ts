/**
 * Execution-surface detection for skill bundles (WI-554).
 *
 * A Conduit skill IS a Claude Code skill, so a bundle may legitimately carry
 * execution surface (scripts/, allowed-tools, hooks, backtick-bang command
 * blocks) meant for a tool-enabled Claude Code session. Conduit's data-only
 * transform path never executes, honors, or evaluates any of it — this module
 * only detects and reports its presence so the limitation is surfaced, not
 * silently dropped.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedSkill } from './parse';

export type ExecutionSurfaceKind = 'scripts' | 'allowed-tools' | 'hooks' | 'command-block';

export interface ExecutionSurfaceWarning {
  code: string;
  skill: string;
  bundle: string;
  surfaces: ExecutionSurfaceKind[];
  message: string;
}

const COMMAND_BLOCK_PATTERN = /!`[^`]*`/;

function hasScriptsDir(bundleDir: string): boolean {
  const scriptsDir = join(bundleDir, 'scripts');
  return existsSync(scriptsDir) && statSync(scriptsDir).isDirectory();
}

export function detectExecutionSurface(skill: ParsedSkill, bundleDir: string): ExecutionSurfaceWarning | null {
  const surfaces: ExecutionSurfaceKind[] = [];

  if (hasScriptsDir(bundleDir)) surfaces.push('scripts');
  if (skill.frontmatter['allowed-tools'] !== undefined) surfaces.push('allowed-tools');
  if (skill.frontmatter.hooks !== undefined) surfaces.push('hooks');
  // Scanned over injectedContent (body + references/), not just body — a
  // references/ file is injected into the prompt exactly like the body, so a
  // command block hiding there is just as much execution surface.
  if (COMMAND_BLOCK_PATTERN.test(skill.injectedContent)) surfaces.push('command-block');

  if (surfaces.length === 0) return null;

  return {
    code: 'SKILL_EXECUTION_SURFACE',
    skill: skill.name,
    bundle: bundleDir,
    surfaces,
    message: `Skill "${skill.name}" (${bundleDir}) carries inert execution surface: ${surfaces.join(', ')}. Conduit reads this bundle for content only — nothing under it is executed, honored, or evaluated.`,
  };
}
