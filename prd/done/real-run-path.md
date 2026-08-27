---
missionId: ~
---

# Conduit — The Minimal Real-Run Path (Production Executor + Dogfood Spike)

**Author:** Josh Owens  **Date:** 2026-06-06  **Status:** Ready

> Scope note: this PRD builds the **minimal surface that lets `conduit run` drive a real
> flow end-to-end** — and uses it to run the **dogfood validation spike** the build-order
> gates steps 8–10 behind ([`docs/build-order.md`](../../docs/build-order.md#after-the-mvp)).
> It targets a **linear flow with a quality gate** (transform + deterministic stations, gate
> check + bounded rework) — deliberately *not* the branching/human-in-the-loop shape, which is
> split into a follow-on PRD ([`branching-and-hitl.md`](branching-and-hitl.md)) so the
> foundation can be proven first. It depends on the shipped MVP kernel
> ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)): the state machine, atomic claim,
> transform/deterministic workers, gate checks + rework guards, checkpoint + outbox, and the two
> andons are all built and unit-tested. This work **wires them into a controller-driven
> executor** rather than reinventing them. It is **not** a throwaway spike — it ships real kernel
> surface (the production executor) — so it is framed as the *real-run path* whose first job is to
> prove the flow-is-config thesis. The *how* lives in [`SPEC.md`](../../SPEC.md) (§3, §5, §6, §10)
> and a companion implementation plan; this document defines *what must be true* and *why*, and
> stays implementation-free.

## 1. Context & Background

The MVP kernel (build-order steps 1–7) shipped and is proven by tests. But that proof is a
**component-integration** proof, not an end-to-end one. `bun test` drives the synthetic
reference flow through every branch — gate back-edge, rank+HITL, effectful-exactly-once,
quorum fan-in, scrap-at-cap, hold-timeout, crash recovery — but it does so with a
**deterministic stub adapter**, **prompts injected inline**, and **routing hand-rolled in
SQL** inside the test harness. The harness itself is explicit that it "does NOT route cards
through the real planTick / transition-matrix / atomic-claim controller."

The production path tells the same story from the other side. `conduit run <flow.yaml>`
validates the flow (fail-closed) and runs the deterministic planner — but only **once**: it
computes one tick's action plan, prints what it *would* do, and exits. The planner is a pure
function whose contract is "the executor acts on the returned plan," and **no executor
exists**. There is no real model transport (the production adapter throws by design), no way
to source a station's prompt or output schema (stations carry only `role` + `model`), and no
way to inject the initial work item (the CLI takes only a flow path).

The build-order anticipated exactly this: before steps 8–10, **dogfood the kernel on a real
flow** — "does the kernel actually run a real flow end-to-end, as config, with no kernel
changes?" The honest answer today is *no*, because the connective tissue between the proven
components was only ever written in the test harness. Building that tissue — the production
executor, a real model adapter, prompt/schema sourcing, and card seeding — *is* the dogfood
spike. It is the right time because every piece it wires is already built and tested; what is
missing is the wiring and the config surface to express a real flow.

## 2. Problem Statement

Conduit's central thesis is **the flow becomes config (`flow.yaml`), not code**. That thesis
is currently unproven: no one can take the shipped kernel, write a `flow.yaml` plus prompts,
and run it against real models to produce a real artifact. The kernel's components are sound
in isolation, but they have never been driven by the real controller, only by a
flow-specific test harness. Until a real flow runs end-to-end — calling real models, gating
quality with a real critic and reworking when it fails, and producing a real deliverable — the
kernel's flow-is-config claim, its real cost profile, and its real parse-miss behavior are all
assumptions. This work makes the first real run possible on a **linear, gated flow** and uses
it to test the thesis; the branching/HITL shape builds on it next.

## 3. Target Users & Use Cases

**Primary user — the flow builder (engineer).** Wants to express a real production line as
`flow.yaml` + prompt templates and run it with `conduit run`, against the model provider of
their choice, without editing kernel code. Cares that the engine routes the flow exactly as
the config declares — including a quality gate that reworks failed output — and that a crash
mid-run never re-bills or double-publishes.

