/**
 * Dogfood example flow — conformance to the finalized config contract (WI-359).
 *
 * Proves the `examples/tiktok-shoppable-ideas` flow is a runnable, maintained
 * example against the shipped real-run surface (FR-1 example, NFR-1): the
 * committed flow.yaml + prompt templates + sanitized fixture DuckDB all conform
 * to the finalized loader contract (WI-351), with ZERO kernel-code changes.
 *
 * Topology:  fetch_context (deterministic, DuckDB) -> ideate (transform)
 *            -> [gate verify] -> done ; gate reject loops back to ideate.
 *
 * Scope of THIS file (and its boundaries):
 *   - AC1: loadFlow(flow.yaml) returns ok:true; happyPathNext routes
 *          fetch_context->ideate->done; the gate records the ideate->ideate
 *          back-edge; command/args, prompt_file/prompt_version, output_schema,
 *          and the resolved gate-critic config all parse per WI-351.
 *   - AC2: fetch_context's declared `duckdb` command + arg vector pass the
 *          Law-lite allowlist with no shell metacharacters (unconditional), and
 *          — gated behind a DuckDB CLI being present — actually read the fixture
 *          and write a valid context.json.
 *   - AC3: the ideate/verify prompt templates reference ONLY declared inputs
 *          (the loader's undeclared-input check passes), and the produced
 *          context.json renders the ideate template with no unresolved
 *          placeholders. An undeclared reference is rejected at load.
 *   - Fail-closed guards: a non-allowlisted command, an absent prompt_file, and
 *          a declared-but-missing prompt file each reject the flow at load.
 *   - AC4: the full controller-driven run — runExecutor (WI-356) drives a seeded
 *          card from fetch_context through ideate + the gate to lane=done and
 *          writes idea.json under the project root, with a stubbed model adapter
 *          (no real model call). Gated behind a DuckDB CLI being present, since
 *          the entry station spawns duckdb. Mirrors src/integration/real-run.test.ts.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadFlow, type LoadFlowResult } from '../flow/load';
import { checkCommandAllowed } from '../worker/deterministic';
import { renderPrompt } from '../flow/render';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runExecutor } from '../controller/executor';
import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';

// ---------------------------------------------------------------------------
// Paths + fixtures
// ---------------------------------------------------------------------------

const EXAMPLE_DIR = join(import.meta.dir, '..', '..', 'examples', 'tiktok-shoppable-ideas');
const EXAMPLE_FLOW = join(EXAMPLE_DIR, 'flow.yaml');

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy the whole example dir to a throwaway root so mutations don't touch the repo. */
function freshExample(): { dir: string; flowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-dogfood-'));
  createdDirs.push(dir);
  cpSync(EXAMPLE_DIR, dir, { recursive: true });
  return { dir, flowPath: join(dir, 'flow.yaml') };
}

/** Read-modify-write a file in a fresh example copy. */
function patchFile(path: string, mutate: (contents: string) => string): void {
  writeFileSync(path, mutate(readFileSync(path, 'utf-8')), 'utf-8');
}

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

function errorCodes(result: LoadFlowResult): string[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors.map((e) => e.code);
}

/** DuckDB CLI present? The live data-step assertions are gated behind this. */
const DUCKDB_AVAILABLE = Bun.which('duckdb') !== null;
const itDuck = DUCKDB_AVAILABLE ? it : it.skip;

// ---------------------------------------------------------------------------
// Stub ModelAdapter for the AC4 executor run. Branches on req.model so one
// adapter serves both the ideate transform worker (gpt-4o-mini) and the gate
// critic (gpt-4o) — exactly as the real wiring does. The worker response MUST
// satisfy the ideate output_schema (featured_variant / hook / filming_idea) or
// the transform's schema validation rejects it and the card never reaches done.
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gemini-flash-lite-latest';
const CRITIC_MODEL = 'gpt-4o';

