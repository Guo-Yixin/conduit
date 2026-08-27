# ADR-0004: Deterministic kernel, LLM-as-labor — no LLM in the control loop

Status: Accepted
Date: 2026-05-30

## Context

The decision *underneath* [ADR-0001](./0001-build-vs-buy-the-orchestration-substrate.md):
where does control flow live — inside an LLM, or in deterministic code? This is the
load-bearing inversion the whole project rests on, and it gets re-litigated every time
someone proposes "just let the agent decide what to do next."

The forcing evidence is concrete: an LLM driving a long-lived orchestration loop in a
reference system **ran away for ~40 hours without converging**, re-reading its context
every tick and never reaching a terminal state. The failure wasn't a bad prompt — it was
structural. An LLM in the steady-state loop is non-reproducible, can't be checkpointed
(you can't replay a thought process), and its cost scales with every context re-read.

## Decision

**The kernel is a deterministic finite-state machine over `(lane, status)`. It owns all
routing, scheduling, dispatch, recovery, and budgets. LLMs are labor at stations — they
produce work and judge work, and never schedule it. No LLM sits in the steady-state
dispatch loop.**

- The conveyor is **dumb on purpose**: each tick is pure Bun code that reads board + deps
  + pool + checkpoints and emits a bounded action plan (SPEC §10). It cannot run away in
  token cost because it spends no tokens.
- The **one** planning LLM — the Wave-1 Architect that decomposes a parent card — is
  explicitly *off* the steady-state path: it runs once per parent, is itself rework-capped,
  and its output is **validated by the kernel** (acyclic deps, disjoint owned paths) before
  anything dispatches (SPEC §9). LLM proposes; kernel disposes.
- On ambiguous or unreadable state the planner emits **zero actions + a `needsJudgment`
  escalation** rather than letting a model improvise (SPEC §10, Principle 9).

## Alternatives considered

### A. LLM orchestrator — an agentic control loop — *rejected*
Let a long-lived agent decide what to do each step. This is the 40-hour runaway by
construction: routing is non-reproducible, a mid-loop crash can't be replayed (no durable
decision record), and cost compounds with context growth. The andon can't cleanly stop it
because "still thinking" is indistinguishable from "stuck."

### B. LLM-in-the-loop but budget-bounded — *rejected*
Keep the LLM deciding next-step, but cap it with a token/wall-clock budget. The budget is a
blunt backstop, not a fix: routing is still non-deterministic and non-replayable, you still
can't validate that a transition is *legal*, and you've traded a runaway for a
truncated-mid-decision. The determinism we need isn't "bounded," it's *absent from the loop*.

### C. Hybrid — LLM proposes, kernel disposes — *adopted, but only off the steady-state path*
This is what we do for decomposition (the Architect) and for quality (critics emit a
structured verdict the kernel routes on). The LLM contributes *judgment as typed output*;
the kernel makes every *control* decision and validates the judgment against the transition
matrix. The line we hold: an LLM may produce a decision the kernel checks — it may never
*be* the loop.

## Consequences

**We gain**
- Reproducible routing, bounded cost, and crash-safe replay — the controller is testable
  Bun code, not a transcript.
- The consumption andon and liveness watchdog can actually halt the system, because the
  loop's state is legible (SPEC §8).
- The runaway is **structurally impossible** in the conveyor.

**We pay**
- The kernel must encode *every* legal transition (the validated transition matrix) and
  must **escalate** unforeseen states instead of hand-waving "the model will figure it out."
  More upfront design; no graceful improvisation on novel states.
- Judgment that genuinely needs a model has to be shaped as a *station that emits typed
  output*, not as a decision made inline.

**Revisit triggers**
- Not expected for the conveyor itself. If a routing decision genuinely needs learned or
  probabilistic dispatch, it becomes a **station** whose typed output the kernel validates —
  never an LLM re-inserted into the tick.

## References

- SPEC §2 (Principle 1), §3 (the state machine), §9 (Wave-1 Architect, validated), §10
  (deterministic tick), §10A (process model), §8 (the two andons).
- [`docs/philosophy.md`](../docs/philosophy.md) — the worldview.
- ADR-0001 (build-vs-buy) — this is the premise beneath it.
