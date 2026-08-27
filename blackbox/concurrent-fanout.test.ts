/**
 * concurrent fan-out journey — Concurrent transform fan-out, proven through the SHIPPED binary.
 *
 * The golden journey and every fault variant run at concurrency=1, so the
 * `--concurrency K>1` surface added in concurrent execution work (overlapping in-process transform
 * fan-out) and the per-child artifacts added in owned-directory artifact work (`output_scope: owned_dir`)
 * had NO black-box coverage — only white-box `runExecutor` tests with a stub
 * adapter. This closes that gap end-to-end:
 *
 *   signed Slack event → listener spawns real 'conduit run'
 *   → 'plan' transform fans out to N homogeneous 'review' children
 *   → the children run CONCURRENTLY (flow `defaults.concurrency: 3`, no listener
 *     change — the run resolves concurrency as flag > flow default > 1)
 *   → each writes its OWN findings.json into its OWN owned dir (no clobber)
 *   → deterministic 'gather' fan-in → terminal 'done'.
 *
 * The load-bearing proof of real overlap is `h.peakConcurrency() > 1`: the fake
 * gateway holds each /chat/completions call briefly open and records peak
 * in-flight, so the assertion fails if the reviewers were serialized.
 *
 * Completion is gated on the concrete per-child artifacts, NOT on `assert.exitCode`:
 * that derives 0 as soon as ANY card reaches a 'done' lane, which fires early for
 * a staggered run whose gated siblings are still pending. The findings files are
 * the unambiguous "every child truly finished" signal.
 *
 * BLACK-BOX: imports only the harness + bun:test — nothing from src/ (WI-678 gate).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness, CONCURRENT_FANOUT_CHILDREN } from "./harness/journey-harness";

const JOURNEY_TIMEOUT_MS = 90_000;

/**
 * Reads every child's findings.json, returning the parsed lens per child — or
 * throwing if any file is not yet written. Used both as a `waitFor` completion
 * gate (all children truly finished) and to assert per-child content.
 */
function readAllChildFindings(h: Awaited<ReturnType<typeof startJourneyHarness>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of CONCURRENT_FANOUT_CHILDREN) {
    const parsed = JSON.parse(h.assert.artifactContent(`${child.dir}/findings.json`)) as { finding: string };
    out[child.id] = parsed.finding;
  }
  return out;
}

describe("concurrent fan-out journey concurrent transform fan-out (shipped binary)", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness({ concurrentFanOut: true });
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "reviewers run concurrently and each writes its own artifact (no clobber)",
    async () => {
      // ── 1. Signed Slack trigger (stable event_id dedups any replay). ──
      const event = {
        event_id: "evt-fanout-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off the parallel review" },
      };
      const res = await h.sendSignedEvent(event);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // ── 2. Listener spawns a real 'conduit run' (observed, not mocked). ──
      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });

      // ── 3. Completion gate: every child's findings.json exists on disk. ──
      await h.waitFor(
        () => {
          try {
            readAllChildFindings(h);
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 60_000 },
      );

      // ── 4. Per-child artifacts: each child wrote its OWN lens into its OWN dir
      //      — proof of no clobber (not merely N files), exercising owned-directory artifact work e2e. ──
      const findings = readAllChildFindings(h);
      for (const child of CONCURRENT_FANOUT_CHILDREN) {
        expect(findings[child.id]).toBe(child.lens);
      }
      // ...and nothing landed at the un-scoped legacy project-root location.
      expect(() => h.assert.artifactContent("findings.json")).toThrow();

      // ── 5. THE load-bearing proof: the reviewer calls genuinely overlapped.
      //      Serialized reviewers would peak at 1; the concurrent batch (concurrent execution work)
      //      dispatches all ready siblings in one tick, so they coincide at the
      //      gateway. > 1 is the black-box signal that K>1 actually parallelized. ──
      expect(h.peakConcurrency()).toBeGreaterThan(1);

      // ── 6. And the run did not scrap (reached a terminal 'done' lane). ──
      await h.waitFor(
        () => {
          try {
            h.assert.exitCode(h.spawns.runInvocations()[0], 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 30_000 },
      );
      h.assert.exitCode(h.spawns.runInvocations()[0], 0);
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("concurrent fan-out journey fan-out cache-warming stagger (shipped binary)", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    // child_stagger_seconds > 0 holds every sibling except the first behind a
    // real release_at gate — exercising the executor's release-gate wait loop
    // end-to-end against the binary's REAL wall clock (white-box tests inject an
    // advancing clock + fast sleep; this proves the gate holds and then releases).
    h = await startJourneyHarness({ concurrentFanOut: true, childStaggerSeconds: 1 });
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "a real release gate delays but does not drop the gated siblings — all run to completion",
    async () => {
      const event = {
        event_id: "evt-fanout-stagger-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off the staggered review" },
      };
      const res = await h.sendSignedEvent(event);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });

      // The gated siblings are held ~1s behind the real clock, then released — the
      // gate must delay, not deadlock. Completion is proven by ALL children's
      // artifacts existing (the un-gated first AND the release-gated rest).
      await h.waitFor(
        () => {
          try {
            readAllChildFindings(h);
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 60_000 },
      );

      const findings = readAllChildFindings(h);
      for (const child of CONCURRENT_FANOUT_CHILDREN) {
        expect(findings[child.id]).toBe(child.lens); // gate delayed dispatch, did not drop work
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
