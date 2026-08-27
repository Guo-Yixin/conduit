/**
 * Tests for skill-bundle execution-surface detection (WI-554).
 *
 * Implements Skill Ingest PRD FR-7 / §4 ("consume all, execute none, surfaced"):
 * a Conduit skill IS a Claude Code skill, so a bundle may legitimately carry
 * *execution surface* — a `scripts/` directory, an `allowed-tools` (or `hooks`)
 * frontmatter grant, or a backtick-bang `` !`command` `` block in its body — that a
 * tool-enabled Claude Code session would honor. In Conduit's data-only transform
 * path NONE of it is executed, honored, or evaluated. This module DETECTS that
 * surface and returns a structured, non-silent warning naming the skill and the
 * inert feature(s) so a caller can surface the limitation programmatically.
 *
 * Contract this file pins for src/skills/detect-surface.ts:
 *
 *   export function detectExecutionSurface(
 *     skill: ParsedSkill,      // the parsed bundle (WI-552)
 *     bundleDir: string,       // the bundle directory (needed to see scripts/)
 *   ): ExecutionSurfaceWarning | null
 *
 *   export type ExecutionSurfaceKind =
 *     | 'scripts'        // a scripts/ directory is present in the bundle
 *     | 'allowed-tools'  // an `allowed-tools` frontmatter grant is present
 *     | 'hooks'          // a `hooks` frontmatter key is present
 *     | 'command-block'  // a backtick-bang `!`...`` block appears in the body
 *
 *   export interface ExecutionSurfaceWarning {
 *     code: string;                      // stable machine code — SKILL_EXECUTION_SURFACE
 *     skill: string;                     // the skill's frontmatter name (lookup identity)
 *     bundle: string;                    // names the offending bundle directory
 *     surfaces: ExecutionSurfaceKind[];  // the detected inert surfaces (order not pinned)
 *     message: string;                   // human-readable; names the skill + its surfaces
 *   }
 *
 * A bundle with NO execution surface returns `null` (no warning). Detection is a
 * pure read: it never executes scripts, honors grants, or evaluates command
 * blocks — it only reports their presence. The warning is DATA on the return
 * value (not a console-only side effect) so callers surface it programmatically.
 *
 * WI-554 owns BOTH halves of this: the pure detector primitive
 * (`detectExecutionSurface`, first describe block) AND surfacing its warning
 * through the loader — AC1/AC4 require loadFlow() on a flow whose station `uses:`
 * a bundle with execution surface to carry a structured `warnings` array on its
 * result while still loading ok (second describe block). Per WI-554's Context,
 * loadFlow's result gains a `warnings?` channel it lacks today
 * ({ok:true,flow,warnings?}) without breaking existing callers. What is NOT
 * exercised here: worker.uses *composition* (injecting skill content into the
 * resolved StationConfig prompt + binding stamp) is WI-555; the pass/flag/deny
 * verdict machinery is Phase 2 (`conduit skills audit`).
 *
 * Fixture <-> PRD §4 corpus letter mapping (fixtures authored in WI-551):
 *   (c) repo-triage      — scripts/ + allowed-tools (execution surface, inert)
 *   (d) changelog-entry  — a backtick-bang `!`git log ...`` block in the body
 *   (a) minimal-notes    — no execution surface (negative control)
 *   (b) code-style-guide — references/ but no execution surface (references/ is NOT surface)
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillBundle, type ParsedSkill } from './parse';
import { detectExecutionSurface, type ExecutionSurfaceWarning } from './detect-surface';
import { loadFlow, type LoadFlowResult } from '../flow/load';

const SKILLS_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'skills');

function bundle(name: string): string {
  return join(SKILLS_DIR, name);
}

/** Parse a fixture bundle, failing the test on a parse error. */
function parsed(name: string): ParsedSkill {
  const result = parseSkillBundle(bundle(name));
  if (!result.ok) {
    throw new Error(`fixture failed to parse: ${name}: ${result.error.code} ${result.error.message}`);
  }
  return result.skill;
}

/** Detect and narrow to a non-null warning, failing the test if none was produced. */
function detectWarning(name: string): ExecutionSurfaceWarning {
  const warning = detectExecutionSurface(parsed(name), bundle(name));
  expect(warning).not.toBeNull();
  if (warning === null) throw new Error(`expected an execution-surface warning for ${name}`);
  return warning;
}

/** Build a synthetic ParsedSkill so frontmatter/body-only cases need no on-disk fixture. */
function synthSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  const body = overrides.body ?? '# Synthetic\n\nplain body, no surface.';
  return {
    name: overrides.name ?? 'synthetic',
    description: overrides.description ?? '',
    frontmatter: overrides.frontmatter ?? {},
    body,
    references: overrides.references ?? [],
    injectedContent: overrides.injectedContent ?? body,
  };
}

