/**
 * Zero-internal-imports gate (WI-678).
 *
 * The black-box suite exercises only the shipped binary and public surfaces, so
 * NO file under blackbox/ may import a Conduit internal module (anything that
 * resolves into src/). This gate scans every .ts file and fails on any such
 * import — static `import … from`, dynamic `import(…)`, or `require(…)` — and
 * reports the offending file + line.
 *
 * The scanner itself is subject to the rule: it reads files with node fs and
 * parses each with the TypeScript compiler API (a third-party devDependency),
 * importing nothing from src/. This test imports only node builtins, bun:test,
 * and the sibling scanner (./harness/import-scan — a blackbox-internal path,
 * NOT src/), so it too passes the gate it enforces.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scanForInternalImports } from "./harness/import-scan";

const blackboxDir = import.meta.dir;
const repoRoot = join(blackboxDir, "..");

/** Line (1-based) of the first line in `file` that contains `needle`. */
function lineOf(file: string, needle: string): number {
  const lines = readFileSync(file, "utf8").split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`needle not found in ${file}: ${needle}`);
  return idx + 1;
}

describe("scanForInternalImports — the current suite is clean", () => {
  test("no file under blackbox/ imports anything that resolves into src/", () => {
    const violations = scanForInternalImports(blackboxDir);
    // A readable failure lists every offender with its file:line.
    const rendered = violations.map((v) => `${v.file}:${v.line} → ${v.specifier}`).join("\n");
    expect(rendered).toBe("");
    expect(violations).toEqual([]);
  });
});

describe("scanForInternalImports — detects internal imports in every form", () => {
  let fixtureRoot: string;
  // Specifier from each fixture file's dir to a real module under repo src/.
  // Resolves into <repoRoot>/src/… so it is a genuine internal import.
  const specTo = (fromDir: string, srcRel: string) => relative(fromDir, join(repoRoot, "src", srcRel));

  let fileStatic: string;
  let fileDynamic: string;
  let fileRequire: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "bb-import-scan-"));
    const nested = join(fixtureRoot, "nested");
    mkdirSync(nested);

    // A — static import into src/, among allowed imports.
    fileStatic = join(fixtureRoot, "a-static.ts");
    writeFileSync(
      fileStatic,
      [
        `import { test } from "bun:test";`,
        `import { readFileSync } from "node:fs";`,
        `import { parse } from "yaml";`,
        ``,
        `import { runExecutor } from "${specTo(fixtureRoot, "controller/executor")}";`,
        ``,
        `test("noop", () => { void runExecutor; void readFileSync; void parse; });`,
        ``,
      ].join("\n"),
    );

    // B — dynamic import into src/, in a nested dir (recursion) with a clean
    // sibling-relative import that must NOT be flagged.
    fileDynamic = join(nested, "b-dynamic.ts");
    writeFileSync(
      fileDynamic,
      [
        `import { join } from "node:path";`,
        `import { sib } from "./b-helper";`,
        ``,
        `export async function load() {`,
        `  const mod = await import("${specTo(nested, "channels/slack")}");`,
        `  return join(sib, String(mod));`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(join(nested, "b-helper.ts"), `export const sib = "ok";\n`);

    // C — require() into src/.
    fileRequire = join(fixtureRoot, "c-require.ts");
    writeFileSync(
      fileRequire,
      [
        `// a comment line`,
        `const main = require("${specTo(fixtureRoot, "cli/main")}");`,
        `export const x = main;`,
        ``,
      ].join("\n"),
    );

    // D — only allowed imports (builtins, third-party, sibling relative): must
    // contribute zero violations.
    writeFileSync(
      join(fixtureRoot, "d-clean.ts"),
      [
        `import { basename } from "node:path";`,
        `import pc from "picocolors";`,
        `import { helper } from "./d-helper";`,
        `export const ok = basename("x") + pc.red("y") + helper;`,
        ``,
      ].join("\n"),
    );
    writeFileSync(join(fixtureRoot, "d-helper.ts"), `export const helper = "h";\n`);
  });

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  test("flags exactly the three violating files, one per form, and nothing clean", () => {
    const violations = scanForInternalImports(fixtureRoot);
    const offenders = new Set(violations.map((v) => v.file));
    expect(offenders).toEqual(new Set([fileStatic, fileDynamic, fileRequire]));
    // The clean file and both sibling helpers are never flagged.
    for (const v of violations) {
      expect(v.file).not.toContain("d-clean");
      expect(v.file).not.toContain("helper");
    }
    expect(violations.length).toBe(3);
  });

  test("reports the correct file + line + specifier for each form", () => {
    const byFile = new Map(scanForInternalImports(fixtureRoot).map((v) => [v.file, v]));

    const s = byFile.get(fileStatic)!;
    expect(s.line).toBe(lineOf(fileStatic, "controller/executor"));
    expect(s.specifier).toContain("controller/executor");

    const d = byFile.get(fileDynamic)!;
    expect(d.line).toBe(lineOf(fileDynamic, "channels/slack"));
    expect(d.specifier).toContain("channels/slack");

    const r = byFile.get(fileRequire)!;
    expect(r.line).toBe(lineOf(fileRequire, "cli/main"));
    expect(r.specifier).toContain("cli/main");
  });
});

