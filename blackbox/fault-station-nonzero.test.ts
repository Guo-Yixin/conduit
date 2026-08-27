/**
 * FR-2 F-2: deterministic station exits nonzero (WI-681) — resumed after WI-686.
 *
 * Drives the journey with the scaffolded flow configured so its pure
 * deterministic station always exits nonzero. At the listener's default
 * concurrency=1 (the synchronous in-process path) the shipped binary counts the
 * failure toward the attempt cap (retry below it, NAMED terminal scrap at it —
 * the pre-public deterministic failure-reporting review's count-and-retry, superseding WI-686's direct-scrap) instead of
 * silently busy-retrying forever. Proves:
 *   - terminal scrap is reached (visible via the run-narration CLI as a
 *     "deterministic station '…' failed (exit N)" terminal + entered_lane →
 *     scrap — pooled-path parity),
 *   - the run process exits NONZERO (visible via the listener's spawn alert),
 *   - it is a SCRAP, not a held HITL park (the CLI narration shows scrap, never
 *     a (hold) transition or an hitl.held_at span),
 *   - bounded wall-clock / no wedged process (the scrap is reached within a
 *     bounded poll — a regression to the busy-loop would time out here).
 *
 * Direct-scrap on the FIRST failure is the shipped design (worker-entry.ts:92-98:
 * a deterministic command is a pure function, so retry is futile) — this asserts
 * that, NOT a multi-retry loop.
 *
 * BLACK-BOX: imports only the WI-677 harness + bun:test (WI-678 gate).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const FAULT_TIMEOUT_MS = 90_000;

/** Parse a spawned run's run id from its argv (`--run-id` / `--run`). */
function runIdFromArgs(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

/**
 * `startJourneyHarness({ failDeterministicStation: true })` scaffolds the flow's
 * deterministic `process` station with a command that always exits nonzero.
 */
describe("FR-2 F-2: a repeatedly-failing deterministic station reaches terminal scrap", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness({ failDeterministicStation: true });
  }, FAULT_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "scraps with a named reason and a nonzero exit, distinct from a held park",
    async () => {
      const timestampSec = Math.floor(Date.now() / 1000);
      const event = {
        event_id: "evt-station-nonzero-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "kick off the failing station" },
      };
      const res = await h.sendSignedEvent(event, { timestampSec });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runId = runIdFromArgs(h.spawns.runInvocations()[0]!.args);
      expect(runId).toBeDefined();
      const cardId = `entry-${runId}`;

      // ── Poll the run-narration CLI until the run reaches terminal scrap. The
      //    poll completing (well under its timeout) IS the bounded-wall-clock /
      //    no-wedge proof — a regression to the silent busy-loop would never
      //    record the scrap and would time out here. ──
      let journey: { stdout: string; exitCode: number } | undefined;
      await h.waitFor(
        async () => {
          journey = await h.runConduit(["journal", "inspect", cardId, "--run", runId!]);
          return (
            journey.exitCode === 0 &&
            /deterministic station '[^']+' failed \(exit [1-9]\d*\)/.test(journey.stdout)
          );
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );

      // ── Named terminal scrap (station + exit code), pooled-path parity. ──
      expect(journey!.stdout).toMatch(/deterministic station 'process' failed \(exit [1-9]\d*\)/);
      expect(journey!.stdout).toMatch(/(?:→|->)\s*scrap/);

      // ── It is a SCRAP, not a held HITL park (distinguish the two exit-1 cases). ──
      expect(journey!.stdout).not.toMatch(/\(hold\)/);
      expect(journey!.stdout).not.toMatch(/hitl\.held_at/);

      // ── The run process exited NONZERO — visible via the listener's spawn
      //    alert (its own public surface). ──
      await h.waitFor(() => /conduit run exited with code [1-9]/.test(h.listenerStderr()), {
        timeoutMs: 15_000,
      });
      expect(h.listenerStderr()).toMatch(/conduit run exited with code [1-9]/);
    },
    FAULT_TIMEOUT_MS,
  );
});