describe('detectExecutionSurface', () => {
  // AC1 — bundle (c): scripts/ + allowed-tools yield ONE structured warning that
  // names the skill and BOTH inert surfaces; detection is non-fatal (the flow
  // still loads — the detector reports, it never throws for a valid bundle).
  it('warns on bundle (c) naming the skill and its scripts + allowed-tools surface', () => {
    let warning!: ExecutionSurfaceWarning;
    expect(() => {
      warning = detectWarning('repo-triage');
    }).not.toThrow();

    // Identifies the skill by its lookup name and names the bundle directory.
    expect(warning.skill).toBe('repo-triage');
    expect(warning.bundle).toContain('repo-triage');

    // Both execution surfaces are reported (order is not pinned).
    expect([...warning.surfaces].sort()).toEqual(['allowed-tools', 'scripts']);

    // Precision: repo-triage has no command block and no hooks grant.
    expect(warning.surfaces).not.toContain('command-block');
    expect(warning.surfaces).not.toContain('hooks');

    // Stable machine code + a human-readable message that names skill and surfaces.
    expect(warning.code).toBe('SKILL_EXECUTION_SURFACE');
    expect(warning.message).toContain('repo-triage');
    expect(warning.message).toMatch(/scripts/i);
    expect(warning.message).toMatch(/allowed-tools/i);
  });

  // AC2 — bundle (d): a backtick-bang command block is WARNED, and the block is
  // injected verbatim as inert text — never evaluated, never shelled out to.
  it('warns on bundle (d) command block yet keeps it verbatim inert text, never evaluated', () => {
    const skill = parsed('changelog-entry');
    const warning = detectExecutionSurface(skill, bundle('changelog-entry'));

    // The block is surfaced as a command-block execution surface.
    expect(warning).not.toBeNull();
    expect(warning!.skill).toBe('changelog-entry');
    expect(warning!.surfaces).toContain('command-block');
    // Precision: this bundle carries no scripts/, no grant.
    expect(warning!.surfaces).not.toContain('scripts');
    expect(warning!.surfaces).not.toContain('allowed-tools');
    expect(warning!.surfaces).not.toContain('hooks');

    // "Consume all, execute none": the command survives verbatim in the injected
    // instruction content as literal prompt text (no references/, so injected == body).
    const literalBlock = '!`git log -1 --pretty=%s`';
    expect(skill.body).toContain(literalBlock);
    expect(skill.injectedContent).toContain(literalBlock);
    expect(skill.injectedContent).toBe(skill.body);

    // Proof it was NOT evaluated: the raw command token is still present, not
    // replaced by any command *output* (e.g. a resolved commit subject/SHA). The
    // detector only reads the block into a warning; it never runs it.
    expect(warning!.message).not.toContain('warning: the following is a shell result');
  });

  // AC3 — a bundle with no execution surface produces no warning at all.
  it('returns null for a bundle with no execution surface (a: minimal-notes)', () => {
    expect(detectExecutionSurface(parsed('minimal-notes'), bundle('minimal-notes'))).toBeNull();
  });

  // AC3 (precision) — references/ is instruction content, NOT execution surface:
  // a bundle carrying references/ but nothing executable stays silent.
  it('treats references/ as content, not surface: no warning for bundle (b) code-style-guide', () => {
    const skill = parsed('code-style-guide');
    expect(skill.references.length).toBeGreaterThan(0); // fixture really does have references/
    expect(detectExecutionSurface(skill, bundle('code-style-guide'))).toBeNull();
  });

  // AC4 — the warning is STRUCTURED DATA on the return value (not a console-only
  // side effect), so a caller can surface it programmatically.
  it('returns the warning as structured, serializable data callers can consume programmatically', () => {
    const warning = detectWarning('repo-triage');

    // Every field is populated on the returned object — the return value is the channel.
    expect(typeof warning.code).toBe('string');
    expect(warning.code.length).toBeGreaterThan(0);
    expect(typeof warning.skill).toBe('string');
    expect(typeof warning.bundle).toBe('string');
    expect(typeof warning.message).toBe('string');
    expect(Array.isArray(warning.surfaces)).toBe(true);
    expect(warning.surfaces.length).toBeGreaterThan(0);

    // It round-trips through JSON with its identity + surfaces intact — i.e. a
    // caller (loader, CLI) can serialize and surface it without any console read.
    const roundTripped = JSON.parse(JSON.stringify(warning)) as ExecutionSurfaceWarning;
    expect(roundTripped.skill).toBe('repo-triage');
    expect([...roundTripped.surfaces].sort()).toEqual(['allowed-tools', 'scripts']);
    expect(roundTripped.code).toBe(warning.code);
  });

  // hooks frontmatter is a fourth execution surface (FR-7) with no dedicated
  // fixture — a synthetic bundle pins that a `hooks` grant is detected and named.
  it('detects a hooks frontmatter grant as an inert execution surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-hooks-'));
    try {
      const skill = synthSkill({
        name: 'hooky',
        frontmatter: { name: 'hooky', hooks: { PostToolUse: 'scripts/notify.sh' } },
      });
      const warning = detectExecutionSurface(skill, dir);

      expect(warning).not.toBeNull();
      expect(warning!.skill).toBe('hooky');
      expect(warning!.surfaces).toContain('hooks');
      // No scripts/ on disk and no other grants → hooks is the only surface.
      expect(warning!.surfaces).not.toContain('scripts');
      expect(warning!.surfaces).not.toContain('allowed-tools');
      expect(warning!.surfaces).not.toContain('command-block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Command-block precision: an ordinary inline code span (no leading `!`) is
  // prose, NOT a command block, and must not raise a false warning.
  it('does not flag an ordinary inline code span (no leading bang) as a command block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-codespan-'));
    try {
      const body = 'Run `git status` to inspect the tree, then review the diff.';
      const skill = synthSkill({ name: 'prose-only', body, injectedContent: body });
      expect(detectExecutionSurface(skill, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A synthetic positive control for the command-block matcher, decoupled from
  // the one fixture: any `!`...`` block in the body is surfaced.
  it('detects a backtick-bang command block in an arbitrary body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-cmd-'));
    try {
      const body = 'Preamble.\n\nInline: !`echo hello` and then more prose.';
      const skill = synthSkill({ name: 'cmd-carrier', body, injectedContent: body });
      const warning = detectExecutionSurface(skill, dir);

      expect(warning).not.toBeNull();
      expect(warning!.skill).toBe('cmd-carrier');
      expect(warning!.surfaces).toEqual(['command-block']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression — a command block hiding in references/ content (not the body)
  // must still be detected: references/ files are injected into the prompt
  // exactly like the body (assembleInjectedContent), so scanning only
  // skill.body would silently miss execution surface that ends up in the
  // model's context just the same.
  it('detects a backtick-bang command block that appears only in references/ content, not the body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-cmd-ref-'));
    try {
      const body = 'Preamble with no command block at all.';
      const refs = [{ name: 'notes.md', content: 'See below: !`rm -rf /` for cleanup.' }];
      const skill = synthSkill({
        name: 'ref-cmd-carrier',
        body,
        references: refs,
        injectedContent: `${body}\n--- references/notes.md ---\n${refs[0]!.content}`,
      });
      const warning = detectExecutionSurface(skill, dir);

      expect(warning).not.toBeNull();
      expect(warning!.surfaces).toContain('command-block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Detection is deterministic: identical inputs yield a deeply-equal warning.
  it('is deterministic: repeated detection of the same bundle yields an equal warning', () => {
    const a = detectExecutionSurface(parsed('repo-triage'), bundle('repo-triage'));
    const b = detectExecutionSurface(parsed('repo-triage'), bundle('repo-triage'));
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // A missing scripts/ directory must not itself be read as surface — only a
  // present scripts/ dir counts (the temp bundleDir below has none).
  it('does not report a scripts surface when the bundle has no scripts/ directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-noscripts-'));
    try {
      expect(detectExecutionSurface(synthSkill(), dir)).toBeNull();
      expect(basename(dir)).toContain('skill-noscripts-'); // sanity: a real, empty dir
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WI-554 AC1/AC4 — loadFlow surfaces the detector's warning on its result.
 *
 * These pin the loader-integration contract WI-554's Context calls for: loadFlow
 * gains a `warnings?` channel on its ok result, so a flow whose transform station
 * `uses:` a bundle carrying execution surface loads OK (ok:true) AND carries a
 * structured warning identifying the skill + inert surface — programmatically,
 * not as a console-only side effect.
 *
 *   export type LoadFlowResult =
 *     | { ok: true;  flow: FlowConfig; warnings?: ExecutionSurfaceWarning[] }
 *     | { ok: false; errors: FlowValidationError[] }
 *
 * Each warning is (at least) ExecutionSurfaceWarning-shaped: it carries `skill`
 * (the bundle name), `surfaces` (the inert kinds), and a human `message`. The
 * loader resolves `worker.uses` from `skills_dir` (default `skills/` next to the
 * flow) via the WI-553 resolver, then runs the WI-554 detector; a skill with no
 * execution surface adds no warning. Existing warning-free flows keep
 * `warnings` empty/absent, so current callers/tests are unaffected.
 */
describe('loadFlow — skill execution-surface warnings surfaced on the load result (AC1/AC4)', () => {
  const FIXTURE_SKILLS = join(import.meta.dir, '..', '..', 'fixtures', 'skills');

  /** View onto the (to-be-added) warnings channel without presuming it exists at runtime yet. */
  interface WarningsView {
    warnings?: ExecutionSurfaceWarning[];
  }

  function warningsOf(result: LoadFlowResult): ExecutionSurfaceWarning[] {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected the flow to load ok, got: ${JSON.stringify(result)}`);
    return (result as unknown as WarningsView).warnings ?? [];
  }

  function flowYaml(stations: Array<{ id: string; uses?: string[] }>): string {
    const blocks = stations
      .map((s) => {
        const uses = s.uses && s.uses.length ? `\n      uses: [${s.uses.join(', ')}]` : '';
        return `  - id: ${s.id}\n    worker:\n      kind: transform${uses}`;
      })
      .join('\n');
    return `flow: skill-surface\nflow_version: 1\nterminal_lanes: [done, scrap, hold]\nstations:\n${blocks}\n`;
  }

  /**
   * Build a temp flow whose stations `uses:` the given real fixture bundles
   * (copied verbatim into the flow's default `skills/` dir), load it, and clean up.
   */
  function loadFlowUsing(stations: Array<{ id: string; uses?: string[] }>): LoadFlowResult {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-skillflow-'));
    try {
      const skillsRoot = join(dir, 'skills');
      mkdirSync(skillsRoot, { recursive: true });
      for (const station of stations) {
        for (const name of station.uses ?? []) {
          // Copy the actual (c)/(d)/… corpus bundle so the loader sees the real
          // scripts/, allowed-tools, and backtick-bang bytes.
          cpSync(join(FIXTURE_SKILLS, name), join(skillsRoot, name), { recursive: true });
        }
      }
      const path = join(dir, 'flow.yaml');
      writeFileSync(path, flowYaml(stations), 'utf-8');
      return loadFlow(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // AC1 — a station using bundle (c) (repo-triage: scripts/ + allowed-tools):
  // the flow loads ok AND the result carries a structured warning naming the
  // skill and its inert scripts + allowed-tools surface.
  it('surfaces a scripts + allowed-tools warning for a station using bundle (c), flow still loads ok', () => {
    const result = loadFlowUsing([{ id: 'triage', uses: ['repo-triage'] }]);

    // The flow loads successfully — execution surface is a warning, never a load error.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.flow.stations.triage).toBeDefined();

    const warnings = warningsOf(result);
    const w = warnings.find((x) => x.skill === 'repo-triage');
    expect(w).toBeDefined();
    expect([...w!.surfaces].sort()).toEqual(['allowed-tools', 'scripts']);
    expect(w!.message).toContain('repo-triage');
  });

  // AC1 — a station using bundle (d) (changelog-entry: backtick-bang block):
  // the flow loads ok AND the result carries a command-block warning; the block
  // is never evaluated (loadFlow does not shell out — the flow still loads).
  it('surfaces a command-block warning for a station using bundle (d), flow still loads ok', () => {
    const result = loadFlowUsing([{ id: 'changelog', uses: ['changelog-entry'] }]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const warnings = warningsOf(result);
    const w = warnings.find((x) => x.skill === 'changelog-entry');
    expect(w).toBeDefined();
    expect(w!.surfaces).toContain('command-block');
    expect(w!.message).toContain('changelog-entry');
  });

  // AC1 (precision) — a station using a bundle with NO execution surface
  // (minimal-notes) loads ok and adds NO warning, so warning-free flows stay quiet.
  it('adds no warning for a station using a bundle with no execution surface', () => {
    const result = loadFlowUsing([{ id: 'notes', uses: ['minimal-notes'] }]);

    expect(result.ok).toBe(true);
    expect(warningsOf(result)).toHaveLength(0);
  });

  // AC4 — the warnings are STRUCTURED DATA on the load result (not a console-only
  // side effect): multiple surface-bearing stations each contribute an
  // identifiable, JSON-serializable warning a caller can enumerate.
  it('carries one structured, serializable warning per surface-bearing station on the result', () => {
    const result = loadFlowUsing([
      { id: 'triage', uses: ['repo-triage'] },
      { id: 'changelog', uses: ['changelog-entry'] },
      { id: 'notes', uses: ['minimal-notes'] }, // no surface → contributes nothing
    ]);

    expect(result.ok).toBe(true);
    const warnings = warningsOf(result);

    // Exactly the two surface-bearing skills are named — minimal-notes adds none.
    const skills = warnings.map((w) => w.skill).sort();
    expect(skills).toEqual(['changelog-entry', 'repo-triage']);

    // Programmatically consumable: survives a JSON round-trip with identity + surfaces intact.
    const roundTripped = JSON.parse(JSON.stringify(warnings)) as ExecutionSurfaceWarning[];
    const triage = roundTripped.find((w) => w.skill === 'repo-triage');
    expect(triage).toBeDefined();
    expect([...triage!.surfaces].sort()).toEqual(['allowed-tools', 'scripts']);
  });
});
