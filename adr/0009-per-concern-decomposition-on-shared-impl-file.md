# ADR-0009: Concerns sharing an impl file stay a dependency chain, not a consolidated item

Status: Accepted
Date: 2026-07-07
Deciders: Face + Sosa (mission M-20260707-002, Agentic Harness Worker)

## Context

Wiring `kind: harness` into the executor spans seven distinct concerns — happy-path execution
and output validation, attempt caps and named failure states, per-attempt journaling, the
integrity gate, liveness, gate composition, and effectful discipline (WI-565..571). All seven
edit the same file, `src/controller/executor.ts`.

The A(i)-Team decomposition rule "concerns sharing a single impl file become a direct dependency
chain" (so the file-collision serialization guard never has two items editing it in parallel)
forces these into a **linear chain**. Combined with the upstream seam/runner/load items, that
chain produces a **10-wave dependency graph** for the mission.

Ten waves reads as a long, sequential timeline and invites the question every planning pass
raises: *should we merge these executor items into two or three larger ones to flatten the
graph?*

## Decision

**Keep the fine-grained, per-concern split — each item with its own acceptance criteria and its
own test file — even at the cost of wave depth.**

We do not consolidate WI-565..571 into a few larger executor items to shrink the wave count.
Each concern maps to a distinct FR or edge case and stays independently table-testable.

## Alternatives considered

### A. Consolidate into 2–3 larger `executor.ts` items to reduce wave depth — *rejected*
Fewer items would flatten the graph and cut cross-item coordination. But merging **loses
per-concern table-testability** (one big item bundles unrelated failure modes behind a single
test file) and blurs the one-item-to-one-FR/edge-case mapping that makes coverage auditable.
Critically, the wave depth is a **scheduling artifact, not a real 10-phase timeline** — Phase 1
alone spans WI-565..569, so the "10 waves" number overstates the actual sequencing cost. Trading
away testability and traceability to optimize a misleading number is a bad deal.

## Consequences

**We gain**
- Every executor concern has isolated ACs and a dedicated test file — coverage stays auditable
  and each failure mode is table-testable on its own.
- A one-to-one item↔FR/edge-case mapping that survives review.

**We pay**
- A deep dependency chain and a larger wave count, which *looks* like a long serial timeline even
  though the real phase structure is flatter. This must be read as a scheduling artifact, not a
  literal 10-step schedule.

**Revisit triggers**
- `src/controller/executor.ts` (and other heavily-reused kernel files) will recur as a shared
  impl target in future missions. When a long single-file chain appears, the default is
  **parity/testability over wave-depth optimization** — do not re-litigate "should we merge
  these?" each pass. Only reconsider if two concerns genuinely cannot be tested apart, in which
  case they were one concern to begin with.

## References

- Mission M-20260707-002 (Agentic Harness Worker); SPEC §16 build-order step 9 (Tool-Bridge).
- Work items: WI-565..571 (the shared-`executor.ts` chain); the same-impl-file→direct-dependency
  rule enforced by the file-collision serialization guard.
- Related: ADR-0008 (adapter capability introspection — sibling decision from the same mission).
