/**
 * SLACK_API_BASE_URL env override (WI-676).
 *
 * Operators can point every production Slack call — Web API + Socket Mode's
 * apps.connections.open — at an alternate BASE HOST via SLACK_API_BASE_URL,
 * defaulting to https://slack.com when unset/empty/invalid.
 *
 * The load-bearing trap this suite guards: src/channels/slack.ts already has a
 * `const SLACK_API_BASE_URL = 'https://slack.com/api'` (WITH /api). The NEW env
 * var holds the base host (NO /api). Every call site appends EXACTLY ONE '/api'
 * segment — so the tests assert no '/api/api' double-suffix and no dropped
 * '/api' at each derivation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSlackApiBaseUrl, resolveSocketConnectionsOpenUrl } from "../controller/executor";
import { createSlackTransport } from "./slack";

const ENV_KEY = "SLACK_API_BASE_URL";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("resolveSlackApiBaseUrl() — resolver behavior", () => {
  test("unset → default host https://slack.com (NO /api suffix)", () => {
    delete process.env[ENV_KEY];
    const base = resolveSlackApiBaseUrl();
    expect(base).toBe("https://slack.com");
    // Collision guard: the default is the bare host, so a single appended
    // /api yields the canonical Web API root and never '/api/api'.
    expect(base.endsWith("/api")).toBe(false);
  });

  test("valid absolute https URL → returned verbatim", () => {
    process.env[ENV_KEY] = "https://slack.internal";
    expect(resolveSlackApiBaseUrl()).toBe("https://slack.internal");
  });

  test("valid absolute http URL (local fake host) → returned verbatim", () => {
    process.env[ENV_KEY] = "http://127.0.0.1:8899";
    expect(resolveSlackApiBaseUrl()).toBe("http://127.0.0.1:8899");
  });

  test("empty string → falls back to default", () => {
    process.env[ENV_KEY] = "";
    expect(resolveSlackApiBaseUrl()).toBe("https://slack.com");
  });

  test.each([
    ["not-a-url", "not a URL"],
    ["slack.com", "no scheme"],
    ["//slack.com", "scheme-relative"],
    ["ftp://slack.com", "non-http(s) scheme"],
    ["   ", "whitespace only"],
  ])("invalid value %p (%s) → falls back to default", (bad) => {
    process.env[ENV_KEY] = bad;
    expect(resolveSlackApiBaseUrl()).toBe("https://slack.com");
  });

  // ── Regression guards (WI-676; defects found by Amy, fixed by B.A.): the
  // resolver returns a NORMALIZED origin, not the env value verbatim, so no
  // surviving trailing slash / whitespace corrupts the `${base}/api` concat. ──

  test("trailing-slash host normalizes so `${base}/api` has no double slash", () => {
    process.env[ENV_KEY] = "https://slack.com/";
    const base = resolveSlackApiBaseUrl();
    expect(base).toBe("https://slack.com");
    expect(base.endsWith("/")).toBe(false);
    // The trailing slash would otherwise splice into a '//api' path segment.
    expect(`${base}/api`).toBe("https://slack.com/api");
    expect(`${base}/api/apps.connections.open`).toBe("https://slack.com/api/apps.connections.open");
  });

  test("surrounding whitespace in an otherwise-valid URL is trimmed, not carried into `${base}/api`", () => {
    // `new URL()` accepts (and trims) leading/trailing whitespace, so a verbatim
    // return would splice the spaces into `${base}/api` and yield an unusable URL.
    process.env[ENV_KEY] = "  https://slack.internal  ";
    const base = resolveSlackApiBaseUrl();
    expect(base).toBe("https://slack.internal");
    expect(base).not.toMatch(/\s/);
    const endpoint = `${base}/api/chat.postMessage`;
    expect(endpoint).toBe("https://slack.internal/api/chat.postMessage");
    expect(() => new URL(endpoint)).not.toThrow();
  });
});

/**
 * Web API endpoint construction through the REAL production transport. The
 * production wiring passes `apiBaseUrl: `${resolveSlackApiBaseUrl()}/api``
 * (executor.ts createSlackTransport), so building the transport that way and
 * capturing the fetched URL proves the collision trap is avoided end-to-end in
 * the endpoint builder.
 */
describe("Slack Web API transport apiBaseUrl derivation", () => {
  const captureUrl = () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = String(url);
      return { json: async () => ({ ok: true, ts: "1700000000.000100" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, url: () => seen };
  };

  const post = async () => {
    const cap = captureUrl();
    const transport = createSlackTransport({
      botToken: "xoxb-test",
      fetchImpl: cap.fetchImpl,
      apiBaseUrl: `${resolveSlackApiBaseUrl()}/api`,
    });
    await transport.post({ channel: "C1", text: "hi" });
    return cap.url();
  };

  test("unset → chat.postMessage hits https://slack.com/api (exactly one /api)", async () => {
    delete process.env[ENV_KEY];
    const url = await post();
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(url).not.toContain("/api/api");
  });

  test("override → chat.postMessage hits the override host with one /api", async () => {
    process.env[ENV_KEY] = "http://127.0.0.1:8899";
    const url = await post();
    expect(url).toBe("http://127.0.0.1:8899/api/chat.postMessage");
    expect(url).not.toContain("/api/api");
    expect(url).toContain("/api/chat.postMessage"); // /api not dropped
  });
});

/**
 * Socket Mode apps.connections.open URL derivation, asserted on the REAL
 * production helper. buildProductionSocketSeam (cli/main.ts) calls
 * resolveSocketConnectionsOpenUrl() to compose the endpoint, so this suite
 * verifies the actual seam expression — a regression in the composition rule
 * (`${resolveSlackApiBaseUrl()}/api/apps.connections.open`) now fails here.
 * (main.ts is deliberately NOT imported — it runs CLI side effects; the helper
 * lives in executor.ts precisely so the test can reach it safely.)
 */
describe("Socket Mode apps.connections.open URL derivation", () => {
  test("unset → today's hardcoded URL, unchanged (regression guard)", () => {
    delete process.env[ENV_KEY];
    const url = resolveSocketConnectionsOpenUrl();
    expect(url).toBe("https://slack.com/api/apps.connections.open");
    expect(url).not.toContain("/api/api");
  });

  test("override → apps.connections.open hits the override host with one /api", () => {
    process.env[ENV_KEY] = "http://127.0.0.1:8899";
    const url = resolveSocketConnectionsOpenUrl();
    expect(url).toBe("http://127.0.0.1:8899/api/apps.connections.open");
    expect(url).not.toContain("/api/api");
    expect(url).toContain("/api/apps.connections.open"); // /api not dropped
  });

  test("trailing-slash host normalizes so the endpoint has no double slash", () => {
    process.env[ENV_KEY] = "https://slack.com/";
    const url = resolveSocketConnectionsOpenUrl();
    expect(url).toBe("https://slack.com/api/apps.connections.open");
    expect(url).not.toContain("/api/api");
  });
});
