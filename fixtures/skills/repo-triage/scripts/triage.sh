#!/usr/bin/env bash
# Fixture-only helper script. Proves that bundled scripts/ are read as inert
# bytes by a data-only skill consumer, never executed.
set -euo pipefail

echo "Triage checklist:"
echo "  1. Reproduce the issue."
echo "  2. Classify: bug | feature | question | chore."
echo "  3. Assign severity: p0 | p1 | p2 | p3."
echo "  4. Tag the relevant owning team."
