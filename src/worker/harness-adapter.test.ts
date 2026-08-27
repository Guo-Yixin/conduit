/**
 * Harness adapter seam (WI-560).
 *
 * This is the SEAM item: it defines the whole HarnessAdapter contract that the
 * dependent items (WI-563 load validation, WI-564 spawn runner, WI-565 executor
 * wiring, WI-567 real claude-headless adapter, WI-573 doctor/explain) build
 * against. The interface must therefore enumerate ALL FIVE capabilities:
 *
 *   (a) a bounded `invoke` taking the rendered prompt, mounted declared inputs,
 *       the tools allowlist, and a wall-clock timeout, returning produced-output
 *       REFERENCES plus per-call usage;                                    (AC1)
 *   (b) per-call structured usage {tokens,cost} OR an EXPLICIT unknown-usage
 *       signal ({ unknown: true });                                        (AC1)
 *   (c) a STATIC `reportsUsage` capability flag, queryable WITHOUT invoking and
 *       DISTINCT from the per-call unknown signal in (b);                  (AC2)
 *   (d) a binary presence/executability probe (`probeBinary`) usable by load
 *       validation + doctor without a full invocation;                     (AC3)
 *   (e) a `canRestrictTools` tools-narrowing/expressibility query answering
 *       whether the adapter can enforce/narrow the declared allowlist.     (AC4)
 *
 * Registry contract:
 *   - `createHarnessRegistry([...])` resolves an adapter by NAME only — a flow
 *     never supplies a raw command line; invocation definitions live in engine
 *     config (AC5). `resolve` returns { ok: true, adapter } for a registered
 *     name and { ok: false, error } NAMING the requested adapter otherwise.
 *     The whole surface is table-testable with no I/O (AC7).
 *
 * Test-fake contract (AC6):
 *   - `makeFakeHarnessAdapter(...)` is the canonical, engine-EXPORTED fake (not
 *     a local helper) so downstream item tests import ONE deterministic fake
 *     rather than each re-implementing it. It implements the full interface —
 *     invoke, reportsUsage, canRestrictTools, probeBinary — returns scripted
 *     outputs/usage with NO network and NO real process, records every call, and
 *     throws on over-call, in the spirit of makeStubAdapter (transform.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import {
  createHarnessRegistry,
  makeFakeHarnessAdapter,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
  type UsageReport,
} from './harness-adapter';

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

/** A concrete usage report (the common {tokens,cost} arm of UsageReport). */
const KNOWN_USAGE: UsageReport = { tokens: 1234, cost: 0.0456 };

/** A scripted successful result: one produced-output reference + known usage. */
function scriptedResult(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    outputs: [{ name: 'artifact', path: '/work/out/artifact.md' }],
    usage: KNOWN_USAGE,
    ...overrides,
  };
}

