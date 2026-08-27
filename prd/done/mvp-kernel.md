---
missionId: ~
---

# Conduit MVP — The Deterministic Kernel

**Author:** Josh Owens  **Date:** 2026-05-30  **Status:** Done (shipped v0.1.0 — build-order steps 1–7)

> Scope note: this PRD defines the **kernel** — the engine that runs any
> `transform`+`deterministic` flow. It corresponds to build-order steps 1–7
> ([`docs/build-order.md`](../../docs/build-order.md)). The *how* lives in
> [`SPEC.md`](../../SPEC.md); this document defines *what must be true* and *why*,
> and stays implementation-free. A post-MVP dogfood spike, the agentic Tool-Bridge,
> the ingress listener, and kaizen are explicitly **out of scope**
> (post-MVP — see [After the MVP](../../docs/build-order.md#after-the-mvp)).

## 1. Context & Background

Three production systems — A(i)-Team (PRD → tested code), Studio (idea → ad assets),
and Autocut (raw footage → video) — were each built independently and **converged on
the same control architecture**: a deterministic state machine that routes work between
stations, with LLMs doing labor *at* the stations but never driving the loop. That
convergence is the evidence that a reusable kernel exists. Conduit extracts it so the
flow becomes config (`flow.yaml`), not bespoke code rebuilt per product.

**Why now.** Two forces make the kernel the right thing to build first:

- **The runaway is a known, expensive failure mode.** An LLM driving a long-lived
  orchestration loop in one of the reference systems ran ~40 hours without converging,
  re-reading context every tick. The kernel exists specifically to remove the LLM from
  the steady-state dispatch loop. Until the deterministic loop exists, every new flow
  re-inherits that risk.
- **Per-flow rebuilds don't compound.** Each of the three flows re-implemented routing,
  WIP, recovery, and budgets by hand. A validated kernel turns the next flow into a
  config file and a few station prompts — the leverage only arrives once the engine is
  real.

The station taxonomy ([SPEC §4](../../SPEC.md#4-the-routing--flowyaml-the-engineconfig-seam),
[ADR-0005](../../adr/0005-station-taxonomy.md))
makes this tractable: the highest-risk surface — the agentic Tool-Bridge and its "Law" —
applies only to `agentic` stations. A flow built purely of `deterministic` + `transform`
stations needs none of it. That is what lets the MVP ship a *complete, runnable kernel*
while deferring the scariest code.

## 2. Problem Statement

Teams building multi-step LLM pipelines have no deterministic substrate to run them on:
control flow ends up *inside* an LLM, which is non-reproducible, prone to runaway cost,
and impossible to checkpoint or recover soundly. Builders rebuild routing, WIP limits,
rework loops, and crash recovery by hand for every new pipeline, and each rebuild
re-introduces the same defects (stale-output replay, double side-effects on retry,
unbounded rework). Conduit needs a kernel that owns control flow deterministically so
that pipelines become configuration and LLMs are confined to producing and judging work.

## 3. Target Users & Use Cases

**Primary user — the flow builder (engineer).** Authors a `flow.yaml`, runs it, and
relies on the kernel for routing, recovery, and bounded behavior. Cares about the
config seam, load-time validation, station isolation for testing, and determinism
guarantees. This is the audience the document is written for.

**Secondary user — the flow operator (a customer).** A non-technical person who triggers a
run and interacts with it through the Slack egress channel — watches status, makes a HITL
selection, receives the finished artifact. Served *through the kernel's egress channel*,
not by a dedicated UI.

**Key use cases:**

- A builder needs to **define a flow as data** (`flow.yaml`) and have the kernel reject
  an invalid flow *before anything runs*, so misconfiguration fails loudly at load, not
  mid-run.
- A builder needs to **run a multi-station flow end-to-end** — fan-out, quality checks
  with rework, deterministic fan-in to a final artifact — driven entirely by the kernel
  with no LLM in the dispatch loop.
- A builder needs a run that **crashes mid-flight to resume soundly** — no re-billing of
  completed work, no duplicated irreversible side effects, no lost progress.
- A builder needs **rework and spend to be provably bounded**, so a misbehaving critic or
  a model that can't converge degrades to a scrap/halt instead of a runaway.
- A builder needs to **test a single station in isolation** against fixtures before
  trusting it on a flow.
- An operator needs to **see status, make an approval/selection, and receive the
  artifact** over Slack without touching the kernel directly.

## 4. Goals & Success Metrics

The MVP is graded on **correctness of the deterministic substrate**, not cost. Cost
benchmarking depends on a real product flow and a frontier baseline and is deferred to
a post-MVP dogfood spike.

| Goal | Metric | Target |
|------|--------|--------|
| Run a flow end-to-end without an LLM in the loop | Reference `transform`+`deterministic` flow reaches `done` and emits its artifact, unattended | 100% of clean-path runs |
| Sound crash recovery | Injected-crash runs that resume with **zero** re-billed completed stations and **zero** duplicated effectful side effects | 100% of injected-crash trials |
| Bounded rework & spend | Runs that exceed the four guards (rework cap, execution-attempt cap, progress-monotonicity, budgets) without terminating | 0 |
| Fail-closed configuration | Invalid `flow.yaml` (cyclic deps, overlapping owned paths, illegal transitions, missing `on_timeout`) that reaches dispatch instead of being rejected at load | 0 |
| The Law is testable | Enforcement hooks (Law-lite: owned-path + allowlisted-command) shipping without unit tests | 0 |
| No silent guessing | Unrecoverable/ambiguous states that auto-resolve instead of pausing to `hold` with a `needsJudgment` payload | 0 |

**Explicitly NOT a goal for the MVP:** reducing cost to a target figure, multi-host
throughput, or agentic (tool-using) stations. These must not regress the above, but they
are not measured here.

## 5. Scope

### In Scope (build-order steps 1–7)

- **State machine & deterministic tick** — the `(lane, status)` model, the transition-matrix
  loader + validator, and the pure-planner controller that emits a bounded action plan each
  tick. ([SPEC §3](../../SPEC.md#3-the-state-machine-the-centerpiece), [§10](../../SPEC.md#10-the-controller--the-deterministic-tick-adopted-from-ai-team))
- **Atomic claim + heartbeat lease** — single-linearization-point dispatch (deps ∧ WIP ∧
  free slot) and lease-based reconcile on restart. ([SPEC §7](../../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface), [§11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite))
- **`transform` + `deterministic` worker runtime** — one kernel-mediated model call,
  coercive parse, per-model adapter, output-schema validation; and command/function
  execution for deterministic stations. **No tool loop, no Bash-in-a-loop.**
- **Checkpoint with binding stamp + outbox** — cost recovery and effectful-station
  idempotency. ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness))
- **Rework engine + four guards + fan-in policy + liveness watchdog.** ([SPEC §6](../../SPEC.md#6-the-quality-system), [§8](../../SPEC.md#8-flow-control-scale--the-two-andons))
- **Dynamic fan-out/fan-in & dependency waves** — Architect-proposed child cards, kernel-enforced
  acyclic deps and disjoint owned paths, emergent waves. ([SPEC §9](../../SPEC.md#9-dynamic-dag--waving))
- **Output adapter + asset tagging + Slack egress channel** — format the artifact (e.g.
  Meta CSV) and wire Slack for status, HITL selection, alerts, and delivery. ([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery))
- **The Work Bench** — single-station fixture testing, mandatory Hook tests, and a
  `flow.yaml` config-contract test. ([SPEC §14](../../SPEC.md#14-the-work-bench))
- **CLI lifecycle** — `conduit run <flow.yaml>` (with live stdout streaming), `conduit resume`,
  `conduit doctor` (boot-time prerequisite check), plus a read-only journal inspect/tail command.
  A rich War Room dashboard is out of scope.
  ([SPEC §10A](../../SPEC.md#10a-process-model--a-resident-per-run-daemon), [§15](../../SPEC.md#15-execution-lifecycle))
- **Persistence** — the split SQLite state DB + append-only journal with OTel-aligned
  per-station cost attribution. ([SPEC §11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite))

### Out of Scope

- **Studio as a shipped product flow.** The MVP is validated by a **synthetic reference
  flow** — engineered purely to exercise every kernel branch (fan-out, a `gate` *and* a
  `rank` check with a back-edge, an effectful station, fan-in, scrap-at-cap, and a
  `hold`-timeout), not to produce real ad assets. Studio's real prompts, brand rubrics,
  market grading, and the cost benchmark are a separate dogfood pass against the proven
  kernel (a post-MVP dogfood spike).
- **Agentic stations — the Tool-Bridge and the full Law** (tool loop, Bash allowlist,
  network-namespace isolation, injection threat model). Built only when a coding-style flow
  needs it (build-order step 9).
- **The ingress trigger-listener** (hands-off webhook/Slack-events triggering). The MVP
  triggers via CLI; egress is wired, ingress is manual. (Build-order step 8.)
- **Kaizen / the Analyst** — skill crystallization and market-feedback loops. (Build-order step 10.)
- **Multi-host scale-out**, an always-on `conduitd` service, and the `market` check kind's
  external grader. (SPEC §17 F1; deferred.)
- **Cost-target benchmarking** against a frontier baseline (measured in a post-MVP dogfood spike).
- **A rich War Room dashboard** (live TUI/web view over the journal). The MVP ships only live
  stdout streaming + a read-only journal tail; the dashboard is deferred.

## 6. Requirements

Requirements describe observable kernel *behavior*; mechanism lives in `SPEC.md`.

### Functional Requirements

1. The kernel **shall** load a `flow.yaml`, validate it, and **refuse to start** if the
   flow graph is invalid — specifically: an `on_reject`/transition target that doesn't
   exist, an unreachable terminal lane, a `depends_on` cycle, overlapping owned-path sets
   across concurrently-eligible cards, or a `hold_timeout` without a required `on_timeout`.
1a. Separately from graph validation, `conduit doctor` **shall** verify **runtime
   prerequisites** at boot — `project_root` exists, declared tools are present, and required
   model endpoints (including any local-model endpoint, see ADR-0003) are reachable — and fail
   loudly before a run starts. Graph validity (FR-1) and environment readiness (FR-1a) are
   distinct checks.
2. The kernel **shall** drive a card through its lanes using only the deterministic tick;
   **no LLM shall participate in routing, scheduling, or dispatch decisions.**
3. A card **shall** be dispatched only when, at a single atomic point, its dependencies are
   satisfied, its target station is under its WIP cap, and a worker slot is free.
4. A `transform` station **shall** make exactly one kernel-mediated model call, coercively
   parse the result, and validate it against the station's output schema before the card
   advances; a `deterministic` station **shall** run its command/function and capture
   stdout + exit code.
5. The kernel **shall** support fan-out (a parent expands into N child cards) and
   deterministic fan-in governed by a fan-in policy (`all` | `quorum(k)` | `best_effort`),
   recording dropped children.
6. A `gate` QC station **shall** evaluate work and, on rejection, route the card to the
   configured earlier lane (the back-edge), incrementing the rework generation, until one
   artifact passes or a bound is hit.
6a. A `rank` QC station **shall** score/curate a shortlist of N candidates **without**
   converging to one via a back-edge, and terminate in a *selection* — routed to a human over
   the HITL `hold` lane, or handed downstream — never silently auto-picking (see NFR/FR-14).
7. On `MARK_DONE`, the kernel **shall** run a deterministic integrity check (touched files ⊆
   owned paths, output schema valid, declared artifacts exist) **separately** from any LLM
   quality check, and only commit + checkpoint the station on integrity pass.
8. Each checkpoint **shall** carry a binding stamp; on resume a completed station **shall**
   be skipped **only if** its binding stamp matches current config, and a mismatch **shall**
   invalidate that checkpoint and cascade to downstream stations whose inputs changed.
9. Before any irreversible side effect, an `effectful` station **shall** record intent to
   the outbox with an idempotency key; on resume the kernel **shall** consult the outbox and
   **never blind-retry** a side effect whose status is `pending`.
10. The kernel **shall** enforce four independent bounds on rework/spend — per-card rework
    cap, per-execution-attempt cap, progress-monotonicity on the critic-findings hash, and
    budgets at card/wave/run scope — and take the configured terminal action (`scrap` or
    `proceed_with_findings`) when a bound is hit.
11. The kernel **shall** run a liveness watchdog that, on "no lane change in
    `no_progress_minutes` AND no active worker," raises a deadlock alert naming the blocking
    reason — distinct from the consumption andon.
12. On any unreadable or contradictory state, the planner **shall** emit zero actions plus a
    `needsJudgment` escalation (pause to `hold`) rather than guess or auto-reverse.
13. The kernel **shall** transport status, HITL selections, alerts, and final delivery over a
    Slack egress channel, correlating each inbound human reaction back to its card; egress
    sends **shall** pass through the outbox so a resume never double-posts.
14. A HITL `hold` **shall** honor `hold_timeout` and apply the card's `on_timeout`
    (`scrap` | `proceed_with_findings` | `escalate`); a `rank` selection **shall never** be
    silently auto-picked.
15. `conduit run <flow.yaml>` **shall** drive a flow to a terminal state and exit;
    `conduit resume` **shall** re-attach to an interrupted run and reconcile from the
    database (leases → `interrupted` → re-hydrate; checkpoints → no re-bill; outbox → no
    double side-effect).
16. The Work Bench **shall** run a single `transform`/`deterministic` station against fixture
    input in isolation and report its output (and, for candidate models, its parse-miss rate).
17. `conduit run` **shall** stream worker/journal output live to stdout, and the kernel **shall**
    provide a read-only command to inspect/tail the journal for a run — enough to diagnose a
    crash-test divergence from the golden baseline. A rich War Room dashboard is out of scope.

### Non-Functional Requirements

1. **Determinism / reproducibility.** Given identical inputs, config, and model outputs, the
   kernel's routing decisions **shall** be reproducible; the database, not process memory,
   **shall** be the authority (each tick recomputes the plan from SQLite).
2. **Recovery soundness.** A host crash at any point **shall** be recoverable via
   `conduit resume` with zero re-billed completed stations and zero duplicated irreversible
   side effects.
3. **The Law is tested.** Every enforcement hook (owned-path enforcement, command allowlist
   for deterministic stations) **shall** ship with unit tests; a disabled or untested hook is
   a release blocker.
4. **Config is validated, not trusted.** All load-time invariants in FR-1 **shall** be checked
   before any worker is dispatched.
5. **Cost attribution** ([ADR-0006](../../adr/0006-telemetry-and-cost-attribution.md)). Per-station
   token/cost **shall** be recorded in the journal aligned to OpenTelemetry GenAI conventions,
   derived from the kernel's own accounting — **never** by parsing provider transcripts.
6. **Secret hygiene.** Raw environment secrets **shall not** enter worker context or the
   journal; logging is allowlist-based, with masking only as defense-in-depth.
7. **Single-host constraint is explicit.** The MVP **shall** operate correctly on a single host
   (SQLite single-writer); multi-host behavior is out of scope and **shall not** be implied.
8. **Idle cost.** The deterministic loop **shall** be cheap at rest (adaptive tick cadence) and
   **shall not** consume model tokens while idle.

### Edge Cases & Error States

- **Worker dies mid-`working`** → card reconciles to `interrupted` via expired lease and
  re-hydrates; any effectful side effect is guarded by the outbox.
- **`MARK_DONE` fails the integrity hook** → card returns to `working`, counted against the
  **execution-attempt** cap (not the rework cap); on exhaustion → scrap with an integrity reason.
- **A critic returns the same findings hash twice** → treated as "no progress," exhausting the
  rework cap immediately rather than looping.
- **A child card scraps** → fan-in policy decides: `all` holds/scraps the parent;
  `quorum(k)`/`best_effort` proceed and record the drop.
- **A card's dependency lands in `scrap`** → dependent moves to `hold` (default) or `scrap` per
  `on_dep_scrap`, never silently proceeds.
- **`hold` with no human past `hold_timeout`** → applies `on_timeout`; default `scrap`
  (fail-closed). No budget consumed while held.
- **Resume against an edited `flow.yaml`** → requires explicit `--rebind` and re-validates every
  binding stamp; stale-output replay is prevented.
- **Coercive parse miss** → bounded by the execution-attempt cap; on exhaustion → scrap with
  `model-incompatible`; parse-miss rate recorded as a journal metric.
- **Andon trips mid-flight** → new claims blocked, in-flight workers drain-and-checkpoint; the
  alert reports the overshoot (soft ceiling).
- **Two child cards declare overlapping owned paths** → rejected at expansion (or a serialization
  edge is forced) before dispatch — never a write race.

## 7. Design Principles

- **Deterministic flow, non-deterministic labor** ([ADR-0004](../../adr/0004-deterministic-kernel-llm-as-labor.md)).
  The kernel decides what is *legal next*; LLMs only produce and judge. No LLM in the
  steady-state dispatch loop — ever.
- **The check is the quality engine.** Quality comes from `work → check → bounded rework` with
  the maker and inspector separated, not from one smarter call.
- **Escalate ambiguity; never guess.** Contradictory or unrecoverable state hard-pauses to a
  human with a bounded payload. The kernel never auto-reverses or auto-mutates.
- **Config is validated, not trusted.** Every structural invariant is checked at load; an
  invalid flow cannot start.
- **Two andons, not one.** A consumption andon (busy runaway) and a liveness watchdog (silent
  stall) are distinct and both required.
- **Recovery over best-effort.** A checkpoint is cost recovery *only with a binding stamp*; an
  effect is safe to retry *only through the outbox*. Replay without these is corruption, not
  recovery.

## 8. Solution Approach

A flow is described as **data** (`flow.yaml`): an ordered set of stations, each tagged with an
execution kind (`deterministic` | `transform`) and whether it has irreversible effects, plus the
back-edges that make quality checks loop. The kernel loads this description, validates it
exhaustively, and then *runs it itself* — a small deterministic loop that, on each tick, looks at
the board and decides what may legally happen next, dispatches work to model-backed or
command-backed stations, and moves cards forward (or back, for rework) until everything reaches a
terminal state.

LLMs appear only as workers at stations: a station hands the model a typed input and gets a typed
output back, validated before the card advances. Quality is a separate kind of station — a critic
that can send work back to an earlier step a bounded number of times. The kernel keeps a durable
record of everything it has completed, so if the machine dies it can be restarted and will pick up
exactly where it left off without paying twice for finished work or repeating an irreversible
action like publishing a file.

The MVP proves this with a **synthetic reference flow** built to push the kernel through every
path it owns — a parent fans out into several pieces, each piece is critiqued and reworked until it
passes (or scraps at the cap), the flow is forced to stall and to time out a human `hold`, and the
results are assembled into a single deliverable handed to a human over Slack for a final selection
and delivery. It uses trivial stand-in prompts and a throwaway artifact format on purpose: the goal
is branch coverage of the engine, not a usable product. (Configuring the kernel into a *real*
ad-factory flow is the next, separate pass — a post-MVP dogfood spike.) Crucially, none of this requires a
tool-using "agent": every station is either a single model call or a plain command, which is what
lets the riskiest machinery be left for later.

## 9. Technical Considerations

**Constraints:**

- **Single host.** SQLite is single-writer; the MVP is correct on one host only. Multi-host is a
  tracked future boundary (SPEC §17 F1), not an MVP capability.
- **Linux for any future agentic isolation** (network-namespace enforcement) — *not* exercised by
  the MVP since it has no agentic stations, but the packaging assumes it (ADR-0003).
- **Provider prefix-cache TTLs** (often ~5 min) may expire before a large batch drains; the MVP
  must not assume caching to meet a *correctness* bar (it's a cost lever, deferred).

**Dependencies:**

- **Bun runtime** as the kernel foundation — `Bun.spawn`, native IPC, `bun:sqlite`, zero-compile
  TypeScript (ADR-0002). Owner: core.
- **Docker-first packaging** with the project root + `conduit.sqlite` on a mounted volume; secrets
  via env, never baked into an image (ADR-0003). Owner: core.
- **A two-adapter set** — one frontier provider (native structured output) + one local model
  (prompted/coercive path), normalized to the kernel tool protocol. The local model is a CI-cheap
  dependency that exercises the coercive parser and the Bench parse-miss gate. Owner: core.
- **A Slack workspace/app** for the egress channel (status, HITL, alerts, delivery).

**Integration points:**

- Model providers (via kernel-mediated adapters only — workers never call the network directly).
- Slack (egress channel).
- The output adapter target format (e.g. Meta Ads CSV) for the reference flow's deliverable.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Atomic claim across DB + physical worker pool is subtle; a split claim corrupts WIP/lease invariants | Medium | High | In-transaction slot reservation (SPEC §7); property/concurrency tests for the claim before anything builds on it |
| Checkpoint replay across a config change silently ships stale output | Medium | High | Binding stamp gates every skip; mismatch cascades; `--rebind` required to resume against an edited flow |
| Effectful resume double-publishes (duplicate live artifact) | Medium | High | Outbox + idempotency key; `pending` rows reconcile or escalate, never blind-retry |
| "Bounded rework" leaks a runaway through an unguarded path | Low | High | Four independent guards incl. findings-hash monotonicity; planner-side cap enforcement in the durable layer |
| SQLite single-writer contention at batch fan-out scale | Medium | Medium | Split state DB vs append-only journal, WAL + busy_timeout; batch scale validated, multi-host explicitly deferred |
| Coercive parser masks a genuinely incompatible model as "flaky" | Low | Medium | Parse-miss rate is a first-class Bench/journal metric; execution-attempt cap → scrap with `model-incompatible` |
| Slack HITL reply lost/duplicated → card stuck or double-acted | Low | Medium | Correlation IDs, `hold_timeout` + `on_timeout` (fail-closed default `scrap`), egress through the outbox |

### Resolved Decisions

- **Reference flow is synthetic** (2026-05-30). The MVP's acceptance proof is a synthetic flow
  engineered for branch coverage of the kernel (gate, rank + back-edge, effectful, fan-in, scrap,
  hold-timeout), **not** a stripped Studio. Building a real Studio flow is a separate dogfood pass
  against the proven kernel (a post-MVP dogfood spike). Rationale: a synthetic fixture gives a clean
  correctness signal without coupling kernel sign-off to product-quality debugging.

- **Both `gate` and `rank` ship in the MVP** (2026-05-30). `gate` (convergent rework loop) and
  `rank` (keep-N → score → terminal selection via HITL `hold`) are distinct control-flow branches,
  both first-class kernel check kinds. `market` stays deferred. Rationale: `rank` is the
  Studio-shaped path; omitting it would mean "kernel done" yet a real `rank` flow needs new kernel
  code — breaking the flow-is-config premise. Marginal cost is low (the critic is still a pure
  `transform`; the HITL `hold` selection is already in scope for FR-13/14).

- **Resume soundness is proven by enumerated kill-points + fuzz against a golden oracle**
  (2026-05-30). Three pillars: (1) a **golden uninterrupted run** with canned model outputs as the
  oracle — records per-station bill, effect log, and final artifact; (2) a **mock effectful
  provider** that logs every call with its idempotency key, honors the key, and can be scripted to
  crash in the danger window (after the effect, before the commit); (3) **deterministic kills at
  every transaction boundary as gates** (after-intent/before-effect, after-effect/before-commit,
  after-commit/before-checkpoint, after-checkpoint/before-transition, mid-`working`) **plus a
  randomized N-seed fuzz pass** as defense-in-depth. Pass = every trial resumes to terminal with no
  re-billed station, every irreversible effect executed exactly once, and an artifact byte-identical
  to the golden baseline.

- **MVP ships a deliberately mismatched two-adapter set** (2026-05-30): one frontier provider with
  **native structured output** + one **local model that lacks it** (driven through the
  prompted/coercive path). Rationale: one adapter proves nothing about the model-independence
  thesis and leaves the coercive parser, prompted-adapter fallback, and Bench parse-miss rejection
  gate unexercised; the mismatched pair proves all three, and the local model is the cheapest
  possible CI dependency. The crash-soundness proof still runs on canned outputs, so this choice
  only governs live-run portability and the Bench gates. Specific models TBD at build time.

- **Builder-facing view is minimal** (2026-05-30): live stdout streaming during `conduit run`
  (the SPEC §7 stream-piping, ~free) + a read-only journal inspect/tail command. **No** rich
  TUI/web War Room dashboard — that's deferred as gold-plating for a correctness MVP. Slack status
  remains the operator-facing surface. Rationale: the journal is the forensic record for diagnosing
  golden-baseline divergence in crash tests, so the kernel must be *inspectable*, but inspectable ≠
  a dashboard.

### Open Questions

_None outstanding — all discovery questions resolved above. New questions will be logged here as
the design firms up._

## 11. Rollout & Measurement

**Phasing (order, not dates) — mirrors build-order steps 1–7:**

- **Phase 1 — Skeleton that can't run wrong.** State DB + `(lane, status)` machine + transition
  validator + deterministic tick, and the atomic claim + heartbeat lease. Nothing dispatches yet;
  the claim and the validator are tested in isolation. (Steps 1–2)
- **Phase 2 — The cheap, safe majority.** `transform`/`deterministic` worker runtime (one model
  call, coercive parse, schema validation), then checkpoint + binding stamp + outbox. A single
  station now runs and recovers. (Steps 3–4)
- **Phase 3 — Quality & bounds.** Rework engine, four guards, fan-in policy, liveness watchdog. The
  reference flow can now loop and stay bounded. (Step 5)
- **Phase 4 — Edges & proof.** Output adapter + asset tagging + Slack egress, then the Bench + Hook
  tests + config-contract test. The reference flow runs **end-to-end** with a human loop, and the
  Law is tested. (Steps 6–7)

**Measurement plan:**

- After Phase 2: stand up the **golden-oracle crash harness** — record an uninterrupted run (canned
  model outputs) as the baseline, then replay it killing at each enumerated transaction boundary
  (gates) plus an N-seed fuzz pass, with a mock effectful provider that logs idempotency keys and
  can crash in the after-effect/before-commit window. Assert every trial: zero re-bill, every
  effect exactly-once, artifact byte-identical to baseline.
- After Phase 3: run the reference flow with a deliberately non-converging critic; assert it scraps
  at the cap and never runs away; assert the watchdog fires on an induced stall.
- After Phase 4: full reference-flow run to `done` over Slack (status → HITL selection → delivery),
  unattended on the clean path; config-contract test green; every hook covered.

**Rollback / stop criteria:** if the atomic claim or resume-soundness tests cannot be made green,
the kernel is not shippable — these are load-bearing and gate everything downstream; cost work and
any agentic surface stay blocked until they pass.
