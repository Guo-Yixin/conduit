# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**MVP kernel + harness precursor tier shipped with Phase 1 exit criterion met (v0.3.1).** Build-order steps 1–7 (deterministic substrate:
transform + deterministic stations, atomic claim, tick planner, checkpoint binding stamps, exactly-once
recovery), 7.6 (multimodal image inputs), 7.7 (Docker packaging), 8.1 (deterministic fan-out/fan-in +
rank/HITL), 8.2 (ingress listener), **9c (harness precursor tier: `kind: harness` station wrapping
external headless agent CLIs)**, and **engine-config adapter registration (per-run projectRoot binding)**
are complete and driven by `runExecutor`. The owned-paths integrity gate, checkpoint cascade invalidation,
the per-wave subtree budget, and the harness adapter registry (environment-config populated at boot) are
wired. Phase 1 exit criterion met: research flow runs end-to-end with real adapters (claude-headless,
codex-exec) and self-serve E2E evidence via `CONDUIT_E2E_CLAUDE=1`. Remaining: the **Law-grade agentic
Tool-Bridge** (step 9b, `prd/drafts/`), and the **kaizen** loop (step 10) — see the build order in
`SPEC.md §16` and `docs/build-order.md`.

## What this is

Conduit is a **deterministic, model-independent flow-shop for LLM labor** — a lean-manufacturing assembly line applied to knowledge work. The kernel is a Bun/SQLite state machine; LLMs are workers at stations, never in the control loop.

The central insight: three independently-built systems (A(i)-Team for code, Studio for ad assets, Autocut for video) converged on the same kernel architecture. Conduit extracts that kernel so **the flow becomes config (`flow.yaml`), not code**.

## Orientation — read in this order

1. `docs/philosophy.md` — the worldview (why shaped this way)
2. `README.md` — the pitch, glossary, and build order
3. `SPEC.md` — the full design (state machine, `flow.yaml` schema, quality system, cost model)
4. `adr/` — why each major decision was made

## Core concepts

### The vocabulary (lean → Conduit)

| Lean term | Conduit component |
|---|---|
| Production line | a `flow` defined in `flow.yaml` |
| Station | a lane with a worker and optional QC |
| Kanban card | a `card` (epic = parent card, task = child) |
| Quality gate | a `check` station (LLM critic) with a back-edge |
| Rework loop | reject-to-an-earlier-station, bounded by four guards |
| Scrap bin | the `scrap` terminal lane |
| Andon cord | the global run budget + liveness watchdog → halt |
| Standard work | a crystallized **skill** (named, reusable) |

### Station taxonomy — the key distinction (SPEC §4)

Every station is classified on two orthogonal axes:

**Axis 1 — execution `kind`:**
- `deterministic` — no LLM; a command or function (`ffmpeg`, `git`)
- `transform` — one LLM call, typed data in/out, **no tools, no loop** (most critics/briefers)
- `agentic` — LLM with Read/Write/Bash in a multi-turn loop (the full Tool-Bridge)

**Axis 2 — `effectful: true|false`:**
- `pure` — replays cleanly from checkpoint
- `effectful` — billed call or irreversible side effect (image-gen, git commit, publish) → needs the outbox + idempotency key

This matters because **the Law (§7) applies only to `agentic` stations**. A `transform`-only flow (Studio) ships without any of the agentic safety surface. The MVP can be built without it.

### The state machine — `(lane, status)` (SPEC §3)

Each card has two orthogonal fields:
- **`lane`** — *where* the card is (routing). Either a station from `flow.yaml` or a kernel terminal (`intake`, `done`, `scrap`, `hold`).
- **`status`** — execution sub-state (scheduling). Universal: `waiting → ready → claimed → working → done_pending_ack`, plus `interrupted`, `held`, `awaiting_children`, `scrapped`.

A card is dispatchable iff: `status=ready` AND lane is a work station AND under WIP cap AND a worker slot is free — ANDed in a **single atomic SQLite transaction**.

### The quality system (SPEC §6)

Quality comes from `work → check → bounded rework`, not from one smart call. Keep two checks strictly separate:
- **Integrity check** — deterministic Summary Hook in the DONE transaction (files ⊆ owned paths, schema valid)
- **Quality check** — a separate QC station (LLM critic, usually a pure `transform`, back-edge to an earlier lane)

Rework is bounded by **four independent guards**: per-card cap → scrap, per-execution-attempt cap, progress-monotonicity on findings hash (not artifact), and budgets at card/wave/run scope + liveness watchdog.

### The Law (SPEC §7)

Because Conduit runs its own runtime with no provider safety net, the Law is the **only guardrail**:
- Path ownership — writes ⊆ card's `owned_paths`, symlink-resolved
- Bash positive allowlist — only listed executables, no shell metacharacters
- Network egress denied by default for content workers

The Law applies to `agentic` stations only. It is load-bearing; hooks must have unit tests. A disabled hook is how a flow learns to `rm -rf` the wrong directory.

### Checkpoint soundness (SPEC §5)

