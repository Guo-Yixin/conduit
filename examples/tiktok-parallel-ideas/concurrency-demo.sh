#!/usr/bin/env bash
#
# Reproducible proof that `conduit run --concurrency K` runs fan-out lanes
# K-at-a-time as real out-of-process workers. See docs/concurrency-demo.md.
#
# Runs the tiktok fan-out flow (DuckDB select -> fan-out x10 -> ideate -> collect)
# at several concurrency levels, with the `ideate` lane instrumented to sleep and
# timestamp its START/END so the actual peak overlap is measurable. Everything
# happens in a temp dir; the committed example is never mutated.
#
# Usage:  examples/tiktok-parallel-ideas/concurrency-demo.sh [K ...]   (default: 1 3 5)
# Requires: bun, duckdb, python3.
set -euo pipefail

LEVELS=("${@:-1 3 5}")
# Resolve repo root from this script's location (examples/tiktok-parallel-ideas/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$REPO_ROOT/src/cli/main.ts"

command -v duckdb >/dev/null || { echo "duckdb not found on PATH"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$SCRIPT_DIR"/* "$WORK/"
rm -rf "$WORK/ideas" "$WORK"/*.sqlite "$WORK/obs.log"

# Instrument `ideate`: timestamp START, sleep, timestamp END into a shared log.
# Raise its `wip` to 10 so the run-level --concurrency flag is the binding cap
# (the real cap is min(K, station.wip)).
cat > "$WORK/obs-ideate.sh" <<'SH'
#!/usr/bin/env bash
printf '%s %s START\n' "$(date +%s.%N)" "$$" >> obs.log
sleep 0.4
printf '%s %s END\n' "$(date +%s.%N)" "$$" >> obs.log
SH
chmod +x "$WORK/obs-ideate.sh"

python3 - "$WORK" <<'PY'
import re, sys
work = sys.argv[1]
src = open(f"{work}/flow-kernel-demo.yaml").read()
src, n = re.subn(
    r'(- id: ideate\n    worker:\n      kind: deterministic\n      role: creative-strategist\n)      command: "true"\n',
    r'\1      command: bash\n      args: ["obs-ideate.sh"]\n    wip: 10\n', src)
assert n == 1, f"ideate substitution failed (n={n})"
open(f"{work}/flow-obs.yaml", "w").write(src)
PY

cat > "$WORK/analyze.py" <<'PY'
import sys
intervals = {}
order = []
for line in open(sys.argv[1]):
    t, pid, ev = line.split()
    if ev == "START":
        intervals[pid] = [float(t), None]; order.append(pid)
    else:
        intervals[pid][1] = float(t)
# Peak simultaneous in-flight via a sweep over START(+1)/END(-1) events.
events = []
for s, e in intervals.values():
    events += [(s, 1), (e, -1)]
events.sort()
cur = peak = 0
for _, d in events:
    cur += d; peak = max(peak, cur)
starts = [v[0] for v in intervals.values()]
ends = [v[1] for v in intervals.values()]
print(f"  lanes observed : {len(intervals)}")
print(f"  PEAK in-flight : {peak}")
print(f"  wall-clock     : {max(ends) - min(starts):.2f}s")
PY

printf '%-14s | %-14s | %-11s | %s\n' "concurrency" "peak in-flight" "wall-clock" "lanes done"
printf '%s\n' "---------------+----------------+-------------+-----------"
for K in ${LEVELS[@]}; do
  rm -f "$WORK/obs.log" "$WORK/state.sqlite" "$WORK/journal.sqlite"
  CONDUIT_STATE_DB="$WORK/state.sqlite" CONDUIT_JOURNAL_DB="$WORK/journal.sqlite" \
    CONDUIT_API_KEY=x CONDUIT_BASE_URL=x CONDUIT_PROJECT_ROOT="$WORK" \
    bun "$CLI" run "$WORK/flow-obs.yaml" --input "$WORK/request.json" --concurrency "$K" \
    >/dev/null 2>&1
  PEAK=$(python3 "$WORK/analyze.py" "$WORK/obs.log" | awk -F': ' '/PEAK/{print $2}')
  WALL=$(python3 "$WORK/analyze.py" "$WORK/obs.log" | awk -F': ' '/wall-clock/{print $2}')
  DONE=$(bun -e "const {openConduitDB}=await import('$REPO_ROOT/src/persistence/db');const db=openConduitDB({stateDbPath:'$WORK/state.sqlite',journalDbPath:'$WORK/journal.sqlite'});console.log(db.getStateDb().prepare(\"SELECT COUNT(*) n FROM cards WHERE parent_id IS NOT NULL AND lane='done'\").get().n);" 2>/dev/null)
  printf '%-14s | %-14s | %-11s | %s/10\n' "$K" "$PEAK" "$WALL" "$DONE"
done
