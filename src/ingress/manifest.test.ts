/**
 * Tests for the engine manifest parser (the original multi-flow engine work).
 *
 * Contract pinned for src/ingress/manifest.ts:
 *   parseEngineManifest(yamlText, manifestDir) → { ok, manifest | errors }
 *
 * The manifest is operator config, so it follows "config is validated, not
 * trusted": unknown keys, missing/empty flows, non-string paths, and invalid
 * flow names are all named errors; relative paths resolve against the
 * manifest's own directory.
 */
import { describe, it, expect } from 'bun:test';
import { parseEngineManifest } from './manifest';

const DIR = '/deploy/conduit';

function expectOk(yamlText: string) {
  const result = parseEngineManifest(yamlText, DIR);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result.manifest;
}

function expectCodes(yamlText: string, ...codes: string[]) {
  const result = parseEngineManifest(yamlText, DIR);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected errors');
  for (const code of codes) {
    expect(result.errors.map((e) => e.code)).toContain(code);
  }
  return result.errors;
}

describe('parseEngineManifest', () => {
  it('parses a valid manifest, resolving relative paths against the manifest dir', () => {
    const manifest = expectOk(`
flows:
  pic-edit: ./flows/pic-edit/flow.yaml
  studio: /abs/studio/flow.yaml
global_alert_channel: "#conduit-ops"
`);
    expect(manifest.flows).toEqual({
      'pic-edit': '/deploy/conduit/flows/pic-edit/flow.yaml',
      studio: '/abs/studio/flow.yaml',
    });
    expect(manifest.globalAlertChannel).toBe('#conduit-ops');
  });

  it('global_alert_channel is optional', () => {
    const manifest = expectOk(`
flows:
  a: ./a.yaml
`);
    expect(manifest.globalAlertChannel).toBeUndefined();
  });

  it('rejects invalid YAML with MANIFEST_PARSE_ERROR', () => {
    expectCodes('flows: [unclosed', 'MANIFEST_PARSE_ERROR');
  });

  it('rejects a non-mapping document', () => {
    expectCodes('- just\n- a\n- list\n', 'MANIFEST_NOT_A_MAPPING');
  });

  it('rejects a manifest with no flows block', () => {
    expectCodes('global_alert_channel: "#x"\n', 'MANIFEST_NO_FLOWS');
  });

  it('rejects an empty flows mapping (an engine serving nothing)', () => {
    expectCodes('flows: {}\n', 'MANIFEST_NO_FLOWS');
  });

  it('rejects a flows block that is not a mapping', () => {
    expectCodes('flows:\n  - a\n  - b\n', 'MANIFEST_FLOWS_NOT_A_MAPPING');
  });

  it('rejects a non-string flow path, naming the flow', () => {
    const errors = expectCodes('flows:\n  bad: 42\n', 'MANIFEST_INVALID_FLOW_PATH');
    expect(errors.find((e) => e.code === 'MANIFEST_INVALID_FLOW_PATH')!.message).toContain('bad');
  });

  it('rejects a flow name outside the addressable charset', () => {
    expectCodes('flows:\n  "bad name!": ./a.yaml\n', 'MANIFEST_INVALID_FLOW_NAME');
  });

  it('rejects unknown top-level keys (config validated, not trusted)', () => {
    const errors = expectCodes('flows:\n  a: ./a.yaml\nflowz: typo\n', 'MANIFEST_UNKNOWN_KEY');
    expect(errors.find((e) => e.code === 'MANIFEST_UNKNOWN_KEY')!.message).toContain('flowz');
  });

  it('rejects an empty global_alert_channel', () => {
    expectCodes('flows:\n  a: ./a.yaml\nglobal_alert_channel: ""\n', 'MANIFEST_INVALID_ALERT_CHANNEL');
  });

  it('parses max_concurrent_runs (the original listener-backpressure work)', () => {
    const manifest = expectOk(`
flows:
  a: ./a.yaml
max_concurrent_runs: 2
`);
    expect(manifest.maxConcurrentRuns).toBe(2);
  });

  it('max_concurrent_runs is optional (unlimited when omitted)', () => {
    const manifest = expectOk('flows:\n  a: ./a.yaml\n');
    expect(manifest.maxConcurrentRuns).toBeUndefined();
  });

  it('rejects a malformed max_concurrent_runs instead of silently uncapping', () => {
    for (const bad of ['0', '-1', '1.5', '"two"', 'true']) {
      expectCodes(
        `flows:\n  a: ./a.yaml\nmax_concurrent_runs: ${bad}\n`,
        'MANIFEST_INVALID_MAX_CONCURRENT_RUNS',
      );
    }
  });

  it('collects multiple errors in one pass instead of stopping at the first', () => {
    const errors = expectCodes(
      'flows:\n  "bad name!": ./a.yaml\n  b: 7\nextra: 1\n',
      'MANIFEST_INVALID_FLOW_NAME',
      'MANIFEST_INVALID_FLOW_PATH',
      'MANIFEST_UNKNOWN_KEY',
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
