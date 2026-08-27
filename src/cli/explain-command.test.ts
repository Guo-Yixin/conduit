/**
 * CLI tests for the `conduit explain <flow.yaml>` subcommand (WI-445).
 *
 * Exercised through the same injected-seam entrypoint as the other commands:
 *
 *   export function main(argv: string[], deps: CliDeps): Promise<number>
 *
 * (see src/cli/cli.test.ts for the seam). `explain` must be wired into main()'s
 * switch as a read-only handler (`cmdExplain`) that:
 *   - loads the flow via the same fail-closed loadFlow() path `run` uses,
 *   - on success prints renderFlow(flow) (WI-443/444) line-by-line via io.out and
 *     resolves to exit 0,
 *   - on validation failure prints one `validation error [code]: message` line per
 *     error via io.err, prints NO diagram, and resolves non-zero,
 *   - with no flow path prints a usage line via io.err and resolves non-zero,
 *   - NEVER touches the state DB, the model adapter, or the engine.
 *
 * The read-only guarantee (AC5) is enforced structurally: every test injects a
 * `db`, `adapter`, and `runEngine` that THROW if touched, so any command path
 * that opens the DB, calls the model, or starts the engine fails the test.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { main, type CliDeps } from './main';
import type { ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { loadFlow } from '../flow/load';
import { renderFlow } from './explain-renderer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXAMPLES = join(import.meta.dir, '..', '..', 'examples');
const FLOWS = join(import.meta.dir, '..', '..', 'fixtures', 'flows');

// A valid flow with NO Slack egress channel (so no boot-secret gating is even
// relevant — explain is read-only and must not gate on run-time secrets).
const VALID_FLOW = join(EXAMPLES, 'tiktok-shoppable-ideas', 'flow.yaml');
// A flow that fails loadFlow validation (cyclic depends_on).
const INVALID_FLOW = join(FLOWS, 'invalid', 'cyclic-deps.flow.yaml');
// A path that does not exist on disk.
const MISSING_FLOW = join(FLOWS, 'this-file-does-not-exist.flow.yaml');

// ---------------------------------------------------------------------------
// Captured IO + throwing seams (read-only enforcement)
// ---------------------------------------------------------------------------

function makeIO() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  io = makeIO();
});

/** A ConduitDB stand-in that throws on ANY access — explain must never use it. */
const throwingDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`explain touched deps.db (.${String(prop)}) — it must be read-only`);
    },
  },
) as unknown as ConduitDB;

/** A ModelAdapter that throws if called — explain makes no model call. */
const throwingAdapter = {
  call: () => {
    throw new Error('explain called the model adapter — it must make no model call');
  },
} as unknown as ModelAdapter;

/** A runEngine that throws if invoked — explain never starts the engine. */
const throwingRunEngine: CliDeps['runEngine'] = async () => {
  throw new Error('explain started the engine — it must be read-only');
};

function makeDeps(): CliDeps {
  return {
    io,
    now: () => 1_000,
    db: throwingDb,
    adapter: throwingAdapter,
    runEngine: throwingRunEngine,
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

// ===========================================================================
// AC1 / AC2 — valid flow → renderFlow diagram on stdout, exit 0.
// ===========================================================================

describe('conduit explain — valid flow (AC1, AC2)', () => {
  it('prints the renderFlow diagram via io.out and exits 0', async () => {
    const code = await main(['explain', VALID_FLOW], makeDeps());

    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines.length).toBeGreaterThan(0);

    // The printed output is exactly the renderFlow() diagram for this flow:
    // every non-blank diagram line appears in the captured stdout.
    const loaded = loadFlow(VALID_FLOW);
    if (!loaded.ok) throw new Error(`fixture ${VALID_FLOW} should load`);
    const printed = io.lines.join('\n');
    for (const line of renderFlow(loaded.flow).split('\n').filter((l) => l.trim().length > 0)) {
      expect(printed).toContain(line);
    }
  });

  it('includes the flow-name header and at least one station id (AC2)', async () => {
    const code = await main(['explain', VALID_FLOW], makeDeps());
    expect(code).toBe(0);
    const printed = io.lines.join('\n');
    expect(printed).toContain('tiktok-shoppable-ideas'); // flow-name header
    expect(printed).toContain('fetch_context'); // a station id from the fixture
  });
});

// ===========================================================================
// AC3 — invalid flow → validation errors, NO diagram, non-zero exit.
// ===========================================================================

describe('conduit explain — invalid flow (AC3)', () => {
  it('prints one validation-error line per error, no diagram, and exits non-zero', async () => {
    const code = await main(['explain', INVALID_FLOW], makeDeps());

    expect(code).not.toBe(0);
    // At least one error, and EVERY error line uses the run-parity format.
    expect(io.errors.length).toBeGreaterThan(0);
    for (const line of io.errors) {
      expect(line).toMatch(/^validation error \[[A-Z0-9_]+\]: /);
    }
    // The cyclic-deps fixture surfaces the cycle error code.
    expect(io.errors.join('\n')).toContain('CYCLIC_DEPENDS_ON');
    // NO diagram is printed on a validation failure.
    expect(io.lines).toEqual([]);
  });
});

// ===========================================================================
// AC (usage) — no flow path → usage line, non-zero exit.
// ===========================================================================

describe('conduit explain — no flow path', () => {
  it('prints a usage line via io.err and exits non-zero', async () => {
    const code = await main(['explain'], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toContain('usage: conduit explain <flow.yaml>');
    expect(io.lines).toEqual([]); // no diagram
  });
});

// ===========================================================================
// AC4 — missing / unreadable path → clear error, non-zero exit (run parity).
// ===========================================================================

describe('conduit explain — missing/unreadable path (AC4)', () => {
  it('prints a clear error naming the path and exits non-zero, with no diagram', async () => {
    const code = await main(['explain', MISSING_FLOW], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.length).toBeGreaterThan(0);
    expect(io.errors.join('\n')).toContain('this-file-does-not-exist');
    expect(io.lines).toEqual([]); // no diagram
  });
});

// ===========================================================================
// AC5 — read-only: no DB / adapter / engine / filesystem-write side effects.
// ===========================================================================

describe('conduit explain — read-only, zero side effects (AC5)', () => {
  it('renders a valid flow without touching the db, adapter, or engine', async () => {
    // makeDeps() supplies a db/adapter/runEngine that throw on use; reaching
    // exit 0 with a printed diagram proves none of them were touched.
    const code = await main(['explain', VALID_FLOW], makeDeps());
    expect(code).toBe(0);
    expect(io.lines.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AC6 — explain is registered: unknown-command usage line lists it.
// ===========================================================================

describe('conduit explain — registered in main() (AC6)', () => {
  it('lists explain among the available commands in the unknown-command message', async () => {
    const code = await main(['definitely-not-a-command'], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toContain('explain');
  });
});
