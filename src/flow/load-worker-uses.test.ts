/**
 * Tests for worker.uses schema + composition into the resolved StationConfig
 * (WI-555, loader half).
 *
 * Skill Ingest PRD §2.1–§2.2 / FR-2, FR-8. A station declares `worker.uses:` (an
 * ordered skill list); the loader resolves each entry (via the WI-553 resolver,
 * already wired by WI-554), then COMPOSES the injected instruction content —
 * each skill's content in `uses:` order, then the station's local prompt last —
 * onto a new `StationConfig.prompt_content` field. Invalid `uses:` declarations
 * are rejected at load ("config is validated, not trusted").
 *
 * Contract this file pins:
 *   - StationConfig gains `prompt_content?: string` (composed instruction content).
 *   - Composition order: skill_1, skill_2, …, then the local prompt (prompt_file
 *     text) last as the station-local override layer.
 *   - Only instruction content comes from skills; model/output_schema/params come
 *     from the station alone.
 *   - Load-time validation errors (FlowValidationError { code, message }):
 *       USES_ON_NON_LLM  — worker.uses on a deterministic (non-LLM) station (FR-8)
 *       DUPLICATE_USES   — the same skill named twice in one station's uses list
 *       UNRESOLVED_USES  — a uses entry naming a skill that does not resolve
 *                          (must be a hard error here, NOT the silent skip /
 *                          warning that WI-554's loadFlow pass does)
 *
 * The executor half (AC6 — the real prompt-render at executor.ts:1594 prefers
 * prompt_content over prompt_file) is pinned in
 * src/controller/executor-worker-uses.test.ts.
 *
 * `prompt_content` does not exist on StationConfig yet, so it is read through a
 * narrow view cast (mirrors WI-554's WarningsView pattern) to stay type-clean
 * until the field lands.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig, StationConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult, type FlowValidationError } from './load';

const FIXTURE_SKILLS = join(import.meta.dir, '..', '..', 'fixtures', 'skills');

interface SkillSpec {
  name: string;
  body: string;
}

interface TempFlowSpec {
  flowYaml: string;
  skills?: SkillSpec[];
  copyFixtures?: string[]; // fixture bundle names cpSync'd verbatim into skills/
  prompts?: Record<string, string>; // relative path under flow dir → file content
}

/** Materialize a temp flow (skills/, prompts/, flow.yaml), load it, clean up. */
function loadTempFlow(spec: TempFlowSpec): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-worker-uses-'));
  try {
    const skillsRoot = join(dir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    for (const s of spec.skills ?? []) {
      const bundle = join(skillsRoot, s.name);
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        join(bundle, 'SKILL.md'),
        ['---', `name: ${s.name}`, `description: ${s.name} marker skill.`, '---', '', s.body, ''].join('\n'),
        'utf8',
      );
    }
    for (const name of spec.copyFixtures ?? []) {
      cpSync(join(FIXTURE_SKILLS, name), join(skillsRoot, name), { recursive: true });
    }
    for (const [rel, content] of Object.entries(spec.prompts ?? {})) {
      const p = join(dir, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
    writeFileSync(join(dir, 'flow.yaml'), spec.flowYaml, 'utf8');
    return loadFlow(join(dir, 'flow.yaml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface PromptContentView {
  prompt_content?: string;
}

function promptContentOf(flow: FlowConfig, stationId: string): string | undefined {
  return (flow.stations[stationId] as unknown as PromptContentView).prompt_content;
}

function flowOf(result: LoadFlowResult): FlowConfig {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected load to succeed, got errors: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

function errorsOf(result: LoadFlowResult): FlowValidationError[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected load to fail with a validation error');
  return result.errors;
}

const HEADER = 'flow: worker-uses-test\nflow_version: 1\nterminal_lanes: [done, scrap, hold]\n';

/**
 * A transform station `draft` that uses skill-one then skill-two and has a local
 * prompt. Shared by the composition-order and station-field-isolation tests.
 */
function composedDraftResult(): LoadFlowResult {
  const flowYaml = `${HEADER}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/draft.md
      prompt_version: "1"
      params: { temperature: 0.5 }
      uses: [skill-one, skill-two]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
  return loadTempFlow({
    flowYaml,
    skills: [
      { name: 'skill-one', body: 'SKILL-ONE-BODY-MARKER' },
      { name: 'skill-two', body: 'SKILL-TWO-BODY-MARKER' },
    ],
    prompts: { 'prompts/draft.md': 'LOCAL-PROMPT-MARKER' },
  });
}

describe('worker.uses composition (loader)', () => {
  // AC1 — ordered composition: first skill, then second skill, then local prompt.
  it('composes prompt_content as skill-one, then skill-two, then the local prompt, in that order', () => {
    const flow = flowOf(composedDraftResult());
    const content = promptContentOf(flow, 'draft');

    expect(typeof content).toBe('string');
    const c = content ?? '';

    const iOne = c.indexOf('SKILL-ONE-BODY-MARKER');
    const iTwo = c.indexOf('SKILL-TWO-BODY-MARKER');
    const iLocal = c.indexOf('LOCAL-PROMPT-MARKER');

    expect(iOne).toBeGreaterThanOrEqual(0);
    expect(iTwo).toBeGreaterThan(iOne); // second skill after the first
    expect(iLocal).toBeGreaterThan(iTwo); // local prompt last, as the override layer
  });

  // AC2 — only instruction content comes from skills; every other StationConfig
  // field comes from the station alone.
  it('takes model, output_schema, and params from the station only — a skill contributes nothing but content', () => {
    const flow = flowOf(composedDraftResult());
    const station: StationConfig = flow.stations['draft'];

    expect(station.model).toBe('gpt-4o-mini');
    expect(station.params).toEqual({ temperature: 0.5 });
    expect(station.output_schema?.fields).toEqual([{ name: 'out', type: 'string', required: true }]);
  });

  // AC3 — the pre-existing channel-level `uses:` keyword is unaffected: a flow
  // declaring both a channel `uses: [hitl]` and a station `worker.uses:` loads
  // without ambiguity, and still composes the station content.
  it('loads without ambiguity when both a channel uses:[hitl] and a station worker.uses are present', () => {
    const flowYaml = `${HEADER}channels:
  ingress:
    type: cli
  egress:
    - type: operator
      target: human
      uses: [hitl]
stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/draft.md
      prompt_version: "1"
      uses: [skill-one]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    const flow = flowOf(
      loadTempFlow({
        flowYaml,
        skills: [{ name: 'skill-one', body: 'SKILL-ONE-BODY-MARKER' }],
        prompts: { 'prompts/draft.md': 'LOCAL-PROMPT-MARKER' },
      }),
    );

    // The station's worker.uses still composed (channel uses did not shadow it).
    expect(promptContentOf(flow, 'draft') ?? '').toContain('SKILL-ONE-BODY-MARKER');
  });

  // AC4 — worker.uses on a deterministic (non-LLM) station is a load error (FR-8):
  // a station with no prompt has nowhere to inject skill content.
  it('rejects worker.uses on a deterministic station with USES_ON_NON_LLM naming the station', () => {
    const flowYaml = `${HEADER}security:
  bash:
    allow: ["true"]
stations:
  - id: build
    worker:
      kind: deterministic
      command: "true"
      uses: [skill-one]
    inputs: []
    outputs: []
`;
    const errors = errorsOf(
      loadTempFlow({ flowYaml, skills: [{ name: 'skill-one', body: 'SKILL-ONE-BODY-MARKER' }] }),
    );

    const err = errors.find((e) => e.code === 'USES_ON_NON_LLM');
    expect(err).toBeDefined();
    expect(err!.message).toContain('build');
  });

  // AC5 — a duplicate skill name within one station's uses list is a load error,
  // preventing double-injection.
  it('rejects a duplicate skill name in one station uses list with DUPLICATE_USES', () => {
    const flowYaml = `${HEADER}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/draft.md
      prompt_version: "1"
      uses: [skill-one, skill-one]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    const errors = errorsOf(
      loadTempFlow({
        flowYaml,
        skills: [{ name: 'skill-one', body: 'SKILL-ONE-BODY-MARKER' }],
        prompts: { 'prompts/draft.md': 'LOCAL-PROMPT-MARKER' },
      }),
    );

    const err = errors.find((e) => e.code === 'DUPLICATE_USES');
    expect(err).toBeDefined();
    expect(err!.message).toContain('draft');
    expect(err!.message).toContain('skill-one');
  });

  // AC7 — zero-dialect proof at composition: a station using the real published
  // fixture (f) find-skills composes and loads with no Conduit-specific field.
  it('composes and loads a station using the real zero-dialect find-skills bundle (fixture f)', () => {
    const flowYaml = `${HEADER}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/draft.md
      prompt_version: "1"
      uses: [find-skills]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    const flow = flowOf(
      loadTempFlow({
        flowYaml,
        copyFixtures: ['find-skills'],
        prompts: { 'prompts/draft.md': 'LOCAL-PROMPT-MARKER' },
      }),
    );

    const content = promptContentOf(flow, 'draft') ?? '';
    // fixture (f)'s body is injected; the local prompt is still appended last.
    expect(content).toContain('# Find Skills');
    expect(content).toContain('discover and install skills');
    expect(content).toContain('LOCAL-PROMPT-MARKER');
  });

  // AC8 — an unresolvable / typo'd uses entry is a load-time validation error
  // naming the station and the missing skill. This must NOT be the silent skip
  // that WI-554's loadFlow warning pass does — composition treats it as a hard error.
  it('rejects an unresolvable worker.uses skill name with UNRESOLVED_USES naming station and skill', () => {
    const flowYaml = `${HEADER}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/draft.md
      prompt_version: "1"
      uses: [no-such-skill]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    const errors = errorsOf(
      loadTempFlow({
        flowYaml,
        skills: [{ name: 'skill-one', body: 'SKILL-ONE-BODY-MARKER' }], // present but unrelated
        prompts: { 'prompts/draft.md': 'LOCAL-PROMPT-MARKER' },
      }),
    );

    const err = errors.find((e) => e.code === 'UNRESOLVED_USES');
    expect(err).toBeDefined();
    expect(err!.message).toContain('draft');
    expect(err!.message).toContain('no-such-skill');
  });

  // Regression (WI-555 rework) — a skill's own body/references content may carry
  // '{{...}}'-looking prose (a third-party author's unrelated templating syntax).
  // Injected into prompt_content, an undeclared placeholder used to pass load
  // and only crash renderPrompt() at runtime in the real executor. Composition
  // must scan the resolved skill content and surface an UNDECLARED_PROMPT_INPUT
  // load error naming the station, skill, and placeholder — the same treatment a
  // station's own local prompt already gets. Amy found the crash; the load-time
  // scan must stay so a refactor can't reintroduce it.
  it('rejects a worker.uses skill whose content has an undeclared {{placeholder}} with UNDECLARED_PROMPT_INPUT', () => {
    const flowYaml = `${HEADER}stations:
  - id: draft
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_version: "1"
      uses: [placeholder-style]
      output_schema:
        fields:
          - { name: out, type: string, required: true }
    inputs: []
    outputs: [draft.json]
`;
    const errors = errorsOf(
      loadTempFlow({
        flowYaml,
        // The skill body contains a placeholder that is NOT a declared station input.
        skills: [{ name: 'placeholder-style', body: 'Style note: address the reader as {{user_name}} in every sentence.' }],
      }),
    );

    const err = errors.find((e) => e.code === 'UNDECLARED_PROMPT_INPUT');
    expect(err).toBeDefined();
    expect(err!.message).toContain('draft'); // the station
    expect(err!.message).toContain('placeholder-style'); // the skill (not the station's own prompt)
    expect(err!.message).toContain('{{user_name}}'); // the offending placeholder
  });
});
