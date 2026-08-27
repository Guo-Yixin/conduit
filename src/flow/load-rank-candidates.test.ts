/**
 * Loader surface for flow-computed HITL candidates (the original HITL reply-and-resume work).
 *
 * A rank check has exactly ONE candidate source — a critic block XOR a
 * `candidates_from` artifact — and three optional presentation/handoff
 * surfaces (`ask_template`, `ask_attach`, `selection_out`), each validated
 * fail-closed at load. The HITL work keys on a non-rank check are rejected rather
 * than silently ignored.
 *
 * Self-contained: each flow is written to a throwaway temp dir and loaded
 * (same pattern as load-prelaunch.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';

function loadInline(
  yaml: string,
  extraFiles: Record<string, string> = {},
): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-flow-rank77-'));
  const path = join(dir, 'flow.yaml');
  try {
    writeFileSync(path, yaml, 'utf-8');
    for (const [rel, content] of Object.entries(extraFiles)) {
      const filePath = join(dir, rel);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
    return loadFlow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

function errorCodes(result: LoadFlowResult): string[] {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors.map((e) => e.code);
}

function errorText(result: LoadFlowResult): string {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors.map((e) => e.message).join(' | ');
}

/**
 * A minimal candidates-mode rank flow. `checkLines` replaces the check block
 * body (indentation: 6 spaces per key line, matching the surrounding YAML).
 */
function candidatesFlow(checkLines: string[], stationExtras: string[] = []): string {
  return [
    'flow: rank-candidates',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    'stations:',
    '  - id: merge',
    '    worker: { kind: transform }',
    '  - id: select',
    ...stationExtras,
    '    check:',
    '      kind: rank',
    '      class: taste',
    ...checkLines,
  ].join('\n') + '\n';
}

describe('loadFlow — candidates_from parses onto rankCheck (the original HITL reply-and-resume work FR-1)', () => {
  it('a rank check with candidates_from and NO critic loads; rankCheck carries the artifact path verbatim', () => {
    const flow = expectOk(loadInline(candidatesFlow(['      candidates_from: work/board.json'])));
    const rankCheck = flow.stations.select!.rankCheck!;
    expect(rankCheck.candidatesFrom).toBe('work/board.json');
    // No critic in this mode — the model/prompt surfaces stay empty and unused.
    expect(rankCheck.criticModel).toBe('');
    expect(rankCheck.criticPromptFile).toBe('');
  });

  it('the full HITL work surface round-trips: ask_template (flow-dir resolved), ask_attach, selection_out', () => {
    const flow = expectOk(
      loadInline(
        candidatesFlow(
          [
            '      candidates_from: work/board.json',
            '      ask_template: prompts/ask.md',
            '      ask_attach: [work/edited.jpg]',
            '      selection_out: work/selection.json',
          ],
          ['    inputs: [work/board.json]'],
        ),
        { 'prompts/ask.md': 'pick one:\n{{work/board.json}}' },
      ),
    );
    const rankCheck = flow.stations.select!.rankCheck!;
    expect(rankCheck.candidatesFrom).toBe('work/board.json');
    expect(rankCheck.askTemplateFile!.endsWith(join('prompts', 'ask.md'))).toBe(true);
    expect(rankCheck.askAttach).toEqual(['work/edited.jpg']);
    expect(rankCheck.selectionOut).toBe('work/selection.json');
  });

  it('the existing critic mode is untouched: critic-only rank still loads with no HITL work fields', () => {
    const flow = expectOk(
      loadInline(
        candidatesFlow([
          '      critic:',
          '        role: selector',
          '        model: gpt-4o',
        ]),
      ),
    );
    const rankCheck = flow.stations.select!.rankCheck!;
    expect(rankCheck.criticModel).toBe('gpt-4o');
    expect(rankCheck.candidatesFrom).toBeUndefined();
    expect(rankCheck.selectionOut).toBeUndefined();
  });
});

describe('loadFlow — candidates_from validation, fail-closed (the original HITL reply-and-resume work)', () => {
  it('declaring BOTH critic and candidates_from is rejected, naming the station', () => {
    const result = loadInline(
      candidatesFlow([
        '      candidates_from: work/board.json',
        '      critic:',
        '        role: selector',
        '        model: gpt-4o',
      ]),
    );
    expect(errorCodes(result)).toContain('RANK_CANDIDATES_AND_CRITIC');
    expect(errorText(result)).toContain('select');
  });

  it('a non-string / empty candidates_from is rejected', () => {
    expect(errorCodes(loadInline(candidatesFlow(['      candidates_from: 42'])))).toContain(
      'INVALID_RANK_CANDIDATES_FROM',
    );
    expect(errorCodes(loadInline(candidatesFlow(['      candidates_from: ""'])))).toContain(
      'INVALID_RANK_CANDIDATES_FROM',
    );
  });

  it('a missing ask_template file is rejected at load, not at ask time', () => {
    const result = loadInline(
      candidatesFlow([
        '      candidates_from: work/board.json',
        '      ask_template: prompts/nope.md',
      ]),
    );
    expect(errorCodes(result)).toContain('RANK_ASK_TEMPLATE_NOT_FOUND');
  });

  it('an ask_template referencing an undeclared artifact is rejected (same scope rule as worker prompts)', () => {
    const result = loadInline(
      candidatesFlow([
        '      candidates_from: work/board.json',
        '      ask_template: prompts/ask.md',
      ]),
      { 'prompts/ask.md': 'pick:\n{{work/undeclared.json}}' },
    );
    expect(errorCodes(result)).toContain('RANK_ASK_UNDECLARED_INPUT');
    expect(errorText(result)).toContain('work/undeclared.json');
  });

  it('an empty or non-string-listed ask_attach is rejected', () => {
    expect(
      errorCodes(
        loadInline(
          candidatesFlow(['      candidates_from: work/board.json', '      ask_attach: []']),
        ),
      ),
    ).toContain('INVALID_RANK_ASK_ATTACH');
    expect(
      errorCodes(
        loadInline(
          candidatesFlow(['      candidates_from: work/board.json', '      ask_attach: [3]']),
        ),
      ),
    ).toContain('INVALID_RANK_ASK_ATTACH');
  });

  it('an empty selection_out is rejected', () => {
    const result = loadInline(
      candidatesFlow(['      candidates_from: work/board.json', '      selection_out: ""']),
    );
    expect(errorCodes(result)).toContain('INVALID_RANK_SELECTION_OUT');
  });

  it('HITL work keys on a GATE check are rejected, not silently ignored', () => {
    const result = loadInline(
      [
        'flow: gate-with-rank-keys',
        'flow_version: 1',
        'terminal_lanes: [done, scrap, hold]',
        'stations:',
        '  - id: draft',
        '    worker: { kind: transform }',
        '    check:',
        '      kind: gate',
        '      class: risk',
        '      candidates_from: work/board.json',
        '      critic:',
        '        role: judge',
        '        model: gpt-4o',
        '      on_reject: draft',
        '      rework_cap: 1',
      ].join('\n') + '\n',
    );
    expect(errorCodes(result)).toContain('RANK_SURFACE_ON_NON_RANK_CHECK');
    expect(errorText(result)).toContain('candidates_from');
  });
});
