#!/usr/bin/env bash
# Reads selected.json, writes plan.json with one child per product.
set -e
python3 - <<'PYEOF'
import json, sys
with open("selected.json") as f:
    products = json.load(f)
children = [
    {"id": p["id"], "depends_on": [], "owned_paths": [f"ideas/{p['id']}/"]}
    for p in products
]
with open("plan.json", "w") as f:
    json.dump({"children": children}, f, indent=2)
print(f"[gen-plan] wrote {len(children)} children to plan.json", file=sys.stderr)
PYEOF
