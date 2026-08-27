# ADR-0007: HITL hold-timeout enforcement — opportunistic, injected-clock, fail-open

Status: Accepted
Date: 2026-06-10

## Context

A `rank` station can hand a decision to a human: it posts a short-list to an egress channel
and parks the card `held`, awaiting a `conduit reply`. Humans are not a reliable scheduler —
the reply may come in seconds, or never. SPEC §4A already settled the **config policy**: a
`hold_timeout_seconds` requires a paired `on_timeout` (`scrap` / `proceed_with_findings` /
`escalate`), and the kernel **never silently auto-picks** a rank winner (FR-14). The timeout
primitive (`applyHoldTimeout`) was built and unit-tested.

What §4A did *not* settle is the part that bites in production: **how and when the timeout
actually fires.** The kernel has no LLM in the control loop (ADR-0004) and — as it stands —
the executor is a **single-process, synchronous tick loop**. When the only remaining work is a
held card, the loop has nothing to dispatch and exits cleanly; the human later runs
`conduit reply` + `conduit resume`. There is no daemon ticking wall-clock between
invocations. So "fire the policy after 30s" has no obvious home: there is no always-on process
to notice that 30s elapsed.

A second, quieter force: the executor runs on an **injected clock** (`now()`), called once per
tick so tests can drive deterministic time. But the persistence layer stamps `created_at` with
SQLite's `unixepoch()` — real wall-clock. Any timeout measured against a DB timestamp would be
non-deterministic under test and would silently diverge from the clock every other guard
(budgets, leases, liveness) already uses.

We need to decide the **enforcement model** before more time-based guards copy whatever the
first one does.

## Decision

**Enforce the HITL hold-timeout opportunistically, on the injected clock, fail-open.**

- **Opportunistic, not timed.** A new `pollHeldTimeouts` runs inside the executor's
  terminal-check, right after the reply-driven held-exit. Every time the executor runs or
  resumes, it re-evaluates held HITL cards; any whose window has elapsed *with no recorded
  selection* is resolved by the channel's `on_timeout`. **There is no background timer.** A
  deadline can be exceeded in real time with no effect until the executor is next invoked past
  it. This is a deliberate consequence of the synchronous-executor lineage (ADR-0004), not an
  oversight.
- **Injected clock as the source of truth.** "Held since" is stamped via a durable
  `hitl.held_at` **journal span** using the same injected `now()` the rest of the loop uses —
  never the DB's `unixepoch()` columns. The deadline is therefore deterministic under test and
  survives crash/resume (the span is journaled). The stamp is written lazily on first
  observation, which for a holding run is its own terminal-check poll (≈ park time).
- **Fail-open on timing.** If the holding run never reached the poll, the window simply starts
  later — a held card is **never scrapped early**. Erring toward giving the human *more* time
  is the safe direction for an irreversible policy like `scrap`.
- **Reply always beats timeout.** A recorded selection is checked before the deadline; a human
  who answered late still wins over the policy. The kernel still never auto-picks (FR-14):
  `scrap`/`escalate` route via `applyHoldTimeout`, and `proceed_with_findings` advances *past*
  the rank station with no winner chosen.
- **Fail-closed config.** An `on_timeout` value outside the three legal policies is rejected at
  **load** (`INVALID_ON_TIMEOUT`), not silently no-op'd at timeout.

## Alternatives considered

### A. A background timer / wall-clock daemon that fires the policy at the deadline — *rejected*
This is what "timeout" intuitively implies, and it's the wrong shape for this kernel. It
reintroduces an always-on concurrent actor mutating card state *outside* the deterministic
tick — precisely the control-loop concurrency ADR-0004 removed. It cannot be driven by an
injected clock (so it's untestable deterministically), and a timer firing mid-crash is a new
exactly-once hazard. Worse, it buys little: the resolved card can't make progress until the
executor runs anyway, so firing "on time" rather than "on next run" is cosmetic.

### B. An external cron/sweeper process that scans for expired holds — *rejected*
Same concurrency and exactly-once problems as (A), plus a second deployable with its own
failure modes and its own clock. The whole point of the single-binary kernel (ADR-0002/0003) is
that there is *one* process that owns state transitions. A sweeper splits that ownership.

### C. Measure "held since" from a DB `created_at` (outbox / card_log `unixepoch()`) — *rejected*
Convenient — the outbox row already has a timestamp — but it couples the timeout to wall-clock,
making it non-deterministic under the injected test clock and inconsistent with every other
time-based guard in the loop. The journal span costs one append and keeps timing on a single,
testable clock.

### D. Record a synthetic selection on timeout so the normal resume path advances the card — *rejected*
Tempting for `proceed_with_findings` (it would reuse the reply path verbatim), but it
manufactures a "human choice" that never happened — a direct violation of the no-auto-pick
guarantee (FR-14). `proceed_with_findings` must advance *without* a winner, so the executor
routes past the rank station explicitly instead.

## Consequences

**We gain**
- One actor owns state transitions — the deterministic tick. No timer thread, no sweeper, no
  new exactly-once surface. The timeout rides the same crash-recovery guarantees as everything
  else.
- Deterministic, fixture-testable timing: the whole feature is covered by driving `runExecutor`
  across `run → resume` with a pinned clock.
- A reusable rule for the next time-based guard: **source the injected clock, journal the
  stamp** — don't reach for `unixepoch()`.

**We pay**
- The timeout is **only as timely as the next executor invocation.** If a run holds-and-exits
  and is never resumed, the policy never fires. This is acceptable while the executor is
  invoked on a cadence (CLI resume, ingress-driven runs), but it is a real limitation to call
  out, not hide.
- "Held since = first observation" can lag actual park time by the gap between hold and the
  next poll. Fail-open makes this safe (never early) but means the effective window is
  `[timeout, timeout + gap]`, not exact.

**Revisit triggers**
- The executor gaining **concurrent in-flight workers** or a **long-running/daemonized** mode
  (foreshadowed by `watchdog.planDrain` in the build-order notes). Once a process is genuinely
  always-on, a real timer becomes coherent with the architecture — revisit whether
  opportunistic enforcement is still sufficient, or whether the drain/heartbeat loop should
  also tick held-timeouts.
- A flow needing **sub-invocation timeout precision** (e.g. an SLA measured in seconds with no
  reliable resume cadence) — that's the signal (A) or an event-driven ingress wake-up is
  warranted.
- Any second time-based guard choosing `unixepoch()` over the injected clock — treat as a bug
  against this ADR.

## References

- SPEC §4A (channel / HITL fail-closed policy: required `on_timeout`, no auto-pick, egress
  through the outbox), §5 (effectful outbox / exactly-once), §8 (the two andons — the liveness
  watchdog is the sibling time-based guard).
- ADR-0004 (deterministic kernel, no LLM in the control loop) — the synchronous tick is why
  enforcement is opportunistic rather than timed.
- ADR-0002 / ADR-0003 (single Bun binary, Docker-first) — why a second sweeper process was
  rejected.
- Implementation: `src/controller/executor.ts` (`pollHeldTimeouts`, `hitl.held_at` /
  `hitl.timeout` journal spans), `src/channels/slack.ts` (`applyHoldTimeout`), `src/flow/load.ts`
  (`INVALID_ON_TIMEOUT`). Tests: `src/controller/executor-rank-hitl.test.ts` (hold-timeout
  enforcement suite), `src/channels/egress.test.ts` (the primitive).
