/**
 * FR-1 Golden Studio journey (WI-679) — the spine.
 *
 * Drives the SHIPPED conduit binary through a full Studio HITL journey, proven
 * entirely through public surfaces (spawn observation, the fake Slack server's
 * recorded traffic, the journal/explain surface, and the artifact on disk):
 *
 *   signed Slack event  → listener spawns real 'conduit run' (observed)
 *   → HITL rank ask posted to fake Slack
 *   → Socket Mode button reply for the ask's correlation id
 *   → listener auto-spawns 'conduit resume' (observed)
 *   → terminal 'done', delivery artifact on disk, exactly-once Slack effects.
 *
 * BLACK-BOX: imports only the WI-677 harness + bun:test — nothing from src/
 * (WI-678 gate). The harness spawns the binary and speaks HTTP/ws to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const JOURNEY_TIMEOUT_MS = 90_000;

/** Parse a spawned run/resume's run id from its argv (`--run-id` / `--run`). */
function runIdFromArgs(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

const ASK_MARKER = "select a candidate";

describe("FR-1 Golden Studio journey", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness();
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "signed event drives run → HITL ask → socket reply → resume → done with exactly-once effects",
    async () => {
      // ── 1. Signed Slack trigger (stable event_id so the accept gate dedups any replay). ──
      const event = {
        event_id: "evt-golden-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off the studio journey" },
      };
      const res = await h.sendSignedEvent(event);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // ── 2. Listener spawns a real 'conduit run' (observed, not mocked). ──
      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runs = h.spawns.runInvocations();
      const runId = runIdFromArgs(runs[0]!.args);
      expect(runId).toBeDefined();
      const cardId = `entry-${runId}`;

      // ── 3. HITL rank ask arrives at the fake Slack server. ──
      await h.waitFor(() => h.slack.posts().some((p) => (p.text ?? "").includes(ASK_MARKER)), {
        timeoutMs: 30_000,
      });

      // ── 4. Discover the ask's correlation id. This is a NON-AC internal lookup
      //      (the correlation id is not printed by any CLI surface — the journal
      //      CLI shows the ask's span NAME but not its attributes), so a direct
      //      journal read via explainField is appropriate here; the AC4 journey
      //      narration below is asserted through the REAL CLI (runExplain). ──
      let correlationId: string | undefined;
      await h.waitFor(
        () => {
          const reason = h.assert.explainField(cardId, "reason", { runId });
          if (typeof reason === "string" && reason.startsWith("hitl::")) {
            correlationId = reason;
            return true;
          }
          return false;
        },
        { timeoutMs: 30_000 },
      );
      expect(correlationId).toMatch(/^hitl::/);

      // ── 5. Socket Mode button reply for the ask's correlation id → auto-resume. ──
      await h.sendInteractiveResponse(correlationId!, "candidate-1");
      await h.waitFor(() => h.spawns.resumeInvocations().length >= 1, { timeoutMs: 30_000 });
      const resumes = h.spawns.resumeInvocations();
      expect(resumes.length).toBe(1);

      // ── 6. Terminal success via a public surface (run reaches 'done' lane). ──
      await h.waitFor(
        () => {
          try {
            h.assert.exitCode(runs[0], 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 45_000 },
      );
      h.assert.exitCode(runs[0], 0);

      // ── AC4: the run's journey, asserted through REAL public CLI surfaces. ──
      // Composite-surface interpretation (ruled acceptable by team-lead + Lynch;
      // zero product change). NOTE for future readers: 'conduit explain' renders
      // only the STATIC flow structure — it has no run/journal awareness — so the
      // real run-narration surface is 'conduit journal inspect <cardId> --run
      // <runId>', spawned here through the shipped binary via runConduit (NOT a
      // journal-DB read). The journey stages map to user-visible CLI markers:
      //   ask       → the 'hitl.ask' span line
      //   selection → the 'hitl.selection' span line
      //   done      → the 'entered_lane: … → done' terminal transition
      // Resume is a process-lifecycle event with no CLI marker; it is asserted
      // via the observed 'conduit resume' child (resumeInvocations, step 5) — a
      // stronger proof than a printed word, since the post-resume 'select → done'
      // transition asserted here only occurs after resume actually ran.
      const journey = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
      expect(journey.exitCode).toBe(0);
      expect(journey.stdout).toMatch(/hitl\.ask/); // ask posted
      expect(journey.stdout).toMatch(/hitl\.selection/); // human selection recorded
      expect(journey.stdout).toMatch(/(?:→|->)\s*done|\bdone\b/); // terminal done reached

      // ── 7. Delivery artifact on disk with the expected content. ──
      expect(h.assert.artifactContent("delivery.txt")).toContain(
        "black-box journey harness delivery payload",
      );

      // ── 8. Exactly-once Slack effects across the resume boundary. ──
      const askPosts = h.slack.posts().filter((p) => (p.text ?? "").includes(ASK_MARKER));
      expect(askPosts.length).toBe(1);
      expect(h.slack.completeUploadCount()).toBe(1);
    },
    JOURNEY_TIMEOUT_MS,
  );
});
