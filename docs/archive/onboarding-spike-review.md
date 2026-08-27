# Onboarding Spike Review: Conduit as a Developer-Facing Library

- **Status:** Spike notes, awaiting triage
- **Date:** 2026-06-13
- **Scope:** Whether Conduit has a real place in the AI ecosystem, how it compares with
  Temporal plus LLM calls, and whether the current `flow.yaml` surface is approachable for
  outside developers.

## Summary

Conduit is probably not best positioned as a general "AI agent framework." That lane is
crowded and already has strong incumbents: LangGraph for durable agent graphs, OpenAI
Agents SDK for agent/tool/handoff ergonomics, and Temporal/Prefect for durable workflow
execution.

Conduit has a stronger and more defensible position as:

> A deterministic quality-control kernel for AI production workflows: stations, bounded
> rework, human approval, model-cost recovery, artifact ownership, and crash-safe side
> effects.

The project is not a waste if it stays opinionated. It becomes a waste if it tries to
become a generic agent framework.

## Where Conduit Has a Real Place

The strongest idea is not "call an LLM from a workflow." The strongest idea is the
production-line contract:

- deterministic control plane
- cards, stations, WIP, terminal lanes
- `work -> check -> bounded rework`
- maker/critic separation
- scrap, hold, and andon semantics
- binding-stamped checkpoints
- outbox discipline for side effects
- HITL as durable data, not control-flow guessing
- model choice per station
- journal as the source of truth

This maps to a real category of AI work:

- ad/content generation pipelines
- video editing and publishing workflows
- PRD-to-code or PRD-to-test-code systems
- research/report generation with review loops
- lead enrichment or data cleanup with validation
- compliance/risk/taste review workflows
- any process where AI emits artifacts and failures must not double-send, double-bill, or
  silently skip approval

## Temporal Comparison

Temporal plus LLM Activities is the serious competitor. Temporal already gives teams:

- durable workflow state
- replay and recovery
- Activities for external calls
- retries, timeouts, schedules
- Signals, Queries, and Updates for human input
- mature distributed-worker operations

A team can build Conduit-like behavior on Temporal. But Temporal does not hand them the
AI production semantics. They still need to design and maintain:

- station/card model
- model-per-station config
- prompt and schema binding
- output checkpoint invalidation when model, prompt, input artifacts, or flow version
  change
- maker/critic separation
- bounded rework
- rank gates
- HITL correlation ids and timeout policy
- token/cost budgets
- artifact ownership
- side-effect outbox policy
- AI-specific journal and War Room projection
- `flow.yaml` as the product surface

Temporal wins if the user already has Temporal, needs distributed durability, or is
building arbitrary business workflows with some LLM calls.

Conduit can win if the user wants the AI workflow semantics directly: configure model and
tool workers through deterministic quality gates, bounded rework, human approval, budget
controls, and artifact-safe side effects.

Recommended positioning:

> Conduit is the quality-control layer for AI production workflows.

Avoid positioning:

> Conduit is a durable workflow engine for AI.

That runs straight into Temporal's strongest claim.

Long-term option: keep the Bun/SQLite runtime as the approachable standalone engine, but
consider a Temporal backend later for enterprise/distributed execution. In that framing,
Temporal is an execution substrate and Conduit remains the station/check/rework semantics.

## `flow.yaml` Authoring Review

The current YAML is reasonable, but it is not yet easy enough for strangers to write from
scratch.

The linear dogfood flow is close:

- `examples/tiktok-shoppable-ideas/flow.yaml` reads like a real production line.
- The sequence `fetch_context -> ideate -> gate verify -> done` is understandable.
- Co-locating `worker.kind`, `model`, `prompt_file`, `params`, and `output_schema` is
  good.
- Attaching `check:` directly to the station being judged is good.
- `on_reject: ideate` is highly legible.
- `security.bash.allow` makes the Law visible.

The branching/HITL example is where the surface starts to leak kernel internals:

- `fan_out`
- `child_entry`
- `child_terminal`
- `resume_at`
- `next`
- quorum `fan_in`
- check-only rank stations
- Slack egress
- `hold_timeout_seconds`
- `on_timeout`
- `no_selection_policy`

These concepts are legitimate, but too many of them arrive at once.

## Authoring Friction

### Manual `flow_version`

`flow_version` is easy to forget and it is load-bearing for checkpoint invalidation.

Consider:

- deriving a config hash
- adding `conduit flow bump`
- adding a validation warning when a changed file appears to reuse a prior version

### Verbose `output_schema`

Current:

```yaml
output_schema:
  fields:
    - { name: hook, type: string, required: true }
```

Possible shorthand:

```yaml
schema:
  hook: string!
  confidence_score: number
```

Also consider allowing:

```yaml
schema_file: schemas/idea.schema.json
```

### Implicit `feedback` Input

`feedback` as a pseudo-input is powerful but not discoverable.

Current:

```yaml
inputs: [context.json, feedback]
```

Possible explicit form:

```yaml
rework:
  inject_feedback: true
```

### Ambiguous Network Egress

`network_egress: allow` is confusing because model calls are kernel-mediated. It is not
obvious whether this controls worker subprocess network access, model-provider access, or
both.

Consider renaming or clarifying:

```yaml
security:
  worker_network_egress: deny
```

### Branching Routing Is Too Manual

Current branching requires the author to wire multiple topology fields correctly:

```yaml
fan_out: 3
child_entry: draft
child_terminal: done
resume_at: assemble
next: assemble
```

Possible higher-level authoring form:

```yaml
fan_out:
  count: 3
  child_path: [draft, publish]
  join: assemble
```

The loader can compile this to the expanded kernel form.

### HITL Is Too Implicit

Today rank HITL is inferred from whether the flow declares an egress channel. That is
surprising. Make it explicit on the rank station.

Possible:

```yaml
selection:
  mode: human
  channel: slack
  timeout: 30s
  on_timeout: scrap
```

### `no_selection_policy` Should Fail Closed

Unknown `no_selection_policy` values currently default to `scrap`. That is safer than
proceeding, but it is still surprising. Match `on_timeout`: invalid values should fail
validation.

## Recommended Tracking

Treat this as an adoption/onboarding spike, not a kernel rewrite.

Suggested work items:

1. Write a "Flow Authoring Guide" with one linear flow and one branching flow.
2. Add `conduit explain flow.yaml` to show the compiled topology, entry station, checks,
   HITL behavior, and side-effect boundaries.
3. Add `conduit init flow` templates:
   - linear transform
   - deterministic fetch plus transform
   - gate with bounded rework
   - fan-out/fan-in
   - rank plus HITL
4. Add schema shorthand or schema-file support.
5. Add an explicit HITL/selection block.
6. Add branching sugar that compiles to the expanded topology.
7. Validate `no_selection_policy` fail-closed.
8. Revisit `flow_version` ergonomics.

## Adoption Test

Use these as the bar for whether Conduit is becoming a real library:

1. Can a stranger install it and run a useful example in under 10 minutes?
2. Can they write a useful `flow.yaml` without reading `SPEC.md` end to end?
3. Can Conduit save them from one painful thing immediately: runaway cost, bad retries,
   missing approvals, no audit trail, weak QC, double-billing, or double-delivery?
4. Can the project be explained in one sentence without relying on internal metaphors?

If those answers become yes, Conduit has a credible place in the AI ecosystem.