// Regression coverage for two comment/string bypass classes that defeat a naive
// line-oriented scanner and are handled by import-scan's TypeScript-AST walk.
// Each fixture pins that a real internal import is still flagged (with the
// specifier's true line number) when:
//   1. a line- or block-comment sits BETWEEN the import keyword and its
//      specifier string (which breaks a naive keyword-to-specifier gap match), and
//   2. a same-line string literal contains a double-slash BEFORE a real import
//      on that line (which a naive line-comment scan would treat as a comment,
//      hiding the import).
describe("scanForInternalImports — comment/string bypass regression", () => {
  let root: string;
  const specTo = (fromDir: string, srcRel: string) => relative(fromDir, join(repoRoot, "src", srcRel));

  let fileLineCommentGap: string;
  let fileBlockCommentGap: string;
  let fileStringSlashes: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bb-import-scan-bypass-"));

    // 1a — a `//` line comment interposed between `from` and the specifier
    // (across newlines). Specifier lands on its own line.
    fileLineCommentGap = join(root, "line-comment-gap.ts");
    writeFileSync(
      fileLineCommentGap,
      [
        `import { test } from "bun:test";`,
        ``,
        `import { runExecutor } from`,
        `// interstitial comment that must not hide the import`,
        `"${specTo(root, "controller/executor")}";`,
        ``,
        `test("noop", () => { void runExecutor; });`,
        ``,
      ].join("\n"),
    );

    // 1b — a `/* */` block comment interposed between `from` and the specifier
    // (same line).
    fileBlockCommentGap = join(root, "block-comment-gap.ts");
    writeFileSync(
      fileBlockCommentGap,
      [
        `import { readFileSync } from "node:fs";`,
        ``,
        `import { slackThing } from /* internal seam */ "${specTo(root, "channels/slack")}";`,
        ``,
        `export const y = () => { void slackThing; void readFileSync; };`,
        ``,
      ].join("\n"),
    );

    // 2 — a same-line string containing `//` BEFORE a real import on that line.
    fileStringSlashes = join(root, "string-slashes.ts");
    writeFileSync(
      fileStringSlashes,
      [
        `// header`,
        `const u = "https://example.com/x"; import { main } from "${specTo(root, "cli/main")}";`,
        `export const v = u;`,
        ``,
      ].join("\n"),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("flags all three bypass fixtures, one violation each", () => {
    const violations = scanForInternalImports(root);
    const offenders = new Set(violations.map((v) => v.file));
    expect(offenders).toEqual(new Set([fileLineCommentGap, fileBlockCommentGap, fileStringSlashes]));
    expect(violations.length).toBe(3);
  });

  test("a // comment between the import keyword and its specifier does not hide the import", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileLineCommentGap);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileLineCommentGap, "controller/executor"));
    expect(v[0].specifier).toContain("controller/executor");
  });

  test("a /* */ comment between the import keyword and its specifier does not hide the import", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileBlockCommentGap);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileBlockCommentGap, "channels/slack"));
    expect(v[0].specifier).toContain("channels/slack");
  });

  test("a same-line string containing // before a real import does not hide the import", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileStringSlashes);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileStringSlashes, "cli/main"));
    expect(v[0].specifier).toContain("cli/main");
  });
});

