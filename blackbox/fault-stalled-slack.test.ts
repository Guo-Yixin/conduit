/**
 * FR-2 F-1: stalled Slack connection fault variant (WI-680).
 *
 * Drives the golden Studio journey with the fake Slack server set to
 * accept-and-never-respond for Web API calls, and a SHORT SLACK_FETCH_TIMEOUT_MS
 * on the spawned child. Proves the shipped binary (the pre-public Slack fetch-timeout review bounded-fetch work):
 *   - aborts the stalled Slack fetch at the SLACK_FETCH_TIMEOUT_MS bound rather
 *     than hanging indefinitely (settles far under the fake's 10-minute stall cap),
 *   - surfaces a NAMED stall/timeout failure on a public surface (the journal /
 *     'conduit explain' card_log reason), not a generic crash or silent exit,
 *   - leaves the run parked (held) and tears down with no wedged/zombie process.
 *
 * BLACK-BOX: imports only the WI-677 harness + bun:test — nothing from src/
 * (WI-678 gate). SLACK_FETCH_TIMEOUT_MS is injected via process.env, which the
 * harness spreads into the spawned child's environment.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const FAULT_TIMEOUT_MS = 90_000;
const FETCH_BOUND_MS = 1500;

/** Parse a spawned run/resume's run id from its argv (`--run-id` / `--run`). */
function runIdFromArgs(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

describe("FR-2 F-1: stalled Slack connection is bounded and named", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;
  const savedTimeout = process.env.SLACK_FETCH_TIMEOUT_MS;

  beforeAll(async () => {
    // Short bound on the child's Slack JSON Web API fetches (the pre-public Slack fetch-timeout review). Set BEFORE
    // boot so the harness spreads it into the spawned 'conduit listen' env.
    process.env.SLACK_FETCH_TIMEOUT_MS = String(FETCH_BOUND_MS);
    h = await startJourneyHarness();
  }, FAULT_TIMEOUT_MS);

  afterAll(async () => {
    // cleanup() must return promptly — a hang here would itself signal a wedged
    // listener/run child, failing the test via timeout.
    await h?.cleanup();
    if (savedTimeout === undefined) delete process.env.SLACK_FETCH_TIMEOUT_MS;
    else process.env.SLACK_FETCH_TIMEOUT_MS = savedTimeout;
  });

  test(
    "a never-responding Slack Web API aborts at the bound and surfaces a named timeout",
    async () => {
      // Accept-and-never-respond on the Web API calls the delivery makes first.
      h.faults.setStall("files.getUploadURLExternal", true);
      h.faults.setStall("chat.postMessage", true);

      const startedAt = Date.now();
      const event = {
        event_id: "evt-stalled-slack-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off with a stalled slack" },
      };
      const res = await h.sendSignedEvent(event);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // A real 'conduit run' is spawned (observed, not mocked).
      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runId = runIdFromArgs(h.spawns.runInvocations()[0]!.args);
      expect(runId).toBeDefined();
      const cardId = `entry-${runId}`;

      // ── Bounded abort + named failure on the real CLI surface ──
      // AC3 names "CLI stderr and/or conduit explain"; the named failure lives on
      // the run-narration CLI (composite-surface reading, per the WI-679 ruling).
      // NOTE: 'conduit explain' is static flow structure only, and the listener
      // discards the run child's stderr (main.ts:2221), so the NAMED timeout is
      // read here from 'conduit journal inspect' via runConduit — a real CLI
      // spawn, NOT a journal-DB read. Poll it until the timeout prints; the wait
      // completing at all (far under the fake's 10-minute stall cap) IS the
      // boundedness proof — an unbounded hang would never record the terminal row.
      let explainOut = "";
      await h.waitFor(
        async () => {
          const e = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
          if (e.exitCode === 0 && /Slack transport network failure/.test(e.stdout)) {
            explainOut = e.stdout;
            return true;
          }
          return false;
        },
        { timeoutMs: 30_000, intervalMs: 500 },
      );
      const settledMs = Date.now() - startedAt;

      // Named timeout on the CLI surface — not a generic crash or silent exit.
      expect(explainOut).toMatch(/Slack transport network failure/);
      expect(explainOut).toMatch(/tim(e|ed) ?out|timeout|abort/i);
      // Names the affected Web API surface (the delivery upload step).
      expect(explainOut).toMatch(/getUploadURLExternal|chat\.postMessage/);

      // Bounded, not indefinite: the named timeout surfaced in well under the
      // fake's 10-minute (600_000ms) accept-never-respond cap.
      expect(settledMs).toBeLessThan(30_000);

      // The run parked on the timeout (held) rather than completing — the CLI
      // narration shows a hold transition and never a terminal '→ done'.
      expect(explainOut).toMatch(/\(hold\)/);
      expect(explainOut).not.toMatch(/(?:→|->)\s*done/);

      // No delivery ever completed while stalled (the canonical upload counter
      // stays at zero — the fetch aborted before files.completeUploadExternal).
      expect(h.slack.completeUploadCount()).toBe(0);
    },
    FAULT_TIMEOUT_MS,
  );
});
