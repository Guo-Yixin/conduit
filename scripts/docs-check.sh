#!/usr/bin/env bash
# Shared documentation-freshness check, scoped to a set of changed files.
#
# ONE implementation, TWO callers — .githooks/pre-commit (staged files) and the
# `docs` CI job (files changed in the PR). CI is the backstop for a commit that
# bypassed the hook (--no-verify, or a contributor who never installed drift),
# so it has to reach the SAME verdict; duplicating this loop in YAML would let
# the two drift apart precisely when the backstop matters.
#
# SCOPED, not a bare `drift check`: unscoped, ONE stale anchor on main fails
# every subsequent commit and every open PR until someone deals with it —
# blocking work that had nothing to do with it, which is how a check earns a
# permanent --no-verify. `drift check --changed <path>` restricts to bindings
# whose target is that path, so a change is only ever accountable for itself.
#
# bash, not sh: callers hand paths over as an array so a pathname containing a
# space, a quote, a glob character or a newline stays ONE argument end to end.
# POSIX sh has no array, and re-splitting on $IFS is how such a path silently
# becomes two paths that match no binding.
#
# Usage: scripts/docs-check.sh <file>...
# Exit:  0 = nothing this change touched is stale (or drift is not installed)
#        1 = at least one bound doc is now unvouched-for, or the check itself
#            could not run (see FAIL CLOSED below)
set -euo pipefail

command -v drift >/dev/null 2>&1 || {
  echo "docs-check: drift not installed — skipping (see CONTRIBUTING.md)" >&2
  exit 0
}
[ "$#" -gt 0 ] || exit 0
[ -f drift.lock ] || exit 0

# FAIL CLOSED. Everything below distinguishes "nothing here is bound" (exit 0,
# the common case) from "the lookup broke" (exit 1). Collapsing the second into
# the first is the dangerous direction: a missing bun, a syntax error or a bad
# argument would then read as a clean bill of health for every anchor.
command -v bun >/dev/null 2>&1 || {
  echo "docs-check: bun not found — cannot resolve which files are bound" >&2
  exit 1
}

# Fast path: skip drift entirely unless something changed is actually a binding
# target. The overwhelmingly common case — 8 of 65 non-test source files are
# anchored — and it keeps a 50-file PR from paying 50 drift invocations.
lookup=$(mktemp)
trap 'rm -f "$lookup"' EXIT
if ! bun scripts/docs-governing.ts --files --print0 -- "$@" >"$lookup"; then
  echo "docs-check: the governing-file lookup (scripts/docs-governing.ts) failed;" >&2
  echo "            refusing to report 'nothing is bound' on a broken lookup." >&2
  exit 1
fi

governed=()
while IFS= read -r -d '' f; do governed+=("$f"); done <"$lookup"
[ "${#governed[@]}" -gt 0 ] || exit 0

# One invocation per path, deliberately: `drift check` takes the LAST --changed
# it is given rather than the union of them, so a loop is the only way to cover
# every governed path. (Verified against drift v0.10.1.)
stale=0
for f in "${governed[@]}"; do
  if ! drift check --changed "$f" --silent >/dev/null 2>&1; then
    stale=1
    drift check --changed "$f" 2>&1 | grep -E 'STALE|BROKEN' || true
  fi
done
[ "$stale" -eq 0 ] && exit 0

cat >&2 <<'MSG'

Documentation bound to the code in this change is now unvouched-for.

This is an obligation, not an error: the code under those anchors moved, so
nobody has confirmed the prose since. Re-read the section named above, then

  - fix the prose if it is now wrong, and
  - re-stamp the anchor:  drift link <doc> --doc-is-still-accurate

`drift link` refuses to re-stamp without that flag. Passing it asserts that you
re-read the doc — do not pass it just to make this check pass. A drift.lock diff
that re-signs anchors while changing no prose is what reviewers look for.

A deleted or renamed binding target reports as STALE (file not found). Fix that
by moving the binding, not by re-stamping it:
  drift unlink <doc> <old-target> && drift link <doc> <new-target>
MSG
exit 1