Each checkpoint carries a **binding stamp**: `hash(model_id, prompt_template_version, input_artifact_hashes, flow_version)`. A completed station is skipped on resume **only if the binding stamp matches**. Mismatch invalidates and cascades downstream. Effectful stations additionally use an outbox + idempotency key (never blind-retry a publish/commit).

## Runtime and packaging decisions

- **Bun** (ADR-0002): the kernel runtime. One binary provides `Bun.spawn` (vfork, cheap), native `process.send` IPC (no broker), in-process `bun:sqlite` (no driver), and zero-compile TypeScript. The kernel and userland are one language, hot-loadable.
- **Docker-first** (ADR-0003): distribute as Docker images with Bun baked in. `conduit.sqlite` + project root must live on a mounted volume — never the ephemeral container FS. Secrets via env/-e, never baked into an image layer. Agentic flows get container-level blast-radius containment.

## Build order

See [`docs/build-order.md`](./docs/build-order.md) for the canonical sequence. Steps 1–7 ship the MVP (Studio, no agentic surface); 7.6–7.7 add multimodal input and Docker packaging; 8.1–8.2 add deterministic branching/HITL and the ingress listener (all shipped). The remaining steps 9–10 add the agentic Tool-Bridge and kaizen.

### Built-as-library vs. driven-in-production

Some kernel modules are **fully implemented and unit-tested but not yet called by the production executor** (`src/controller/executor.ts` / `runExecutor`). This is deliberate — they are later-build-order capabilities waiting for their step — **not dead code or bugs**. Do not assume `runExecutor` exercises them just because the tests are green; the unit tests drive the modules directly, and some integration/crash tests drive the `src/test-harness/` scaffolding (`crash-oracle.ts`, `reference-flow-runner.ts`) rather than `runExecutor`.