// Regression coverage for the three AST token-class bypasses confirmed in later
// review rounds — each defeated the earlier regex/tokenizer scanners and is now
// handled by import-scan's TypeScript-AST walk. Pins that a real src/ import is
// still flagged (with the specifier's true line) when it sits alongside:
//   1. a regex literal whose body contains the two-char sequence "/*" (Amy R4 —
//      a naive block-comment tokenizer read it as a comment opener and swallowed
//      code to EOF, hiding the import),
//   2. an `import x = require("…")` ImportEqualsDeclaration (Lynch R5 — a TS-only
//      node the import/require regexes never matched), and
//   3. a `require.resolve("…")` PropertyAccessExpression call (Lynch R5 — not a
//      bare `require(...)` identifier call, so the require regex skipped it).
describe("scanForInternalImports — AST token-class regression", () => {
  let root: string;
  const specTo = (fromDir: string, srcRel: string) => relative(fromDir, join(repoRoot, "src", srcRel));

  let fileRegexLiteral: string;
  let fileImportEquals: string;
  let fileRequireResolve: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bb-import-scan-ast-"));

    // 1 — a regex literal containing "/*" (via the escaped `\/*`) BEFORE a real
    // static src/ import. The AST tokenizes the regex, so the import survives.
    fileRegexLiteral = join(root, "regex-literal.ts");
    writeFileSync(
      fileRegexLiteral,
      [
        `const PATH_RE = /^\\/api\\/*/;`,
        `import { runExecutor } from "${specTo(root, "controller/executor")}";`,
        `export const x = () => { void PATH_RE; void runExecutor; };`,
        ``,
      ].join("\n"),
    );

    // 2 — `import x = require("…")` (TypeScript ImportEqualsDeclaration).
    fileImportEquals = join(root, "import-equals.ts");
    writeFileSync(
      fileImportEquals,
      [
        `// TS import-equals form`,
        `import slack = require("${specTo(root, "channels/slack")}");`,
        `export const s = slack;`,
        ``,
      ].join("\n"),
    );

    // 3 — `require.resolve("…")` (PropertyAccessExpression call, not bare require).
    fileRequireResolve = join(root, "require-resolve.ts");
    writeFileSync(
      fileRequireResolve,
      [
        `// require.resolve form`,
        `const mainPath = require.resolve("${specTo(root, "cli/main")}");`,
        `export const p = mainPath;`,
        ``,
      ].join("\n"),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("flags all three AST-class fixtures, one violation each", () => {
    const violations = scanForInternalImports(root);
    const offenders = new Set(violations.map((v) => v.file));
    expect(offenders).toEqual(new Set([fileRegexLiteral, fileImportEquals, fileRequireResolve]));
    expect(violations.length).toBe(3);
  });

  test("a regex literal containing /* does not hide a following src/ import", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileRegexLiteral);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileRegexLiteral, "controller/executor"));
    expect(v[0].specifier).toContain("controller/executor");
  });

  test("an `import x = require(\"src/…\")` (ImportEqualsDeclaration) is flagged", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileImportEquals);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileImportEquals, "channels/slack"));
    expect(v[0].specifier).toContain("channels/slack");
  });

  test("a `require.resolve(\"src/…\")` (PropertyAccessExpression) is flagged", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileRequireResolve);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileRequireResolve, "cli/main"));
    expect(v[0].specifier).toContain("cli/main");
  });
});

// Regression coverage for the module-extension bypass (F1): bun executes the
// whole TypeScript module family (.mts/.cts/.tsx), not just .ts, so a file with
// any of those extensions that imports into src/ must be scanned and flagged.
// Before the fix the walker only discovered `.ts` files, so these fixtures were
// silently skipped and contributed zero violations — a genuine gate bypass.
describe("scanForInternalImports — TypeScript module-extension regression", () => {
  let root: string;
  const specTo = (fromDir: string, srcRel: string) => relative(fromDir, join(repoRoot, "src", srcRel));

  let fileMts: string;
  let fileCts: string;
  let fileTsx: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bb-import-scan-ext-"));

    // .mts — ESM TypeScript module with a static src/ import.
    fileMts = join(root, "esm-module.mts");
    writeFileSync(
      fileMts,
      [
        `import { readFileSync } from "node:fs";`,
        `import { runExecutor } from "${specTo(root, "controller/executor")}";`,
        `export const x = () => { void readFileSync; void runExecutor; };`,
        ``,
      ].join("\n"),
    );

    // .cts — CommonJS TypeScript module with a src/ import.
    fileCts = join(root, "cjs-module.cts");
    writeFileSync(
      fileCts,
      [
        `import { slackThing } from "${specTo(root, "channels/slack")}";`,
        `export const s = () => { void slackThing; };`,
        ``,
      ].join("\n"),
    );

    // .tsx — TSX module: JSX alongside a real src/ import. The scanner must
    // parse the JSX (ScriptKind.TSX) without a syntax error AND still flag the
    // import.
    fileTsx = join(root, "component.tsx");
    writeFileSync(
      fileTsx,
      [
        `import { main } from "${specTo(root, "cli/main")}";`,
        `export const El = () => <div className="x">{String(main)}</div>;`,
        ``,
      ].join("\n"),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("flags all three module-extension fixtures, one violation each", () => {
    const violations = scanForInternalImports(root);
    const offenders = new Set(violations.map((v) => v.file));
    expect(offenders).toEqual(new Set([fileMts, fileCts, fileTsx]));
    expect(violations.length).toBe(3);
  });

  test("a .mts file importing into src/ is flagged", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileMts);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileMts, "controller/executor"));
    expect(v[0].specifier).toContain("controller/executor");
  });

  test("a .cts file importing into src/ is flagged", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileCts);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileCts, "channels/slack"));
    expect(v[0].specifier).toContain("channels/slack");
  });

  test("a .tsx file (JSX) importing into src/ is parsed and flagged", () => {
    const v = scanForInternalImports(root).filter((x) => x.file === fileTsx);
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(lineOf(fileTsx, "cli/main"));
    expect(v[0].specifier).toContain("cli/main");
  });
});
