/**
 * Load-time validation for `kind: subflow` stations (the original multi-flow engine work).
 *
 * Composition problems must die at flow load, never at dispatch:
 *   - SUBFLOW_MISSING_FLOW  — kind: subflow with no worker.flow
 *   - SUBFLOW_INVALID       — child path unresolvable or child flow invalid
 *   - SUBFLOW_CYCLE         — A→B→A at any depth, including self-reference
 *   - SUBFLOW_DEPTH_EXCEEDED — nesting beyond the cap (3)
 *
 * A valid reference loads transitively and lifts the resolved absolute child
 * path onto StationConfig.flow; a subflow station is exempt from the model-
 * station prompt/schema checks (its "worker" is a child flow, not a model).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadFlow } from './load';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-load-subflow-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a flow at <dir>/<name>/flow.yaml with one station of the given body. */
function writeFlowFile(name: string, stationBody: string): string {
  const flowDir = join(dir, name);
  mkdirSync(flowDir, { recursive: true });
  const path = join(flowDir, 'flow.yaml');
  writeFileSync(
    path,
    `
flow: ${name}
project_root: .
flow_version: 1
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
stations:
${stationBody}
`,
  );
  return path;
}

const DETERMINISTIC_STATION = `  - id: work
    worker: { kind: deterministic, command: "true" }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;

function subflowStation(flowRef: string | null, id = 'call'): string {
  return `  - id: ${id}
    worker:
      kind: subflow${flowRef === null ? '' : `\n      flow: ${flowRef}`}
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
}

function expectErrorCodes(path: string, ...codes: string[]): string {
  const result = loadFlow(path);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected load failure');
  const found = result.errors.map((e) => e.code);
  for (const code of codes) {
    expect(found).toContain(code);
  }
  return result.errors.map((e) => e.message).join('\n');
}

describe('subflow reference validation', () => {
  it('a valid reference loads and lifts the resolved absolute child path', () => {
    const childPath = writeFlowFile('child', DETERMINISTIC_STATION);
    const parentPath = writeFlowFile('parent', subflowStation('../child/flow.yaml'));

    const result = loadFlow(parentPath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.flow.stations['call']!.kind).toBe('subflow');
    expect(result.flow.stations['call']!.flow).toBe(childPath);
  });

  it('kind: subflow with no worker.flow is SUBFLOW_MISSING_FLOW', () => {
    const path = writeFlowFile('parent', subflowStation(null));
    expectErrorCodes(path, 'SUBFLOW_MISSING_FLOW');
  });

  it('an unresolvable child path is SUBFLOW_INVALID naming the child', () => {
    const path = writeFlowFile('parent', subflowStation('../nope/flow.yaml'));
    const message = expectErrorCodes(path, 'SUBFLOW_INVALID');
    expect(message).toContain('nope/flow.yaml');
  });

  it('an unresolvable child path hints that worker.flow is a path, not a manifest name (child-flow path-diagnostic work review)', () => {
    // The reviewer guessed worker.flow took an engine-manifest flow NAME
    // (manifest right there, same key vocabulary) — the FILE_READ_ERROR from
    // the failed child load is clear enough on its own, but the SUBFLOW_INVALID
    // wrapper should spell out the path-vs-name distinction so nobody else
    // has to guess.
    const path = writeFlowFile('parent', subflowStation('../nope/flow.yaml'));
    const message = expectErrorCodes(path, 'SUBFLOW_INVALID');
    expect(message).toContain('not an engine-manifest flow name');
  });

  it('an INVALID child flow rejects the parent with the child errors inlined', () => {
    // Child's deterministic station has no command → child fails to load.
    writeFlowFile(
      'child',
      `  - id: broken
    worker: { kind: deterministic }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`,
    );
    const path = writeFlowFile('parent', subflowStation('../child/flow.yaml'));
    const message = expectErrorCodes(path, 'SUBFLOW_INVALID');
    expect(message).toContain('MISSING_DETERMINISTIC_COMMAND');
  });

  it('an existing-but-invalid child does NOT get the manifest-name hint (child-flow path-diagnostic work review)', () => {
    // The child path resolved and loaded — it just failed its own validation.
    // That's a different mistake than guessing a manifest name, so the
    // message shape must stay unchanged (no hint appended).
    writeFlowFile(
      'child',
      `  - id: broken
    worker: { kind: deterministic }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`,
    );
    const path = writeFlowFile('parent', subflowStation('../child/flow.yaml'));
    const message = expectErrorCodes(path, 'SUBFLOW_INVALID');
    expect(message).not.toContain('not an engine-manifest flow name');
  });

  it('a direct self-reference is SUBFLOW_CYCLE', () => {
    const path = writeFlowFile('selfref', subflowStation('./flow.yaml'));
    expectErrorCodes(path, 'SUBFLOW_CYCLE');
  });

  it('an A→B→A cycle dies at load, naming the chain', () => {
    // A references B; B references A. Loading A must fail (the cycle surfaces
    // through B's load as SUBFLOW_CYCLE, inlined into A's SUBFLOW_INVALID).
    writeFlowFile('flow-a', subflowStation('../flow-b/flow.yaml'));
    writeFlowFile('flow-b', subflowStation('../flow-a/flow.yaml'));

    const result = loadFlow(join(dir, 'flow-a', 'flow.yaml'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected load failure');
    const all = result.errors.map((e) => `${e.code}: ${e.message}`).join('\n');
    expect(all).toContain('SUBFLOW_CYCLE');
  });

  it('nesting deeper than the cap is SUBFLOW_DEPTH_EXCEEDED', () => {
    // a → b → c → d: d is the 4th level; the chain exceeds the cap of 3.
    writeFlowFile('d', DETERMINISTIC_STATION);
    writeFlowFile('c', subflowStation('../d/flow.yaml'));
    writeFlowFile('b', subflowStation('../c/flow.yaml'));
    const aPath = writeFlowFile('a', subflowStation('../b/flow.yaml'));

    const result = loadFlow(aPath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected load failure');
    const all = result.errors.map((e) => `${e.code}: ${e.message}`).join('\n');
    expect(all).toContain('SUBFLOW_DEPTH_EXCEEDED');
  });

  it('two-level nesting (within the cap) is legal', () => {
    writeFlowFile('leaf', DETERMINISTIC_STATION);
    writeFlowFile('mid', subflowStation('../leaf/flow.yaml'));
    const topPath = writeFlowFile('top', subflowStation('../mid/flow.yaml'));

    expect(loadFlow(topPath).ok).toBe(true);
  });
});
