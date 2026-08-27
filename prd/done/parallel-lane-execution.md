---
missionId: ~
---

# Conduit — Parallel Lane Execution (concurrent workers + per-child input)

**Status:** Done

> Motivated by [`examples/tiktok-parallel-ideas`](../../examples/tiktok-parallel-ideas/):
> fan out one ideation flow across N products and get N ideas back — running
> several lanes at a time.

## 1. Context & Background

Conduit already has fan-out/fan-in wired (`src/dag/expand.ts` `commitFanOut`/
`evaluateFanIn`, driven by `runExecutor`). A station with `fan_out` + `child_entry`
+ `child_terminal` + `resume_at` spawns N child cards that run a sub-path and
merge at a fan-in. The `branching` and `tiktok-parallel-ideas` examples exercise
this topology.

Building `tiktok-parallel-ideas` surfaced that the topology alone does **not**
deliver the intended "N different products → N ideas, several at a time." Two
capabilities are missing from the kernel:

1. **Per-child input binding.** A `ProposedChild` carries only `id`,
   `depends_on`, and `owned_paths` (`src/dag/expand.ts:29`); `commitFanOut`
   persists only `parent_id` + `owned_paths` (`expand.ts:17`). The project root
   / worker cwd is a single value for the whole run (`executor.ts:177`,
   `cwd: projectRoot`). So every child runs the *same* station config against the
   *same* input artifacts — N stochastic variants of one input, not product-_i_
   per lane. **This is the per-child differentiation gap**, which also appears
   in the `branching` example. The intended design is that an architect can seed each child with its own
   input/params that reaches the `child_entry` station's prompt rendering.

2. **Concurrent execution.** `runExecutor`'s dispatch loop `await`s each
   `executeStation()` one at a time (`executor.ts`, the `for (const action of
   plan.actions)` loop) — never more than one worker in flight. The N lanes run
   serially; output is identical, only wall-clock differs.

The *safety substrate* for concurrency already exists and is the hard part:
- atomic claim (`dispatch/claim.ts` `attemptClaim`, a single `BEGIN IMMEDIATE`
  linearization point) — checks card-ready + WIP cap + free slot atomically;
- `active_workers` table with a `lease_until` heartbeat (`persistence/db.ts`);
- `renewLease`, `reconcile` (lease-expiry → `interrupted`), and
  `reclaimOrphanedWorkers` (crash recovery);
- per-station `wip` caps, enforced inside the claim;
- `watchdog.planDrain` — drain-and-checkpoint on a soft-ceiling andon trip,
  **built but unwired precisely because there is nothing to drain when work is
  serial** (CLAUDE.md "built but not driven").

The SPEC treats concurrent workers as foundational, not deferred: §1 (Bun chosen
because `Bun.spawn` "makes dozens of concurrent lanes cheap to run"), §8 ("WIP is
per station … ANDed at the atomic claim"), §10A (workers as `Bun.spawn`
subprocesses reporting via `process.send`, kernel event-driven).

## 2. Problem Statement

A user wants to fan one flow out across a batch of distinct inputs and run
several lanes at once — e.g. ideate on 10 products, 5–10 lanes in flight. Today
the kernel can express the topology but (a) cannot give each lane its own input
and (b) runs the lanes one at a time.

## 3. Target Users & Use Cases

- **Studio batch ideation** (the motivating case): top-5 + bottom-5 products by
  sales velocity → one ideation lane per product → 10 ideas. Throughput matters
  at 100s of products; correctness (right product per lane) matters at any N.
- **A(i)-Team Wave-1**: fan a plan into independent task cards, each touching
  disjoint owned paths, running in parallel.
- **Enrichment / research**: N records or sub-questions, one lane each.

## 4. Goals & Success Metrics

- A fan-out flow delivers **one output per distinct input** (per-product ideas),
  not N variants of one input.
- An operator can cap concurrency (e.g. "≤ 8 lanes in flight") and observe lanes
  running in parallel (wall-clock for N lanes ≈ slowest lane, not Σ lanes).
- **Determinism and crash-safety are preserved**: same inputs → same outputs;
  a mid-batch crash resumes without double-billing or double-publishing; the
  per-wave budget still scraps a runaway subtree without halting siblings.
- No regression to single-in-flight flows (concurrency defaults off / =1).

## 5. Scope

### In Scope
- **Per-child input binding** for fan-out children — the per-child **seed**
  payload that closes the correctness gap. [OQ2]
- **The SPEC §10A multi-process worker pool**: the kernel spawns worker harnesses
  via `Bun.spawn`, assigns claimed lanes over `process.send` IPC, and becomes
  **event-driven** (re-plan on each `MARK_DONE`) instead of running a synchronous
  await-loop. [OQ4]