function makeStubAdapter(opts: { gateRejectsBeforePass?: number } = {}): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  let gateRejectsLeft = opts.gateRejectsBeforePass ?? 0;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        const verdict =
          gateRejectsLeft > 0
            ? (gateRejectsLeft--, { verdict: 'reject', findings: ['needs work'], return_to: 'ideate' })
            : { verdict: 'pass', findings: [] };
        return { text: JSON.stringify(verdict), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      // ideate worker — shape matches the example's declared output_schema.
      return {
        text: JSON.stringify({
          featured_variant: 'Sunset Fade, 12 oz',
          hook: 'open on the gap since the last video',
          filming_idea: 'A 15s close-up unboxing of the Sunset Fade colorway, ending on a CTA.',
        }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

// ===========================================================================
// AC1 — the example flow loads against the finalized contract with full topology.
// ===========================================================================

describe('dogfood example flow — loads against the finalized contract (WI-359, AC1)', () => {
  it('returns ok:true with exactly the fetch_context and ideate stations', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(Object.keys(flow.stations).sort()).toEqual(['fetch_context', 'ideate']);
  });

  it('builds happyPathNext from declared next fields: fetch_context -> ideate -> done', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.happyPathNext).toEqual({ fetch_context: 'ideate', ideate: 'done' });
  });

  it('records the gate back-edge ideate -> ideate (on_reject)', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.back_edges).toContainEqual({ from: 'ideate', to: 'ideate' });
  });

  it('parses fetch_context as a deterministic DuckDB station with its declared arg vector', () => {
    const fc = expectOk(loadFlow(EXAMPLE_FLOW)).stations.fetch_context!;
    expect(fc.kind).toBe('deterministic');
    expect(fc.command).toBe('duckdb');
    expect(fc.args).toEqual(['-readonly', 'fixtures/fixture.duckdb', '-f', 'fetch.sql']);
    expect(fc.next).toBe('ideate');
    expect(fc.inputs).toEqual(['request.json']);
    expect(fc.outputs).toEqual(['context.json']);
  });

  it('parses ideate as a transform station with prompt_file, prompt_version and output_schema', () => {
    const id = expectOk(loadFlow(EXAMPLE_FLOW)).stations.ideate!;
    expect(id.kind).toBe('transform');
    expect(id.model).toBe('gemini-flash-lite-latest');
    expect(id.prompt_file).toMatch(/prompts\/ideate\.md$/);
    expect(id.prompt_version).toBe('1');
    expect(id.next).toBe('done');
    expect(id.inputs).toEqual(['context.json', 'feedback']);
    expect(id.outputs).toEqual(['idea.json']);

    const fields = id.output_schema!.fields;
    expect(fields.map((f) => f.name)).toEqual(['featured_variant', 'hook', 'filming_idea']);
    expect(fields.map((f) => f.type)).toEqual(['string', 'string', 'string']);
    expect(fields.every((f) => f.required)).toBe(true);
  });

  it('resolves the gate-critic config (model, prompt, on_reject ideate, rework cap, input scope)', () => {
    const gate = expectOk(loadFlow(EXAMPLE_FLOW)).stations.ideate!.gateCheck!;
    expect(gate.criticModel).toBe('gpt-4o');
    expect(gate.criticPromptFile).toMatch(/prompts\/verify\.md$/);
    expect(gate.criticPromptVersion).toBe('1');
    expect(gate.onReject).toBe('ideate');
    expect(gate.reworkCap).toBe(2);
    // critic scope = station inputs + outputs, so verify.md may reference both.
    expect(gate.criticInputScope).toEqual(['context.json', 'feedback', 'idea.json']);
  });
});

// ===========================================================================
// AC2 — fetch_context's command is Law-lite-safe, and (gated) runs for real.
// ===========================================================================

describe('dogfood example flow — fetch_context is Law-lite-safe (WI-359, AC2)', () => {
  it('passes the Law-lite allowlist with a metacharacter-free arg vector', () => {
    const fc = expectOk(loadFlow(EXAMPLE_FLOW)).stations.fetch_context!;
    const verdict = checkCommandAllowed(
      { command: fc.command!, args: fc.args! },
      { allowlist: ['duckdb'] },
    );
    expect(verdict).toEqual({ allowed: true });
  });

  itDuck('runs the declared duckdb command against the fixture and produces a context.json that renders the ideate prompt', () => {
    const { dir, flowPath } = freshExample();
    // Seed request.json (fetch_context's input) from the committed example seed.
    cpSync(join(dir, 'request.example.json'), join(dir, 'request.json'));

    const fc = expectOk(loadFlow(flowPath)).stations.fetch_context!;

    // Run the EXACT declared command + args, with cwd = the project root so the
    // relative fixture/fetch.sql/request.json paths resolve (as the executor will).
    const proc = Bun.spawnSync([fc.command!, ...fc.args!], { cwd: dir });
    expect(proc.exitCode).toBe(0);

    // fetch_context's declared output artifact exists and is valid JSON.
    const contextRaw = readFileSync(join(dir, 'context.json'), 'utf-8');
    const context = JSON.parse(contextRaw) as Record<string, unknown>;
    expect(context).toHaveProperty('product_id');
    expect(context).toHaveProperty('sales');
    expect(context).toHaveProperty('top_hooks');

    // AC3 (concrete): the produced context.json renders the ideate template with
    // no unresolved placeholder left behind.
    const template = readFileSync(join(dir, 'prompts', 'ideate.md'), 'utf-8');
    const rendered = renderPrompt(template, ['context.json', 'feedback'], dir);
    expect(rendered).not.toMatch(/\{\{\s*context\.json\s*\}\}/);
    expect(rendered).toContain('"product_id"'); // the context.json body was inlined
  });
});

// ===========================================================================
// AC3 — prompt templates reference ONLY declared inputs (loader enforces it).
// ===========================================================================

