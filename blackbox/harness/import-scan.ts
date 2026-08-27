/**
 * Zero-internal-imports gate (WI-678).
 *
 * Scans every TypeScript module file (.ts/.mts/.cts/.tsx) under a directory for
 * imports/requires that resolve into <repoRoot>/src — the boundary the
 * black-box suite must never cross
 * (it exercises the shipped binary and public surfaces only).
 *
 * Round 3: rewritten on the TypeScript compiler API instead of hand-lexing.
 * Two prior regex/tokenizer approaches each closed one bypass class and
 * opened another (a same-line comment scan missed a `//` inside a string; a
 * char-by-char comment-stripper then misread an unescaped `/*` inside a
 * regex literal, e.g. `/^\/api\/*​/`, as a block-comment opener and swallowed
 * code to EOF). Three token classes — comments, strings, regex literals —
 * in three hand-written passes doesn't converge; a real parser does, by
 * construction, for every future token class too. `typescript` is a
 * third-party devDependency (tsc already runs it for typecheck), not a
 * src/ import, so this satisfies the gate's own zero-internal-imports rule.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import ts from "typescript";

export interface Violation {
  file: string;
  line: number;
  specifier: string;
}

// This file lives at <repoRoot>/blackbox/harness/import-scan.ts.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const REPO_SRC_DIR = resolve(REPO_ROOT, "src");

/** True iff `specifier`, resolved from `fromFile`, lands inside <repoRoot>/src. */
function resolvesIntoSrc(fromFile: string, specifier: string): boolean {
  let resolved: string;
  if (specifier.startsWith(".")) {
    resolved = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    // tsconfig path alias: "@/*" -> "src/*".
    resolved = resolve(REPO_ROOT, "src", specifier.slice(2));
  } else if (isAbsolute(specifier)) {
    resolved = specifier;
  } else {
    // Bare specifier: node:/bun: builtin or a third-party package — never
    // resolves into a repo-relative src/ path.
    return false;
  }
  return resolved === REPO_SRC_DIR || resolved.startsWith(REPO_SRC_DIR + sep);
}

function walkTsFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.(m|c)?tsx?$/.test(entry.name)) {
        // The whole TypeScript module family bun executes as TS: .ts, .mts,
        // .cts, and .tsx. Scanning only .ts would let a blackbox/foo.mts (or
        // .tsx) import into src/ and evade the gate entirely.
        files.push(full);
      }
    }
  }
  return files;
}

/** The specifier string-literal node for a matched import/export/require form, or undefined. */
function matchedSpecifierNode(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node)) {
    // Covers both `import ... from "x"` and side-effect-only `import "x"`.
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
  }
  if (ts.isExportDeclaration(node)) {
    // `export ... from "x"` / `export * from "x"`; plain `export {...}` has
    // no moduleSpecifier and is correctly ignored.
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (ts.isImportEqualsDeclaration(node)) {
    // TypeScript's `import x = require("...")` — a distinct node kind from
    // ImportDeclaration; the specifier lives on moduleReference, not on the
    // ImportEqualsDeclaration itself, and only for the require(...) form
    // (an entity-name module reference like `import x = A.B` has no string
    // specifier at all).
    const ref = node.moduleReference;
    return ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)
      ? ref.expression
      : undefined;
  }
  if (ts.isCallExpression(node)) {
    // ts.isImportCall exists at runtime but isn't part of the public .d.ts
    // surface, so match the dynamic-import call expression's own kind
    // directly (`import(...)` parses with an ImportKeyword expression node).
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    // `require.resolve("...")` — a PropertyAccessExpression call, not a bare
    // identifier call, so the plain `require(...)` check above never matches it.
    const isRequireResolve =
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "require" &&
      node.expression.name.text === "resolve";
    if (isDynamicImport || isRequire || isRequireResolve) {
      const arg = node.arguments[0];
      return arg && ts.isStringLiteralLike(arg) ? arg : undefined;
    }
  }
  return undefined;
}

function scanFile(file: string, content: string): Violation[] {
  // A parse-level failure on real TypeScript source is unexpected enough to
  // treat as a hard scan error (fail-closed) rather than silently skipping
  // the file — a silent skip is exactly the kind of gap this gate exists to
  // never have.
  // .tsx must parse as TSX so JSX syntax doesn't raise a spurious parse error;
  // .ts/.mts/.cts all parse cleanly as plain TS.
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`scanForInternalImports: failed to parse '${file}': ${detail}`);
  }

  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    const specifierNode = matchedSpecifierNode(node);
    if (specifierNode) {
      const specifier = specifierNode.text;
      if (resolvesIntoSrc(file, specifier)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile));
        violations.push({ file, line: line + 1, specifier });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * Recursively scans every TypeScript module file (.ts/.mts/.cts/.tsx) under
 * `rootDir` (skipping node_modules) for an import/export/require whose
 * specifier resolves into <repoRoot>/src.
 */
export function scanForInternalImports(rootDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkTsFiles(rootDir)) {
    const content = readFileSync(file, "utf8");
    violations.push(...scanFile(file, content));
  }
  return violations;
}