**Secondary user — the kernel maintainer (Josh).** Needs the dogfood run to answer one
question about the *engine*: does it run a real flow end-to-end as config? A pass promotes the
sequenced build-out (the branching/HITL PRD, then step 8); a fail surfaces the missing
`flow.yaml` knob, validation hole, or adapter edge as **kernel** work to do first. Also needs
the deferred kernel measurements the MVP could not take without a real flow: cost vs. a
frontier-agent baseline, real parse-miss rates, and prefix-cache behavior.

**Key use cases:**

- A builder **runs a linear gated flow end-to-end** from a single CLI invocation that supplies
  the initial work item, and watches it call real models and produce a real artifact at
  `lane=done`.
- A builder's **quality gate rejects** weak output, the flow **reworks** it via the declared
  back-edge (bounded by the rework guards), and then passes — no kernel code involved.
- A builder **points the same flow at a different model provider** by changing a config value
  and a model string — no code change — relying on one gateway to route per-station models.
- A maintainer **kills a real run mid-flight and resumes it**, confirming no checkpointed
  station is re-billed and no effectful side effect fires twice.
- A maintainer **captures the dogfood measurements** (cost, parse-miss rate, prefix-cache)
  from a real run to grade the flow-is-config thesis.

## 4. Goals & Success Metrics

The work is graded on **end-to-end correctness of a real run** and on **delivering the
spike's measurements** — not on throughput or breadth of providers.

| Goal | Metric | Target |
|------|--------|--------|
| A real linear gated flow runs end-to-end | A `conduit run` drives a real transform→gate→deterministic flow to `lane=done` with a real artifact, using real model calls | 100% (the example flow completes) |
| No kernel changes needed to run *a* flow | Kernel-code edits required to run the example flow once the real-run surface exists (flow + prompts are config only) | 0 |
| Routing matches the config, not insertion order | Mis-routed cards in the run (forward on pass, declared back-edge on reject) | 0 |
| The quality loop works on real output | A real gate rejection routes to rework and the per-card rework cap is enforced durably | Demonstrated |
| Exactly-once across a crash | Re-billed checkpointed stations or duplicated effectful side effects after a mid-run kill + `resume` | 0 |
| Spike measurements captured | Real parse-miss rate, token/cost total vs. a frontier-agent baseline, and prefix-cache behavior recorded from the run | All three recorded |

**The v1 pass bar is end-to-end completion** — the example flow runs to `lane=done` with a real
artifact. The three measurements are *captured* but **not gated on a threshold** for v1; cost /
parse-miss bars are a later decision informed by the numbers this run produces.

**Explicitly NOT goals:** branching flows (fan-out/fan-in), human-in-the-loop selection,
multi-provider breadth (one gateway suffices), high throughput or concurrency, an always-on
listener, agentic stations, or hitting a specific cost *target* (the spike *measures* cost; the
target is a separate decision informed by the measurement).

## 5. Scope

### In Scope