**Wired into `runExecutor` today:** the `(lane, status)` FSM (`statemachine/transitions.ts` — the executor routes every post-work transition through `transition()`), the effectful outbox + idempotency discipline (`checkpoint.ts` `writePendingIntent`/`commitIntent`/`reconcileOnResume`, gated on `station.effectful`), `cap_policy` (`flow.defaults.capPolicy`, applied via the FSM), the atomic claim, checkpoint skip-on-resume (binding-stamp match), **binding-stamp cascade invalidation** (`cascadeInvalidation` — a stale upstream stamp on resume invalidates downstream checkpoints), the **MARK_DONE owned-paths integrity gate** (`worker/integrity.ts` `checkIntegrity` — opt-in per flow via `defaults.enforce_owned_paths`; a write outside `owned_paths` hard-pauses to `hold`), the **per-wave/subtree budget** (`aggregateByWave`/`checkWaveBudget` — guard #4's wave scope; an over-budget `parent_id` subtree is scrapped without halting the run), **fan-out / fan-in** (`dag/expand.ts` `commitFanOut`/`validateExpansion`/`evaluateFanIn` — acyclic-deps + disjoint-ownership validation, child seeding, quorum/all/best-effort merge), **rank QC + HITL selection** (`quality/rank.ts` `runRankCheck` — short-list, hold for a human pick, `conduit reply`), the consumption andon, the liveness watchdog (`checkLiveness`/`checkConsumptionAndon`), and the **event-driven worker pool** (`conduit run --concurrency K>1`): real out-of-process workers (`worker/worker-entry.ts`, spawned via the `makeWorkerPool`/`buildWorkerPool` seam as `conduit __worker`), START_WORK/MARK_DONE over Bun IPC (codec-validated by `worker/ipc-protocol.ts`), the K-bounded concurrency cap (run-level `concurrency` ANDed with station `wip` via the atomic claim), `beginWork`-stamped leases + live `reconcile` for hung-worker reclaim, MARK_DONE token attribution into the run/wave budgets, and `watchdog.planDrain` (drain/hard-kill on andon trip — now driven against genuinely concurrent in-flight workers). Only PLAIN PURE deterministic stations are POOLED as out-of-process workers; transform/agentic/fan-out/effectful/`enforce_owned_paths` stations stay in-process. **(v10)** Under `concurrency>1`, plain TRANSFORM siblings ready in one tick run as *overlapping in-process adapter calls* (the fan-out reviewer case) — per-call token attribution isolated via `AsyncLocalStorage`, K-bounded, with fan-out/effectful/gated/deliver/rank transforms excluded and still serial. An optional `child_stagger_seconds` on the fan-out station gates siblings behind `cards.release_at` so the first child warms a shared prompt-prefix cache before the rest fire.

**Built but NOT yet driven by `runExecutor`:** none of the kernel substrate remains library-only — the remaining unshipped work is the agentic Tool-Bridge (step 9) and kaizen (step 10), which are new surfaces rather than wired-vs-unwired modules.

When you pick up a later build-order step, prefer **wiring the existing library module into `runExecutor`** over re-implementing its logic inline — then point the integration/contract tests at the real executor path so the SPEC guarantee becomes one the shipping binary actually provides.

## Docs are an input, not a cleanup step

Parts of this repo are **normative**: SPEC.md does not describe what the kernel
happens to do, it states what the kernel must do. The Law (§7), the four rework
guards (§6), the binding stamp (§5), and the `(lane, status)` FSM (§3) are
specified behaviour, and `CLAUDE.md`'s wired-vs-library inventory is what steers
every agent session. Code that contradicts them is wrong even when its tests are
green — and prose left behind by a change quietly misleads the next agent.

[`drift`](https://github.com/fiberplane/drift) binds those documents to the
symbols they govern. `drift.lock` records, per binding, an AST fingerprint of
the target at the moment someone last vouched for the prose. It is a routing
table, not a correctness checker: it tells you *which paragraph to re-read*,
never that a paragraph is right.

Two obligations, at two different moments. They are separate on purpose — one is
an input to the work, the other is only answerable once the work has settled.

**Once, when you scope a task** — not per edit — name the files the task will
touch:

```bash
bun run docs:governing src/quality/rework.ts src/controller/gate-rework.ts
# -> SPEC.md
```

Anything it prints makes claims about the code you are about to change. **Read
those sections and implement against them.** Silence means nothing is bound and
there is nothing to read — the common case, and it costs nothing. Do not skip
this because a change looks small: issue #1 was a one-line cap comparison whose
correct behaviour was specified in SPEC §6.

Run it once per task, not once per edit. Editing a file five times does not make
SPEC §6 say anything new.

**At commit time** — enforced by `.githooks/pre-commit`, scoped to staged files:

```bash
bun run docs:check          # `drift check` — exits 1 on any stale anchor
```

The commit is the unit here because "is this prose still true?" cannot be
answered while the code is still moving; asking per-edit asks before the answer
exists, and invites rewriting a SPEC paragraph three times as one change
settles.

A stale anchor is an obligation, not an error. Re-read the section it names,
then either fix the prose or confirm it still holds:

```bash
drift link SPEC.md --doc-is-still-accurate
```

`drift link` **refuses** to re-stamp a stale anchor without that flag. Passing it
is an assertion that you re-read the doc. Do not pass it to make the hook or CI
pass — a `drift.lock` diff that re-signs anchors while changing no prose is
exactly what reviewers look for.

**When adding or renaming a governed symbol**, update the binding
(`drift link <doc> <file#Symbol>` / `drift unlink`) in the same change.

Bindings are deliberately **symbol-level** (`file#Symbol`), not file-level: a
binding to all of `src/controller/executor.ts` would flag on nearly every PR and
train everyone to re-stamp reflexively, which is worse than no binding. And the
binding set is deliberately small — `adr/`, `docs/archive/`, `docs/history/`,
`prd/`, `CHANGELOG.md` and the `examples/`+`fixtures/` prompt templates are
**never** bound. An ADR is a dated record of a decision and is *supposed* to
describe the world as it was; prompt templates are runtime inputs, not docs.

## Design principles to apply consistently

- **Deterministic flow, non-deterministic labor.** The kernel decides what's legal next; LLMs only produce and judge. No LLM in the steady-state dispatch loop.
- **Escalate ambiguity; never guess.** On contradictory/unrecoverable state → hard-pause to `hold`, surface to a human. Don't auto-reverse.
- **Config is validated, not trusted.** `flow.yaml` is checked at load (disjoint path ownership, legal transitions, acyclic deps) before anything runs.
- **The check is the quality engine.** The back-edge is the point; separate maker from inspector (different prompt, often different model).
- **Two andons, not one.** The consumption andon (wall-clock + tokens, busy runaway) and the liveness watchdog ("no progress + no active worker", deadlock/stall) are distinct and both necessary.

## Key mechanisms modeled on A(i)-Team

The kernel design is substantially proven — the same patterns run in production across three flows. See SPEC Appendix B for the full conceptual mapping. Key ones:
- Lane graph + transition matrix
- Deterministic tick / action plan (replaced a runaway LLM orchestration loop)
- Generation-keyed idempotent action IDs (fixes prefix-dedup blocking legitimate rework)
- Dependency waves + DFS cycle detection
- `needsJudgment` fail-closed escalation

## Maintainer-only: A(i)-Team Integration

> This is a private maintainer workflow. External contributors do not need the
> A(i)-Team plugin or any `/ai-team:*` commands; follow
> [`CONTRIBUTING.md`](./CONTRIBUTING.md) instead.

Maintainers use the A(i)-Team plugin for PRD-driven development.

### When to Use A(i)-Team

Use the A(i)-Team workflow when:
- Implementing features from a PRD document
- Working on multi-file changes that benefit from TDD
- Building features that need structured test → implement → review flow

### Commands

- `/ai-team:plan <prd-file>` - Decompose a PRD into tracked work items
- `/ai-team:run` - Execute the mission with parallel agents
- `/ai-team:status` - Check current progress
- `/ai-team:resume` - Resume an interrupted mission

### Workflow

1. Place your PRD in the `prd/` directory
2. Run `/ai-team:plan prd/your-feature.md`
3. Run `/ai-team:run` to execute

The A(i)-Team will:
- Break down the PRD into testable units
- Write tests first (TDD)
- Implement to pass tests
- Review each feature
- Probe for bugs
- Update documentation and commit

**Maintainers:** do not work on PRD features directly without using
`/ai-team:plan` first.
