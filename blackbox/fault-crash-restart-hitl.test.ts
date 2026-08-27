/**
 * FR-2 F-4: kill/restart around HITL (WI-683) — the last fault variant.
 *
 * Drives the golden journey to the HITL ask, SIGKILLs the listener, restarts
 * `conduit listen` against the SAME state+journal DBs, then answers the ask.
 * Proves the shipped binary (outbox + idempotency-key reconciler,
 * checkpoint.ts writePendingIntent/commitIntent/reconcileOnResume) holds across
 * a crash boundary:
 *   - the HELD HITL work survives the SIGKILL (visible via the run-narration CLI
 *     on the restarted listener),
 *   - answering after restart (Socket Mode button, same correlation id) resumes
 *     the run to terminal 'done',
 *   - exactly-once Slack effects hold across the crash — ONE ask post, ONE
 *     delivery upload total.
 *
 * BLACK-BOX: imports only the WI-677 harness + bun:test (WI-678 gate). All waits
 * are bounded/condition-polled (no unbounded loops — the restarted listener and
 * its socket reconnect are awaited with timeouts inside the harness helpers).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const FAULT_TIMEOUT_MS = 150_000;
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

const countMatches = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const DONE_RE = /(?:→|->)\s*done/g;

describe("FR-2 F-4: held HITL work survives a listener crash/restart", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness();
  }, FAULT_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "SIGKILL after the ask, restart on the same DBs, answer → resumes with exactly-once effects",
    async () => {
      // ── Drive the journey to the HITL ask. ──
      const timestampSec = Math.floor(Date.now() / 1000);
      const event = {
        event_id: "evt-crash-restart-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off, then crash" },
      };
      const res = await h.sendSignedEvent(event, { timestampSec });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runId = runIdFromArgs(h.spawns.runInvocations()[0]!.args);
      expect(runId).toBeDefined();
      const cardId = `entry-${runId}`;

      await h.waitFor(() => h.slack.posts().some((p) => (p.text ?? "").includes(ASK_MARKER)), {
        timeoutMs: 30_000,
      });
      // Capture the ask's correlation id BEFORE the crash (non-AC internal lookup;
      // it persists in the journal DB across the restart).
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

      // ── Crash: SIGKILL the listener, then restart on the SAME state+journal DBs. ──
      await h.killListener();
      await h.restartListener();

      // ── The held HITL work SURVIVED the crash — visible on the restarted
      //    listener via the real run-narration CLI: the ask is journaled but no
      //    selection/terminal-done has happened yet. ──
      const held = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
      expect(held.exitCode).toBe(0);
      expect(held.stdout).toMatch(/hitl\.ask/);
      expect(held.stdout).not.toMatch(/hitl\.selection/);
      expect(countMatches(held.stdout, DONE_RE)).toBe(0);

      // ── Answer AFTER restart (Socket Mode button, same correlation id). ──
      await h.sendInteractiveResponse(correlationId!, "candidate-1");
      await h.waitFor(() => h.spawns.resumeInvocations().length >= 1, { timeoutMs: 30_000 });

      // ── Resumes to terminal success — poll the CLI until 'done'. ──
      let done: { stdout: string; exitCode: number } | undefined;
      await h.waitFor(
        async () => {
          done = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
          return done.exitCode === 0 && countMatches(done.stdout, DONE_RE) >= 1;
        },
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      expect(done!.stdout).toMatch(/hitl\.selection/);
      expect(countMatches(done!.stdout, DONE_RE)).toBe(1);

      // ── Exactly-once Slack effects across the crash boundary. ──
      const askPosts = h.slack.posts().filter((p) => (p.text ?? "").includes(ASK_MARKER));
      expect(askPosts.length).toBe(1);
      expect(h.slack.completeUploadCount()).toBe(1);
      expect(distinctRunIds(h.spawns.resumeInvocations()).size).toBe(1);
    },
    FAULT_TIMEOUT_MS,
  );
});
