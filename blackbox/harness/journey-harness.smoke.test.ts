/**
 * Black-box journey harness — smoke test (WI-677).
 *
 * Pins the PUBLIC CONTRACT of startJourneyHarness(). This harness is the ONLY
 * module that owns the fakes + reusable assertions; the golden journey (WI-679)
 * and the four fault variants (WI-680..683) CONSUME this surface and must not
 * reimagine it — so this test is the authoritative shape.
 *
 * BLACK-BOX RULE: zero imports from src/. The harness spawns the shipped binary
 * and speaks HTTP/ws; this test only imports the harness and node/bun builtins.
 * node:crypto is a builtin (not src/) — it recomputes the Slack v0 HMAC
 * independently to prove the harness's signer matches PRODUCTION's scheme
 * (src/ingress/adapters/slack-events.ts: 'v0='+HMAC-SHA256(secret,
 * `v0:${ts}:${rawBody}`)), not merely an internally-consistent one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startJourneyHarness } from "./journey-harness";

const BOOT_TIMEOUT_MS = 45_000;

/** Independent recompute of Slack's v0 request signature (mirrors production). */
function expectedV0Signature(secret: string, timestampSec: number, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestampSec}:${rawBody}`).digest("hex");
}

describe("startJourneyHarness — boot, fake Slack contract, teardown", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test("boots with a fake Slack base host and a signing secret", () => {
    // slackBaseUrl is the BASE HOST handed to the child as SLACK_API_BASE_URL
    // (WI-676): an absolute http(s) URL with NO trailing /api.
    const u = new URL(h.slackBaseUrl);
    expect(u.protocol).toMatch(/^https?:$/);
    expect(u.host.length).toBeGreaterThan(0);
    expect(h.slackBaseUrl.endsWith("/api")).toBe(false);
    expect(typeof h.signingSecret).toBe("string");
    expect(h.signingSecret.length).toBeGreaterThan(0);
  });

  test("signed-event sender computes a correct Slack v0 HMAC that the fake verifies", () => {
    const rawBody = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const signed = h.signSlackRequest(rawBody);

    // Correct against the REAL v0 scheme (independent recompute).
    const expected = expectedV0Signature(h.signingSecret, signed.timestamp, rawBody);
    expect(signed.signature).toBe(expected);
    expect(signed.headers["X-Slack-Signature"]).toBe(expected);
    expect(signed.headers["X-Slack-Request-Timestamp"]).toBe(String(signed.timestamp));

    // The fake's verifier accepts a correctly-signed event...
    expect(h.slack.verifySignedEvent({ headers: signed.headers, rawBody })).toBe(true);
    // ...and rejects a tampered body (signature no longer matches).
    expect(h.slack.verifySignedEvent({ headers: signed.headers, rawBody: rawBody + " " })).toBe(false);
    // ...and a tampered signature.
    const badHeaders = { ...signed.headers, "X-Slack-Signature": "v0=" + "0".repeat(64) };
    expect(h.slack.verifySignedEvent({ headers: badHeaders, rawBody })).toBe(false);
  });

  test("fake records chat.postMessage traffic", async () => {
    const before = h.slack.posts().length;
    const res = await fetch(`${h.slackBaseUrl}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-test", "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: "C_SMOKE", text: "smoke ping" }),
    });
    const body = (await res.json()) as { ok: boolean; ts?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("string");

    const posts = h.slack.posts();
    expect(posts.length).toBe(before + 1);
    const last = posts[posts.length - 1] as { channel?: string; text?: string };
    expect(last.channel).toBe("C_SMOKE");
    expect(last.text).toBe("smoke ping");
  });

  test("full 3-step upload flow: upload_url resolves back to the fake; one-delivery counter keys on completeUploadExternal", async () => {
    const completeBefore = h.slack.completeUploadCount();

    // Step 1 — files.getUploadURLExternal (form-encoded, as production sends).
    const step1 = await fetch(`${h.slackBaseUrl}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-test",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({ filename: "asset.png", length: "3" }).toString(),
    });
    const s1 = (await step1.json()) as { ok: boolean; upload_url?: string; file_id?: string };
    expect(s1.ok).toBe(true);
    expect(typeof s1.upload_url).toBe("string");
    expect(typeof s1.file_id).toBe("string");

    // CRITICAL GOTCHA: the returned upload_url must point BACK at the fake's own
    // host — otherwise the raw-byte POST escapes to a real host and the journey
    // hangs. Assert same host as the fake base.
    expect(new URL(s1.upload_url!).host).toBe(new URL(h.slackBaseUrl).host);

    // getUploadURLExternal alone must NOT bump the canonical delivery counter.
    expect(h.slack.completeUploadCount()).toBe(completeBefore);

    // Step 2 — raw byte POST to the returned upload_url (200, plain-text body).
    const step2 = await fetch(s1.upload_url!, { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(step2.ok).toBe(true);

    // Raw byte POST alone must NOT bump the canonical delivery counter either.
    expect(h.slack.completeUploadCount()).toBe(completeBefore);

    // Step 3 — files.completeUploadExternal (JSON, as production sends).
    const step3 = await fetch(`${h.slackBaseUrl}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-test", "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ files: [{ id: s1.file_id }], channel_id: "C_SMOKE" }),
    });
    const s3 = (await step3.json()) as { ok: boolean; files?: Array<{ id: string }> };
    expect(s3.ok).toBe(true);

    // Exactly-once: the 'one delivery upload' counter is keyed on
    // completeUploadExternal specifically — +1 after step 3 only.
    expect(h.slack.completeUploadCount()).toBe(completeBefore + 1);
  });

  test("exposes the public surface every downstream journey/fault item consumes", () => {
    // End-to-end signed sender + Socket Mode interactive response (WI-679).
    expect(typeof h.sendSignedEvent).toBe("function");
    expect(typeof h.sendInteractiveResponse).toBe("function");
    // Traffic observers.
    expect(typeof h.slack.uploads).toBe("function");
    // Child-spawn observers (WI-679/681): 'conduit run' / 'conduit resume'.
    expect(typeof h.spawns.runInvocations).toBe("function");
    expect(typeof h.spawns.resumeInvocations).toBe("function");
    // Reusable public-surface assertion helpers.
    expect(typeof h.assert.exitCode).toBe("function");
    expect(typeof h.assert.explainField).toBe("function");
    expect(typeof h.assert.artifactContent).toBe("function");
    // Condition-polled wait (no fixed sleeps anywhere in the harness).
    expect(typeof h.waitFor).toBe("function");
  });

  test("fault knobs exist and toggle without throwing (stall, duplicate)", () => {
    expect(typeof h.faults.setStall).toBe("function");
    expect(typeof h.faults.setDuplicateDelivery).toBe("function");
    expect(() => h.faults.setStall("chat.postMessage", true)).not.toThrow();
    expect(() => h.faults.setStall("chat.postMessage", false)).not.toThrow();
    expect(() => h.faults.setDuplicateDelivery(true)).not.toThrow();
    expect(() => h.faults.setDuplicateDelivery(false)).not.toThrow();
  });
});

describe("deterministic teardown", () => {
  test("cleanup() makes the fake Slack server unreachable", async () => {
    const h = await startJourneyHarness();
    const base = h.slackBaseUrl;

    // Reachable before teardown.
    const live = await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-test", "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: "C1", text: "pre-teardown" }),
    });
    expect(live.ok).toBe(true);

    await h.cleanup();

    // Unreachable after teardown — the socket is closed, so the connection is
    // refused (fetch rejects). A resolved response would mean the port leaked.
    let refused = false;
    try {
      await fetch(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, BOOT_TIMEOUT_MS);
});
