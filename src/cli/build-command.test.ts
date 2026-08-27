/**
 * Tests for the `conduit build <flow.yaml>` CLI subcommand (WI-438, FR-3).
 *
 * `conduit build` GENERATES a per-flow Dockerfile FROM the engine image (WI-435),
 * bakes in the flow directory, and `apt-get install`s exactly the packages from
 * the flow's `prerequisites` field (WI-434 — the single source of truth). The
 * deliverable is the generated Dockerfile TEXT, asserted deterministically; the
 * tests NEVER shell out to `docker build`.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/cli/main.ts (B.A. implements):
 * ---------------------------------------------------------------------------
 *
 *   // 1. A PURE, exported generator — the deterministic, unit-testable artifact:
 *   export function generateFlowDockerfile(
 *     flow: FlowConfig,
 *     opts: { flowDir: string },
 *   ): string;
 *   //   - first FROM line is the engine image: `FROM conduit-engine:<tag>`
 *   //     (the AC writes it `conduit:<version>`; any tagged conduit* image matches)
 *   //   - includes a COPY instruction baking the flow directory into the image
 *   //   - emits a single `apt-get install` step listing EXACTLY flow.prerequisites,
 *   //     and NO apt-get step at all when prerequisites is empty/absent
 *
 *   // 2. main()'s switch gains `case 'build': return cmdBuild(argv, deps);`
 *   //    and the unknown-command help string lists 'build'.
 *
 *   // 3. cmdBuild(argv, deps):
 *   //    - no flow arg → io.err(usage), return 1 (no Dockerfile emitted)
 *   //    - loadFlow fails (missing file / invalid flow) → io.err(validation
 *   //      errors), return 1 (no Dockerfile emitted)
 *   //    - success → write the generated Dockerfile text to deps.io.out, return 0
 *   //      (emit to stdout — no real fs write, no docker invocation)
 *
 * RED before WI-438: generateFlowDockerfile is not exported (module load fails =
 * correct red), and 'build' is not a command (falls to "unknown command").
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, dirname, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import type { ModelAdapter } from '../worker/adapter';
import {
  main,
  generateFlowDockerfile,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from './main';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BRANCHING_FLOW = join(REPO_ROOT, 'examples', 'branching', 'flow.yaml');

// ---------------------------------------------------------------------------
// Temp flow fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** Write an inline flow.yaml into a fresh temp dir and return its path. */
function writeTempFlow(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-build-'));
  tempDirs.push(dir);
  const path = join(dir, 'flow.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

/** Load a flow path, failing the test loudly if it does not validate. */
function loadOk(path: string): FlowConfig {
  const result = loadFlow(path);
  if (!result.ok) throw new Error(`expected ok flow, got: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

const flowYaml = (prereqLine: string): string => `
flow: buildtest
flow_version: 1
terminal_lanes: [done, scrap, hold]
${prereqLine}
stations:
  - id: a
    worker: { kind: transform }
`;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dockerfile-parsing helpers (deterministic text assertions; no docker)
// ---------------------------------------------------------------------------

/** The first FROM instruction line, trimmed (or undefined if none). */
function firstFromLine(dockerfile: string): string | undefined {
  return dockerfile
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^FROM\s+/i.test(l));
}

/**
 * The package list of the (single) `apt-get install` step, or null if there is
 * no apt-get install step. Joins line-continuations, slices after the install
 * verb up to the next shell operator, and drops flags (tokens starting with -).
 */
function aptInstallPackages(dockerfile: string): string[] | null {
  const joined = dockerfile.replace(/\\\n/g, ' ');
  const m = joined.match(/apt-get\s+install\b([^\n]*)/);
  if (!m) return null;
  const afterVerb = m[1]!.split(/&&|;|\|\||>/)[0]!;
  return afterVerb.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('-'));
}

/**
 * The first physical line that begins with a shell operator (`&&` / `||`) whose
 * PREVIOUS line does NOT end with a `\` line-continuation, or undefined if none.
 *
 * Such a line is the WI-441 bug: a multi-line `RUN apt-get ... \` block whose
 * last package line drops its backslash leaves `&& rm -rf ...` dangling as its
 * own line, which Docker reads as a new instruction → "unknown instruction: &&"
 * and `docker build` fails. A valid multi-line RUN keeps every non-final line
 * backslash-continued.
 */
function orphanedOperatorLine(dockerfile: string): string | undefined {
  const lines = dockerfile.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i]!.trim();
    if ((cur.startsWith('&&') || cur.startsWith('||')) && !lines[i - 1]!.trimEnd().endsWith('\\')) {
      return lines[i];
    }
  }
  return undefined;
}

// ===========================================================================
// GROUP A — generateFlowDockerfile: deterministic Dockerfile content
// ===========================================================================

describe('generateFlowDockerfile — base image + flow COPY (AC1)', () => {
  it('starts FROM the tagged engine image and COPYs the flow directory', () => {
    const flow = loadOk(BRANCHING_FLOW);
    const dockerfile = generateFlowDockerfile(flow, { flowDir: dirname(BRANCHING_FLOW) });

    const from = firstFromLine(dockerfile);
    expect(from).toBeDefined();
    // Engine image, tagged. AC writes `conduit:<version>`; the repo's engine
    // image is `conduit-engine` — accept any tagged conduit* base.
    expect(from!).toMatch(/^FROM\s+conduit[\w.-]*:\S+/i);
    // The flow files are baked in via a COPY instruction.
    expect(dockerfile).toMatch(/^COPY\s+\S+/m);
    // The runtime user must be able to write project outputs under /flow.
    expect(dockerfile).toMatch(/^COPY\s+--chown=conduit:conduit\s+\[/m);
  });

  it('emits a space-safe COPY when the flow directory path contains spaces', () => {
    // Real scenario: a flow living under e.g. '/home/user/my flow'. A bare
    // shell-form `COPY my flow/ /flow/` is tokenized by Docker as THREE args
    // (sources=['my','flow/'], dest='/flow/') → copies the wrong files. The
    // source must stay a single token: JSON-exec form `COPY ["my flow/", ...]`
    // or a context-relative `COPY . /flow/` are both safe; an unquoted spaced
    // source is the bug.
    const flow = loadOk(writeTempFlow(flowYaml('prerequisites: [jq]')));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/my flow' });

    const copyLines = dockerfile
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^COPY\b/i.test(l));
    expect(copyLines.length).toBeGreaterThan(0); // the flow is still copied

    // No shell-form (non-JSON) COPY line may contain the spaced directory name —
    // that is exactly the token Docker would split on whitespace.
    const brokenCopy = copyLines.find((l) => {
      const jsonCopy = /^COPY(?:\s+--[^\s]+)*\s+\[/i.test(l);
      return !jsonCopy && /\bmy flow\b/.test(l);
    });
    expect(brokenCopy).toBeUndefined();
  });
});

describe('generateFlowDockerfile — apt-get from prerequisites (AC2/AC3/AC4)', () => {
  it('installs EXACTLY the single declared prerequisite [jq] (AC2)', () => {
    const flow = loadOk(writeTempFlow(flowYaml('prerequisites: [jq]')));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/x' });

    expect(aptInstallPackages(dockerfile)).toEqual(['jq']);
  });

  it('installs EXACTLY [ffmpeg, git] and no other packages (AC3)', () => {
    const flow = loadOk(writeTempFlow('flow: t\nflow_version: 1\nterminal_lanes: [done, scrap, hold]\nprerequisites: [ffmpeg, git]\nstations:\n  - id: a\n    worker: { kind: transform }\n'));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/x' });

    const pkgs = aptInstallPackages(dockerfile);
    expect(pkgs).not.toBeNull();
    expect([...pkgs!].sort()).toEqual(['ffmpeg', 'git']); // exactly these two
    expect(pkgs!.length).toBe(2); // and no others
  });

  it.each([
    ['a single prerequisite', 'prerequisites: [jq]'],
    ['multiple prerequisites', 'prerequisites: [ffmpeg, git]'],
  ])('emits the apt-get step as ONE valid RUN with no dangling && line for %s', (_label, line) => {
    const flow = loadOk(writeTempFlow(flowYaml(line)));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/x' });

    // There IS an apt-get step (guards against a vacuous pass)...
    expect(aptInstallPackages(dockerfile)).not.toBeNull();
    // ...and it is a single continued RUN: no `&& rm -rf ...` orphaned onto its
    // own line by a missing backslash (the WI-441 docker-build parse failure).
    expect(orphanedOperatorLine(dockerfile)).toBeUndefined();
  });

  it('switches to root before apt-get and back to conduit for runtime', () => {
    const flow = loadOk(writeTempFlow(flowYaml('prerequisites: [jq]')));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/x' });

    expect(dockerfile).toMatch(/USER root[\s\S]*RUN apt-get/);
    expect(dockerfile).toMatch(/RUN apt-get[\s\S]*USER conduit/);

    const lastUser = dockerfile
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^USER\s+/i.test(line))
      .at(-1);
    expect(lastUser).toBe('USER conduit');
  });

  it.each([
    ['an explicitly empty list', 'prerequisites: []'],
    ['an absent prerequisites field', ''],
  ])('emits NO apt-get install step for %s but stays a valid Dockerfile (AC4)', (_label, line) => {
    const flow = loadOk(writeTempFlow(flowYaml(line)));
    const dockerfile = generateFlowDockerfile(flow, { flowDir: '/tmp/x' });

    expect(aptInstallPackages(dockerfile)).toBeNull(); // no apt-get install step
    expect(dockerfile).not.toMatch(/apt-get\s+install/);
    // Still valid: a per-flow image must still start FROM the engine image.
    expect(firstFromLine(dockerfile)).toMatch(/^FROM\s+conduit[\w.-]*:\S+/i);
  });
});

// ===========================================================================
// GROUP B — cmdBuild orchestration via main()
// ===========================================================================

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
});

afterEach(() => {
  db.close();
});

function makeDeps(): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (_args: RunEngineArgs) => {},
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) } as PrereqProbe],
  };
}

describe('conduit build — dispatch + emission (AC1 wiring)', () => {
  it('emits the generated Dockerfile to stdout and exits 0 for a valid flow', async () => {
    const code = await main(['build', BRANCHING_FLOW], makeDeps());

    expect(code).toBe(0);
    const stdout = io.lines.join('\n');
    expect(stdout).toMatch(/^FROM\s+conduit[\w.-]*:\S+/m); // the Dockerfile reached stdout
  });

  it('lists "build" in the unknown-command usage string', async () => {
    const code = await main(['definitely-not-a-command'], makeDeps());

    expect(code).toBe(1);
    const message = io.errors.join('\n');
    expect(message).toContain('build');
    expect(message).toContain('run'); // sanity: the full dispatcher list
  });
});

describe('conduit build — fail-closed error paths (AC5/AC6)', () => {
  it('exits non-zero with an error and emits no Dockerfile when the flow path is missing', async () => {
    const missing = join(tmpdir(), 'conduit-build-absent-zzz999', 'flow.yaml');

    const code = await main(['build', missing], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n').length).toBeGreaterThan(0);
    expect(io.lines.join('\n')).not.toContain('FROM '); // no Dockerfile generated
  });

  it('exits non-zero with usage and emits no Dockerfile when no flow arg is given', async () => {
    const code = await main(['build'], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n').toLowerCase()).toContain('usage');
    expect(io.lines.join('\n')).not.toContain('FROM ');
  });

  it('exits non-zero with the validation error and emits no Dockerfile when the flow fails loadFlow', async () => {
    // prerequisites as a bare string → INVALID_PREREQUISITES (WI-434): a flow
    // that parses as YAML but fails validation. "config is validated, not trusted".
    const invalidFlow = writeTempFlow(flowYaml("prerequisites: 'ffmpeg'"));

    const code = await main(['build', invalidFlow], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toContain('INVALID_PREREQUISITES');
    expect(io.lines.join('\n')).not.toContain('FROM ');
  });
});