describe('dogfood example flow — prompt templates reference only declared inputs (WI-359, AC3)', () => {
  it('loads cleanly: every template ref is within its station\'s declared scope', () => {
    // The unmutated example load succeeding IS the positive proof: the loader
    // emits UNDECLARED_PROMPT_INPUT for any out-of-scope {{ref}}.
    const result = loadFlow(EXAMPLE_FLOW);
    expect(result.ok).toBe(true);
  });

  it('rejects the flow when a template references an artifact outside the declared scope', () => {
    const { dir, flowPath } = freshExample();
    // ideate's declared inputs are [context.json]; idea.json is its OUTPUT and is
    // out of the WORKER prompt scope. Injecting it must be caught at load.
    patchFile(join(dir, 'prompts', 'ideate.md'), (s) => `${s}\n\nLeaked: {{idea.json}}\n`);

    expect(errorCodes(loadFlow(flowPath))).toContain('UNDECLARED_PROMPT_INPUT');
  });
});

// ===========================================================================
// Fail-closed config guards — the example is protected by the loader.
// ===========================================================================

describe('dogfood example flow — fail-closed config guards (WI-359)', () => {
  it('rejects the flow when the duckdb command is not in security.bash.allow (COMMAND_NOT_ALLOWLISTED)', () => {
    const { flowPath } = freshExample();
    // Drop duckdb from the allowlist — the declared command is now unauthorized.
    patchFile(flowPath, (s) => s.replace('["duckdb"]', '["sqlite3"]'));

    expect(errorCodes(loadFlow(flowPath))).toContain('COMMAND_NOT_ALLOWLISTED');
  });

  it('rejects the flow when the ideate station has no prompt_file (MISSING_PROMPT_TEMPLATE)', () => {
    const { flowPath } = freshExample();
    // Remove only the ideate WORKER prompt_file line (verify.md critic stays).
    patchFile(flowPath, (s) => s.replace(/^.*prompt_file: prompts\/ideate\.md.*$/m, ''));

    expect(errorCodes(loadFlow(flowPath))).toContain('MISSING_PROMPT_TEMPLATE');
  });

  it('rejects the flow when a declared prompt_file is absent on disk (PROMPT_FILE_NOT_FOUND)', () => {
    const { flowPath } = freshExample();
    patchFile(flowPath, (s) => s.replace('prompts/ideate.md', 'prompts/does-not-exist.md'));

    expect(errorCodes(loadFlow(flowPath))).toContain('PROMPT_FILE_NOT_FOUND');
  });
});

// ===========================================================================
// AC4 — the example is runnable as config: runExecutor drives a seeded card from
//   fetch_context through ideate + the gate to lane=done and writes idea.json.
//   Gated behind a DuckDB CLI (the entry station spawns duckdb); the model
//   adapter is stubbed (no real model call). Mirrors real-run.test.ts wiring.
// ===========================================================================

describe('dogfood example flow — runs end-to-end to lane=done (WI-359, AC4, requires duckdb)', () => {
  itDuck('drives the seeded card fetch_context -> ideate -> gate(pass) -> done and writes idea.json', async () => {
    const { dir, flowPath } = freshExample();
    // Seed fetch_context's input artifact from the committed example seed.
    cpSync(join(dir, 'request.example.json'), join(dir, 'request.json'));

    const flow = expectOk(loadFlow(flowPath));
    const db: ConduitDB = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());

    // The flow's project_root is '.', and fetch_context's duckdb args + artifact
    // I/O are relative, so the executor must run with cwd = the project dir.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      db.insertCard({
        run_id: DEFAULT_RUN_ID,
        id: 'entry',
        parent_id: null,
        lane: 'fetch_context',
        status: 'ready',
        attempt: 0,
        wave: 0,
        owned_paths: ['request.json', 'context.json', 'idea.json'],
        rework_count: 0,
      });

      const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
      const { io } = makeIO();

      await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

      const card = db.getCard(DEFAULT_RUN_ID, 'entry');
      // The card reached the terminal done lane (lane AND status), proving the
      // example routes end-to-end as pure config.
      expect(card?.lane).toBe('done');
      expect(card?.status).toBe('complete');

      // ideate's declared output artifact was written under the project root...
      const ideaPath = join(dir, 'idea.json');
      expect(existsSync(ideaPath)).toBe(true);
      expect(statSync(ideaPath).size).toBeGreaterThan(0);
      // ...and it carries the schema-validated fields the station declared.
      const idea = JSON.parse(readFileSync(ideaPath, 'utf-8')) as Record<string, unknown>;
      expect(idea).toHaveProperty('featured_variant');
      expect(idea).toHaveProperty('hook');
      expect(idea).toHaveProperty('filming_idea');
    } finally {
      process.chdir(prevCwd);
      db.close();
    }
  });
});
