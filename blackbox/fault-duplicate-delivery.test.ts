/**
 * FR-2 F-3: duplicate Slack event AND duplicate button tap (WI-682).
 *
 * Drives the golden journey, then redelivers the IDENTICAL signed Slack event
 * (same event_id + timestamp → same signature) and double-taps the same ask
 * (same correlation id) over the Socket Mode fake. Proves the shipped binary
 * (the pre-public ingress-deduplication review dedup / first-pick-wins) holds exactly-once through the duplicates:
 *   - the duplicate event spawns NO second run (both map to one derived run id),
 *   - exactly one HITL selection is applied (the second tap is a no-op),
 *   - the fake Slack records exactly one ask post and one delivery upload.
 *
 * BLACK-BOX: imports only the WI-677 harness + bun:test (WI-678 gate).
 *
 * NOTE on spawn count: a held run is re-driven once by the listener's periodic
 * recovery, so BOTH a single-event journey and this duplicate-event journey
 * produce two `conduit run` OS spawns of the SAME run id (verified empirically).
 * The duplicate event therefore adds NO new run — the dedup assertion is on the
 * number of DISTINCT run ids (exactly one), not the raw OS-spawn count.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const FAULT_TIMEOUT_MS = 120_000;
const ASK_MARKER = "select a candidate";

/** Parse a spawned run/resume's run id from its argv (`--run-id` / `--run`). */
function runIdFromArgs(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

const distinctRunIds = (records: { args: string[] }[]): Set<string> =>
  new Set(records.map((r) => runIdFromArgs(r.args)).filter((id): id is string => id !== undefined));

describe("FR-2 F-3: duplicate event + duplicate tap are deduplicated", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness();
  }, FAULT_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "one run, one selection, exactly-once Slack effects across identical redelivery + double-tap",
    async () => {
      // ── Redeliver the IDENTICAL signed event twice (same event_id + timestamp
      //    ⇒ byte-identical body + signature, a true provider re-delivery). ──
      const timestampSec = Math.floor(Date.now() / 1000);
      const event = {
        event_id: "evt-duplicate-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off, then again" },
      };
      const first = await h.sendSignedEvent(event, { timestampSec });
      const second = await h.sendSignedEvent(event, { timestampSec });
      expect(first.status).toBeGreaterThanOrEqual(200);
      expect(first.status).toBeLessThan(300);
      expect(second.status).toBeGreaterThanOrEqual(200);
      expect(second.status).toBeLessThan(300);

      // ── A run is spawned; the duplicate event must NOT create a second run. ──
      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runId = runIdFromArgs(h.spawns.runInvocations()[0]!.args);
      expect(runId).toBeDefined();
      const cardId = `entry-${runId}`;

      // ── HITL ask arrives; discover its correlation id (non-AC internal lookup —
      //    the id is not printed by any CLI). ──
      await h.waitFor(() => h.slack.posts().some((p) => (p.text ?? "").includes(ASK_MARKER)), {
        timeoutMs: 30_000,
      });
      let correlationId: string | undefined;
      await h.waitFor(
        () => {
          const r = h.assert.explainField(cardId, "reason", { runId });
          if (typeof r === "string" && r.startsWith("hitl::")) {
            correlationId = r;
            return true;
          }
          return false;
        },
        { timeoutMs: 30_000 },
      );

      // ── Double-tap the SAME ask (same correlation id) over Socket Mode. ──
      await h.sendInteractiveResponse(correlationId!, "candidate-1");
      await h.sendInteractiveResponse(correlationId!, "candidate-1");

      // ── The run resumes and reaches 'done'. ──
      await h.waitFor(() => h.spawns.resumeInvocations().length >= 1, { timeoutMs: 30_000 });
      await h.waitFor(
        () => {
          try {
            h.assert.exitCode(h.spawns.runInvocations()[0], 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 45_000 },
      );

      // ── Settle: give any duplicate-driven second run / ask / upload / selection
      //    a bounded window to (wrongly) appear before asserting exactly-once —
      //    the dedup race is precisely what this fault variant probes. ──
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      // ── Dedup: both identical events derived ONE run id (no second run). ──
      expect(distinctRunIds(h.spawns.runInvocations()).size).toBe(1);
      expect(distinctRunIds(h.spawns.resumeInvocations()).size).toBe(1);

      // ── Exactly-once Slack effects across BOTH duplicates. ──
      const askPosts = h.slack.posts().filter((p) => (p.text ?? "").includes(ASK_MARKER));
      expect(askPosts.length).toBe(1);
      expect(h.slack.completeUploadCount()).toBe(1);

      // ── First-pick-wins on the real CLI surface: exactly ONE hitl.selection in
      //    the run narration (the second tap applied no selection), and the run
      //    reached terminal 'done' once. ──
      const journey = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
      expect(journey.exitCode).toBe(0);
      const selectionCount = (journey.stdout.match(/hitl\.selection/g) ?? []).length;
      expect(selectionCount).toBe(1);
      const doneCount = (journey.stdout.match(/(?:→|->)\s*done/g) ?? []).length;
      expect(doneCount).toBe(1);
    },
    FAULT_TIMEOUT_MS,
  );
});
