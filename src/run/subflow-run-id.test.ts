/**
 * Tests for subflow child run-id derivation (the original multi-flow engine work) and the production
 * subflow CLI contract (buildSubflowRunArgv).
 */
import { describe, it, expect } from 'bun:test';
import { deriveSubflowRunId, validateRunId } from './run-id';
import { buildSubflowRunArgv } from '../cli/main';

describe('deriveSubflowRunId', () => {
  it('is deterministic per (parent, station, attempt) — resume reuses the child run', () => {
    expect(deriveSubflowRunId('run-1', 'edit', 0)).toBe(deriveSubflowRunId('run-1', 'edit', 0));
  });

  it('derives distinct ids across attempts, stations, and parents', () => {
    const base = deriveSubflowRunId('run-1', 'edit', 0);
    expect(deriveSubflowRunId('run-1', 'edit', 1)).not.toBe(base);
    expect(deriveSubflowRunId('run-1', 'name', 0)).not.toBe(base);
    expect(deriveSubflowRunId('run-2', 'edit', 0)).not.toBe(base);
  });

  it('always yields a valid CLI run id, even for maximal parent ids', () => {
    const longParent = 'p'.repeat(128);
    const id = deriveSubflowRunId(longParent, 'a-station-with-a-long-name', 12);
    expect(() => validateRunId(id)).not.toThrow();
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('keeps a readable parent--station stem', () => {
    expect(deriveSubflowRunId('ig-Ev06-abc', 'edit-photo', 0)).toContain('ig-Ev06-abc--edit-photo');
  });
});

describe('buildSubflowRunArgv (production CLI contract)', () => {
  it('builds the full child argv: run id, project root, seed, budget ceilings', () => {
    const argv = buildSubflowRunArgv({
      flowPath: '/flows/child/flow.yaml',
      runId: 'parent--edit-a0-abc123def456',
      seedPath: '/proj/work/in.json',
      projectRoot: '/proj',
      budgetMaxTokens: 900,
      budgetWallClockSeconds: 540,
      parentRunId: 'parent',
      parentStation: 'edit',
    });

    expect(argv).toEqual([
      '/flows/child/flow.yaml',
      '--run-id', 'parent--edit-a0-abc123def456',
      '--project-root', '/proj',
      '--input', '/proj/work/in.json',
      '--budget-tokens', '900',
      '--budget-wall-clock-seconds', '540',
    ]);
  });

  it('omits seed and budget flags when absent (no ceiling imposed)', () => {
    const argv = buildSubflowRunArgv({
      flowPath: '/flows/child/flow.yaml',
      runId: 'r',
      projectRoot: '/proj',
      parentRunId: 'parent',
      parentStation: 'edit',
    });

    expect(argv).toEqual(['/flows/child/flow.yaml', '--run-id', 'r', '--project-root', '/proj']);
  });
});
