# Build Order

Canonical implementation sequence for Conduit. The station taxonomy ([SPEC §4](../SPEC.md#4-the-routing--flowyaml-the-engineconfig-seam)) lets the highest-risk surface — the agentic Tool-Bridge — be deferred entirely: a `transform`+`deterministic` flow (Studio) ships without it.

Steps 1–7 are the shipped **MVP**: the kernel running any `transform`+`deterministic` flow end-to-end — proven by a **synthetic reference flow**, with no agentic surface (see the [kernel PRD](../prd/done/mvp-kernel.md)).

1. **State DB + the state machine** — the `(lane, status)` model, transition matrix loader + validator, and the deterministic tick skeleton. Nothing else is correct without this. ([SPEC §3](../SPEC.md#3-the-state-machine-the-centerpiece), [§10](../SPEC.md#10-the-controller--the-deterministic-tick-adopted-from-ai-team))
2. **Atomic claim + heartbeat lease** — the single-linearization-point claim and lease-based reconcile. ([SPEC §7](../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface), [§11](../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite))
3. **IPC bridge + `transform` worker runtime** — one model call + coercive parse + one model adapter + output-schema validation. No tools, no Bash — the cheap, safe majority of stations. ([SPEC §4](../SPEC.md#4-the-routing--flowyaml-the-engineconfig-seam), [§7](../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface))
4. **Checkpoint with binding stamp + outbox** — cost recovery *and* effectful-station safety together. The difference between recovery and corruption. ([SPEC §5](../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness))
5. **Rework engine + four guards + fan-in policy + liveness watchdog** — the quality loop, fully bounded. ([SPEC §6](../SPEC.md#6-the-quality-system), [§8](../SPEC.md#8-flow-control-scale--the-two-andons))
6. **Output adapters + asset tagging + egress channel** — format the artifact (Meta CSV) and wire Slack for status/HITL/alerts/delivery. ([SPEC §4A](../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery), [§13](../SPEC.md#13-continuous-improvement-kaizen))
7. **Work Bench + Hook tests + config contract test** — make the Law testable before relying on it. ([SPEC §14](../SPEC.md#14-the-work-bench))

> **◆ MVP — shipped**, proven by a synthetic reference flow. CLI trigger, Slack egress, no agentic surface.
>
> **◇ Post-MVP validation — shipped:** the real-run path and branching/HITL flows exercise the production executor. See [After the MVP](#after-the-mvp).

8. **Ingress trigger-listener** ✅ **shipped** — thin webhook/Slack-events receiver that shells out to `conduit run`; hands-off triggering without making the kernel always-on. ([SPEC §4A](../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery))
9a. **Event-driven worker pool** ✅ **shipped** — parallel worker subprocess dispatch with `--concurrency K`, deterministic START_WORK/MARK_DONE/HEARTBEAT IPC, per-child seeded inputs, dead-PID detection, and consumption-andon drain. The Law-enforcing sandbox (9b) wraps this pool. ([SPEC §10A](../SPEC.md#10a-process-model--a-resident-per-run-daemon))
9b. **Agentic Tool-Bridge + the Law** 🧭 **planned** — tool loop, Bash positive allowlist, path-ownership enforcement, network namespace isolation, injection threat model. Wraps the 9a pool for agentic stations. Law-grade tier; stays in `prd/drafts/` as the fallback unless a flow demands per-tool-call pre-execution gating that the harness tier (9c) cannot provide. ([SPEC §7](../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface))
9c. **`kind: harness` — the agentic precursor tier** ✅ **shipped** — a station whose worker is an external headless agent harness (`claude -p`, `codex exec`, …) wrapped in the transform contract: declared inputs/outputs, `check:` gates, kernel bounds, per-attempt journaling, binding stamps. Deliberately weaker containment claim than 9b's Law — see [`docs/harness-containment.md`](./harness-containment.md) and [`prd/done/agentic-harness-worker.md`](../prd/done/agentic-harness-worker.md). First tier for flows needing tool-using makers/critics today; `agentic` keeps its Law-grade meaning reserved for 9b. **Engine-config adapter registration** ✅ **shipped** — per-run projectRoot binding, production registry populated from environment variables; see [`docs/harness-adapter-registration.md`](./harness-adapter-registration.md) for operator guide.
10. **Kaizen pipe** 🧭 **planned** — skill-detection trigger first; market-feedback loop deferred. ([SPEC §13](../SPEC.md#13-continuous-improvement-kaizen))

For ordering rationale see [SPEC §16](../SPEC.md#16-implementation-priority).

---

## After the MVP

The MVP (steps 1–7), production real-run path, branching/HITL extension,
ingress listener, event-driven worker pool, and harness precursor tier are
shipped. The Law-grade Tool-Bridge and kaizen pipe remain planned.

### Real-flow validation

The post-MVP work established the production executor, real model adapter,
prompt/schema sourcing, explicit flow topology, CLI seeding, and the full
branching/HITL shape:

- [`real-run-path.md`](../prd/done/real-run-path.md) ✅ **shipped** — a linear gated flow with transformation, deterministic work, gate rework, and an OpenAI-compatible adapter.
- [`branching-and-hitl.md`](../prd/done/branching-and-hitl.md) ✅ **shipped** — planner-driven fan-out, quorum fan-in, rank checks, and a Slack human-in-the-loop round trip.

Cost benchmarking against a frontier-agent baseline and representative
prefix-cache/parse-miss measurements still require a maintained production-like
flow. Those measurements are follow-up validation, not missing executor work.

### Remaining sequenced build-out

- **Step 9b:** [`agentic-tool-bridge.md`](../prd/drafts/agentic-tool-bridge.md) remains the unbuilt Law-grade tier for flows that need kernel-owned per-tool-call enforcement.
- **Step 10:** [`kaizen-pipe.md`](../prd/drafts/kaizen-pipe.md) remains a draft until real usage provides enough repeated rework data to justify it.

### Deferred capabilities (not yet sequenced)

Punted by the MVP and not on the 8–10 critical path:

- **Cost-target benchmarking** vs a frontier baseline — needs a representative maintained flow.
- **The `market` check kind** — a check whose verdict comes from a real external signal (clicks / signups / watch-time) instead of an LLM critic; the internal critic degrades to a cheap pre-filter. The *engine capability* is Conduit's; the *signal source* is the builder's. Needs attribution infra.
- **Market-feedback kaizen** (the second kaizen loop) — deferred until the line reliably produces cheap assets ([SPEC §13](../SPEC.md#13-continuous-improvement-kaizen)). See [feedback loops](./feedback-loops.md) for the fuller model — the **HITL preference loop** (cheaper than market, build it first) and the CSV-first ingest.
- **A rich War Room dashboard** (live TUI/web over the journal) — the MVP ships only stdout streaming + a read-only journal tail.
- **The compiled single-binary CLI** (`bun build --compile`) — a local, no-Docker convenience for developers ([ADR-0003](../adr/0003-packaging-and-distribution.md) alt A); run the "compiled binary loads user `.ts`" spike first.

### Future-watch (tracked, not yet designed)

Carried from [SPEC §17](../SPEC.md#17-future-watch-tracked-not-yet-designed):

- **F1 — Multi-host scale-out** (and an always-on `conduitd` multi-flow service): SQLite single-writer caps us to one host; horizontal scale needs a different store + a distributed claim.
- **F2 — Bucket vs WIP interaction**: a global throttle over local pull can collapse throughput.
- **F3 — Market-loop attribution**: asset tagging is non-backfillable; verify the ID survives every downstream hop.
- **F4 — OTel GenAI conventions** churn: pin the version, expect change ([ADR-0006](../adr/0006-telemetry-and-cost-attribution.md)).

### Pending ADRs

Settled in the SPEC but not yet recorded ([adr/README](../adr/README.md)):

- **Secret handling** — allowlist what reaches the journal; never raw env in worker context.
- **Channel / HITL fail-closed policy** — `hold_timeout` with a required `on_timeout`; `rank` never silently auto-picks.
