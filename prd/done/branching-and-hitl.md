---
missionId: M-20260610-001
---

# Conduit — Branching Flows & Human-in-the-Loop

**Author:** Josh Owens  **Date:** 2026-06-06  **Status:** Draft

> Scope note: this PRD **extends the real-run path** ([`real-run-path.md`](real-run-path.md))
> from a linear gated flow to the **full production-line shape**: planner-driven **fan-out** into
> per-item child work, a **child sub-path**, **quorum fan-in**, a **rank** quality check, and a
> **human-in-the-loop** selection delivered over a **real Slack** round-trip. It depends on the
> controller-driven executor, the OpenAI-compatible adapter, prompt/schema sourcing, and CLI
> seeding that the real-run-path PRD ships, plus the shipped MVP kernel
> ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) — the fan-out/fan-in, rank check, outbox, and
> HITL hold primitives are all built and unit-tested. This work **wires** them into the executor;
> it changes no station, QC, or checkpoint semantics. It is **post-real-run-path** and sequenced
> *before* the full ingress trigger-listener (step 8) — a thin manual reply command is the
> deliberate stand-in. Agentic stations + the Law (step 9) and market-feedback kaizen (step 10)
> remain out of scope. The *how* lives in [`SPEC.md`](../../SPEC.md) (§4A, §6, §9) and a companion
> implementation plan; this document defines *what must be true* and *why*.

## 1. Context & Background

The real-run-path PRD proves the kernel can drive a **linear, gated** flow end-to-end against
real models — the foundation. But Conduit's converged design (A(i)-Team, Studio, Autocut) is
fundamentally a **branching** flow-shop: one parent decomposes into many parallel items, each
item runs its own sub-path, the results are ranked, a human picks, and survivors are assembled.
The synthetic reference flow exercises exactly this shape — fan-out 1→3, child draft→publish,
rank + HITL select, quorum(2) fan-in, deterministic assemble — but only inside the test harness,
with routing hand-rolled in SQL.

Two structural gaps surface the moment a *real* branching flow runs through the real controller:

1. **`flow.yaml` cannot express fan-out topology.** Routing is derived from the order stations
   appear in the file. For a branching flow that is wrong: children must terminate after their
   last child station, while the rank/assemble stations are parent-level work that resumes only
   after fan-in. The harness hardcodes which stations are the child sub-path and where the parent
   resumes. A real flow needs to *declare* this.
2. **Human-in-the-loop is asynchronous, but a run is synchronous.** A rank check that defers to a
   human parks the card and waits — but `conduit run` drives a flow to a terminal state and exits.
   There is no way for a human's selection to re-enter a held run, because the ingress listener
   that would receive it (step 8) is not built.

This PRD closes both. It is sequenced after the real-run path because the executor it extends —
and the topology model it generalizes — must exist and be proven on the simple shape first.

## 2. Problem Statement

A real Conduit flow fans out, ranks, and asks a human to choose — but today the engine can only
be driven through a branching flow by hand-rolled harness code, and a human decision cannot
re-enter a running flow. Until a real branching flow runs end-to-end — decomposing into real
parallel items, calling real models per item, posting a real ranked short-list to a human, and
assembling the human's choice — the flow-is-config thesis holds only for the simplest shape. This
work makes the full production-line shape runnable as config, with the human in the loop.

## 3. Target Users & Use Cases

**Primary user — the flow builder (engineer).** Has proven a linear flow on the real-run path and
now wants the real shape: a planner that decomposes a brief into N variants, a per-variant
sub-path, a ranked short-list posted to their team's Slack, and an assembled deliverable from the
human's pick. Declares the branching topology and the rank/HITL channel in `flow.yaml`; relies on
the kernel for disjoint per-child ownership, quorum tolerance of failed items, and exactly-once
delivery of the human prompt.

