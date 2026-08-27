# tiktok-parallel-ideas

The [`tiktok-shoppable-ideas`](../tiktok-shoppable-ideas/) flow, **fanned out
across a batch of products**: select the top-5 and bottom-5 products by recent
sales velocity, fire off one ideation lane per product, and collect the batch of
ideas. One trigger → N parallel asset lanes — the "Studio" fan-out pattern.

```
select (DuckDB)            rank by velocity, pick top-5 + bottom-5
  └─> plan (FAN-OUT ×10)   one child lane per product
        └─ ideate ─> gate ─> done    the normal ideation, per lane
  └─> collect (FAN-IN: all)          gather the 10 ideas
        └─> done
```

Render it: `conduit explain examples/tiktok-parallel-ideas/flow.yaml`

## Why top-5 + bottom-5

It's a deliberately sharp batch: ideate on your **winners** (double down on what
sells) and your **laggards** (try to revive them) in one run. The selection
policy lives entirely in [`select.sql`](./select.sql) — change the query and the
flow is unchanged.

## What works today

This flow **loads, renders, and runs end-to-end today** — fan-out/fan-in, the
per-product fan-out, and **bounded concurrent execution** are all wired into the
executor (the [`parallel-lane-execution`](../../prd/done/parallel-lane-execution.md)
PRD has landed):

1. **Per-child input binding.** Each fan-out child receives a materialized
   per-child seed (`seed.json`) in its owned directory, so every `ideate` lane
   works on its own product rather than N stochastic variants of a shared input.
2. **Concurrent execution.** `conduit run … --concurrency K` dispatches the
   fan-out lanes K-at-a-time as real out-of-process workers, bounded by
   `min(K, station.wip)`. The output is identical to the serial run; only
   wall-clock differs.

### Proving the parallelism

`flow-kernel-demo.yaml` runs the whole topology with **zero model calls**
(DuckDB `select` + a deterministic `plan` + no-op `ideate`/`collect`), so you can
exercise the kernel without a gateway:

```
conduit run examples/tiktok-parallel-ideas/flow-kernel-demo.yaml \
  --input examples/tiktok-parallel-ideas/request.json --concurrency 5
```

All 10 product lanes fan out, run under the cap, and fan back in. For a measured,
reproducible proof that the lanes actually run K-at-a-time as real subprocesses,
run the demo harness (instruments `ideate` with a timed sleep and reports the
peak simultaneous lanes at each concurrency level):

```
examples/tiktok-parallel-ideas/concurrency-demo.sh 1 3 5
```

```
concurrency    | peak in-flight | wall-clock  | lanes done
1              | 1              | 4.06s       | 10/10
3              | 3              | 1.75s       | 10/10
5              | 5              | 0.87s       | 10/10
```

Peak in-flight tracks `--concurrency` exactly and all 10 lanes complete in every
case — only wall-clock changes. The full write-up is in
[`docs/concurrency-demo.md`](../../docs/concurrency-demo.md). Note the cap is
`min(K, station.wip)`: a station's `wip` still bounds K, so raise `ideate.wip` to
let a larger `--concurrency` take effect (the harness does this for you).

## Files

| File | Role |
|---|---|
| `flow.yaml` | the flow definition (select → plan fan-out → ideate → collect) |
| `flow-deterministic-plan.yaml` | same flow with a deterministic `plan` station (`gen-plan.sh` instead of an LLM) — fan-out as pure mapping, model tokens spent only on ideation |
| `select.sql` | the velocity ranking + top/bottom-5 selection query |
| `prompts/plan.md` | fan-out parent: emit one child lane per selected product |
| `prompts/ideate.md` | per-product ideation (reused verbatim from tiktok-shoppable-ideas) |
| `prompts/verify.md` | the gate critic (reused verbatim from tiktok-shoppable-ideas) |
| `request.json` | sample batch request (window + selection policy) |

The DuckDB fixture is not committed here — point `select.sql` and the `select`
station's `args` at your own data (or the sibling `tiktok-shoppable-ideas`
fixture) to run for real.