/** A representative bounded invocation carrying all four AC1 inputs. */
function invocation(overrides: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return {
    prompt: 'do the task',
    inputs: [{ name: 'task', path: '/work/in/task.md' }],
    tools: ['Read', 'Write', 'Bash'],
    timeoutMs: 30_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC5 / AC7 — engine-config registry: name resolution, unknown-name rejection,
//             table-testable with no I/O.
// ---------------------------------------------------------------------------

describe('harness registry (AC5, AC7)', () => {
  it('resolves a registered adapter by name and returns that exact adapter', () => {
    const claude = makeFakeHarnessAdapter({ name: 'claude-headless' }).adapter;
    const registry = createHarnessRegistry([claude]);

    const resolved = registry.resolve('claude-headless');

    expect(resolved.ok).toBe(true);
    // The narrowed success arm carries the SAME adapter instance that was registered.
    if (resolved.ok) {
      expect(resolved.adapter).toBe(claude);
      expect(resolved.adapter.name).toBe('claude-headless');
    }
  });

  it('rejects an unknown name with an error that names the requested adapter', () => {
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless' }).adapter,
    ]);

    const resolved = registry.resolve('gpt-headless');

    expect(resolved.ok).toBe(false);
    // AC5: the not-found error must NAME the requested adapter so an operator
    // sees which engine-config entry is missing.
    if (!resolved.ok) {
      expect(resolved.error).toContain('gpt-headless');
    }
  });

  it('resolves each registered adapter independently (table-testable, no I/O)', () => {
    const adapters = ['claude-headless', 'codex-headless', 'aider-headless'].map(
      (name) => makeFakeHarnessAdapter({ name }).adapter,
    );
    const registry = createHarnessRegistry(adapters);

    // Every registered name resolves back to its own adapter — pure in-memory.
    for (const adapter of adapters) {
      const resolved = registry.resolve(adapter.name);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.adapter).toBe(adapter);
    }
    // list() enumerates exactly the registered names.
    expect([...registry.list()].sort()).toEqual(
      ['aider-headless', 'claude-headless', 'codex-headless'],
    );
  });

  it('the resolve surface accepts only a name — a flow cannot supply a command line (AC5)', () => {
    // Structural guarantee: resolve() takes a bare string, so there is no channel
    // for a flow.yaml to inject a raw executable/args. Invocation definitions live
    // in engine config (the adapters passed to createHarnessRegistry) only.
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless' }).adapter,
    ]);
    const resolve: (name: string) => ReturnType<typeof registry.resolve> = registry.resolve;
    expect(resolve('claude-headless').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 / AC3 / AC4 — static/probe capabilities queryable WITHOUT invoking.
// ---------------------------------------------------------------------------

describe('harness adapter capabilities queryable without invocation (AC2, AC3, AC4)', () => {
  it('exposes reportsUsage and canRestrictTools as static flags, read before any invoke', () => {
    const { adapter, calls } = makeFakeHarnessAdapter({
      name: 'claude-headless',
      reportsUsage: true,
      canRestrictTools: true,
    });

    // AC2 / AC4: both are readable with zero invocations.
    expect(adapter.reportsUsage).toBe(true);
    expect(adapter.canRestrictTools).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('models a usage-blind adapter (reportsUsage=false) distinctly from a per-call unknown signal', () => {
    const { adapter } = makeFakeHarnessAdapter({
      name: 'aider-headless',
      reportsUsage: false,
    });
    // The STATIC capability: this adapter can never report usage at all — the
    // signal WI-573 renders as the usage-blind indicator, without invoking.
    expect(adapter.reportsUsage).toBe(false);
  });

  it('models a tools-blind adapter (canRestrictTools=false) for load validation to fail-closed on', () => {
    const { adapter } = makeFakeHarnessAdapter({
      name: 'codex-headless',
      canRestrictTools: false,
    });
    // AC4: WI-563 consumes this to require the unrestricted_tools waiver when the
    // adapter cannot narrow the declared allowlist.
    expect(adapter.canRestrictTools).toBe(false);
  });

  it('probes binary presence/executability without a full invocation', async () => {
    const present = makeFakeHarnessAdapter({ name: 'claude-headless', binaryPresent: true });
    const missing = makeFakeHarnessAdapter({ name: 'ghost-headless', binaryPresent: false });

    const presentProbe = await present.adapter.probeBinary();
    const missingProbe = await missing.adapter.probeBinary();

    // AC3: present/invocable vs missing/non-executable.
    expect(presentProbe.present).toBe(true);
    expect(missingProbe.present).toBe(false);
    // The probe did NOT invoke the adapter (no scripted result consumed).
    expect(present.calls).toHaveLength(0);
    expect(missing.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC6 — bounded invoke + the full offline lifecycle on the test-fake.
// ---------------------------------------------------------------------------

describe('harness adapter invoke lifecycle on the test-fake (AC1, AC6)', () => {
  it('invoke returns scripted produced-output references and structured usage', async () => {
    const result = scriptedResult();
    const { adapter, calls } = makeFakeHarnessAdapter({
      name: 'claude-headless',
      reportsUsage: true,
      results: [result],
    });

    const got = await adapter.invoke(invocation());

    // AC1: produced-output REFERENCES (name+path), not bytes, are returned.
    expect(got.outputs).toEqual([{ name: 'artifact', path: '/work/out/artifact.md' }]);
    // AC1: per-call structured usage flows back for budget attribution.
    expect(got.usage).toEqual({ tokens: 1234, cost: 0.0456 });
    // The invocation was recorded exactly once, carrying all four bounded inputs.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe('do the task');
    expect(calls[0]!.inputs).toEqual([{ name: 'task', path: '/work/in/task.md' }]);
    expect(calls[0]!.tools).toEqual(['Read', 'Write', 'Bash']);
    // AC1: the timeout bound is carried through to the adapter.
    expect(calls[0]!.timeoutMs).toBe(30_000);
  });

  it('invoke can return an EXPLICIT unknown-usage signal distinct from the reportsUsage flag', async () => {
    // reportsUsage=true (the adapter CAN report usage in general) yet THIS call
    // returns { unknown: true } — proving the per-call signal (AC1) is separate
    // from the static capability (AC2).
    const { adapter } = makeFakeHarnessAdapter({
      name: 'claude-headless',
      reportsUsage: true,
      results: [scriptedResult({ usage: { unknown: true } })],
    });

    const got = await adapter.invoke(invocation());

    expect(adapter.reportsUsage).toBe(true);
    expect(got.usage).toEqual({ unknown: true });
  });

  it('drives the full offline lifecycle — probe then invoke — with no network and no real process', async () => {
    const { adapter, calls } = makeFakeHarnessAdapter({
      name: 'claude-headless',
      reportsUsage: true,
      canRestrictTools: true,
      binaryPresent: true,
      results: [scriptedResult()],
    });

    // 1. Capability + probe checks (what WI-563 load validation runs first).
    expect(adapter.canRestrictTools).toBe(true);
    expect((await adapter.probeBinary()).present).toBe(true);
    // 2. The bounded invocation itself.
    const got = await adapter.invoke(invocation({ tools: ['Read'] }));

    expect(got.outputs[0]!.name).toBe('artifact');
    expect(calls[0]!.tools).toEqual(['Read']);
  });

  it('returns scripted results deterministically in order and throws on over-call', async () => {
    const { adapter } = makeFakeHarnessAdapter({
      name: 'claude-headless',
      results: [
        scriptedResult({ outputs: [{ name: 'a', path: '/work/out/a.md' }] }),
        scriptedResult({ outputs: [{ name: 'b', path: '/work/out/b.md' }] }),
      ],
    });

    const first = await adapter.invoke(invocation());
    const second = await adapter.invoke(invocation());
    expect(first.outputs[0]!.name).toBe('a');
    expect(second.outputs[0]!.name).toBe('b');

    // Over-call past the scripted results throws loudly — mirrors makeStubAdapter,
    // catching a station that invokes more times than the test scripted.
    await expect(adapter.invoke(invocation())).rejects.toThrow(/over-called|no.*scripted|no.*result/i);
  });

  it('is usable as a HarnessAdapter through the interface type (structural conformance)', () => {
    // The fake IS a full HarnessAdapter — assigning to the interface type proves
    // it carries every member the downstream items depend on.
    const adapter: HarnessAdapter = makeFakeHarnessAdapter({ name: 'claude-headless' }).adapter;
    expect(typeof adapter.name).toBe('string');
    expect(typeof adapter.reportsUsage).toBe('boolean');
    expect(typeof adapter.canRestrictTools).toBe('boolean');
    expect(typeof adapter.probeBinary).toBe('function');
    expect(typeof adapter.invoke).toBe('function');
  });
});