**Secondary user — the flow operator (a customer).** A non-technical reviewer who receives the
ranked short-list in Slack, replies with a choice, and gets the assembled result — without
touching the CLI. (Until the step-8 listener lands, a technical operator bridges the reply via a
CLI command; the operator's Slack experience is unchanged.)

**Key use cases:**

- A builder's flow **fans out a brief into N variant items**, each running its own draft→publish
  sub-path in parallel, with per-item outputs that never collide.
- A flow **tolerates a failed item** — if a variant scraps, a quorum policy lets the flow proceed
  with the survivors rather than deadlocking.
- A flow **posts a ranked short-list to Slack and waits for a human pick**; the kernel never
  auto-selects.
- A human **replies with a selection** and the run **resumes** to assemble and deliver the choice.
- A maintainer **kills the run mid-flight** (including mid-fan-out and around the effectful
  publish) **and resumes**, confirming no re-bill and no double-publish.

## 4. Goals & Success Metrics

Graded on **end-to-end correctness of a real branching, human-in-the-loop run**.

| Goal | Metric | Target |
|------|--------|--------|
| A real branching+HITL flow runs end-to-end | A `conduit run` + human Slack reply + `resume` drives a real fan-out → child sub-path → rank+HITL → quorum fan-in → assemble flow to `lane=done` with a real artifact | 100% (the example flow completes) |
| Routing matches declared topology | Mis-routed cards (child terminates where declared; parent resumes where declared) | 0 |
| Children never collide | Concurrent child cards that write a shared owned path | 0 |
| Quorum tolerates failure | A flow with one scrapped item still proceeds when the quorum is met, recording the dropped item | Demonstrated |
| HITL never auto-picks | Rank selections made by the kernel without a human reply or explicit timeout policy | 0 |
| Exactly-once across a crash | Re-billed checkpointed stations or duplicated effectful publishes after a mid-run kill + `resume` (incl. mid-fan-out, around publish) | 0 |
| HITL delivery is exactly-once | Duplicate Slack hold prompts posted for the same decision (incl. across a resume) | 0 |

**Explicitly NOT goals:** the full ingress webhook/Slack-events listener (step 8 — the manual
reply command is the stand-in), nested/recursive fan-out beyond one level, agentic stations,
multi-host concurrency, or market-feedback kaizen.

## 5. Scope

### In Scope

- **Branching topology in `flow.yaml`** — beyond the linear `next`/back-edge of the real-run path:
  a fan-out station's **child-entry** station, the child sub-path's terminal, and the parent's
  **post-fan-in resume** station — all validated fail-closed at load.
  ([SPEC §9](../../SPEC.md#9-dynamic-dag--waving))
- **Planner-driven fan-out** — the fan-out station's worker output **proposes** the child cards
  (ids, per-child ownership, optional dependencies); the kernel validates the proposal for
  acyclicity and **disjoint ownership** and seeds the children with namespaced paths so concurrent
  children never collide.
- **Quorum fan-in** — the executor applies the declared fan-in policy (e.g. quorum *k*) over the
  children's terminal outcomes: proceed with survivors (recording dropped items), or hold the
  parent when the policy cannot be met — never deadlocking on an item that can never complete.
- **Rank check + human-in-the-loop** — a rank station posts a ranked short-list to the egress
  channel, moves the card to `held`, and the run ends cleanly with the held card surfaced; the
  kernel never auto-selects. A configured hold-timeout policy applies if no human replies.
  ([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery),
  [§6](../../SPEC.md#6-the-quality-system))
- **A real Slack transport** behind the existing channel seam (the outbox idempotency logic
  already exists) for the HITL prompt and final delivery.
- **A manual reply command** — `conduit reply` (or equivalent) maps a human selection to the
  correct held card, durably records it, and lets `conduit resume` continue the card to terminal.
  A deliberate thin stand-in for the step-8 ingress listener.
- **A real branching example flow** — a coherent Studio-style `flow.yaml` of the full shape with
  real prompt templates, kept as a **maintained example under `examples/`** — and the run itself,
  including a crash-and-resume across the effectful publish.

### Out of Scope

- **The full ingress trigger-listener** (build-order step 8) — webhook/Slack-events receiver with
  dedup; its own PRD ([`prd/done/ingress-listener.md`](../done/ingress-listener.md)). The manual
  reply command here is the stand-in.
- **Nested / recursive fan-out** — one level of decomposition; a child that itself fans out is a
  future concern.
- **Agentic stations and the Law** (step 9), **multi-host concurrency / scale-out**, and
  **market-feedback kaizen** (step 10).
- **Resume cost-optimization** (skip-on-matching-binding-stamp) — inherited as out of scope from
  the real-run path; correctness, not cost, is required on resume.

## 6. Requirements

Requirements describe observable behavior; mechanism lives in `SPEC.md` and the companion plan.

### Functional Requirements

1. `flow.yaml` **shall** express branching topology — a fan-out station's child-entry station, the
   child sub-path terminal, and the parent's post-fan-in resume station — and the loader **shall**
   reject, fail-closed at load, any topology field naming an unknown station or terminal.
2. The executor **shall** route children through the declared child sub-path and **shall** resume
   the parent at the declared post-fan-in station — never inferring either from station order.
3. A **fan-out** station **shall** create child cards from the **station worker's own output** (a
   proposed decomposition); the kernel **shall** validate the proposal for acyclic dependencies and
   disjoint ownership and **shall** reject the whole proposal — committing no children — when
   invalid.
4. Each child **shall** own a **distinct path namespace** so that concurrent children never write a
   shared path; a proposal with overlapping child paths **shall** be rejected (or serialized) at
   validation, not discovered at runtime.
5. A **fan-in** station **shall** apply its declared policy (e.g. quorum *k*) over the children's
   terminal outcomes: proceed with survivors and record dropped children when the policy is met;
   hold the parent when it cannot be; and **shall not** deadlock on a child that can never complete.
6. A **rank** check **shall** produce a ranked short-list and, when HITL is enabled, **shall** post
   it to the egress channel, move the card to `held`, and the run **shall** end cleanly with the
   held card and its correlation id surfaced; the kernel **shall not** auto-select a candidate.
7. The HITL prompt **shall** be delivered through the outbox-guarded transport so that a resume
   never re-posts the same prompt (no double-ask), consistent with effectful exactly-once
   ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
8. A human selection **shall** be injectable into a held run via a CLI reply that maps the reply to
   the correct card (by correlation id), durably records the selection, and **shall** be refused for
   an unknown or unparseable correlation id (never coerced onto an arbitrary card).
9. After a recorded selection, `conduit resume` **shall** continue the held card to a terminal
   outcome (assemble + deliver).
10. When no human replies within the configured hold-timeout, the declared policy
    (proceed-with-findings / scrap / escalate) **shall** apply; the kernel **shall** still never
    auto-select a candidate.
11. The real Slack transport **shall** post HITL prompts and final delivery to the configured
    channel; secrets **shall not** be logged or written to the journal.

### Non-Functional Requirements

1. **Flow-is-config.** Running the branching example flow **shall** require zero kernel-code
   changes beyond what this PRD ships — only `flow.yaml`, prompt templates, and configuration.
2. **Exactly-once under crash.** A kill at any recoverable seam — including mid-fan-out, around the
   effectful publish, and between HITL post and commit — followed by `conduit resume` **shall not**
   re-bill a checkpointed station, double-publish, or re-ask the human.
3. **No auto-pick, structurally.** No code path **shall** select a rank candidate on the kernel's
   behalf; selection is always a human reply or an explicit timeout policy.
4. **Fail-closed config.** Every new branching/topology field **shall** be validated at load; an
   invalid flow never reaches dispatch.
5. **Determinism preserved.** The executor remains a deterministic loop; fan-out decomposition is
   the only place a model influences structure, and its proposal is validated before commit.

### Edge Cases & Error States

- **Planner proposes a malformed decomposition** (cycle, dangling dependency, or overlapping child
  paths) → the fan-out is rejected with no partial children committed; the parent escalates rather
  than committing an invalid wave.
- **A child scraps and quorum can still be met** → fan-in proceeds with survivors, the scrapped
  child recorded as dropped; **quorum can no longer be met** → the parent holds.
- **Crash mid-fan-out** (some children created, some not) → resume reconciles to a consistent wave
  without duplicating children or re-billing committed work.
- **Crash between HITL post and commit** → resume reconciles the outbox intent (or escalates to
  `hold`); the human is never re-asked blindly.
- **Human replies to an unknown / stale correlation id** → refused and logged; no card is mutated.
- **A held run is resumed before the human replies** → the card stays held; resume makes no
  progress on it and surfaces it again.
- **Hold-timeout fires** → the declared policy applies; no auto-pick.

## 7. Design Principles

- **Wire, don't reinvent.** Fan-out/fan-in, the rank check, the outbox, and the HITL hold are all
  built and tested. This work declares the topology and drives those primitives from the executor.
- **The config expresses the branch.** Which stations are the child sub-path, and where the parent
  resumes, are declarations — never inferred from file order.
- **Selection is always conscious.** The kernel never picks a rank winner; a human reply or an
  explicit timeout policy does. This is a structural guarantee, not a convention.
- **Exactly-once spans the human, too.** A resume must not re-ask a human any more than it
  re-publishes — the HITL prompt is an effectful send under the outbox.
- **Thin stand-in, not scope creep.** The manual reply command bridges the human's selection only;
  the real listener is step 8 and is not built here.

## 8. Solution Approach

Built as an extension of the real-run-path executor:

- **Topology** — extend `flow.yaml` and its loader so a fan-out station declares its child-entry
  and the parent's post-fan-in resume; validate fail-closed.
- **Fan-out** — when the fan-out station's worker completes, map its output to a child proposal,
  validate (acyclic + disjoint ownership), and commit namespaced children; route the parent to
  await them.
- **Fan-in** — evaluate the declared policy over child outcomes and resume or hold the parent.
- **Rank + HITL** — run the rank critic, post the short-list to Slack under the outbox, park the
  card `held`, and end the run cleanly; a CLI reply + `resume` closes the loop, with a hold-timeout
  policy as the fallback.
- **Proof** — a real Studio-style branching flow run end-to-end, with a human pick over real Slack
  and a crash-and-resume around the effectful publish.

## 9. Technical Considerations / Dependencies

**Dependencies:**

- **The real-run path** ([`real-run-path.md`](real-run-path.md)) — the controller-driven
  executor, the OpenAI-compatible adapter, prompt/schema sourcing, explicit linear topology, and
  CLI seeding. This PRD extends that executor.
- **The shipped MVP kernel** ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) — fan-out/fan-in
  validation + quorum, the rank check, the HITL hold + timeout primitives, and the outbox.
- **A Slack app / bot token** for the real egress + HITL transport.
- **Bun** ([ADR-0002](../../adr/0002-bun-as-the-kernel-runtime.md)) and **Docker-first** packaging
  ([ADR-0003](../../adr/0003-packaging-and-distribution.md)).

**Integration points:**

- The transition matrix's fan-out / fan-in / QC-reject events (routing), reused as-is and fed
  explicit branching topology.
- Slack (HITL prompt + delivery) via the outbox-guarded transport.
- `conduit.sqlite` — state + journal, including the durable HITL selection record.

**Constraints:**

- **One level of fan-out** — nested decomposition is deferred.
- **Single-host / single-writer** — concurrency within a run is still synchronous; multi-host is
  future-watch.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The fan-out proposal contract over- or under-constrains the planner | High | High | Require only what the kernel must validate (ids + disjoint paths); let richer per-child spec ride in the child's seeded input; iterate as a finding |
| The branching topology model from the real-run path doesn't extend cleanly | Medium | High | Co-design the child-entry/resume fields with the linear `next` in the prior PRD; if it breaks, settle the model before building the example flow |
| Async HITL via a manual reply command is too clunky to validate the loop | Medium | Medium | Clean `held` exit + surfaced correlation id + `reply`/`resume` is the documented loop; the step-8 listener replaces it later |
| Crash mid-fan-out leaves an inconsistent wave | Low | High | Validate-then-commit fan-out (no partial children); reuse the proven outbox/checkpoint seams; cover mid-fan-out crash in verification |
| Real Slack delivery double-asks the human across a resume | Low | High | HITL prompt is an outbox-guarded effectful send; reconcile-on-resume, never blind re-post |

### Open Questions

- **Fan-out proposal contract.** What exactly must a planner station emit to propose children (how
  much structure; how are per-child input artifacts derived), and how is it validated without
  over-constraining the planner? The branching example flow is the first data point.
- **Topology expressiveness.** Is child-entry + parent-resume enough, or do real flows need a
  richer sub-flow / multi-edge model (e.g. children with divergent sub-paths)?
- **Reply ergonomics.** Is a single `conduit reply` command the right stand-in, or does the spike
  want a minimal local receiver — without becoming the step-8 listener?
- **Hold-timeout defaults.** What is the sane default `on_timeout` for a rank/HITL hold when the
  flow doesn't specify one (proceed-with-findings vs. escalate)?
