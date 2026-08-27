/**
 * Example research-shaped harness flow — load-validation evidence (WI-590).
 *
 * This is the automatable half of the Phase-1 EXIT-CRITERION artifact: a
 * committed `examples/research-flow.yaml` an operator can run against the real
 * claude binary (the real-binary, token-spending run is delivered separately by
 * WI-595 as a flag-gated E2E test — NOT here). This file pins the fixture's
 * SHAPE and its load-time behavior with FAKE adapters, so the example cannot rot
 * into an invalid or fail-open state:
 *
 *   AC1 — the flow defines a `kind: harness` MAKER station and an ADVERSARIAL
 *         HARNESS CRITIC (a gate check whose critic uses a harness), i.e. the
 *         research maker+critic shape named in the exit criterion.
 *   AC2 — it loads and validates CLEAN against a registry that registers the
 *         referenced adapter (a fake here).
 *   AC3 — it fails closed with UNKNOWN_HARNESS_ADAPTER against an EMPTY registry
 *         (no adapters configured) — the fail-closed posture, not fail-open.
 *   AC4 — its harness stations declare owned_paths (inputs+outputs) and the flow
 *         enables enforce_owned_paths anchored at a project root, so the
 *         mandatory integrity gate is active.
 *
 * ── CONTRACT PINNED FOR B.A.'s FIXTURE (examples/research-flow.yaml) ──
 *   - references the adapter NAME `claude-headless` for BOTH the maker's
 *     `worker.harness` and the critic's `check.critic.harness` (one adapter —
 *     the real claude CLI in WI-595; "adversarial" comes from a distinct critic
 *     prompt/model, not a second adapter). Only the MAKER's harness is
 *     registry-validated at load (load.ts), so that name is load-bearing here.
 *   - flow-level `defaults.enforce_owned_paths: true` and a `project_root`.
 *   - every harness station declares non-empty `inputs` and `outputs`.
 *   - a BOUNDED `budgets.run.max_tokens` (WI-595 spends real tokens — keep the
 *     prompts tiny, the model cheap, and the per-run budget small).
 *   If B.A. needs a second/different adapter name, register another fake below
 *     and relax the name assertions — ping murdock.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { loadFlow } from '../flow/load';
import { createHarnessRegistry, makeFakeHarnessAdapter, type HarnessRegistry } from '../worker/harness-adapter';
import type { FlowConfig, StationConfig } from '../types/kernel';

/** The single harness adapter the example references (maker + critic). */
const ADAPTER = 'claude-headless';

/** Absolute path to the committed example fixture (repo-root relative). */
const FLOW_PATH = join(import.meta.dir, '../../examples/research-flow.yaml');

/** A registry that KNOWS `claude-headless` and can restrict tools. */
function configuredRegistry(): HarnessRegistry {
  return createHarnessRegistry([
    makeFakeHarnessAdapter({ name: ADAPTER, canRestrictTools: true, binaryPresent: true }).adapter,
  ]);
}

/** Load against the configured registry, failing loudly with the errors. */
function loadOk(): FlowConfig {
  const result = loadFlow(FLOW_PATH, { harnessRegistry: configuredRegistry() });
  if (!result.ok) {
    throw new Error(
      `examples/research-flow.yaml should load clean but did not:\n${JSON.stringify(result.errors, null, 2)}`,
    );
  }
  return result.flow;
}

function harnessMakerStations(flow: FlowConfig): StationConfig[] {
  return Object.values(flow.stations).filter((s) => s.kind === 'harness');
}

function harnessCriticStations(flow: FlowConfig): StationConfig[] {
  return Object.values(flow.stations).filter((s) => s.gateCheck?.criticHarness !== undefined);
}

describe('examples/research-flow.yaml — Phase-1 exit-criterion load validation (WI-590)', () => {
  // -------------------------------------------------------------------------
  // AC2 — loads clean against a registry that registers the referenced adapter.
  // -------------------------------------------------------------------------
  it('AC2: loads and validates clean against a registry that registers the referenced adapter', () => {
    const result = loadFlow(FLOW_PATH, { harnessRegistry: configuredRegistry() });
    if (!result.ok) {
      throw new Error(`expected a clean load, got errors:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC1 — the research maker + adversarial harness critic shape.
  // -------------------------------------------------------------------------
  it('AC1: defines a kind:harness maker station referencing the configured adapter', () => {
    const flow = loadOk();
    const makers = harnessMakerStations(flow);
    expect(makers.length).toBeGreaterThan(0);
    // At least one harness maker resolves against the registered adapter.
    expect(makers.some((s) => s.harness === ADAPTER)).toBe(true);
  });

  it('AC1: defines an adversarial harness critic (a gate check whose critic uses a harness)', () => {
    const flow = loadOk();
    const critics = harnessCriticStations(flow);
    expect(critics.length).toBeGreaterThan(0);
    // The critic runs on the same harness adapter (the real claude CLI in WI-595).
    expect(critics.some((s) => s.gateCheck?.criticHarness === ADAPTER)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC4 — owned-paths integrity gate anchored at the project root.
  // -------------------------------------------------------------------------
  it('AC4: enables enforce_owned_paths anchored at a declared project root', () => {
    const flow = loadOk();
    expect(flow.defaults?.enforceOwnedPaths).toBe(true);
    expect(flow.project_root).toBeDefined();
  });

  it('AC4: every harness station declares inputs and outputs (the owned_paths the gate anchors)', () => {
    const flow = loadOk();
    const makers = harnessMakerStations(flow);
    expect(makers.length).toBeGreaterThan(0);
    for (const station of makers) {
      expect(station.outputs.length).toBeGreaterThan(0);
      expect(station.inputs.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Sizing guard — WI-595 executes this exact flow on the real binary with real
  // tokens, so the fixture must cap its per-run budget.
  // -------------------------------------------------------------------------
  it('declares a bounded per-run token budget (WI-595 spends real tokens)', () => {
    const flow = loadOk();
    const maxTokens = flow.budgets?.run?.max_tokens;
    expect(typeof maxTokens).toBe('number');
    expect(maxTokens!).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // AC3 — fails closed against an empty registry.
  // -------------------------------------------------------------------------
  it('AC3: fails closed with UNKNOWN_HARNESS_ADAPTER against an empty registry', () => {
    const result = loadFlow(FLOW_PATH, { harnessRegistry: createHarnessRegistry([]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_HARNESS_ADAPTER')).toBe(true);
    }
  });
});
