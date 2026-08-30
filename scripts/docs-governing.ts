#!/usr/bin/env bun
/**
 * Reverse lookup: which docs make claims about a given source file?
 *
 * WHY THIS EXISTS (rather than shelling out to `drift refs`): `drift refs`
 * requires an EXACT anchor match. Given a binding to
 * `src/quality/rework.ts#decideQcReject`, `drift refs src/quality/rework.ts`
 * returns nothing — you must already know the symbol. An agent about to edit a
 * file does not know which of its symbols are bound, which makes `drift refs`
 * unusable for the pre-edit routing this script serves.
 *
 * So we prefix-match the target column of drift.lock instead: any binding whose
 * target is the file itself or `<file>#Symbol` counts as governing that file.
 *
 * Usage:  bun scripts/docs-governing.ts [--files] [--print0] [--] <path>...
 * Output: one governing doc path per line (deduped, sorted). With `--files`,
 *         instead echoes back the subset of INPUT paths that any binding
 *         targets — used by docs-check.sh to skip `drift check` entirely when a
 *         change touches nothing bound. Both are empty for unbound input;
 *         silence is the common case and costs nothing.
 * Exit:   0 on a successful lookup, whether or not it found anything. This
 *         routes attention; it never gates. `drift check` gates. A CRASH still
 *         exits non-zero, and docs-check.sh treats that as a failure rather
 *         than as an empty result — see the fail-closed note there.
 *
 * `--print0` NUL-terminates each output path, and `--` ends flag parsing, so a
 * pathname containing a space, a quote, a glob character or a newline survives
 * the round trip from `git diff -z` through this script and into `drift`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

const LOCKFILE = 'drift.lock';

/** One `[[bindings]]` table reduced to the two fields this lookup needs. */
interface Binding {
  doc: string;
  target: string;
}

/**
 * Minimal TOML reader for drift.lock's `[[bindings]]` array-of-tables. Written
 * by hand rather than pulling a TOML dependency: the file's shape is fixed by
 * drift (version + repeated bindings with quoted scalar fields), and a doc
 * lookup must never be the reason `bun install` grows.
 */
export function parseBindings(toml: string): Binding[] {
  const bindings: Binding[] = [];
  let current: Partial<Binding> | null = null;

  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '[[bindings]]') {
      if (current?.doc !== undefined && current.target !== undefined) {
        bindings.push({ doc: current.doc, target: current.target });
      }
      current = {};
      continue;
    }
    if (current === null) continue;
    const match = /^(doc|target)\s*=\s*"(.*)"$/.exec(line);
    if (match !== null) current[match[1] as 'doc' | 'target'] = match[2] as string;
  }
  if (current?.doc !== undefined && current.target !== undefined) {
    bindings.push({ doc: current.doc, target: current.target });
  }
  return bindings;
}

/**
 * True when `target` governs `file` — an exact file binding, or a symbol
 * binding into that file. The '#' guard keeps `src/law/contract.ts` from
 * matching a hypothetical `src/law/contract.ts.bak`: only an exact match or a
 * genuine symbol suffix counts.
 */
export function targetGoverns(target: string, file: string): boolean {
  return target === file || target.startsWith(`${file}#`);
}

export function docsGoverning(bindings: Binding[], files: string[]): string[] {
  const docs = new Set<string>();
  for (const file of files) {
    for (const b of bindings) {
      if (targetGoverns(b.target, file)) docs.add(b.doc);
    }
  }
  return [...docs].sort();
}

/**
 * The subset of `files` that some binding targets, in the order given.
 *
 * Shares `targetGoverns` with `docsGoverning` deliberately: the rule for "does
 * this target belong to this file" — including the '#' guard that stops
 * `contract.ts` matching `contract.test.ts` — is subtle enough that a second
 * copy in shell would eventually disagree with this one.
 */
export function governedFiles(bindings: Binding[], files: string[]): string[] {
  return files.filter((f) => bindings.some((b) => targetGoverns(b.target, f)));
}

/** Normalise to repo-relative POSIX paths so hook-supplied absolute paths match. */
function toRepoRelative(p: string): string {
  return (isAbsolute(p) ? relative(process.cwd(), p) : p).replaceAll('\\', '/');
}

/** A parsed invocation. Exported so the argument boundary itself has coverage. */
export interface Invocation {
  wantFiles: boolean;
  print0: boolean;
  files: string[];
}

/**
 * Leading flags, then paths. `--` ends flag parsing so a pathname that begins
 * with a dash — or is literally named `--files` — is still treated as a path;
 * docs-check.sh always passes it for exactly that reason.
 */
export function parseInvocation(argv: string[]): Invocation {
  let wantFiles = false;
  let print0 = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '--files') {
      wantFiles = true;
      continue;
    }
    if (arg === '--print0') {
      print0 = true;
      continue;
    }
    break;
  }
  return { wantFiles, print0, files: argv.slice(i) };
}

if (import.meta.main) {
  const { wantFiles, print0, files: raw } = parseInvocation(process.argv.slice(2));
  const files = raw.map(toRepoRelative);
  if (files.length === 0 || !existsSync(LOCKFILE)) process.exit(0);
  const bindings = parseBindings(readFileSync(LOCKFILE, 'utf-8'));
  const out = wantFiles ? governedFiles(bindings, files) : docsGoverning(bindings, files);
  if (out.length === 0) process.exit(0);
  // NUL-TERMINATED, not NUL-separated: a trailing delimiter is what lets the
  // reading loop treat "no output" and "one empty path" as different things.
  process.stdout.write(print0 ? out.map((p) => `${p}\0`).join('') : `${out.join('\n')}\n`);
}
