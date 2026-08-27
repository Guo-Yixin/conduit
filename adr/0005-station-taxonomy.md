# ADR-0005: Station taxonomy — two axes, with the Law scoped to agentic stations

Status: Accepted
Date: 2026-05-30

## Context

Not every station is the same animal. A critic is a single typed data-in/data-out call. An
assembler runs `ffmpeg` and exits. A coder runs a multi-turn Read/Write/Bash loop over a
shared filesystem. Treating these identically forces one of two bad outcomes: either every
cheap critic pays the full agentic safety tax, or the dangerous tool loop runs under-guarded.

We need a classification that determines each station's runtime, cost shape, safety surface,
and checkpoint semantics — and, crucially, one that lets the **highest-risk surface be
deferred** so the first shippable kernel (and most stations forever) avoid it.

## Decision

**Classify every station on two orthogonal axes, declared in `flow.yaml` and validated at
load.**

- **Axis 1 — `kind`:** `deterministic` (no LLM; a command/function) · `transform` (one
  kernel-mediated model call, typed in/out, **no tools, no loop**) · `agentic` (an LLM with
  Read/Write/Bash in a **multi-turn loop**).
- **Axis 2 — `effectful: true|false`:** `pure` (output is a function of input; replays
  cleanly) · `effectful` (billed call or irreversible side effect; needs the outbox +
  idempotency key, **regardless of `kind`**).

Two scoping rules fall out, and they are the entire point:

- **The full Law + Tool-Bridge is scoped to `agentic` stations only** — the multi-turn loop,
  the Bash positive allowlist, network-namespace isolation, and the injection threat model
  exist *because there is a tool loop* (SPEC §7). A `transform` station's only safety surface
  is **output-schema validation**; a `deterministic` station gets **Law-lite** (owned-path
  writes + one allowlisted command, no loop, no model, no injection vector).
- **The outbox is scoped to `effectful` stations, any `kind`** (SPEC §5). Pure stations
  replay for free; effectful ones need idempotency whether they're a transform (image-gen) or
  agentic (a git commit).

**Consequence that drives the roadmap:** a flow built only of `deterministic` + `transform`
stations needs **none** of the agentic surface. Studio is exactly this, so the MVP ships the
kernel without the scariest code (build-order steps 1–7); the agentic Tool-Bridge is step 9,
built only when a coding-style flow needs it (SPEC §16).

## Alternatives considered

### A. One uniform station type, full safety surface always on — *rejected*
Simplest mental model, worst economics and risk profile: every cheap critic carries the
sandbox, the Bash allowlist, and the injection model for no benefit, and the MVP is forced to
build and trust the highest-risk surface on day one. The whole deferral that makes the MVP
tractable disappears.

### B. The `kind` axis only, no `effectful` axis — *rejected*
Effectfulness is genuinely orthogonal to execution model. A pure `transform` critic and an
effectful `transform` image-gen share a `kind` but have completely different recovery needs:
one replays for free, the other will double-bill or double-publish without the outbox.
Collapsing the axis either over-protects pure stations or under-protects effectful ones —
exactly the bug the outbox exists to prevent.

### C. Classify by model tier (frontier vs cheap/local) — *rejected*
The safety surface follows **what a station can do** — tools, shell, side effects — not which
model executes it. A cheap model in a tool loop is *more* dangerous, not less. Model choice is
a separate, per-station cost lever (ADR-0001), not a safety classifier.

## Consequences

**We gain**
- The scary surface is the **agentic minority**; every critic/briefer/director is a
  `transform`. `transform`/`deterministic` stations are Unix filters — fixture-testable,
  cacheable, composable (SPEC §14).
- The MVP defers the agentic Tool-Bridge/Law entirely; the outbox is built only where
  effects are real.
- A clean, testable contract per station class.

**We pay**
- The classification must be declared per station and **enforced at config load** —
  misclassifying an effectful station as `pure` silently loses idempotency, a real footgun, so
  the validator must treat the axes as load-bearing, not advisory.
- Two axes is marginally more to learn than "a station is a station."

**Revisit triggers**
- A genuinely new execution mode that fits neither `kind` (e.g. a long-lived streaming
  station) → **extend the axis**, don't collapse it.
- If the agentic surface ever needs to apply to a non-agentic station, that's a signal the
  taxonomy boundary was drawn wrong — revisit before weakening the scope.

## References

- SPEC §4 (the two axes, the `flow.yaml` seam), §5 (effectful stations / outbox), §7 (the
  Law scoped to agentic), §14 (the Bench / fixture-testing filters), §16 (build order),
  Appendix A (the three flows mapped).
- ADR-0001 (build-vs-buy), ADR-0004 (deterministic kernel) — the taxonomy is how the
  deferral in those decisions is realized.