- **A production executor** that drives a linear `transform`+`deterministic` flow from `intake`
  to a terminal state by consuming the existing planner's actions and routing via the existing
  transition matrix — replacing the print-only stub. Covers dispatch, **gate-check QC + bounded
  rework**, the consumption andon, and the liveness watchdog.
  ([SPEC §3](../../SPEC.md#3-the-state-machine-the-centerpiece),
  [§10](../../SPEC.md#10-the-controller--the-deterministic-tick-adopted-from-ai-team))
- **Explicit linear topology in `flow.yaml`** — a station's happy-path successor and a gate's
  back-edge target — so the engine routes by declaration rather than by station insertion order.
- **Prompt + output-schema sourcing** — each model-calling station sources a versioned prompt
  template and a declared output schema from config; the prompt version feeds the checkpoint
  binding stamp. ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness))
- **A real model adapter** behind the existing adapter seam: one OpenAI-compatible HTTP client
  pointed at a gateway, with the station `model:` string selecting the route. **LiteLLM (run as
  a local OpenAI-compatible proxy) is the default/recommended gateway** — it routes 100+
  providers from one base URL + key *and returns per-call cost*, which becomes the kernel's cost
  source of truth. Config is a base URL + one API key.
- **Card seeding from the CLI** — `conduit run` accepts the initial work item (a file or an
  inline idea) and seeds the entry card so the run has something to do.
- **Delivery to disk + journal** — the final artifact lands under the project root and the run's
  real token/cost spans are queryable; no external egress transport is required for v1.
- **A real example flow** — the **TikTok shoppable-video filming-ideas** flow (see *The dogfood
  flow* below), a coherent linear gated `flow.yaml` with real prompt templates that reads a
  **local DuckDB database** (`arcane.duckdb`), kept as a **maintained example under
  `examples/tiktok-shoppable-ideas/`** (not a throwaway fixture) — and the **dogfood run** itself,
  including the deferred measurements.

### Out of Scope

- **Branching flows and human-in-the-loop** — fan-out, child sub-paths, quorum fan-in, rank
  checks, the real Slack HITL round-trip, and the manual reply command are the **follow-on PRD**
  ([`branching-and-hitl.md`](branching-and-hitl.md)), which extends this executor.
- **Agentic stations and the Law** (build-order step 9) — no Read/Write/Bash tool loop, no
  path-ownership or Bash-allowlist enforcement beyond the existing deterministic Law-lite.
- **The full ingress trigger-listener** (build-order step 8) — its own PRD
  ([`prd/done/ingress-listener.md`](../done/ingress-listener.md)).
- **Resume cost-optimization** — on resume, completed pure stations may re-execute rather than
  being skipped on a matching binding stamp; correctness (no double effects) is required,
  skip-on-match is not.
- **Multi-provider breadth and provider-native features** — one OpenAI-compatible gateway;
  no streaming, no per-provider SDKs, no rate-limit/retry orchestration.
- **Concurrency / scale** — single-process synchronous execution is acceptable.

### The dogfood flow — TikTok shoppable-video filming ideas

The concrete real flow used to run the spike, kept under `examples/tiktok-shoppable-ideas/`:

- **Goal:** from a product reference, produce **one short paragraph of filming ideas** for a
  TikTok shoppable video — the hook to open with, the technique, and how to feature the product.
- **Data source:** a **local DuckDB database** (`arcane.duckdb`) holding the real TikTok-shop
  data — `orders` (sales), `campaigns`/`campaign_daily` (ad performance), `video_analysis`
  (high-performing hooks/techniques: `hook_description`, `hook_themes`, `lane2_techniques`,
  `format_style`) joined to `videos` (per-video views/GMV), and product detail from
  `orders`/`videos`. Local DuckDB makes the dogfood **fully self-contained and reproducible** —
  no network (so `network_egress: deny` stays on), and the run repeats deterministically for the
  crash-and-resume test. The real DB carries buyer PII and is large (~36 MB), so the example ships
  a **small, sanitized fixture DuckDB** (committed, reproducible); the **DB path is configurable**
  so the same flow points at the real `arcane.duckdb`.
- **Stations (linear):**
  1. **`fetch_context`** (deterministic) — reads the seeded request (which product / time window)
     and queries the local DuckDB, writing a single `context.json` artifact (sales + ad + hooks +
     product data). The DuckDB CLI fits the Law-lite allowlist cleanly — `duckdb -readonly <db>
     -f fetch.sql` with `COPY (…) TO context.json` keeps every argument metacharacter-free, so no
     shell wrapper is needed.
  2. **`ideate`** (transform) — its prompt template is *rendered against `context.json`* (FR-4a)
     and asks the model for one filming-idea paragraph, validated against a small output schema
     (`{ filming_idea }`).
  3. **`ideate`'s gate check** (a second, stronger critic model) — verifies the idea is grounded
     in the data and actionable; on reject it routes back to `ideate` for bounded rework.
- **Delivery:** the approved `idea.json` lands under the project root; the run's real per-call
  token/cost spans are queryable via the journal.
- **What it proves end-to-end:** a deterministic DB read → prompt assembled from real data → a
  real model call → a real second-LLM quality gate with rework — the entire linear real-run path,
  on real data, with a single CLI invocation.

## 6. Requirements

Requirements describe observable behavior; mechanism lives in `SPEC.md` and the companion plan.

### Functional Requirements

1. `conduit run <flow.yaml>` **shall** drive a valid linear flow from its entry card to a
   terminal outcome (`done`, `scrap`, or `hold`), executing each station's worker and routing
   between stations — not merely planning and printing one tick.
2. The executor **shall** route every card according to the flow's **declared topology** — a
   station's successor and a gate's back-edge target — and **shall not** infer routing from the
   order stations appear in the file.
3. `flow.yaml` **shall** be able to express that topology, and the loader **shall** reject —
   fail-closed, at load — a flow whose declared successor or back-edge names an unknown station
   or terminal.
4. Each model-calling station **shall** source its prompt from a **versioned** template and its
   expected output from a **declared output schema**, both supplied by config; the loader
   **shall** reject a model-calling station missing either, and a missing prompt template
   **shall** fail at load, not mid-run.
4a. The prompt template **shall** be **rendered against the station's declared input artifacts**
   so upstream data (e.g. records fetched by a prior station) reaches the model — this is how a
   prompt is "assembled from the data"; a template that references an input the station does not
   declare **shall** fail at load, not mid-run.
5. The prompt template version **shall** participate in the station's checkpoint binding stamp,
   so that changing a prompt invalidates the affected checkpoint on resume
   ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
6. A `transform` station **shall** execute via a real model call through a configurable
   OpenAI-compatible gateway, with the station's `model:` string passed through to select the
   route; the adapter **shall** read its base URL and API key from configuration/environment at
   call time, so validation and `doctor` run without credentials.
7. A `deterministic` station **shall** declare its **command + arguments in `flow.yaml`** and
   **shall** execute it under the existing Law-lite allowlist (`security.bash.allow`); the loader
   **shall** reject — fail-closed at load — a deterministic station with no declared command or a
   command absent from the allowlist, and a command not on the allowlist **shall** be refused, not
   run. (The command is config today only at runtime; the flow schema carries no command field —
   this work adds it.)
8. A station with a **gate** check **shall** route a passing card forward and a rejected card to
   its declared back-edge, bounded by the four rework guards already in the kernel
   ([SPEC §6](../../SPEC.md#6-the-quality-system)); the per-card rework count **shall** persist
   across the card's lifetime so the cap is enforced durably.
9. `conduit run` **shall** accept the initial work item (a file or an inline idea), seed the
   entry card and its input artifact, and **shall** fail-closed when neither an input nor an
   existing runnable card is present.
10. The run **shall** deliver the final artifact under the project root and record real per-call
    token/cost spans queryable via the existing journal.
11. The run **shall** halt on a tripped consumption andon (wall-clock or token budget) and on a
    liveness-watchdog stall (no progress + no active worker), surfacing the reason; a contradictory
    state **shall** escalate to `hold`, never be guessed past
    ([SPEC §8](../../SPEC.md#8-flow-control-scale--the-two-andons)).
12. `conduit run` **shall** exit with distinct codes for *completed* and *halted* (budget/deadlock
    /escalation), so an operator (or a future listener) can tell them apart.

### Non-Functional Requirements

1. **Flow-is-config.** Running the example flow **shall** require zero kernel-code changes —
   only `flow.yaml`, prompt templates, and environment configuration.
2. **Exactly-once under crash.** A kill at any recoverable seam followed by `conduit resume`
   **shall not** re-bill a checkpointed station or fire an effectful side effect twice; pending
   effects **shall** be reconciled or escalated, never blind-retried
   ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
3. **Determinism preserved.** No LLM enters the control loop; routing remains a pure function of
   state + config. Worker non-determinism is confined to the station.
4. **Fail-closed config.** Every new `flow.yaml` field **shall** be validated at load (topology
   targets exist, schemas well-formed, prompts present); an invalid flow never reaches dispatch.
5. **Secret hygiene.** Model credentials **shall not** be logged or written to the journal, and
   **shall not** enter the worker context beyond the legitimate call.
6. **Budget accuracy.** Token accounting (for the consumption andon and budgets) **shall** be
   accurate from real provider usage; monetary cost **shall** be taken from the gateway when it
   reports it (LiteLLM does), and any approximation **shall** be visible, not silent.

### Edge Cases & Error States

- **Model returns unparseable output** → coercive parse + schema validation fails, the attempt
  is re-billed and retried up to the per-card cap, then the card scraps as model-incompatible —
  the real parse-miss rate is a spike measurement.
- **Gate rejects every attempt** → rework loops to the back-edge until the rework cap, then the
  card scraps; the durable rework count makes the cap enforceable across the card's life.
- **Crash between an effectful post and its commit** → resume reconciles the outbox intent (or
  escalates to `hold`); the effect is never re-fired blindly.
- **No model API key / gateway unreachable at run time** → the run fails loudly on the first real
  call with a clear message; validation and `doctor` still work without credentials.
- **Deterministic station command not on the allowlist** → refused before spawn; the station
  fails closed rather than executing an unlisted binary.

## 7. Design Principles

- **Wire, don't reinvent.** The kernel already owns its routing matrix, gate checks, rework
  guards, outbox, and andons. The executor's job is to *drive* them from config — every line of
  new routing logic is a smell to check against an existing primitive.
- **The config expresses the flow; the engine obeys it.** Topology, prompts, schemas, and budgets
  are declarations. Where the engine previously inferred structure (insertion-order routing), it
  must instead read an explicit declaration — that gap *is* a finding.
- **Deterministic flow, non-deterministic labor.** The executor stays a deterministic loop; the
  only non-determinism is inside a station's model call.
- **Fail-closed at every new seam.** New config is validated, not trusted; an ambiguous or
  contradictory runtime state escalates to a human instead of being guessed past.
- **The spike's value is the gaps it surfaces.** A missing `flow.yaml` knob, a validation hole,
  or an adapter edge found by the real run is a *success* of this work, fed back into kernel work
  before the branching PRD and steps 8–10.

## 8. Solution Approach

The real-run path is assembled in layers on top of the proven kernel:

- **Config surface first** — extend `flow.yaml` so a flow can declare its linear topology
  (successor + gate back-edge), per-station prompts (versioned, **rendered against the station's
  inputs**) and output schemas, **deterministic commands**, and carry its project root; all
  validated fail-closed at load. The central finding lives here: the flow graph — and everything a
  station needs to run (prompt, schema, command) — must be **declared in config**, not inferred
  from station order or hardcoded in a harness.
- **A model transport** — one OpenAI-compatible client behind the existing adapter seam, pointed
  at a gateway (LiteLLM by default) so a single key + base URL serves any provider the gateway
  routes, and per-call cost comes back from the gateway.
- **The executor** — a deterministic loop that reconciles, promotes ready work, asks the planner
  what to dispatch, runs each station's worker (transform or deterministic), routes the result
  through the existing transition matrix, performs gate QC with bounded rework, and halts on the
  andons.
- **The edges** — CLI seeding of the initial work item and delivery of the artifact to disk + the
  journal.
- **The proof** — a real, coherent linear gated example flow exercised end-to-end, including a
  deliberate crash-and-resume, with the deferred measurements captured.

Integration is with the existing kernel only; this work adds a controller-driven executor and a
config/transport surface, and changes no station, QC, checkpoint, or andon semantics.

## 9. Technical Considerations / Dependencies

**Dependencies:**

- **The shipped MVP kernel** ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) — state machine,
  atomic claim + lease, transform/deterministic workers, gate checks + rework guards, checkpoint
  + outbox, the two andons. All are reused; their semantics are not changed.
- **A model gateway** exposing an OpenAI-compatible `chat/completions` endpoint. **LiteLLM**
  (local proxy) is the default — it routes many providers and returns per-call cost; OpenRouter or
  OpenAI direct also work behind the same adapter.
- **The DuckDB CLI** (≥ 1.5) available to the run environment — the dogfood's `fetch_context`
  station shells out to it to read `arcane.duckdb`. It is the example flow's dependency, not the
  kernel's, but must be present where the dogfood runs (and baked into the Docker image used for
  the dogfood).
- **Bun runtime** ([ADR-0002](../../adr/0002-bun-as-the-kernel-runtime.md)) and **Docker-first**
  packaging ([ADR-0003](../../adr/0003-packaging-and-distribution.md)) — the run and its state DB
  + project root share the mounted volume.
- **A schema migration** of the state DB to persist per-card rework count (a fail-closed version
  bump; old databases are rejected rather than silently migrated).

**Integration points:**

- The deterministic planner and transition matrix (routing), reused as-is and fed explicit
  topology.
- The model gateway (per-station model calls).
- `conduit.sqlite` (state + journal) — the run's record of truth, including real token/cost spans.

**Constraints:**

- **One real provider via one gateway** — multi-provider routing is the gateway's concern, not the
  kernel's.
- **Single-process, synchronous execution** is acceptable for the spike; concurrency is deferred.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Linear topology in `flow.yaml` doesn't cleanly generalize to the branching shape the next PRD needs | Medium | Medium | Design the `next`/back-edge fields with the branching extension in mind; treat any mismatch as a finding to settle before the branching PRD |
| The executor diverges from the harness's proven sequencing and re-introduces fixed bugs | Medium | High | First controller-driven e2e test runs the linear+gate flow against a stub adapter before any real call; harness behavior is the oracle |
| Real models miss the output schema far more than the stubs, stalling stations at the rework cap | Medium | Medium | Measure the real parse-miss rate (a spike goal); tune prompts/schemas as config, not code; scrap-at-cap bounds the blast radius |
| Crash-recovery against a *real* effectful station double-publishes | Low | High | Reuse the proven outbox + idempotency key; include a real crash-and-resume in verification (NFR-2) |

### Open Questions

- **Topology expressiveness.** Is per-station `next` + a gate back-edge enough for v1, and does
  the shape extend cleanly to the branching model (child-entry + parent resume) the next PRD adds?
  This run is the first data point.

*Settled during review:* the **v1 pass bar is end-to-end completion** (cost/parse-miss thresholds
deferred — see §4); the example flow is a **maintained example under `examples/`** (see §5); and
**cost comes from the gateway** (LiteLLM returns it), so the kernel maintains no price table.

## 11. Rollout & Measurement

**Phasing (order, not dates):**

- **Phase 1 — config surface:** prompt/schema sourcing (prompts rendered against inputs),
  deterministic command sourcing, explicit linear topology, project-root plumbing, and the
  rework-count migration, all fail-closed at load.
- **Phase 2 — transport:** the OpenAI-compatible adapter (LiteLLM default), with a `doctor` probe.
- **Phase 3 — executor:** the controller-driven loop (dispatch, gate rework, deterministic +
  transform runners, andons, terminal/deadlock), proven by the first controller-driven e2e test.
- **Phase 4 — edges + proof:** CLI seeding + disk/journal delivery; the
  `examples/tiktok-shoppable-ideas/` flow + its sanitized DuckDB fixture + prompt templates; the real
  dogfood run, a crash-and-resume, and the captured measurements.

**Measurement plan:** from the real run, record parse-miss rate per model, token/cost totals vs. a
frontier-agent baseline, and prefix-cache behavior. **Pass** (end-to-end completion) → proceed to
the branching/HITL PRD, then step 8. **Fail** (a missing knob, a validation hole, an adapter edge)
→ the gaps feed back into kernel work first; the topology model is the prime candidate to revisit.
