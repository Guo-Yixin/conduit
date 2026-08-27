/**
 * End-to-end synthetic reference-flow run — the PRIMARY MVP validation
 * deliverable (WI-307, SPEC §8, integration-last).
 *
 * This drives the WI-291 reference flow.yaml end-to-end through the ASSEMBLED
 * kernel (real flow loader, FSM, claim, tick, transform/deterministic runtimes,
 * checkpoint/outbox, QC gate+rank, dag fan-out/fan-in, egress/HITL, CLI). The
 * wiring lives in the reusable fault-injection driver
 * src/test-harness/reference-flow-runner.ts (B.A.'s impl — it imports the REAL
 * modules; it is NOT an empty scaffold and does NOT reimplement them). Model
 * calls use a DETERMINISTIC STUB adapter and a virtual clock so a run is fully
 * reproducible (the 30s hold_timeout must NOT be a real wall-clock wait).
 *
 * These tests assert that EVERY kernel branch fires. They are behavioral: the
 * outcomes asserted here (assembled artifact delivered, effectful-exactly-once,
 * quorum fan-in, scrap-at-cap, hold-timeout) can only be produced by the real
 * assembled engine — a divergent stand-in could not.
 *
 * Contract this file pins for src/test-harness/reference-flow-runner.ts:
 *
 *   interface ReferenceRunOptions {
 *     gateRejectsBeforePass?: number; // gate-check rejects this many times, then passes (default 0)
 *     hitlReply?: string | null;      // rank HITL human selection; null = no reply → hold_timeout fires
 *     forceScrapChild?: boolean;      // make one child exhaust its rework cap → scrap (drives quorum + scrap-at-cap)
 *     simulateResume?: boolean;       // re-drive the effectful station to prove outbox dedup
 *   }
 *   interface CardState { lane: string; status: string; attempt: number }
 *   interface ReferenceRunResult {
 *     cardStates: Record<string, CardState>;
 *     delivered: boolean;             // assembled artifact delivered via egress
 *     effectfulPostCount: number;     // real side effects for the effectful (publish) station
 *     gateRejections: number;
 *     hitlHoldPosted: boolean;
 *     hitlSelection: string | null;
 *     rankAutoPicked: boolean;        // FR-14 — must always be false
 *     droppedChildren: string[];      // fan-in quorum dropped children
 *     scrappedCards: string[];
 *     onTimeoutApplied: string | null;// the on_timeout action applied when no HITL reply
 *     parentLane: string;             // terminal lane of the parent/assembler
 *   }
 *   function runReferenceFlow(opts?: ReferenceRunOptions): Promise<ReferenceRunResult>
 */
import { describe, it, expect } from 'bun:test';
import { runReferenceFlow } from '../test-harness/reference-flow-runner';

const TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// AC1 — clean path reaches lane=done with the assembled artifact delivered.
// ---------------------------------------------------------------------------

describe('reference flow — clean path (AC1)', () => {
  it(
    'drives the flow to lane=done and delivers the assembled artifact',
    async () => {
      const r = await runReferenceFlow();
      expect(r.parentLane).toBe('done');
      expect(r.delivered).toBe(true);
      // No faults → nothing scrapped, no rework, no timeout.
      expect(r.scrappedCards).toHaveLength(0);
      expect(r.gateRejections).toBe(0);
      expect(r.onTimeoutApplied).toBeNull();
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC2 — gate-check branch: rejected ≥1, routed via on_reject back-edge, passes.
// ---------------------------------------------------------------------------

describe('reference flow — gate-check back-edge (AC2)', () => {
  it(
    'rejects at least once, routes via the on_reject back-edge, then passes through to done',
    async () => {
      const r = await runReferenceFlow({ gateRejectsBeforePass: 1 });
      expect(r.gateRejections).toBeGreaterThanOrEqual(1); // it was rejected
      expect(r.delivered).toBe(true); // …and still reached done after rework
      expect(r.parentLane).toBe('done');
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC3 — rank-check branch: curated, selection via HITL hold, never auto-picked.
// ---------------------------------------------------------------------------

describe('reference flow — rank-check via HITL (AC3)', () => {
  it(
    'curates candidates and applies a HITL-hold selection without auto-picking',
    async () => {
      const r = await runReferenceFlow({ hitlReply: 'variant-B' });
      expect(r.hitlHoldPosted).toBe(true); // a HITL hold was posted (not auto-resolved)
      expect(r.rankAutoPicked).toBe(false); // FR-14
      expect(r.hitlSelection).toBe('variant-B'); // the human reply drove the selection
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC4 — effectful station side effect recorded EXACTLY ONCE via the outbox.
// ---------------------------------------------------------------------------

describe('reference flow — effectful exactly-once (AC4)', () => {
  it(
    'records the effectful side effect exactly once even across a resume',
    async () => {
      const r = await runReferenceFlow({ simulateResume: true });
      // The outbox idempotency key prevents a duplicate publish on resume.
      expect(r.effectfulPostCount).toBe(1);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC5 — fan-in quorum policy + dropped children, AND scrap-at-cap.
// ---------------------------------------------------------------------------

describe('reference flow — quorum fan-in + scrap-at-cap (AC5)', () => {
  it(
    'scraps a child that exhausts its rework cap, drops it, and proceeds via quorum(2)',
    async () => {
      const r = await runReferenceFlow({ forceScrapChild: true });
      // scrap-at-cap: the exhausted child reached the scrap terminal.
      expect(r.scrappedCards.length).toBeGreaterThanOrEqual(1);
      const scrapped = r.scrappedCards[0]!;
      expect(r.cardStates[scrapped]!.lane).toBe('scrap');
      // fan-in quorum(2): the dropped child is recorded, and 2-of-3 still assembles + delivers.
      expect(r.droppedChildren).toContain(scrapped);
      expect(r.delivered).toBe(true);
      expect(r.parentLane).toBe('done');
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC6 — hold-timeout applies the configured on_timeout when no reply arrives.
// ---------------------------------------------------------------------------

describe('reference flow — hold-timeout on_timeout (AC6)', () => {
  it(
    'applies the configured on_timeout (scrap) when no human reply arrives in hold_timeout',
    async () => {
      // hitlReply:null → no human responds; the reference flow's egress sets on_timeout: scrap.
      const r = await runReferenceFlow({ hitlReply: null });
      expect(r.onTimeoutApplied).toBe('scrap');
      expect(r.rankAutoPicked).toBe(false); // a timeout NEVER silently picks a winner (FR-14)
    },
    TIMEOUT,
  );
});
