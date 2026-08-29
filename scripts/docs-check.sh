#!/bin/sh
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
# Usage: scripts/docs-check.sh <file>...
# Exit:  0 = nothing this change touched is stale (or drift is not installed)
#        1 = at least one bound doc is now unvouched-for
set -eu

command -v drift >/dev/null 2>&1 || {
  echo "docs-check: drift not installed — skipping (see CONTRIBUTING.md)" >&2
  exit 0
}
[ "$#" -gt 0 ] || exit 0
[ -f drift.lock ] || exit 0

# Fast path: skip drift entirely unless something changed is actually a binding
# target. The overwhelmingly common case — 8 of 65 non-test source files are
# anchored — and it keeps a 50-file PR from paying 50 drift invocations.
governed=$(bun scripts/docs-governing.ts --files "$@" 2>/dev/null || true)
[ -n "$governed" ] || exit 0

stale=0
for f in $governed; do
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
MSG
exit 1
