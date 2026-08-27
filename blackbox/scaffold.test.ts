/**
 * Black-box suite scaffold smoke test (WI-675).
 *
 * Pins the plumbing that makes blackbox/ a first-class, separately-run,
 * NON-required test suite:
 *   - package.json exposes a `test:blackbox` script that runs this suite
 *   - the default `test` script is scoped to src/ and no longer globs blackbox/
 *   - the blackbox/ home exists (harness/ subfolder + README stub)
 *   - a dedicated .github/workflows/blackbox.yml runs on PRs but is kept OUT
 *     of the required check set (no job named `tests`, the required gate) and
 *     documents the burn-in-then-promote plan
 *
 * Black-box rule: this suite reads only from disk and public deps — NO src/
 * imports. Reading package.json / workflow YAML from the filesystem keeps it
 * compliant with the zero-internal-imports gate.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = join(import.meta.dir, "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));

describe("package.json test-script scoping", () => {
  const pkg = readJson("package.json");
  const scripts: Record<string, string> = pkg.scripts ?? {};

  test("exposes a `test:blackbox` script that runs the blackbox/ suite", () => {
    expect(scripts["test:blackbox"]).toBeDefined();
    expect(scripts["test:blackbox"]).toContain("blackbox/");
  });

  test("default `test` script is scoped to src/ and does not glob blackbox/", () => {
    expect(scripts.test).toBeDefined();
    expect(scripts.test).toContain("src/");
    expect(scripts.test).not.toContain("blackbox");
  });
});

describe("blackbox/ directory layout", () => {
  const isDir = (rel: string) => existsSync(join(repoRoot, rel)) && statSync(join(repoRoot, rel)).isDirectory();

  test("blackbox/ exists with a harness/ subfolder", () => {
    expect(isDir("blackbox")).toBe(true);
    expect(isDir("blackbox/harness")).toBe(true);
  });

  test("blackbox/README stub exists and is non-empty", () => {
    const readme = join(repoRoot, "blackbox/README.md");
    expect(existsSync(readme)).toBe(true);
    expect(readFileSync(readme, "utf8").trim().length).toBeGreaterThan(0);
  });
});

describe("non-required blackbox CI workflow (DQ-3)", () => {
  const workflowPath = join(repoRoot, ".github/workflows/blackbox.yml");

  test(".github/workflows/blackbox.yml exists as a separate workflow", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  test("runs on pull_request but is kept out of the required check set", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const wf = parse(raw);

    // Triggers on every PR. YAML 1.1 folds a bare `on:` key to boolean `true`,
    // which becomes the string key "true" on the parsed JS object (JS object
    // keys are always strings); YAML 1.2 keeps it as "on". Read whichever the
    // parser produced — string-index "true" (never a literal boolean index).
    const on = wf.on ?? (wf as Record<string, unknown>)["true"];
    const triggers = Array.isArray(on) ? on : Object.keys(on ?? {});
    expect(triggers).toContain("pull_request");

    // The required check is the job named `tests` (in test.yml). A separate
    // workflow that named its job `tests` too would be folded into the required
    // gate — so blackbox must NOT define one.
    const jobNames = Object.keys(wf.jobs ?? {});
    expect(jobNames.length).toBeGreaterThan(0);
    expect(jobNames).not.toContain("tests");

    // Comments are stripped by the YAML parse, so assert the burn-in plan is
    // documented against the raw source.
    expect(raw).toMatch(/burn-in|burn in/i);
    expect(raw).toMatch(/requir/i);
  });
});