- A **run-level `concurrency` cap** (flow.yaml default + `conduit run
  --concurrency K` override) bounding concurrent worker processes, composing
  with per-station `wip`. [OQ3]
- **Wire `watchdog.planDrain`** so a soft-ceiling andon trip drains in-flight
  worker lanes to a checkpoint instead of hard-breaking.
- Concurrency-aware tests through the real executor (parallel claims, crash
  mid-batch, per-wave budget under concurrency, IPC round-trip).

### Out of Scope
- **Agentic stations.** This pool is the foundation agentic isolation will build
  on (§10A), but the agentic Tool-Bridge (step 9) is its own PRD.
- Cross-machine / distributed workers (single host, multiple processes).
- Per-child *routing* to different `child_entry` stations — the per-child seed
  covers heterogeneous work with one parameterized station; routing
  is a possible follow-on.

## 6. Requirements

### Functional Requirements
- **FR-1 (per-child input).** A fan-out parent can bind a distinct input to each
  child. The chosen design follows the original requirement: the
  architect proposal attaches a per-child **seed** — a small input artifact or
  params blob — alongside each `ProposedChild`; `commitFanOut` materializes it
  into the child's `owned_paths` dir; and prompt rendering for the `child_entry`
  station can see it (e.g. `{{seed.json}}` / the child's own inputs), so one
  parameterized station covers heterogeneous children ("do the job in my seed").
  Must compose with the owned-paths integrity gate. Per-child *routing* to
  genuinely different stations is a nice-to-have on top, not required; the seed
  is the unlock.
- **FR-2 (multi-process workers).** The kernel spawns worker harnesses via
  `Bun.spawn` and assigns each a claimed lane over `process.send` IPC
  (START_WORK → the harness runs the station → MARK_DONE / heartbeat back). The
  kernel becomes **event-driven**: it reacts to worker IPC (a lane finished →
  re-plan) rather than awaiting stations in a synchronous loop. The atomic claim
  remains the single linearization point; workers never write the state DB —
  they report results and the **kernel stays the sole DB writer**.
- **FR-2a (concurrency cap).** A run-level `concurrency: K` (flow.yaml default,
  `conduit run --concurrency K` override; default 1 → today's behavior) bounds
  the number of in-flight worker processes. Effective per-station parallelism =
  `min(K, station.wip)`.
- **FR-3 (drain on andon).** When the consumption andon trips while lanes are in
  flight, `planDrain` checkpoints/drains the in-flight workers rather than
  abandoning work.
- **FR-4 (fan-in unchanged).** `evaluateFanIn` (quorum/all/best-effort) and the
  per-wave budget operate correctly when children complete concurrently and
  out of order (MARK_DONE arrives in nondeterministic order).
- **FR-5 (worker liveness).** A worker reports a heartbeat that renews its lease
  (`renewLease`); a crashed/stalled worker is caught by `reconcile` (lease
  expiry → `interrupted`) and `reclaimOrphanedWorkers` on resume — extended to
  detect dead child PIDs, not only expired leases.

### Non-Functional Requirements
- **NFR-1 (determinism).** Concurrency must not change *outputs* — only ordering
  and wall-clock. Checkpoints, binding stamps, and the journal stay correct under
  interleaving.
- **NFR-2 (crash-safety).** Lease/`reconcile`/`reclaimOrphanedWorkers` already
  cover crashed in-flight workers; verify under K>1.
- **NFR-3 (single-writer persistence).** Only the kernel writes the state DB;
  workers report results over IPC. This preserves the single-writer model under
  concurrency — there is no multi-process SQLite contention because workers never
  open the DB. (The kernel's own writes remain synchronous and serialized.)
- **NFR-4 (IPC discipline).** The kernel↔worker protocol (START_WORK, MARK_DONE,
  heartbeat) uses `process.send` with bounded message sizes; large artifacts go
  through the filesystem (owned_paths), not the IPC channel.

### Edge Cases & Error States
- A lane fails mid-batch → only that subtree is affected (sibling lanes and the
  run continue); the per-wave budget / cap policy applies.
- Per-child owned-paths overlap → already rejected at `commitFanOut`
  (`overlapping_owned_paths`).
- K larger than available ready cards → bounded by what's dispatchable; no busy-spin.

## 7. Design Principles
- **Deterministic flow, non-deterministic labor** — concurrency changes timing,
  never the legal-next decision.
- **The atomic claim is the only linearization point** — do not add a second
  concurrency-control substrate; lean on `attemptClaim` + `wip`.
- **Reuse the built substrate** — lease, reconcile, reclaim, planDrain already
  exist; wire them, don't reinvent.
- **Concurrency is opt-in** — default cap 1 keeps existing flows byte-identical.

## 8. Solution Approach

**Tier 1 — per-child seed (correctness).** `ProposedChild`
gains an optional `seed` (a small input artifact / params blob). `commitFanOut`
materializes each child's seed into that child's `owned_paths` dir (e.g.
`<child-dir>/seed.json`) inside its existing atomic transaction. Prompt rendering
for the `child_entry` station exposes the seed (`{{seed.json}}`) alongside the
shared parent inputs — so one parameterized station covers heterogeneous
children. Composes with the owned-paths integrity gate (the seed lands inside
the dir the lane already owns).

**Tier 2 — multi-process worker pool (throughput, SPEC §10A).** The synchronous
`await executeStation()` loop becomes an **event-driven kernel**:
1. Each tick, the kernel claims up to `min(K, wip)` dispatchable lanes via the
   existing atomic `attemptClaim`.
2. For each claim, it `Bun.spawn`s (or reuses a pooled) worker harness and sends
   `START_WORK` with the lane's station + card + resolved inputs over
   `process.send`. The worker runs the station body (the current `executeStation`
   logic) in its own process and reports `MARK_DONE` (+ periodic heartbeat).
3. The kernel reacts to each `MARK_DONE`: it performs the post-work transition,
   checkpoint, journal write, fan-in evaluation, and re-plan — all **in the
   kernel** (sole DB writer). Worker crashes surface via lease expiry
   (`reconcile`) or dead-PID detection; `reclaimOrphanedWorkers` recovers on
   resume.
4. The run-level cap `K` bounds concurrent worker processes; `planDrain` drains
   them to a checkpoint on a soft-ceiling andon trip.

This reuses the entire built substrate (atomic claim, `active_workers` lease,
`renewLease`/`reconcile`/`reclaimOrphanedWorkers`, per-station `wip`, per-wave
budget, `planDrain`) and the runtime ADR-0002 was chosen for (`Bun.spawn` +
`process.send`, no broker). The invasive part is replacing the synchronous tick
with the event-driven loop (see Risks).

This pool is also the foundation the **agentic Tool-Bridge** (step 9) needs for
per-station process isolation — building it here means agentic concurrency is
a smaller follow-on, not a second worker model.

## 9. Alternatives Considered

- **External orchestration (no kernel change)** — [OQ1, rejected]. Run **N
  independent `conduit run` invocations** (one per product, each its own
  `request.json` + state DB), launched 5–10 at a time via a launcher / the
  operator compose stack (`docker-compose.operator.yml` already models per-run
  kernel services that spawn-and-exit). Works today, sidesteps the per-child gap.
  Rejected because the batch then has **no shared fan-in / rank / per-wave
  budget** — the batch exists only in the launcher, not as a first-class flow.
- **In-process bounded concurrency** — [OQ4, rejected]. A Promise pool over
  `executeStation` in the single kernel process (parallelism at the model-call /
  subprocess `await` points), single SQLite connection. Smaller, faster to ship.
  Rejected in favor of building the SPEC §10A multi-process model directly: it
  avoids a throwaway interim, gives true per-station process isolation, and is
  the **same foundation agentic stations need** — so it's built once.

## 10. Resolved Questions

- **Approach** — in-flow fan-out concurrency (not external orchestration). [OQ1]
- **Per-child input** — a per-child **seed** payload materialized into the
  child's owned dir and exposed to prompt rendering. [OQ2]
- **Concurrency knob** — a run-level `concurrency` cap (flow default +
  `--concurrency` override), composing with per-station `wip`. [OQ3]
- **Execution model** — the SPEC §10A multi-process worker pool (`Bun.spawn`
  harnesses + `process.send` IPC + event-driven kernel). [OQ4]

## 11. Risks

- **RISK (highest) — event-driven kernel rewrite.** Replacing the synchronous
  tick/await loop with an event-driven loop driven by worker IPC is the most
  invasive change in the codebase. Mitigation: keep `planTick` as the planner;
  change only *who drives execution* (IPC events vs. a `for` loop), and gate the
  whole pool behind `concurrency > 1` so the existing synchronous path stays the
  default and the regression surface is opt-in.
- **RISK — worker lifecycle leaks.** Spawned harnesses that hang or leak. Mitigation:
  the per-station `timeout_seconds` + lease expiry + `reclaimOrphanedWorkers`,
  extended with dead-PID detection (FR-5).
- **RISK — IPC protocol surface.** A new kernel↔worker contract (START_WORK /
  MARK_DONE / heartbeat). Mitigation: keep it minimal, artifacts via filesystem
  not IPC (NFR-4), contract-test the round-trip.
- **RISK — andon latency.** A hard andon with lanes in flight should drain, not
  abandon (FR-3, `planDrain`).
- **DEPENDENCY — `watchdog.planDrain`** is built but unwired; this PRD is its
  build-order step. This work is also the **prerequisite for agentic-station
  concurrency** (step 9).
