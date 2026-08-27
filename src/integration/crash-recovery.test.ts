/**
 * Golden crash-recovery oracle — THE FINAL recovery-soundness proof (WI-308,
 * NFR-2). Success metric: "injected-crash runs with zero re-billed stations +
 * zero duplicated effects = 100%".
 *
 * Drives the SAME WI-291 reference flow as WI-307, but injects a crash at each
 * recoverable seam (checkpoint §5, outbox §5, heartbeat lease §9) and then runs
 * `conduit resume` (WI-306). The clean WI-307 run is the BASELINE; every
 * crash+resume run is compared against it. A deterministic stub adapter makes
 * baseline and recovered runs byte-comparable.
 *
 * The wiring lives in the reusable golden-oracle comparator
 * src/test-harness/crash-oracle.ts (B.A.'s impl — it imports the real kernel/CLI
 * and the WI-307 reference-flow-runner harness; it does NOT reimplement them).
 *
 * Contract this file pins for src/test-harness/crash-oracle.ts:
 *
 *   type CrashPoint =
 *     | 'mid_working_before_mark_done'   // §9 lease: worker dies before MARK_DONE
 *     | 'after_pure_checkpoint'          // §5 checkpoint: pure station already checkpointed
 *     | 'after_pending_outbox'           // §5 outbox: pending intent, side effect not committed
 *     | 'after_effectful_commit'         // §5 outbox: committed, crash before transition
 *   const ALL_CRASH_POINTS: CrashPoint[]
 *
 *   interface CardTerminal { lane: string; status: string }
 *   interface Baseline {
 *     terminalArtifact: string; modelCalls: number; effectCount: number;
 *     terminalState: Record<string, CardTerminal>;
 *   }
 *   interface OracleTrial {
 *     crashPoint: CrashPoint;
 *     terminalArtifact: string;
 *     modelCalls: number;                    // total across crash + resume
 *     effectCount: number;                   // recorded effectful side effects (publish)
 *     rebilledCheckpointedStations: number;  // checkpointed stations that re-ran (0 = sound)
 *     duplicateEffects: number;              // effects fired more than once (0 = sound)
 *     blindRetried: boolean;                 // did resume blind-retry a pending effect? (must be false)
 *     terminalState: Record<string, CardTerminal>;
 *   }
 *   function runBaseline(): Promise<Baseline>
 *   function runWithCrash(crashPoint: CrashPoint): Promise<OracleTrial>
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import {
  runBaseline,
  runWithCrash,
  ALL_CRASH_POINTS,
  type Baseline,
  type OracleTrial,
  type CrashPoint,
} from '../test-harness/crash-oracle';

let baseline: Baseline;
const trials = new Map<CrashPoint, OracleTrial>();

beforeAll(async () => {
  baseline = await runBaseline();
  for (const cp of ALL_CRASH_POINTS) {
    trials.set(cp, await runWithCrash(cp));
  }
}, 120_000);

// ---------------------------------------------------------------------------
// AC1 — crash mid-working → reconcile to interrupted → re-run → same terminal.
// ---------------------------------------------------------------------------

describe('crash mid-working before MARK_DONE (AC1)', () => {
  it('recovers to the same terminal state as the clean baseline', () => {
    const t = trials.get('mid_working_before_mark_done')!;
    // The station never checkpointed, so it legitimately re-runs — and lands
    // in exactly the baseline terminal state.
    expect(t.terminalState).toEqual(baseline.terminalState);
  });
});

// ---------------------------------------------------------------------------
// AC2 — crash after a pure-station checkpoint → skipped on resume (zero re-bill).
// ---------------------------------------------------------------------------

describe('crash after a pure-station checkpoint (AC2)', () => {
  it('skips the checkpointed station on resume — model-call count equals baseline', () => {
    const t = trials.get('after_pure_checkpoint')!;
    // A re-billed station would push modelCalls above the baseline.
    expect(t.modelCalls).toBe(baseline.modelCalls);
    expect(t.rebilledCheckpointedStations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — crash after pending outbox, before commit → no blind re-fire.
// ---------------------------------------------------------------------------

describe('crash after pending outbox write (AC3)', () => {
  it('does NOT blind-retry the side effect on resume (reconcile/escalate)', () => {
    const t = trials.get('after_pending_outbox')!;
    expect(t.blindRetried).toBe(false);
    expect(t.duplicateEffects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — crash after an effectful commit → exactly one recorded side effect.
// ---------------------------------------------------------------------------

describe('crash after an effectful commit (AC4)', () => {
  it('records exactly one side effect across crash + resume (idempotency key held)', () => {
    const t = trials.get('after_effectful_commit')!;
    expect(t.effectCount).toBe(1);
    expect(t.duplicateEffects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — golden oracle: crash+resume terminal artifact is byte-identical.
// ---------------------------------------------------------------------------

describe('golden artifact equivalence (AC5)', () => {
  it.each([
    'mid_working_before_mark_done',
    'after_pure_checkpoint',
    'after_effectful_commit',
  ] as CrashPoint[])('crash at %s resumes to a byte-identical terminal artifact', (cp) => {
    const t = trials.get(cp)!;
    expect(t.terminalArtifact).toBe(baseline.terminalArtifact);
  });
});

// ---------------------------------------------------------------------------
// AC6 — across ALL crash points: zero re-bill AND zero duplicated effects.
//        This is the NFR-2 success metric (100% of trials).
// ---------------------------------------------------------------------------

describe('recovery soundness across all crash points (AC6 / NFR-2)', () => {
  it('covers every recoverable seam', () => {
    // Guard: we actually exercised each injection point.
    expect(trials.size).toBe(ALL_CRASH_POINTS.length);
    expect(ALL_CRASH_POINTS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(ALL_CRASH_POINTS)('crash at %s re-bills zero checkpointed stations', (cp) => {
    expect(trials.get(cp)!.rebilledCheckpointedStations).toBe(0);
  });

  it.each(ALL_CRASH_POINTS)('crash at %s duplicates zero effects', (cp) => {
    expect(trials.get(cp)!.duplicateEffects).toBe(0);
  });
});
