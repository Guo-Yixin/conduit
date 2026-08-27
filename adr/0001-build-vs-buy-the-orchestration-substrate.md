# ADR-0001: Build the orchestration substrate; don't adopt an existing engine

Status: Accepted
Date: 2026-05-30

## Context

Conduit needs a durable, model-independent **flow-shop**: work flows through stations, some
stations are quality gates that can **reject work back down the flow** (cyclic rework), with
per-station **WIP limits**, **dependency waves**, and crash-safe **resume**. Before building a
bespoke kernel we surveyed the landscape across three families to decide build-vs-buy. Three
forces dominate the decision:

1. **Cyclic rework is the defining feature.** `work → check → reject → rework` is a *cycle*,
   not a DAG. Most pipeline engines forbid cycles by construction.
2. **Model independence and cost.** Flows must drive *any* model, chosen per station
   (frontier where judgment lives, cheap/local where it doesn't). A reference flow dropped
   from ~$2–3/run to ~$0.21/run by moving off a frontier-agent harness onto a deterministic
   state machine.
3. **No host lock-in.** Hosting on an agent harness (Claude Code et al.) bills CLI/headless
   use as API, doesn't let us pick the model per station, and ties us to one plugin format.

The durability question underneath is: *an LLM call can't be deterministic, so how do we get
crash-safe resume without re-paying for completed work?*

## Decision

**Build the kanban/WIP/cyclic orchestrator ourselves**, on a deterministic **Bun/SQLite**
kernel, with LLMs as labor at stations. Specifically:

- **Durability via output-checkpoint, not deterministic code-replay.** Persist each station's
  *actual output* (with a binding stamp) and resume from the last completed station; effectful
  stations use an outbox + idempotency key. (SPEC §5.)
- **Cyclic rework is first-class and bounded** by the four guards (per-card cap → scrap,
  progress-monotonicity on findings, per-wave + global budgets, liveness watchdog). (SPEC §6, §8.)
- **Steal primitives, not runtimes.** Adopt proven *patterns* from existing systems; do not
  take on their deployment or constraints.
- **Run our own runtime.** Not hosted on Claude Code or any single agent harness. (SPEC §1, §10A.)

The kernel is ~60% proven already: it's the controller extracted from the A(i)-Team reference
implementation (SPEC Appendix B).

## Alternatives considered

### A. Adopt a DAG / dataflow engine — *rejected*
**Airflow, Dagster, Prefect, Beam, Flyte, Luigi, Ray Core; Apache Storm/Flink (streaming).**
These are acyclic by construction (Airflow: "no A→B→A"; Beam: "can't feed back into itself").
They **structurally cannot express the reject-to-an-earlier-station back-edge**, which is the
whole point of a quality flow. They simulate iteration by re-creating downstream work at
runtime, which loses the kanban-card identity. Storm/Flink *do* allow cycles, but as
stream-processing infra they're far heavier than we need and bring distributed-coordination
failure modes (Storm's ZK back-pressure stalls). **What we steal:** the *scheduling* model —
Airflow "pools" ≈ per-station WIP; dependency edges ≈ dependency waves; "dispatch a task when
deps are done AND a slot is free." Not the graph model.

### B. Adopt a durable-execution runtime as the substrate — *rejected (steal the model)*
**Temporal/Cadence, Azure Durable Functions (code-replay); Inngest, Restate, DBOS, Hatchet,
Windmill (output-checkpoint).** Temporal's *model* is exactly right and is the conceptual
basis for Conduit: deterministic **workflow** code orchestrating non-deterministic
**activities**, where activity results are recorded once and replayed — i.e. *our*
deterministic controller orchestrating *LLM steps whose outputs are checkpointed*. Temporal
even documents the LLM case ("re-execution means re-paying for tokens; record the decision
once"). But:
- **Code-replay imposes a determinism tax** on the controller (no clock/random/uuid/IO,
  generator gymnastics) plus painful versioning so in-flight runs survive code edits — cost we
  don't need, since *the steps*, not the control flow, are the expensive/variable part.
- **Server/worker deployment is mismatched** with our own-runtime, single-binary, cost-driven
  goal.

The **output-checkpoint family** (DBOS, Restate, Inngest, Hatchet) is the closer fit —
persist real step outputs, resume from the last completed step, far weaker determinism
constraints. **DBOS/Hatchet are the closest architectural analogs** (Postgres-backed,
library-over-DB). We adopt this *family's model* but implement it ourselves on SQLite: we
already have a state DB, `bun:sqlite` is in-binary, and "query on every tick" is cheap. **What
we steal:** record-and-replay-the-output (the checkpoint), per-step retry budgets (Inngest),
step-memoization keys, declarative retry-as-data (Step Functions).

### C. Adopt an LLM-native orchestration framework — *rejected (compose, don't adopt)*
**Orchestrators:** LangGraph, LlamaIndex Workflows, CrewAI, AutoGen, Inngest AgentKit,
OpenAI Agents SDK, Claude Agent SDK. **Typed-step layers:** DSPy, Pydantic-AI, BAML, Vercel
AI SDK. Two findings:
- The orchestrators handle state/branching/cycles (LangGraph notably allows cyclic graphs)
  but treat the LLM call as opaque code and — critically — **none has per-column WIP /
  kanban**. That's the industry gap Conduit fills. Most also have only in-process *snapshot*
  checkpoints, not durable execution (a mid-step crash loses work, no auto-recovery).
- The typed-step layers nail what we want *inside* a transform station: typed I/O, structured
  output, and **retry-on-invalid** (BAML's schema-aligned parsing recovers structure from
  garbled output; Pydantic-AI/DSPy re-prompt with the validation error, bounded).

So we **compose**: steal the typed-step contract (schema-aligned parsing + bounded
retry-on-invalid) for our transform stations (SPEC §7), and build the kanban/WIP/cyclic
orchestrator ourselves.

### D. Host on an existing agent harness (Claude Code, OpenCode) — *rejected*
Fails all three forces: CLI/headless use bills as API (plans don't cover it), you can't pick
the model per station, and plugin formats don't port across harnesses. Conduit must own its
runtime to own its model and its cost.

## Consequences

**We gain**
- Model independence and the cost control that comes with per-station model choice.
- The **WIP + kanban + cyclic-rework** combination essentially nobody else ships.
- Ownership of the cost and safety surfaces, and a ~60%-proven kernel from A(i)-Team.
- A small dependency footprint (Bun gives runtime + IPC + SQLite + TS in one binary; SPEC §1).

**We pay**
- We own the hard parts durable-execution engines give you for free: crash-safe checkpoint +
  resume, the binding-stamp replay-soundness work, and effectful-station idempotency (the
  outbox). These are subtle and must be gotten right (SPEC §5).
- The **Tool-Bridge / coercive parser** for arbitrary models is the highest-risk surface we
  must build (SPEC §7) — though the station taxonomy lets us defer the *agentic* part (SPEC §4, §16).
- **SQLite single-writer** caps us to one host for now (SPEC §11, §17 F1).

**Revisit triggers**
- **Multi-host / multi-tenant scale** → revisit the store (Postgres/Redis + a distributed
  claim) and whether a durable-execution engine (Temporal/Restate) becomes worth its weight
  at that point. This ADR would then be partially superseded.
- If the binding-stamp + effectful-idempotency work proves too costly to maintain correctly,
  reconsider borrowing a durable-execution runtime for the activity layer only.

## References

- SPEC: §3 (state machine), §5 (checkpoint/outbox), §6 (rework guards), §7 (tool-bridge),
  §10 (controller), §11 (persistence), Appendix B (A(i)-Team mechanisms adopted).
- Landscape survey conducted 2026-05-29 across durable-execution, dataflow/DAG, and LLM-native
  families.
- A(i)-Team reference implementation (`the-ai-team-plugin`) — the controller this kernel
  extracts and generalizes.
