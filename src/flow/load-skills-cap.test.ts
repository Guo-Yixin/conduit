/**
 * Tests for the injected skill-content size cap (WI-556).
 *
 * Skill Ingest PRD §2.3 / FR-5. The composition step (WI-555) assembles a
 * station's injected skill content (each skill's body + references, in uses
 * order). This item caps the TOTAL assembled skill content per station at a
 * default of 64 KiB (65536 bytes), overridable via
 * `defaults.skill_content_max_bytes`. Exceeding the cap is a load-time
 * validation error naming the offending skill and its per-file sizes, so an
 * eager-concat transform station cannot be silently bloated.
 *
 * Contract this file pins:
 *   - Default cap = 65536 bytes (64 KiB) when defaults.skill_content_max_bytes
 *     is absent.
 *   - The cap is measured on assembled injected content (bodies + references),
 *     summed ACROSS ALL skills in one station's worker.uses — a per-station
 *     aggregate, NOT a per-file or per-skill limit. (description is catalog
 *     metadata and does not count.)
 *   - Violation → FlowValidationError { code: 'SKILL_CONTENT_CAP_EXCEEDED', … }
 *     whose message names the offending skill and reports per-file sizes
 *     (raw byte counts).
 *
 * Builds on the composition in src/flow/load.ts (WI-555) and consumes WI-551
 * negative fixture (g) = large-reference-corpus (body + two references summing
 * to ~70 KiB).
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadFlow, type LoadFlowResult, type FlowValidationError } from './load';

const FIXTURE_SKILLS = join(import.meta.dir, '..', '..', 'fixtures', 'skills');
const DEFAULT_CAP = 65536; // 64 KiB

interface SkillSpec {
  name: string;
  body: string;
}

interface CapFlowSpec {
  uses: string[];
  skills?: SkillSpec[];
  copyFixtures?: string[];
  maxBytes?: number; // → defaults.skill_content_max_bytes
}

/** Materialize a one-station flow whose `draft` station uses the given skills. */
function loadCapFlow(spec: CapFlowSpec): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-skills-cap-'));
  try {
    const skillsRoot = join(dir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    for (const s of spec.skills ?? []) {
      const bundle = join(skillsRoot, s.name);
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        join(bundle, 'SKILL.md'),
        ['---', `name: ${s.name}`, `description: ${s.name} cap-test skill.`, '---', '', s.body, ''].join('\n'),
        'utf8',
      );
    }
    for (const name of spec.copyFixtures ?? []) {
      cpSync(join(FIXTURE_SKILLS, name), join(skillsRoot, name), { recursive: true });
    }
    const defaultsLine =
      spec.maxBytes !== undefined ? `defaults: { skill_content_max_bytes: ${spec.maxBytes} }\n` : '';
    const flowYaml = `flow: skills-cap-test
flow_version: 1
terminal_lanes: [done, scrap, hold]
${defaultsLine}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      uses: [${spec.uses.join(', ')}]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    writeFileSync(join(dir, 'flow.yaml'), flowYaml, 'utf8');
    return loadFlow(join(dir, 'flow.yaml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function capErrorOf(result: LoadFlowResult): FlowValidationError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected load to fail with a cap error');
  const err = result.errors.find((e) => e.code === 'SKILL_CONTENT_CAP_EXCEEDED');
  expect(err).toBeDefined();
  return err!;
}

function expectOk(result: LoadFlowResult): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected load to succeed, got: ${JSON.stringify(result.errors)}`);
}

describe('injected skill-content size cap', () => {
  // AC1 — under the default cap loads successfully.
  it('loads a station whose injected skill content is under the default 64 KiB cap', () => {
    expectOk(loadCapFlow({ uses: ['small-note'], skills: [{ name: 'small-note', body: 'A tiny style note.' }] }));
  });

  // AC2 — negative fixture (g) exceeds 64 KiB → load error naming the skill and
  // its per-file sizes.
  it('rejects fixture (g) which exceeds the default cap, naming the skill and per-file sizes', () => {
    const err = capErrorOf(loadCapFlow({ uses: ['large-reference-corpus'], copyFixtures: ['large-reference-corpus'] }));

    expect(err.message).toContain('large-reference-corpus'); // the offending skill
    // Per-file reporting: each references/ file is named with its raw byte size.
    expect(err.message).toContain('data-01.md');
    expect(err.message).toContain('data-02.md');
    expect(err.message).toContain('40068'); // data-01.md byte size
    expect(err.message).toContain('30072'); // data-02.md byte size
  });

  // AC3 — the knob LOWERS the threshold: a payload that passes at the default
  // fails when defaults.skill_content_max_bytes is set below its size.
  it('fails an otherwise-under-cap payload when skill_content_max_bytes is lowered below its size', () => {
    const skills = [{ name: 'small-note', body: 'A tiny style note.' }];
    // Sanity: passes at the default cap.
    expectOk(loadCapFlow({ uses: ['small-note'], skills }));
    // With the knob set to 10 bytes, the same content is over the cap.
    capErrorOf(loadCapFlow({ uses: ['small-note'], skills, maxBytes: 10 }));
  });

  // AC3 — the knob RAISES the threshold: fixture (g), which fails at the default,
  // passes when skill_content_max_bytes is raised above its size.
  it('passes fixture (g) when skill_content_max_bytes is raised above its size', () => {
    expectOk(loadCapFlow({ uses: ['large-reference-corpus'], copyFixtures: ['large-reference-corpus'], maxBytes: 200000 }));
  });

  // AC4 — the cap is a per-station AGGREGATE across all skills in worker.uses,
  // not a per-file / per-skill limit: two skills each individually under the cap
  // whose sum exceeds it must fail.
  it('sums injected content across all skills in one station (aggregate, not per-skill)', () => {
    const bodyA = 'A'.repeat(40000);
    const bodyB = 'B'.repeat(40000);
    const both = [
      { name: 'big-a', body: bodyA },
      { name: 'big-b', body: bodyB },
    ];

    // Each skill alone (~40 KiB injected) is under the 64 KiB cap.
    expect(bodyA.length).toBeLessThan(DEFAULT_CAP);
    expectOk(loadCapFlow({ uses: ['big-a'], skills: both }));

    // Both together (~80 KiB) exceed the per-station aggregate cap.
    expect(bodyA.length + bodyB.length).toBeGreaterThan(DEFAULT_CAP);
    capErrorOf(loadCapFlow({ uses: ['big-a', 'big-b'], skills: both }));
  });
});
