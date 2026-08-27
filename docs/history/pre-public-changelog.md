# Pre-Public Development Changelog

> This archive preserves Conduit's development history from before the fresh
> public repository was created. These entries do not correspond to releases,
> commits, issues, or pull requests in the public repository. Legacy issue and
> pull-request numbers have been replaced with descriptive context; internal
> `WI-*` and mission identifiers are retained as historical implementation
> notes.
>
> Public release history starts in [the root changelog](../../CHANGELOG.md).

## [Unreleased] — Ingress: Ack On Accept

**The webhook now answers as soon as the event is accepted and its run is launched, instead of holding the HTTP response open for the entire run.** The production spawn seam resolved on `await proc.exited`, so `POST /webhook/<flow>` stayed pending until `conduit run` terminated — hours for a render. Observed 2026-08-05 on Autocut Inbox → Conduit Magi: the run launched and reported progress normally while the caller's fetch hit its 5-minute timeout and marked the job `failed`, push-notifying the user that an edit that was actually running had failed to start. Generic providers (GitHub, Stripe) time out after ~10–30s, so any provider-facing binding hit the same wall whenever a run slot was free. (When slots were full the path returned `queued` immediately — only the healthy case hung.)

### Fixed

- **Webhook responses no longer wait for the run to finish** (`src/ingress/adapters/webhook.ts`, `src/ingress/spawn.ts`, `src/cli/main.ts`): the spawn seam resolves on **launch** and reports the child's terminal state separately, through an optional `exited: Promise<{ code: number }>`. `runSpawnPath` marks the row, logs the outcome, and returns while the run executes; a non-zero exit gets the same FR-7 treatment (`markIngressFailed` + alert + `spawn_failed` log entry) asynchronously, and a clean exit leaves the row `spawned`. A synchronous `Bun.spawn` throw is still the existing launch-failure path.
- **Re-drive sweeps no longer run as long as the runs they recover** (`src/ingress/recovery.ts`): the respawn seam takes the same launch/exit split (`RedriveLaunch`), so boot re-drive stops blocking the listener from serving while a recovered render executes, and the periodic sweep is no longer serialized behind one long run. A re-driven child that exits non-zero marks its row failed asynchronously — the same end state the synchronous sweep reached — leaving it re-drivable within the cap.

### Changed

- **`spawn_state = 'spawned'` now means LAUNCHED**, not "ran to a clean exit". Consequence: a listener crash *mid-run* leaves the row `'spawned'`, so ingress re-drive no longer covers it — recovery from that point belongs to the run's own resume/journal machinery (`conduit resume --run <id>`), the only layer that knows how far the run got. This was already effectively true (a re-driven completed run deduplicates at the run layer); it is now explicit in the state. Documented in `docs/ingress-listener.md` and `docs/diagrams.md`.
- **Run slots are released at child exit, not at webhook return**, so `max_concurrent_runs` keeps meaning concurrent *runs*. The queued path (slots full → row stays `accepted` → the release-kicked sweep launches it) and every duplicate-suppression rule are unchanged.
- **Webhook response contract**: `202` with `{"outcome":"accepted"|"queued","run_id":"…"}` for work this delivery set in motion, `200` with `{"outcome":"duplicate"|"spawn_failed"}` otherwise. Every outcome stays 2xx as before — a provider retry adds nothing the bounded re-drive is not already doing — so callers checking only `response.ok` are unaffected, and callers can now distinguish "rejected" from "accepted and running".

## [Unreleased] — Per-Child Output Artifacts: `output_scope: owned_dir`

**Homogeneous fan-out children can now produce their own artifacts.** A transform station's declared outputs have always been written to `<projectRoot>/<name>` — a static name per station — so N fan-out children of one `child_entry` station clobbered a single shared file, making per-child output collection impossible (SPEC §9 intends outputs to be disjoint across concurrent cards). Motivated by the Nitpick review flow: 5 seed-parameterized reviewer children each need their own `findings.json`.

### Added

- **`output_scope: 'project_root' | 'owned_dir'`** on transform stations. Default `project_root` (historical behavior, unchanged). `owned_dir` writes each declared output into the card's `owned_paths[0]` directory — the same card-scoped location `seed.json` lives in — so each child produces its own artifacts. The traversal/symlink escape guard is rooted at the owned dir, and the `enforce_owned_paths` integrity gate checks the owned-dir-joined paths (the bare names would test project-root locations nothing wrote to). Fail-closed: validated at load (`INVALID_OUTPUT_SCOPE` — enum-valued, transform-only, requires declared outputs) and at write time (a scoped card whose `owned_paths[0]` is not an existing directory is a thrown config violation, same rule as the per-child seed).

## [Unreleased] — Black-Box Test Suite: Golden Journey + Fault Variants

**A second test tier that spawns the real shipped `conduit` binary — no `src/` imports — against a fake Slack Web API, fake Socket Mode, and a fake model gateway, so bugs that only exist where real processes, real SQLite files, and real HTTP meet are caught before production.** PRD: [`prd/done/black-box-testing.md`](../../prd/done/black-box-testing.md), slice 2 (slice 1 was the earlier CI test gate).

### Added

- **`blackbox/` suite scaffold**: `blackbox/harness/journey-harness.ts` boots a real `conduit listen` child (temp state/journal SQLite, temp workspace, a scaffolded flow) wired via env to a fake Slack Web API (3-step upload flow), a fake Socket Mode server, and a fake OpenAI-compatible model gateway; exposes fault knobs (`setStall`, `setDuplicateDelivery`, env-based timeouts) and public-surface assertions (`runConduit`, `explainField`, spawn observation) — see `blackbox/README.md` for the full guide and the standing rule that every production bug gets a fault variant here.
- **FR-1 golden journey** (`blackbox/golden-journey.test.ts`): signed Slack event → real `conduit run` → HITL rank ask → Socket Mode reply → real `conduit resume` → terminal `done`, asserted entirely through public surfaces. Required zero product changes.
- **Fault variants**: stalled Slack connections (`fault-stalled-slack.test.ts`, validates the existing fetch bound), duplicate event/interactive delivery (`fault-duplicate-delivery.test.ts`, validates the existing deduplication behavior), listener crash-restart mid-journey (`fault-crash-restart-hitl.test.ts`, validates outbox recovery), and a deterministic station exiting nonzero (`fault-station-nonzero.test.ts`) — the last of which found the WI-686 bug below.
- **Zero-internal-imports gate** (`blackbox/no-internal-imports.test.ts` + `blackbox/harness/import-scan.ts`): a TypeScript-compiler-API AST scan fails the suite if any file under `blackbox/` imports anything resolving into `src/`, with regression fixtures for three live-confirmed bypass classes a hand-rolled string/regex scan missed.
- **`SLACK_API_BASE_URL` env knob** (`resolveSlackApiBaseUrl` in `src/controller/executor.ts`): overrides the base host for every production Slack call — Web API and Socket Mode's `apps.connections.open` — normalized to a bare origin (no `/api` suffix; each call site appends exactly one). Invalid/non-http(s)/unset values fall back to `https://slack.com`. Wired into all 5 production Slack call sites. This is what lets the black-box harness point a real `conduit` child at its fake Slack server. Documented in `docs/slack-channel.md`'s egress env-knobs table.
- **Test-script scoping**: `bun run test` now runs `bun test src/` (was a bare `bun test`, which would silently fold `blackbox/` into every required-gate run); new `bun run test:blackbox` (`bun test blackbox/`) and `bun run typecheck:blackbox` (`tsc --noEmit -p blackbox/tsconfig.json`, a new scoped tsconfig) run the suite and its typecheck independently. `.github/workflows/blackbox.yml` runs both on every PR in a non-`tests`-named job, advisory-only for a ~2-week/~50-PR burn-in before a follow-up considers promoting it to a required check.

### Fixed

- **Sync-path deterministic station failure silently busy-looped forever** (WI-686, found via WI-681's black-box fault variant, a previously identified failure class): at the listener's default `concurrency=1` (the synchronous in-process executor path — the path the ingress listener actually runs), a pure deterministic station command exiting nonzero released its worker slot without routing through the FSM, so the tick planner re-dispatched the same card indefinitely — no scrap, no error, no output, nothing a human would see. The pooled (`concurrency>1`) path already handled this correctly via the MARK_DONE `scrap` outcome. Both paths now share `scrapCardDirect`, which routes to a single, named terminal scrap immediately (retry is futile — a deterministic command is a pure function of its inputs, so re-running it reproduces the identical failure). Regression tests at both the white-box executor layer (`src/controller/sync-deterministic-failure.test.ts`) and the black-box layer (`blackbox/fault-station-nonzero.test.ts`).

### Known Limitations ⚠️

- **Black-box suite is advisory-only during burn-in**: not yet a required CI check; see the burn-in-then-promote plan in `.github/workflows/blackbox.yml` and `blackbox/README.md`.
- **Seeded fault-variant backlog**: several known production failure classes do not have a fault variant yet; they are tracked in `blackbox/README.md`'s "Seeded backlog" section.
- **Known follow-up, not fixed**: a `registerRun()` TOCTOU race identified during this mission remains on the record for follow-up work.

## [Unreleased] — Per-List Tools Expressibility

### Added

- **`HarnessAdapter.canExpressTools(tools)`** (optional) + the `adapterCanExpressTools` helper: tools-allowlist expressibility is now judged per-list instead of per-adapter. Adapters whose containment surface is a capability lattice rather than a per-tool-name flag can host gate critics and tools-declaring makers for exactly the lists their envelopes match. `codex-exec` implements it via `planCodexSandbox`: read-ish lists → `-s read-only` (sandboxed exec is read-confined), write lists (Bash required, since workspace-write's shell can write) → `-s workspace-write`, web tools → `network_access=true`; unknown tool names and unmatched shapes stay `HARNESS_TOOLS_UNEXPRESSIBLE` at load and fail closed at invoke. The static `canRestrictTools` flag is unchanged (codex-exec stays `false`) so boolean-only callers remain fail-closed. Motivated by cross-model gating: a claude-headless research maker adversarially checked by a GPT-5.x codex-exec critic.
## [Unreleased] — Concurrent Transform Fan-Out + Cache-Warming Stagger

**Transform fan-out children now run in parallel, with an optional stagger that lets the first child warm a shared prompt-prefix cache before the rest fire.** Motivated by the Nitpick PR-review flow: N specialist reviewers over one diff, each a `transform` station sharing a byte-identical prompt prefix. Before this, `--concurrency K` only parallelized plain deterministic stations, so the reviewers ran one-at-a-time; now they overlap, cutting wall-clock from ~sum to ~max. Both behaviors are gated so default runs (`concurrency=1`, no stagger) are byte-for-byte unchanged.

### Added

- **Concurrent transform execution under `concurrency > 1`**: transform siblings that are all ready in one tick now run as overlapping in-process adapter calls instead of serially (`executor.ts`). Bounded by the run-level K ceiling and per-station `wip`, exactly like the deterministic worker pool. Per-call token attribution is isolated with `AsyncLocalStorage` so each concurrent call credits its spend to the right card across interleaved awaits (the shared `currentCardId` still serves the untouched serial path). Excludes fan-out/effectful/gated/deliver/rank transforms — those keep their serial semantics (proposal seeding, outbox, critic, delivery, HITL).
- **`child_stagger_seconds`** — a fan-out station knob (integer seconds ≥ 0): the first spawned child (lowest id) dispatches immediately while the remaining siblings are held behind `cards.release_at = now + child_stagger_seconds`, so the first child warms a shared prompt-prefix cache before the rest hit it. Validated fail-closed at load (`INVALID_CHILD_STAGGER_SECONDS`; a non-negative integer, only on a fan-out station). Absent or `0` = no stagger (all children dispatch together).
- **`cards.release_at`** (schema v9→v10): a nullable not-before dispatch gate (epoch seconds). `planTick` skips a ready card whose `release_at > now` — compared against the **injected** clock, so the gate is deterministic and crash/resume-safe (a resume re-derives the remaining wait from the persisted `release_at`). The main loop waits out the gate (via an injectable `sleep`, default `setTimeout`) instead of misreading a release-gated card as a stall. Additive migration; pre-v10 rows and non-staggered children have `release_at = NULL`.

## [Unreleased] — Harness Critic Timeout

### Added

- **`check.critic.timeout_seconds`**: configurable wall-clock bound for an agentic (harness) critic's invocation, mirroring the maker's `worker.timeout_seconds`. Absent keeps the 5-minute engine default; existing flows are unchanged. Validated fail-closed at load (integer >= 1, `INVALID_TIMEOUT_SECONDS`), and rejected on a harness-less critic (`CRITIC_TIMEOUT_REQUIRES_HARNESS`) — a model-based critic has no wall-clock surface, so a declared bound would otherwise be silently dropped. Motivated by a live kill: a critic re-reading long-form inputs (full podcast transcript + draft + prior findings) exceeded the default mid-verdict and fail-closed a healthy card to scrap (`harness-critic-invoke-failed`).

## [Unreleased] — Slack Egress File Delivery (Outbox-Guarded)

**First-class file delivery through Slack channels, guarded by the outbox exactly-once guarantee.**
A station's `deliver` block now uploads produced files to the triggering thread via Slack's external-upload sequence, with idempotency-keyed recovery and reconciliation on crash-resume. Text sends gain the same optional threading. PRD: [`prd/done/slack-file-egress.md`](../../prd/done/slack-file-egress.md).

### Added

- **Station-level `deliver` block** (WI-596): Stations declare one or more produced files to deliver upon successful completion, with optional caption (Slack `initial_comment`) and thread addressing (resolving a substrate field from the triggering event). Flow load rejects: zero files declared, no delivery-capable egress channel, or a delivery-only channel with no producer. Delivery is journaled per attempt and visible in `conduit explain`.
- **Slack file upload via external-upload sequence** (WI-597): `files.getUploadURLExternal` → raw byte POST → `files.completeUploadExternal`, with size validation (default 1 GiB, `SLACK_MAX_UPLOAD_BYTES` env override), connection timeouts, token redaction on all failure paths, and thread addressing (`thread_ts` for threaded delivery, optional). Upload URL acquisition and byte transfer are safely re-runnable; completion is the effectful edge.
- **Outbox-guarded file delivery** (WI-598): `egressSendFile` writes a pending intent before the completion call and commits it on success. On resume: committed intents are skipped, pending intents are reconciled, and ambiguous outcomes escalate to `hold`. Idempotency keys incorporate run/card/station/attempt/file-path/content-hash so rework attempts re-deliver while crash-retries of the same attempt do not.
- **Executor wiring for station delivery** (WI-599): `performStationDelivery` runs sequentially after station work completes, skipping on prefix-resume, checking owned-paths gate (same as integrity check), resolving thread address, and journaling delivery outcome. Delivers files in declared order; resume after partial delivery continues from the first undelivered file. Ambiguous delivery fails escalate to `hold` rather than re-running station work.
- **HITL text sends now support threading** (WI-600): Rank-selection prompts land as threaded replies on the triggering message when substrate carries `thread_ts`; unthreaded degrade (CLI trigger, or missing substrate field) is journaled as `threadResolution: 'not_available'` for explain visibility, never a delivery error.
- **File-egress reconciliation** (WI-602): `createFilesInfoReconciler` probes Slack's `files.list` (unthreaded) or `conversations.replies` (threaded) to verify whether a pending file delivery landed before a crash-resume. Match on basename+size: exactly-one match → `landed` (commit, skip); no match → `not_landed` (fire once); multiple matches or probe failure → `unknown` (fail-closed, escalate to hold). Narrows the hold-only window without removing the ambiguity-is-fail-closed invariant.
- **Documentation & ADRs** (WI-601): New `docs/slack-channel.md` section on file delivery; `SPEC.md` §4A extended to cover station-level delivery blocks, thread addressing, and the outbox workflow; [`ADR-0010`](../../adr/0010-thread-address-convention-for-egress-sends.md) records the thread-address resolution (conventional `thread_ts` field, resolved per run via run-level substrate, safe degradation on absence); [`ADR-0011`](../../adr/0011-file-egress-reconciliation.md) records the reconciliation strategy (probe-based narrowing with fail-closed ambiguity handling).
- **New Slack bot scope**: `files:write` required for file delivery (checked at channel load).

### Fixed

- **Token leak on delivery failures** (pre-review defect): Slack API errors embedding the bot token were being logged. Token is now redacted on all `egressSendFile` failure paths, matching text-send NFR-11 (and caught by the same redaction layer).
- **`deliver` block type validation** (pre-review defect): A `deliver` block without a `files` entry passed load validation and crashed at runtime. Now rejected at load with a clear error.
- **Empty-file guard** (pre-review defect): A station producing an empty file would fail upload. Now skipped at delivery time with a journal entry (empty files don't have a valid upload URL to acquire).
- **Size-limit production wiring** (pre-review defect): The `SLACK_MAX_UPLOAD_BYTES` environment variable was defined but not wired into the upload path. Now enforced with a load-time warning if unset (defaults to 1 GiB).
- **Reconciler landed-commit bug** (pre-review, ADR-0011 discovery): The file-reconciliation path returning `landed` was not committing the outbox row, so every resume re-probed Slack for an outcome already conclusively proven. Reconciler now commits on both `landed` and `fire` branches.
- **Pooled deliver stations silently skipped delivery** (final-review, Stockwell): Stations with `deliver` blocks were pool-eligible, so concurrent workers would claim them but skip delivery (only available in the single-threaded path). `poolEligible` now excludes deliver stations, forcing them into the synchronous executor path. Added regression test on the real pool path.
- **Cross-run idempotency collision silently skipped delivery** (PR review, HIGH): the delivery idempotency key used `flow.version` rather than the run, and `egressSendFile` did not scope its outbox rows by run — so two runs computing the same key (same card/station/attempt/bytes, which recurs because card ids repeat across runs) collided, the second silently skipping on the first's committed intent. The key now leads with `runId` and every outbox operation is run-scoped (the table's `UNIQUE (run_id, idempotency_key)` is now honored). Regression tests: distinct runs with the same key both deliver; a same-run resume still dedups.
- **Reconciler could guess `not_landed` on a paginated probe** (PR review, MEDIUM): `not_landed` — the one verdict that re-fires an upload — was returned on any zero-match, including a partial (paginated) `files.list` / `conversations.replies` result where the file could sit on a later page, risking a double-post. It now returns `not_landed` only when the probe is provably complete (`has_more:false` and empty `next_cursor`); an incomplete probe fails closed to `unknown` → hold.
- **`deliver.files` could escape the project root** (PR review, MEDIUM): a delivered file is read and shipped to an external service, but containment ran only under the opt-in `enforce_owned_paths` gate. Absolute and `..`-escaping literals are now rejected at load (`DELIVER_FILE_ESCAPES_ROOT`), and the executor unconditionally symlink-resolves each delivered path against the project root before reading it (a symlink under the root pointing outside now holds instead of exfiltrating). Regression tests at both layers.

### Changed

- **`uses: [delivery]` is now enforced** (WI-596): Channel resolution honors egress channels that declare `uses: [delivery]`, matching the existing `hitl` resolution; mirroring the first-channel fallback for configs declaring no `uses`.

### Known Limitations ⚠️

- **File reconciliation matches on basename+size only** (ADR-0011, intentional): Slack's upload endpoint exposes no content hash. A future enhancement (Alternative B) could download and verify on reconciliation, but costs a full download per attempt. Current design fails closed on ambiguous matches (multiple same-size files with the same name in the channel).
- **Truly-ambiguous window still needs human judgment**: The reconciler narrows (not eliminates) the hold-only window. A probe failure or multiple matches still escalates to `hold`, and this is a **permanent** property of the design unless Slack ships a content-hash-bearing API.

## [Unreleased] — Multi-Flow Engine: Ingress Run Identity, Per-Run Workspaces, Flow Composition

One daemon can now host N flows safely, and events can no longer be silently lost under concurrency. Fixes the full ingress event-loss chain and ships three multi-flow capabilities: engine-as-router, shared-process economics via the manifest, and flow-as-station composition. PRD: [`prd/drafts/multi-flow-engine.md`](../../prd/drafts/multi-flow-engine.md) (Resolved Decisions section records the v1 calls).

### Added

- **Per-event ingress run ids**: every ingress-spawned run gets `--run-id` derived from its event id (`ig-<stem>-<sha256-prefix>`, charset/length-safe, deterministic so re-drive resumes rather than forks). Concurrent events no longer collide on the default run and fail the per-run lease.
- **Attributed, faithful re-drive** (schema v9, additive migration): `ingress_events` persists flow attribution (`flow_id`, `flow_path`), the derived `run_id`, and the projected substrate JSON atomically with the accept. Re-drive relaunches the owning flow with its original payload — fixing the latent bug where a re-driven run got NO input — and multi-flow listeners no longer mark unattributable events permanently failed (only legacy pre-v9 rows keep that fallback).
- **Periodic re-drive sweep**: the bounded re-drive now also runs on an interval (default 60s, `CONDUIT_REDRIVE_INTERVAL_MS`) while the listener serves — a transiently-failed event recovers without a restart. Sweeps serialize; attempt caps unchanged.
- **Per-run filesystem workspaces**: `defaults.workspace: per_run` binds each run's effective project root to `<project_root>/.conduit/runs/<run-id>/` through the per-run `projectRoot` seam (seed staging, station io, owned_paths, integrity gate, harness confinement, resume recorded-root all follow). N concurrent runs of one flow are filesystem-disjoint by construction. Seeding now creates the seed's parent directory (a fresh workspace starts empty). An explicit `--project-root` override is caller-imposed and wins verbatim (no workspace nesting) — this is what lets a subflow parent invoke a child flow that declares `per_run` for its own standalone runs: the child runs exactly where the parent points it, so the parent's station contract can read its outputs.
- **Engine manifest**: `conduit listen --manifest <engine.yaml>` hosts N flows from an operator manifest (`flows:` name → path, optional `global_alert_channel`, paths resolve against the manifest dir). **Per-flow quarantine**: a flow failing load/validation/secret resolution is excluded and reported loudly while the rest serve; zero servable flows refuses to boot (`NO_SERVABLE_FLOWS`). `--validate` is the strict CI/deploy-time gate (boots fail-closed, exits without serving). `--flows` keeps its fail-closed behavior.
- **Slack channel collision detection** (`CHANNEL_COLLISION`, follow-up hardening): two flows claiming one channel is now a boot error in strict mode and quarantines every claimant in engine mode — the channel→flow map is the engine's router; last-wins would silently misroute a team's events. Pinned end-to-end: two flows behind one Slack app share ONE socket connection and each envelope reaches its channel-owning flow with its own run id.
- **Flow-as-station composition** (`kind: subflow`): a station may invoke another flow by path (`worker.flow`). Load-time transitive validation (`SUBFLOW_MISSING_FLOW`/`SUBFLOW_INVALID`/`SUBFLOW_CYCLE`/`SUBFLOW_DEPTH_EXCEEDED`, depth cap 3). Child runs as a `conduit run` subprocess (supervisor pattern, own lease + namespaced tables) in the parent's project root. Budget: child ceiling = parent's remaining budget (new `--budget-tokens` / `--budget-wall-clock-seconds` run flags, min()ed with the child's own declaration); child spend folds into the parent's run/wave budgets. Failure: child scrap/halt/error fails the attempt named; cap exhaustion scraps. Lineage: per-attempt `<station>.subflow` journal spans carry the child run id; new `db.getRunUsageTotals(runId)`.

### Known Limitations ⚠️

- **Child holds burn the parent attempt** (v1): a child run terminating `halted` (stall, or a hold outlasting the child process) is a named attempt failure on the calling station. Parent-context HITL surfacing waits on future resume-on-reply work.
- **`conduit explain` does not yet render the parent→child edge** — the lineage is journaled; the renderer edge is a follow-up.
- **Subflow siblings share the parent root**: concurrent subflow stations writing overlapping paths are not isolated from each other (the flow author keeps outputs disjoint, as with any two stations); per-child workspace nesting is a straightforward later extension of the seam.

## [Unreleased] — Harness Adapter Registration (Engine-Config Binding)

**Phase 1 exit criterion met**: Production adapter registry now ships populated via environment-config per-run binding. The `claude-headless` and `codex-exec` adapters are engine-config registered, introspectable via `doctor`, and self-serve E2E evidence driven through the research flow.

The harness precursor tier (step 9c, shipped in the prior cycle) deferred adapter registration because flows couldn't yet bind a per-run `projectRoot` to the adapters' environment allowlist and working-directory confinement. This cycle completes that binding: engine config (`CONDUIT_HARNESS_*` environment variables) seeding the adapter registry at run boot, two-phase resolution (late bind of `projectRoot` per invocation), operator visibility (`conduit doctor` adapter listing), and E2E evidence that real flows run end-to-end.

Kernel fixes ridden along: (1) `db.ts` cold-start race on `PRAGMA journal_mode = WAL` under concurrent `conduit run` processes (`withBusyRetry` gates only the bootstrap pragmas); (2) `gate.ts` critic tools-allowlist threading gap (agentic critic now works for all maker kinds, not just harness makers).

See [`docs/harness-adapter-registration.md`](../../docs/harness-adapter-registration.md) for the operator guide and [`prd/done/agentic-harness-worker.md §11`](../../prd/done/agentic-harness-worker.md#11-rollout--measurement) for the Phase 1 measurement framework.

### Added

- **Engine-config adapter registration** (WI-586, WI-587): Environment variables `CONDUIT_HARNESS_<NAME>_ENV` (required allowlist), `CONDUIT_HARNESS_<NAME>_COMMAND` (optional, harness path), and `CONDUIT_HARNESS_<NAME>_MODEL` (optional, default model) seed typed adapter config defs at boot. Collision detection on names; validation of required fields. Two-phase registry: `buildHarnessDefinitionRegistry(configDefs)` resolves identity/caps/probe with no `projectRoot`, then `bind(projectRoot)` at run boot and per-invocation stamps the root into the invocation contract. Old registry interface untouched; additive surface.
- **Per-run projectRoot binding and validation** (WI-588): `projectRoot` bound at `cmdRun`/`cmdResume`/`worker-entry` boot, threading through `TransformArgs`/`HarnessInvocation` to every adapter method. Adapter name resolution deferred until binding — unresolved names now logged as a diagnostics error (not a config-load crash). Unwired-registry paths get byte-identical behavior to before the mission.
- **Harness model precedence in binding stamp** (WI-589): Adapter's `_MODEL` env overrides station's declared model; effective model threads through `HarnessInvocation.model` and binds into the checkpoint stamp (fixing a latent empty-model journaling bug). Binding-stamp mismatch invalidates on resume.
- **Research flow demonstration** (WI-590): Committed `examples/research-flow.yaml`, example prompts, and flow-load test. Harness maker (draft) → adversarial harness critic (refine) → transform final-verdict stage. Bounded budget; objective criteria in critic prompt.
- **Concurrent project-root confinement tests** (WI-591): New `src/integration/harness-projectroot-binding.test.ts` acceptance tests: distinct `conduit run` processes with distinct roots in concurrent worktrees, child-process isolation verified, symlink-resolved paths contained. Surfaced and fixed `harness-runner.ts` missing-root named error; fixed `db.ts` cold-start `SQLITE_BUSY` race on WAL pragma (`withBusyRetry` gates only the bootstrap pragmas, allowing real concurrent writes).
- **`conduit doctor` adapter listing** (WI-592): New flow-independent subcommand listing configured adapter name/caps/probe status; flags HOME/PATH allowlist warnings (never credential-var warnings); flags relative `_COMMAND` paths. Wired `HarnessDefinitions` into `CliDeps`.
- **`conduit resume` projectRoot mismatch warning** (WI-593): If `--project-root` override differs from the recorded run root, stderr warning surfaces both paths so an operator doesn't silently re-run against a different tree.
- **Operator guide** (WI-594): New [`docs/harness-adapter-registration.md`](../../docs/harness-adapter-registration.md) — all CONDUIT_HARNESS_* variables, mapping to flow stations, Docker + bare-metal guidance, per-credential-mode minimums (subscription: HOME,PATH / API-key: +ANTHROPIC_API_KEY / Codex: assumed-verify), `doctor` walkthrough, and E2E evidence reproduction. Also fixed `main.ts` entrypoint raw-stack-trace-on-boot-failure (now clean `fatal:` line); new regression test `src/cli/main-entrypoint-fatal.test.ts`.
- **E2E evidence with real harnesses** (WI-595, Phase-1 exit criterion): Flag-gated E2E test (`CONDUIT_E2E_CLAUDE=1` + `claude` binary required) runs the research flow end-to-end through production wiring (4/4 real runs green post-fix). Surfaced and fixed `gate.ts` agentic-critic tools-allowlist threading bug (critic adapter name resolution now cascades through all maker kinds, not just harness makers); HARNESS_TOOLS_UNEXPRESSIBLE asymmetry (deliberately no waiver, commented in research-flow-load.test.ts).

### Changed

- **Engine-config seeding** (WI-586/587): Adapter registry boot path now reads environment config, builds typed defs, and validates collisions at `conduitd` boot or `conduit run/resume/worker` entry — not at flow load. Explicit adapter lookup remains in registry, but the registry is no longer empty.
- **`HarnessRegistry` now requires explicit binding** (WI-587): Calling adapter methods on an unbound registry throws named error "not bound" (fail-closed). Early call site uncover and fix.

### Known Limitations ⚠️

- **Agentic critic usage not journaled/budgeted**: `runHarnessGateCheck()` hardcodes `usage: {unknown: true}` to zero out critic tokens/cost (off the books). The maker path (WI-565/567) correctly computes and journals usage. Phase 2 FR-5 (agentic critic parity) will fold critic usage into budgets and journaling for the harness tier, matching the transform/deterministic critic behavior. Currently no impact on the quality system — critic rework bounds and per-card caps are enforced; only the measurement is deferred.

### Fixed (post-mission code review)

- **`db.ts` cold-start race** (WI-591): Concurrent `conduit run` processes both calling `bootstrap()` could contend on the bootstrap `PRAGMA busy_timeout` / `PRAGMA journal_mode = WAL` writes, causing transient `SQLITE_BUSY` failures on cold-start. Now wrapped in the shared `withBusyRetry` (busy-retry.ts) with a cold-start budget; only those bootstrap pragmas are gated, real writes use the established WAL mode directly. `withBusyRetry`'s busy detection was extended to also recognise the codeless "database is locked" throw shape bun:sqlite raises on a fresh connection's own bootstrap pragma. Regression test via harness-projectroot-binding acceptance test under concurrent invocation.
- **Agentic critic adapter resolution** (WI-595 discovery): `runGateCheckOrAdvance` accepted an optional harness registry but only threaded it for harness-maker completion paths; a transform or deterministic maker declaring `check.critic.harness` threw "no harness adapter registry configured" and silently escalated to `hold`. Registry now threaded through `TransformArgs`/`DeterministicArgs` into all four call sites. Regression test in harness-e2e-claude.test.ts.
- **Harness tools allowlist asymmetry documented** (WI-595 discovery): A flow can declare `unrestricted_tools: true` on a harness station (deliberate waiver, flagged by doctor), but critic harness adapter never gets the waiver — if a critic harness tries to use a tool outside its allowlist, it fails (no fallback). This is intentional (quality gates must be auditable), documented in research-flow-load.test.ts with a comment explaining why no waiver exists for critics.
- **Empty/omitted critic tools now fail closed** (RetroLearning row 16, operator-ruled): A harness gate critic (`check.critic.harness`) that declares no `criticTools` — or an explicitly empty list — is now a LOAD-TIME error (`HARNESS_CRITIC_TOOLS_REQUIRED`, naming the station + adapter) instead of silently running the critic with the adapter's default (unrestricted) tool set. The critic is the quality gate itself, so its verdict must be produced under known containment; the omission path is not allowed to grant what the already-ruled-out `unrestricted_tools` waiver forbids. Consequence (intentional): harness critics require a `canRestrictTools` adapter (e.g. `claude-headless`) — on `canRestrictTools:false` adapters (codex-exec) the declared tools already fail `HARNESS_TOOLS_UNEXPRESSIBLE`, so critics there are impossible by design. Runtime `config.tools ?? []` in gate.ts stays as defense-in-depth.

### Follow-ups (deferred, tracked)

- Delete the now-orphaned zero-arg `buildHarnessRegistry()` at `src/worker/harness-adapter.ts:154` and refresh stale comments at ~162/219 (Stockwell review note, deferred to next harness mission).
- **ADR-0010 candidate**: Additive two-phase registry pattern — `bind()` is additive (new bindings stack), the invoke-bearing resolve interface stays stable across bindings, snapshots never invalidate live calls. (Sosa's ADR candidate from planning; write in next cycle if still material.)

---

## [Unreleased] — Slack Socket Mode Ingress Transport

**Slack ingress without a public edge.** The Slack channel binding gains a `transport` field:
`events` (the default — the existing Events API webhook) or `socket` (Socket Mode — the listener
opens an *outbound* wss connection via `apps.connections.open` and Slack delivers the same event
envelopes over it). Built for self-hosted deployments with zero inbound reachability (the first
consumer runs the engine next to a tailnet-only VLM box). Slack's own positioning maps onto ours:
Events API for distributed/public apps, Socket Mode for internal/behind-firewall apps.

See [`docs/slack-channel.md` §2A](../../docs/slack-channel.md) for the transport design and
[`docs/ingress-listener.md`](../../docs/ingress-listener.md) for the operator surface.

### Added

- **`transport: socket` slack binding** (`src/ingress/binding.ts`): socket-transport bindings require
  `app_token_env` (the env var naming the app-level token, `xapp-…`, scope `connections:write`) and
  drop the `auth` requirement — the wss connection is the auth; request signing never runs on this
  transport. New fail-closed validation codes: `INVALID_TRANSPORT` (unknown value, transport on a
  non-slack binding, or `app_token_env` on the events transport) and `MISSING_APP_TOKEN`.
- **Socket Mode client** (`src/ingress/adapters/slack-socket.ts`): envelope ack (`envelope_id` echo)
  is sent BEFORE processing — the Socket Mode equivalent of the webhook's fast HTTP 2xx; unacked
  envelopes are redelivered and absorbed by the existing dedup ledger. Connection lifecycle:
  `disconnect(refresh_requested)` performs an overlap handoff (replacement opened before the old
  socket closes, stale-generation close events are no-ops); unexpected drops reconnect with
  1s-doubling backoff (30s cap), reset on a healthy `hello`; `disconnect(link_disabled)` is terminal
  — never retry-loop against a disabled app. `interactive` envelopes are acked but logged as
  unsupported (HITL Interactivity is not implemented on either transport yet).
- **Shared post-ack pipeline** (`processSlackPayload` extracted from
  `src/ingress/adapters/slack-events.ts`): both transports feed the identical
  parse → channel-resolve → derive-event-id → accept/spawn path; the transports differ only in
  delivery + ack.
- **Listener boot wiring** (`src/ingress/listener.ts`): socket flows resolve their app token at boot —
  fail-loud `MISSING_APP_TOKEN_SECRET` when the env var is unset (a socket client has no request to
  fail-close; it would retry-loop `invalid_auth` forever) and `SOCKET_SEAM_UNAVAILABLE` when the
  environment provides no Socket Mode I/O. Flows sharing one app token share one connection; routing
  stays per-channel via the same map the webhook path uses. `Listener` gains a `sockets` handle —
  clients are created at boot but started by the serving caller and stopped on shutdown.
- **Production seams** (`src/cli/main.ts`): real `apps.connections.open` over fetch + Bun-native
  WebSocket; socket lifecycle logged to the CLI; `conduit listen` starts socket clients alongside the
  HTTP server and closes them on SIGTERM/SIGINT. The missing-`CONDUIT_SLACK_SIGNING_SECRET` warning
  now fires only for events-transport slack bindings (socket bindings never verify signatures).

---

## [Unreleased] — Agentic Harness Worker (Step 9c Precursor Tier)

**Phase 1 of agentic surface: external headless agent harnesses** (`claude -p`, `codex-exec`) wrapped in
the transform contract. Delivers `kind: harness` station type — declared inputs/outputs, `check:` gates,
kernel bounds, per-attempt journaling, binding stamps, and checkpoint safety — without the Law-grade
per-tool-call containment of the full Tool-Bridge (step 9b). Precursor tier for flows needing tool-using
makers/critics today; `agentic` remains Law-grade-only per [SPEC §7](../../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface).

See [`prd/done/agentic-harness-worker.md`](../../prd/done/agentic-harness-worker.md) for the design,
[`docs/harness-containment.md`](../../docs/harness-containment.md) for the containment story, and
[`docs/build-order.md` §9c](../../docs/build-order.md#remaining-sequenced-build-out) for the
build-order rationale.

### Added

- **`kind: harness` station type** (WI-559): New station kind alongside `deterministic`, `transform`, and
  `agentic`. Stations declare an external-agent-CLI harness by name (engine-config resolved, not
  flow.yaml trusted), with declared inputs/outputs matching `transform` contract, and optional tools
  allowlist narrowing.
- **Harness adapter seam** (WI-560): `HarnessAdapter` interface defines the bounded invocation contract:
  `invoke(prompt, inputs, tools, timeout) → Promise<outputs[], usage-or-unknown>`. Static capability
  flags (`reportsUsage`, `canRestrictTools`) queryable without invoking. Binary presence/executability
  probe for load-time and doctor checks (NFR-Op-1 deterministic validation). Engine-config registry
  resolves named adapters; test-fake adapter (`makeFakeHarnessAdapter`) drives CI offline.
- **Harness process runner** (WI-561): Bounded subprocess spawn via `Bun.spawn` with wall-clock timeout,
  whole-process-group termination on expiry (SIGKILL to negative pid, not single-child kill), and
  confined working directory inside `project_root` (blast-radius floor, NFR-Security-6).
- **Harness child-env allowlist** (WI-562): Secrets-by-allowlist-only containment (NFR-Security-2).
  Child process receives only explicitly allowlisted environment variables from engine config, never
  wholesale inheritance of kernel `process.env`. Unset allowlisted names omitted, never empty-string
  injected.
- **Load-time harness validation** (WI-563): Flow load fails closed on unknown adapter, missing prompt
  file/version, malformed output_schema, or tools-allowlist unexpressible by the adapter
  (UNKNOWN_HARNESS_ADAPTER, HARNESS_TOOLS_UNEXPRESSIBLE, HARNESS_BINARY_NOT_FOUND, plus reused
  MISSING_PROMPT_TEMPLATE/VERSION/OUTPUT_SCHEMA family). `unrestricted_tools: true` waiver honored
  and recorded for explain/doctor to flag. Binary presence failure (FR-10) at load/startup, not first
  dispatch — async `probeHarnessBinaries()` runs separately from sync flow load.
- **`claude-headless` harness adapter** (WI-564): First shipping real adapter wrapping `claude -p`.
  Builds invocation from engine config, spawns via bounded runner with env allowlist (WI-561/562),
  parses structured JSON usage (tokens sum, cost from `total_cost_usd`), never scraped from free-text.
  Translates declared tools allowlist to claude's `--allowed-tools` flag. Fail-closed on malformed
  payload — including `usage: null`, a non-object usage value, or an array — never a silent
  zero-usage "success" (an early version of the guard let two of those three shapes through silently;
  closed before ship).
- **Harness execution path** (WI-565, the keystone item): Executor dispatch for `kind: harness`
  stations mirroring the `transform` path: renders declared inputs and `{{feedback}}` on rework,
  invokes the resolved adapter, collects declared outputs from disk and validates them via coercive
  parsing (a parse miss is a hard non-advance, never a silent advance), and populates the checkpoint
  binding-stamp inputs with adapter identity so resume is sound. Six or more downstream items build on
  this dispatch path.
- **Harness attempt caps and named failure states** (WI-566): Non-zero exit, timeout, unparseable
  output, and missing declared output each map to a distinct named failure outcome and count against
  `max_execution_attempts`; on exhaustion the card scraps with a reason naming which failure class
  exhausted it — never a silent advance.
- **Harness journaling and budgets** (WI-567): Per-attempt journal rows (success and failure alike)
  carrying adapter identity, model, wall-clock duration, artifact hashes, and usage; usage folds into
  the card/wave/run budget accumulators the consumption andon reads. A harness that reports no usage
  is journaled as explicitly *unknown*, never zero. Also closed a false-positive liveness-watchdog
  stall found during review: a multi-minute harness attempt wasn't refreshing the adapter-activity
  marker, so a long call could trip the watchdog on the very next tick and strand an already-ready
  downstream card (a previously observed liveness bug class — fixed by stamping activity at both invoke() settle points).
- **Mandatory owned-paths integrity gate** (WI-568): Unlike the opt-in `enforce_owned_paths` flag on
  `transform` stations, the integrity gate is unconditional for `kind: harness`. A breach hard-pauses
  the card to `hold`, naming the offending path, before the checkpoint is written. Originally shipped
  checking only the station's *declared* outputs against `owned_paths` — review found this let a
  harness write any *undeclared* file outside `owned_paths` completely undetected, defeating the
  gate's own purpose for a kind whose underlying CLI has raw filesystem access independent of its
  declared output. Fixed with a whole-tree snapshot/diff (mirroring the existing effectful-deterministic
  path's `snapshotTree`/`diffTouched`), including a symlink-dirent fix in the shared snapshot helper
  that had been silently skipping symlinked files.
- **Liveness integration for in-flight harness attempts** (WI-569): Verified that a `kind: harness`
  station — always dispatched synchronously in-process, never pool-eligible — never leaves a window
  where `checkLiveness` can evaluate mid-attempt; combined with WI-567's activity-stamping fix, a
  long-running attempt is never mistaken for a stall while remaining fully subject to its own timeout
  and the consumption andon.
- **Harness stations compose with `check:` gates in both roles** (WI-570): A harness maker behind a
  critic gate reworks with `{{feedback}}` threaded, producing journaled `gate_verdict` rows; a harness
  station can also act as the critic evaluating any maker's output. Composes with the existing
  `runGateCheckOrAdvance` path rather than forking it. Review found and fixed two real bugs along the
  way: an unresolvable critic-adapter name crashed the entire run and left the card's claim stuck
  (now escalates to `hold` cleanly), and a stale `verdict.json` left over from a prior check could be
  silently read as the current attempt's verdict — a real quality-gate bypass — now cleared before
  every critic invocation.
- **Effectful harness stations use the outbox + idempotency discipline** (WI-571, the last
  `executor.ts` harness item): An effectful harness attempt writes a pending intent before firing and
  commits it after success; on resume a committed intent is skipped (no re-fire), an un-fired intent
  may fire once, and an indeterminate outcome escalates to `hold` rather than blind-retrying. A pure
  harness station's incomplete attempt is unaffected, re-running bounded by the usual checkpoint rules.
- **Binding-stamp extension for harness identity** (WI-572): `computeBindingStamp` incorporates the
  harness adapter name alongside model id and prompt-template version (binary version deliberately
  excluded — upgrading the installed harness never invalidates a checkpoint). A changed adapter name
  invalidates and cascades; an unchanged one skips re-invocation on resume without re-billing.
- **`conduit explain`/`doctor` render harness stations** (WI-573): `explain` shows a harness station's
  adapter identity, tools allowlist, attached gate, an `unrestricted_tools` waiver warning, and a
  usage-blind indicator; `doctor` probes the configured binary and reports present/invocable vs.
  missing/non-executable, naming the adapter and the probed path.
- **Second harness adapter proving config-only swap** (WI-574): A `codex-exec` adapter (no per-tool
  allowlist, so it always carries the `unrestricted_tools` waiver) proves a flow can swap harnesses by
  changing only the configured adapter name. Review caught that the adapter's own recorded test
  fixtures fabricated a `total_cost_usd` field the real Codex `turn.completed` event never emits
  (verified against the official API docs) — every real invocation would have discarded genuine token
  counts as "unknown". Fixed to match the real schema: token counts extracted, cost defaults to 0 when
  absent, nothing silently discarded.
- **Harness containment profile documentation** (WI-575): New `docs/harness-containment.md` states the
  weaker-than-Law containment profile plainly — mandatory owned-paths integrity, env allowlist,
  process-group termination, the ADR-0003 container as the blast-radius wall, and full network egress
  in v1 stated in exactly those words. A short SPEC §7 note names the harness tier; `docs/build-order.md`
  names both the harness precursor tier (9c) and the Tool-Bridge Law-grade tier (9b).
- **Wired harness load-time validation into every real entry point** (WI-576): WI-563's fail-closed
  load-time validation only ran when `loadFlow()` was called with an explicit adapter registry — an
  optional parameter no real call site passed. A malformed `kind: harness` station (unknown adapter,
  unexpressible tools without the waiver) would pass load-time validation entirely and only surface at
  runtime, or not at all — directly undermining FR-10 and NFR-Security-3. Threaded the registry into
  all seven real call sites: `cmdRun`, `cmdResume`, `cmdExplain`, `cmdDoctor`, `cmdBuild` (CLI), the
  worker-pool entry point, and the ingress listener's boot path.
- **ADR-0008 & ADR-0009**: Design decisions for adapter capability introspection (static flags vs.
  per-call probes, avoiding premature `canX()` combinatorial explosion) and per-concern decomposition on
  a shared implementation file (`executor.ts`) even at the cost of a deeper dependency-wave graph.

### Changed

- **`SPEC.md` §4 updated**: Station taxonomy now documents `kind: harness` as the agentic precursor tier
  alongside `deterministic`, `transform`, and the Law-grade `agentic`. Containment claim is weaker than
  `agentic` (process-group kill, cwd confinement, env allowlist; no symlink-resolved path ownership or
  Bash/tool pre-execution gating). Prompts, output schemas, declared inputs/outputs, check gates, and
  rework bounds are shared with `transform` stations.
- **`flow.yaml` schema**: New optional fields on stations: `worker.harness` (adapter name string),
  `worker.tools` (string[] allowlist), `worker.unrestricted_tools` (boolean waiver). Model/prompt
  fields reused (no duplication).

### Known Limitations ⚠️

- **Agentic critic usage not journaled/budgeted**: `runHarnessGateCheck()` hardcodes `usage: {unknown: true}` to zero out critic tokens/cost (off the books). The maker path (WI-565/567) correctly computes and journals usage. Phase 2 FR-5 (agentic critic parity) will fold critic usage into budgets and journaling for the harness tier, matching the transform/deterministic critic behavior. Currently no impact on the quality system — critic rework bounds and per-card caps are enforced; only the measurement is deferred.
### Fixed (post-branch code review)

A second review round over the full branch diff surfaced one wiring gap and several fail-closed
inconsistencies; all fixed with regression tests:

- **Agentic critic now works for every maker kind** (review #1): `runGateCheckOrAdvance` accepted an
  optional harness registry, but only the harness-maker completion path passed it — a `transform` or
  `deterministic` maker declaring a `check.critic.harness` threw "no harness adapter registry
  configured" inside the gate and silently escalated the card to `hold`. The registry is now threaded
  through `TransformArgs`/`DeterministicArgs` into all four `runGateCheckOrAdvance` call sites;
  regression tests cover transform-maker and deterministic-maker flows gated by a harness critic.
- **`escalateToHold` releases the card's WIP slot** (review #2): a held card left its `active_workers`
  row behind (reconcile only reclaims `status='working'`), permanently consuming a WIP slot — at
  `wip: 1` a sibling card could never claim the station, and the stale row suppressed the liveness
  watchdog so the run hung until the wall-clock andon. The slot is now deleted in the same transaction
  that freezes the card. Pre-existing pattern, but materially widened by the harness tier's new hold
  paths (mandatory integrity gate, adapter-unresolved, effectful-reconcile).
- **Harness load validation no longer gated on `next`** (review #3): the WI-563 adapter/tools checks
  lived inside the `next !== undefined` loop, so a harness station without `next` skipped fail-closed
  load validation and instead escalated to `hold` at first dispatch. The checks now run unconditionally
  per station (mirroring the image_inputs validation).
- **codex adapter `--` option terminator** (review #4): the codex adapter passed the rendered prompt
  without the `--` terminator the claude adapter already used, so an LLM-authored prompt beginning with
  `-` would be misparsed by `codex exec` as a flag, failing every attempt to scrap.
- **`kind: harness` stations must declare an outputs entry** (review #5, new `HARNESS_MISSING_OUTPUTS`
  load error): the executor reads the maker's typed payload from `outputs[0]`; with none declared every
  attempt scrapped under a misleading `harness-output-unparseable … (none declared)` runtime reason.
  Now rejected at load, registry present or not.
- **codex usage summed across turns, reasoning tokens counted** (review #6): only the final
  `turn.completed` event's usage was kept and `reasoning_output_tokens` (billed output) was ignored —
  a multi-turn session undercounted the spend feeding the run/wave budgets and consumption andon.
  Usage is now accumulated across every per-turn `turn.completed` event, reasoning tokens included;
  a stream with no parseable usage still journals explicitly *unknown*.
- **`BindingStampInputs.adapterName` is now load-bearing** (review #7): WI-572's dedicated stamp field
  was dead code — the harness call site folded adapter identity into `modelId` via string
  concatenation instead. The call site now passes `modelId` and `adapterName` as separate fields, so
  `modelId` stays semantically the model id and the WI-572 mechanism carries adapter identity.

### Documentation

- **`docs/harness-containment.md`**: New document detailing the containment story for the precursor tier:
  process-group termination (blast-radius floor), environment allowlist (secrets-by-allowlist-only),
  cwd confinement inside `project_root`, and absence of symlink-resolved path ownership or per-tool-call
  pre-execution gating (those are Law-grade agentic-only, step 9b). Contrasts with full Tool-Bridge
  containment profile. See [the Tool-Bridge security model](../../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface).
- **`docs/build-order.md` updated**: §9c formally records the harness precursor tier as a sequenced
  step (now shipped) distinct from 9b (the Law-grade Tool-Bridge, still in `prd/drafts/`).

### Test Coverage

- **18 work items (WI-559 through WI-576), 2066 test suite passing** (1 pre-existing skip, 0
  failures; count includes the post-branch review-fix regression tests). Comprehensive test harnesses for: kernel types (WI-559), harness-adapter interface +
  test-fake (WI-560), process runner with process-group reap + timeout-boundary race regression tests
  (WI-561), env-allowlist isolation (WI-562), load-time validation (WI-563), claude-headless
  invocation/parsing/tools including the usage-guard fix (WI-564), executor dispatch/output-validation/
  binding-stamp wiring (WI-565), attempt-cap/named-failure-state coverage (WI-566), journaling/budget
  attribution + the liveness false-stall regression (WI-567), the mandatory integrity gate including
  the undeclared-write and symlink-dirent fixes (WI-568), liveness-integration proof (WI-569), gate
  composition including the critic-crash and stale-verdict regressions (WI-570), effectful outbox
  discipline (WI-571), binding-stamp extension (WI-572), explain/doctor rendering (WI-573), the
  codex-exec adapter including the real-schema fixture fix (WI-574), and the registry-wiring
  regression test across all seven real `loadFlow()` call sites (WI-576). WI-575 (containment-profile
  docs) is `NO_TEST_NEEDED`.

---

## [Unreleased] — Single-Host Run Safety

This cycle closes the launch-readiness run-lock gap (PLR §2.5): a per-run advisory lease
prevents two processes from driving the same run id, and a bounded `SQLITE_BUSY` retry absorbs
sustained write contention between distinct concurrent runs sharing one state DB. See
[`docs/single-host-concurrency.md`](../../docs/single-host-concurrency.md) for the full story of
what's supported, what's prevented, and what an integrator dispatching `conduit run`/`resume`
processes still owns.

### Added

- **Per-run advisory lease**: `conduit run`/`resume` now acquire an advisory lease on
  their run id (new `holder_pid`/`lease_acquired_at` columns on the `runs` table, schema
  v7→v8) before driving the engine, and release it on exit. A second process invoked against
  the **same** run id fails fast — exit code 1, with a clear message naming the run id and the
  holding pid — instead of racing the first process against shared run state. A stale lease
  left by a dead pid is reclaimed automatically via pid-liveness, so a crashed holder doesn't
  permanently wedge the run. This is single-host advisory locking only; pid-reuse is a
  documented limitation (see the doc's non-goals section for the multi-host and
  container-pid-namespace caveats).
- **Bounded `SQLITE_BUSY` retry on the atomic claim**: `src/dispatch/claim.ts`'s
  write transactions are now wrapped in `withBusyRetry` — roughly 5 attempts with exponential
  backoff and jitter (~50ms up to a 1s cap) — layered on top of the existing WAL mode and
  `PRAGMA busy_timeout=5000`. Sustained write contention between concurrent runs on a shared
  DB now waits it out instead of surfacing a raw `SQLITE_BUSY` failure.

### Documentation

- **`docs/single-host-concurrency.md`**: New doc covering the supported single-host
  concurrency story — distinct run ids on one shared DB (safe, schema-v6+ multi-run model),
  the same run id from two processes (prevented, advisory lease), what the integrator still
  owns (process fan-out/bounding, backpressure, distinct entry-input paths per concurrently
  seeded run), and explicit non-goals (multi-host / `conduitd`, containers with separate pid
  namespaces sharing one volume-mounted DB).
- **`docs/launch-readiness.md`**: Item 11 (run-lock) marked done, pointing at the new doc.

---

## [Unreleased] — Silent-Failure Cluster (Fail-Closed Seeding, Mandatory Outputs, Gated Determinism, Watchdog Fix)

This cycle closes four independent paths where the kernel advanced a run past a real problem without a trace in the journal: `conduit run --input` could silently overwrite a pre-staged entry artifact, a `kind: deterministic` station could drop a declared output and let the flow proceed as if it had succeeded, a `check:` gate attached to a deterministic station was validated at load time but never actually invoked at runtime, and the liveness watchdog could misfire mid-run on a long synchronous model call. All four are fail-closed fixes: the new behavior is to stop and surface the problem (hard-pause to `hold`, reject the CLI invocation, or journal the gate verdict) rather than to guess and continue.

### Fixed

- **`conduit run --input`/`--input-inline` no longer silently overwrites a pre-staged entry input**: Seeding now fails closed — if the entry station's declared input already exists on disk, is non-empty, and differs from the seed content, the run refuses with a clear remediation message before any card is inserted. Missing/empty targets seed as before, and a byte-identical target is treated as an idempotent no-op re-run.
- **Deterministic stations no longer silently drop declared outputs**: Every `outputs:` entry declared on a `kind: deterministic` station is now mandatory-on-disk after the station completes. A single-declared-output station whose command exits 0 and writes only to stdout now has that stdout persisted as the artifact (never clobbering a file the command wrote itself). Any output still missing after that hard-pauses the card to `hold` with reason `deterministic-output-missing: <name>`, instead of advancing the flow as if the station had succeeded.
- **`check:` gates on deterministic stations now actually run**: A `check:` gate attached to a `kind: deterministic` station validated at load time and rendered in `conduit explain`, but at runtime the critic was never invoked — the deterministic completion path routed straight to `INTEGRITY_PASS` with no `gate_verdict` row in the journal. All three deterministic completion paths (effectful skip-on-resume, effectful fire-success, pure success) now route through the same gated path as transform stations: pass/reject is journaled, and the `on_reject` back-edge and all four rework guards apply. `poolEligible` also now excludes gate-checked stations, closing a second silent-skip path where the concurrency pool's plain MARK_DONE handler could advance a gated deterministic station under `--concurrency K>1` without running the gate at all.
- **Liveness watchdog no longer trips on long synchronous model calls**: The watchdog measured no-progress from the last lane-change timestamp alone; a tick that synchronously awaited a multi-minute draft + critic call could leave that timestamp stale enough to exceed `no_progress_minutes` on a run that was continuously busy. `checkLiveness` now measures no-progress from `max(last lane change, last adapter activity)`, stamped fresh each time a transform/gate-critic/rank model call resolves. A genuine stall (no lane change, no adapter activity, no active workers) still trips exactly as before; the consumption andon is unaffected.

### Changed

- **Breaking: re-seeding an entry input over a shared `project_root` now requires distinct content or a per-run root**: Flows that launch multiple runs against one shared `project_root` and re-seed the same entry-input path with different content each time must move to per-run project roots (e.g. via `--project-root`), or explicitly clear the stale entry artifact between runs. Byte-identical re-seeding remains an idempotent no-op and needs no migration.
- **Breaking: a declared deterministic `outputs:` entry is now unconditionally mandatory**: There is no "optional output" notion. A station that only sometimes writes a declared output must stop declaring it, or change its command to always write it — otherwise the card now hard-pauses to `hold` instead of the flow silently continuing past the gap.

---

## [Unreleased] — Skill Library Ingest (Phase 1: Local Skills, Worker Composition)

This cycle delivers **skill-bundle parsing**, **local skill resolution** with path-safety, **`worker.uses:` composition** into deterministic prompt-override injection, a **64 KiB per-station skill-content cap**, and **skill-aware checkpoint binding stamps** so skill edits invalidate and cascade downstream on resume. The foundation for reusable, checksummed Claude Code skills in Conduit flows.

### Added

- **SKILL.md bundle parser** (WI-552): New `src/skills/parse.ts` parses the zero-dialect SKILL.md format (frontmatter name/description, body, optional `references/` inline files). Robust error recovery; adversarial fuzzing found and fixed a prefix-matching parser bug.
- **Local skill resolver with path-safety** (WI-553): New `src/skills/resolve.ts` resolves skill names to `skills/<name>/SKILL.md` bundles, with symlink-boundary validation (rejects `../../escape` paths) and comprehensive logging. Resolver cache minimizes re-reads.
- **Execution-surface warning detector** (WI-554): New `src/skills/detect-surface.ts` scans skill content for tool-like syntax and LLM-specific constructs; flags skills with execution surface and logs warnings at load time.
- **Worker.uses composition** (WI-555): Stations may now declare `worker.uses: [skill_1, skill_2, ...]` to inject resolved skill content into the prompt. Composition rule: injected skills in order, then the station's local prompt as the final override layer. Injected content is eager-concatenated into `StationConfig.prompt_content` at load time (station-time binding).
- **Injected skill-content cap** (WI-556): Per-station aggregate cap on total injected skill content (bodies + references), measured in UTF-8 bytes. Default 64 KiB, overridable via `defaults.skill_content_max_bytes`. Guard detects overflow at load time with per-skill byte breakdown in error message.
- **Skill-aware checkpoint binding stamps** (WI-557): Stations with `worker.uses` embed SHA-256 hashes of each injected skill's content (in declared order) into the checkpoint binding stamp via `computeSkillAwarePromptTemplateVersion`. Editing a skill body or references/ file invalidates the station's checkpoint on resume and cascades downstream (binding-stamp mismatch invalidation). Non-uses stations unaffected; the stamp input remains the bare `prompt_version`.
- **Fixture corpus** (WI-551): Checked-in test fixtures under `fixtures/skills/` including a vendored real-world skill (`find-skills`, from vercel-labs/skills), zero-dialect examples, path-escape safety tests, and a large-reference corpus.
- **Load-time skill validation** (FR-2, FR-8): `worker.uses` restrictions — no uses on deterministic stations (no prompt to inject into), duplicate uses detection, unresolved skills escalate to hard errors, skill-injected content is scanned for undeclared prompt placeholders (`{{...}}`), and composition errors surface with human-readable context.

### Changed

- **StationConfig type** (WI-555/557): New fields `prompt_content` (composed instruction) and `skill_content_hashes` (per-skill SHA-256 digests) added. Prompt-render path prefers `prompt_content` over raw `prompt_file` when present.
- **CheckpointKey binding stamps** (WI-557): Transform stations with `skill_content_hashes` use `computeSkillAwarePromptTemplateVersion` to fold skill hashes into `promptTemplateVersion` input. Skill-free stations use the bare `prompt_version` (backward compatible).
- **PRD promoted to production** (WI-558): Phase 1 spec split and promoted from draft to `prd/done/skill-library-ingest.md`; captures design decisions (composition, references/ eager-concat, size cap, stamp combination). Parent spec (`prd/drafts/skill-library.md`) updated with Phase 1 follow-up notes; Phases 2–4 (audit, sources/lockfile, skill-eval integration, agentic tier) remain open.

### Fixed

- **Parser prefix-matching bug** (WI-552): Adversarial probe (invalid YAML in references/) exposed a parser grepping for `---` line prefix that could match mid-content (e.g., `-` in a line like `- item` matching a dash-dash-dash). Fixed by strict line-boundary check.
- **Path-traversal symlink vulnerability** (WI-553): Resolver now resolves all paths to canonical form and verifies symlinks do not cross the `skills/` boundary. Adversarial probe created `references/` symlinks pointing to `../../` and confirmed rejection.

### Acceptance Criteria

- ✅ Parse SKILL.md bundles with robust error recovery (unit tested, fuzzing coverage)
- ✅ Resolve local skills from `skills/` directories with path-safety (symlink-boundary validation)
- ✅ Detect and warn execution surface (LLM constructs, tool syntax) at load time
- ✅ Compose `worker.uses` into prompt_content (skills + local prompt, in order)
- ✅ Enforce 64 KiB per-station skill-content cap with clear error messages
- ✅ Bind skill-content hashes into checkpoint stamps (invalidate on skill edit)
- ✅ Load-time validation: no uses on deterministic stations, duplicates rejected, unresolved skills block load
- ✅ Skill-injected content scanned for undeclared template placeholders (fail-closed)
- ✅ Full test suite green (1818 tests) with zero-dialect and determinism NFRs verified against compat corpus

### Technical Details

- **Build order**: Skill ingest (Phase 1) is independent and pre-MVP; Phases 2–4 (audit, sources, skill-eval, agentic) build on Phase 1's composition/stamp foundation.
- **Zero-dialect guarantee**: The parser/loader accept only the zero-dialect SKILL.md format (name/description/body/references); no execution-surface features (TemplateScript, imports, tools) are supported. Detected execution surface surfaces warnings; flows remain data-only.
- **Determinism**: All composition and stamp generation is deterministic; skills are idempotent content, not code. Replay safety via binding-stamp invalidation.
- **Backward compatibility**: Flows without `worker.uses` are unaffected; the executor, schema, and stamp logic remain backward compatible.

### Migration Notes

Skill ingest is a new, additive feature. Existing flows continue to work unchanged. To use reusable skills:

1. Place a SKILL.md bundle in `skills/<name>/` (relative to `flow.yaml`)
2. Declare `worker.uses: [skill_name]` on any transform/agentic model station
3. Run `conduit run <flow.yaml>` — skills are composed at load time into the station's prompt

Skills are read-only, checksummed, and locked by the binding stamp; editing a skill body invalidates on resume and cascades to dependent stations.

---

## [Unreleased] — Run Namespacing (Multi-Run Shared-DB Support)

This cycle delivers **schema v6** with `run_id` scoping on all per-run tables, a **run registry** for idempotent run registration with fingerprint-based conflict detection, and **executor/dispatch/journal/gate-rework scoping** to isolate concurrent runs sharing a single SQLite database. Multiple `conduit run --run-id <id>` jobs now operate safely without cross-contamination.

### Added

- **Schema v6 migration** (WI-474): All per-run tables (`cards`, `station_outputs`, `outbox`, `active_workers`, `journal`, `card_log`) gain a `run_id TEXT NOT NULL` column. Composite primary keys on `cards (run_id, id)` and `active_workers (run_id, card_id, station)` via table-recreate migration. New `runs` table persists run registry. Legacy single-run databases auto-adopt `DEFAULT_RUN_ID = 'default'` with zero data loss (v5→v6 migration runs idempotently).
- **Run registry with idempotent registration** (WI-476): New `src/run/` module with `validateRunId` (1–128 chars, `[A-Za-z0-9_-]`), `registerRun` (idempotent, fingerprint-keyed for conflict detection), and `getRun`/`getRunState` accessors. Fingerprint computed from resolved project path prevents duplicate run registration under the same `run_id`.
- **Executor run scoping** (WI-477): All ~25–30 aggregate/sweep queries in `runExecutor` scoped by `run_id`, including `reconcile()`, promote, dispatch, liveness watchdog, and wave budget checks. Each run is a partition; concurrent runs do not interfere.
- **Atomic claim scoping** (WI-478): All three Guards in `atomicClaim` (`slot_occupied`, `card status`, `WIP cap`) scoped by `run_id`. `beginWork` and `renewLease` operations are per-run. A card in run A does not block a dispatch in run B even if both card IDs match.
- **Journal and HITL scoping** (WI-479): `appendJournalSpan` stamps `run_id` on every entry. New `getJournalSpansForRun` reads journal entries for a specific run only. `readHeldAt`, `getRecordedHitlSelection`, and gate-rework Guard #3 (progress monotonicity) scoped to the active run, preventing one run's HITL state from polluting another's.
- **CLI --run-id flag and run seeding** (WI-481): `conduit run --run-id <id>` validates, registers, and seeds per-run entry card. Conflict detection rejects duplicate submission of the same run. Existing/errored runs surface clear messages. `conduit status` and `conduit result` are run-scoped.
- **Checkpoint run field** (WI-480): `CheckpointKey` and `OutboxIntent` gain optional `run` field for future per-run checkpoint isolation (forward-compatible, not yet enforced).
- **Run-namespacing acceptance test** (WI-485): Adversarial test (`src/test/run-namespacing-acceptance.test.ts`) proves isolation across two concurrent runs with identical card IDs: `card_log`, `journal`, HITL `held_at`, and `gate_verdict` entries do not cross-contaminate. Zero leaks under stress.

### Changed

- **Card.run_id now required** (WI-474): All cards inserted carry `run_id` (thread from context); getCard returns it round-trip.
- **Fan-out child inheritance** (WI-483): Child cards inherit `run_id` from parent, ensuring multi-generational family trees stay scoped to one run.
- **Acceptance test count** (WI-485): 6 new concurrent-run tests, all passing.

### Fixed

- **Run registry conflicts deterministic** (WI-476): Fingerprint collision detection prevents silent overwrite when the same `--run-id` is submitted twice with different project paths.

### Technical Details

- **Build order**: Run namespacing is foundational; agentic surface (step 9) and kaizen (step 10) depend on clean run isolation.
- **Backward compatibility**: Legacy v5 databases auto-adopt `DEFAULT_RUN_ID` on first load; no manual migration needed.
- **Scoping boundaries**: `run_id` partitions all per-run state (cards, workers, journal, HITL); per-flow state (flow definition, flow version) and global state (config, pool) remain unscopedl multi-run per single-flow deployments are now safe.
- **Test coverage**: 1699 tests pass (up from prior release); 12 new items with acceptance + unit coverage on all scoping boundaries.

### Migration Notes

This release ships **run namespacing**: the database is now multi-run safe. Existing single-run flows continue to work unchanged (automatic `DEFAULT_RUN_ID` adoption). To use multi-run isolation, pass `--run-id <id>` to `conduit run`; each distinct run_id is a partition of the shared database.

**Concurrency model:** Run namespacing supports multiple concurrent `conduit run --run-id job-A` and `conduit run --run-id job-B` against the same `conduit.sqlite`, with zero inter-job interference. Worker pools remain per-executor instance (each run has its own kernel process with its own concurrency level).

---

## [Unreleased] — Parallel Lane Execution (Build-Order Step 9b — Production Worker Pool)

This cycle delivers **deterministic worker IPC**, **per-child seeded inputs**, and a **fully production-wired event-driven worker pool** for the agentic surface. `conduit run --concurrency K>1` now spawns real out-of-process `conduit __worker` subprocesses that run deterministic stations and report results over Bun IPC; the kernel remains the sole DB writer. The synchronous single-worker path (concurrency=1) is unchanged. Full suite green at **1421 tests**, including a live multi-process integration test that spawns real worker subprocesses.

**Step 9b scope (production wiring + code-review punch-list):** the pool is no longer a test-seam-only library — `cmdRun`/`cmdResume` build a real `Bun.spawn`-backed pool (`buildWorkerPool`) and thread it into `runExecutor`, whose loop is now genuinely event-driven (it awaits asynchronous MARK_DONE rather than assuming synchronous completion). Earlier `9a` builds parsed `--concurrency > 1` but fell through to the synchronous path at runtime; that gap is now closed.

### Added

- **Production worker-pool wiring (step 9b)**: New `worker/worker-entry.ts` subprocess entry (`conduit __worker <flowPath> <projectRoot>`) that loads + validates the flow, runs a plain pure deterministic station via the harness, and reports exactly one MARK_DONE before self-exiting (one-shot, reaped on exit). New `buildWorkerPool`/`makeWorkerPool` seam on `CliDeps` builds a real `Bun.spawn`-backed pool routing each child's codec-validated IPC into the single handler `runExecutor` registers; `cmdRun`/`cmdResume` construct it when `concurrency > 1` and dispose it after the run. Only PLAIN PURE deterministic stations are pooled — transform/agentic/fan-out/effectful/`enforce_owned_paths` stations stay on the synchronous in-process path.
- **Event-driven control loop**: `runExecutor` now blocks on an internal worker-event wait (timeout-bounded) when workers are in flight or the concurrency cap deferred ready cards, and resumes on each MARK_DONE — replacing the prior assumption that completions fire synchronously inside `send()`. A live `reconcile` pass reclaims hung workers (dead-lease) mid-run and reaps their subprocesses.
- **Pooled-worker token attribution**: `MarkDoneMessage` gains an optional typed `usage` field; the harness forwards station spend and `runExecutor` folds it into the run + per-wave token budgets, so the consumption andon applies to out-of-process work (deterministic stations report 0).
- **Live multi-process integration test**: spawns real `conduit __worker` subprocesses through the production `buildWorkerPool` seam and verifies a deterministic flow completes end-to-end (and that a failed command drives the card terminal without hanging).
- **Per-child seeded fan-out inputs** (WI-464): Committed fan-out children now receive materialized per-child seed payloads (seed.json) in their owned directories, atomically written during child insertion. Each child has its own distinct input instead of N stochastic variants of a shared input, enabling heterogeneous branching.
- **Typed kernel↔worker IPC protocol** (WI-465): New `WorkerMessage` discriminated union (START_WORK, MARK_DONE, HEARTBEAT) with strict field allowlists, size bounds (NFR-4: no artifact bytes over IPC), and parse/serialize validators. All messages parsed from JSON with fail-closed error returns, never throwing.
- **Run-level concurrency cap** (WI-466): New `FlowDefaults.concurrency` field (default 1) and `--concurrency K` CLI flag; the resolved cap is threaded into RunEngineArgs and controls the worker pool size. Invalid values (<1) are rejected before dispatch with clear errors. The flag overrides the flow default.
- **Dead-PID detection and reclaim** (WI-467): Extended `active_workers` table with a `pid` INTEGER column (schema v4→v5 migration). The reclaimOrphanedWorkers pass now detects dead worker subprocesses via PID liveness checks and reclaims their slots even when lease is still valid, enabling recovery under K>1 with live workers.
- **Per-child seed in prompt templates** (WI-468): Transform stations can now reference `{{seed.json}}` in prompts; the child's materialized seed is resolved from the child's owned_paths directory and rendered per-child. Binding stamps include seed content hash (per-child, not shared), so seed changes invalidate checkpoints correctly.
- **Worker harness subprocess** (WI-469): New `handleStartWork` harness that receives START_WORK over process.send, executes the assigned station, emits periodic HEARTBEATs on a bounded interval, and reports exactly one MARK_DONE with the outcome. The harness never opens the state DB (NFR-3) and never sends artifact bytes over IPC (NFR-4).
- **Event-driven kernel worker pool** (WI-470): runExecutor now contains the pool dispatch path: when `spawn` and `onMessage` seams are wired, it claims slots, spawns workers, sends START_WORK, and processes MARK_DONE/HEARTBEAT asynchronously. The `concurrency=1` path is unchanged byte-for-byte. (The real `Bun.spawn` ↔ harness binding that this path consumes is now wired in production — see "Production worker-pool wiring (step 9b)" above.)
- **Consumption-andon drain wiring** (WI-471): When the consumption andon trips while workers are in flight, the kernel calls `planDrain` to decide per-worker action: drain (lease-valid worker finishes and checkpoints) vs. hard_kill (past-lease worker terminated). New claims are blocked while drain completes, and the run halts with andon reason surfaced via error output.
- **End-to-end concurrency integration tests** (WI-472): Real runExecutor exercised with concurrency K>1 over a seeded fan-out batch; tests verify one correct output per distinct input, crash mid-batch with resume recovery, and peer-worker lifecycle (spawn/heartbeat/reap).
- **MARK_DONE reaction handler** (WI-473): Kernel now processes each MARK_DONE by running post-work transitions (fan-in evaluation via pollAwaitingChildren, checkpoint writes, journal logging), advancing the card through the FSM, and dispatching rework or terminal outcomes. Terminal-lane idempotency prevents double-logging when a MARK_DONE arrives for an already-completed card.

### Changed

- **FlowDefaults gains concurrency field** (WI-466): New optional `concurrency?: number` field; loadFlow defaults to 1 when absent.
- **RunEngineArgs carries concurrency** (WI-466): New required field threads the resolved cap into the executor.
- **SpawnWorker seam added to RunEngineArgs** (WI-470): Injected spawn function (overridable for testing) returns {pid, send} for worker subprocess IPC. No production default yet — CLI wiring pending step 9b.
- **Schema v5 migration** (WI-467): active_workers table extended with `pid INTEGER` column; v4→v5 migration runs idempotently on load.

### Fixed

- **Dispatch failure is fail-closed, not fatal or infinite (code-review #5)**: If `spawn()`/`worker.send()` throws (EMFILE, fork failure, dead child), the kernel releases the claimed slot and escalates that card to `hold` for a human, then keeps other lanes running. Replaces the prior behavior of re-throwing (which aborted the entire pool on one transient failure) — and avoids the infinite `ready→claim→throw→ready` re-dispatch spin a plain "reset to ready" would cause.
- **Pooled cards take a `working` lease (code-review #4)**: pool dispatch now calls `beginWork` after the atomic claim, so an in-flight pooled card is `working` (not stranded at `claimed`) and a hung worker is visible to the live `reconcile` mid-run rather than only on resume.
- **`now()` contract clarified for the IPC handler (code-review #7)**: the async MARK_DONE/HEARTBEAT handler samples the clock per inbound message (a HEARTBEAT must renew the lease to the current instant); the "once per tick" rule applies to the loop body, not the event callback.
- **Recycled-PID reclaim hardening (code-review #6)**: `reclaimOrphanedWorkers`'s optional liveness predicate now receives the slot's stored `started_at` so a caller can verify process identity (not bare PID existence) and detect a recycled PID; the resume path stays predicate-free (always reclaims, the sound choice when the owner is dead).
- **Config trust-boundary guards (code-review #8/#9)**: removed two load-bearing `as` casts (`defaults.concurrency`, `happyPathNext`) in favor of runtime narrowing, and added a visited-set guard to the root-card `owned_paths` chain-walk so a cyclic `resume_at`/`next` flow cannot infinite-loop at seed time.
- **Concurrency cap is now genuinely tested (code-review #2)**: the pool tests use a deferred-completion fake that holds multiple workers simultaneously in flight and samples true peak occupancy, so the `min(K, wip)` cap is falsifiable (removing the guard would let the peak reach `wip`); the prior fake completed each card synchronously, making the assertion tautological.
- **Seed binding stamp includes per-child content** (WI-468): Input hash loop now reads seed.json from the child's owned_paths directory (child-scoped), not projectRoot, so sibling children with distinct seeds get distinct binding stamps and stale checkpoints are not replayed on seed change.
- **Image/text input overlap rejected** (WI-468): render.ts now validates that no input name appears in both declaredInputs and declaredImageInputs, fail-closed before any disk read.

### Technical Details

- **Build order step 9a** (event-driven worker pool): agentic surface begins. The pool is pure dispatch (no LLM in the spawn/claim loop); the Law applies to what workers do, not to the pool machinery. Concurrency=1 preserves byte-identical output for regression-testing.
- **Worker isolation** (NFR-3, NFR-4): Harness has no state-DB handle (all results over IPC). Artifact bytes never travel over IPC (START_WORK carries input refs, not contents; MARK_DONE carries outcome, not outputs).
- **Deterministic pool**: No randomness in scheduling; K ceiling is enforced per-action via attemptClaim's existing WIP checks; spawn order is stable (action order from plan).
- **PID-liveness predicate**: Default `process.kill(pid, 0)` wrapped in try/catch; injected as `isPidAlive?: (pid: number) => boolean` seam for deterministic testing.
- **Test coverage**: 1402 tests (up from 1377); 25 new tests covering seed materialization, IPC protocol, concurrency cap CLI, PID reclaim, seed prompt rendering, worker harness, pool dispatch, drain wiring, E2E batch, and MARK_DONE reaction.
- **Backward compatibility**: All changes are additive or backward-compatible (concurrency defaults to 1, optional seam functions, spawn seam injected).

### Migration Notes

This release ships **build-order step 9a** (worker pool library). Existing flows continue to work unchanged (concurrency=1 is default and preserves byte-identical behavior).

The `--concurrency K` flag and `defaults: { concurrency: K }` YAML field parse and validate correctly. At runtime they have no effect yet — CLI subprocess wiring is pending step 9b. Do not rely on `--concurrency > 1` for production parallel dispatch in this release.

For agentic stations with fan-out, add `seed:` fields to ProposedChild to deliver per-variant inputs. Child_entry stations can reference `{{seed.json}}` to render per-child seeded inputs.

---

## [Unreleased] — Per-Wave Subtree Budget (executor wiring)

Wires guard #4's wave scope (SPEC §6/§8) — `aggregateByWave`/`checkWaveBudget` were implemented-as-library but never driven by `runExecutor`.

### Added

- **Per-wave (parent_id subtree) budget**: the executor now partitions per-card token/dispatch spend by `parent_id` each tick and scraps any subtree that exceeds `budgets.per_wave` (`max_tokens` / `max_dispatches`). Unlike the run-scope consumption andon, this does **not** halt the run — sibling subtrees under other parents keep running (blast-radius isolation: one runaway fan-out variant is scrapped while the rest deliver). Active only when at least one `per_wave` cap is declared; tracks spend per run-invocation (consistent with the run andon). Per-card spend is attributed in-memory (worker + gate-critic model calls counted against the running card); the over-budget subtree is moved to `scrap` with terminal reason `wave_budget`.

### Technical Details

- Driven through the REAL executor by `executor-wave-budget.test.ts`: over-budget subtree scrapped mid-flow while a sibling subtree completes (run not halted), under-budget subtree completes, independent `max_dispatches` cap, and inactive-when-unset. Full suite green at 1168.

---

## [Unreleased] — Integrity Gate & Checkpoint Cascade (executor wiring)

Wires two SPEC §5/§6 mechanisms that were implemented-as-library but never driven by `runExecutor`, so the guarantees now hold for the shipping binary.

### Added

- **MARK_DONE owned-paths integrity gate** (SPEC §5/§6): the executor now runs `checkIntegrity` after a station completes, verifying every file it wrote stays within the card's `owned_paths`. A containment breach hard-pauses the card to `hold` (a Law-class violation is escalated to a human, never auto-retried) and invalidates the just-written checkpoint so a resume cannot skip-replay an out-of-bounds output. Transform stations check their declared outputs; deterministic stations diff a before/after project-tree snapshot to capture what an arbitrary command actually touched. Opt-in per flow via `defaults.enforce_owned_paths: true` (default false) — existing flows are not yet authored to keep all outputs within `owned_paths` (e.g. fan-out children sharing a static output name), so enforcement is per-flow rather than global.
- **Binding-stamp cascade invalidation** (SPEC §5): on resume, when a station's checkpoint binding stamp no longer matches (model/prompt/inputs/flow changed), `cascadeInvalidation` now invalidates every downstream station that consumes its outputs, so none skip-replays a checkpoint built on stale inputs. Always on (no config dependency).

### Changed

- **`FlowDefaults` gains `enforceOwnedPaths`** (parsed from `defaults.enforce_owned_paths`, default false).

### Technical Details

- Both mechanisms are driven through the REAL executor by `executor-integrity-cascade.test.ts` (integrity hold-on-escape for deterministic + transform stations, opt-out passthrough, in-bounds pass; cascade fires on a stale upstream stamp and stays quiet on a match). Full suite green at 1171.

---

## [0.2.0] — Docker Packaging & Install Docs (Build-Order Step 7.7)

This cycle delivers **Docker-first distribution**, **per-flow image generation**, **container pre-flight validation**, and **end-to-end install documentation**. The engine runs in a distroless, non-root container with automatic prerequisite installation. The CLI ships a `conduit build` command to generate per-flow Dockerfiles from the engine image, and `conduit doctor` now includes container-aware probes that validate the environment before runs. Full suite green at **1285 tests** (up from 1185).

### Added

- **Engine Dockerfile** (WI-435): Multi-arch (`linux/amd64`, `linux/arm64`), non-root `conduit` user, distroless base image, dispatching entrypoint that sources `/conduit/flow.sh` (project-specific env baked in per-flow), and ENV sentinels for container-aware probe behavior (`CONDUIT_PROJECT_ROOT`, `CONDUIT_ENGINE_CONTAINER`)
- **Flow Dockerfile generator** (WI-438): `generateFlowDockerfile()` accepts engine image, flow config, and generates a per-flow Dockerfile from the engine as base; includes `COPY . /flow/`, `RUN apt-get install` for declared prerequisites, `ENV CONDUIT_PROJECT_ROOT=/flow`, and per-flow `flow.sh` sourcing at container boot; output is pure text for `docker build` integration or storage
- **Prerequisites field in flow.yaml** (WI-434): New `prerequisites` array on `FlowConfig` (validated, non-empty when declared); consumed by `conduit build` to generate `RUN apt-get install -y <prerequisites>` in per-flow images; `conduit doctor` validate-present probe checks installed state
- **.dockerignore** (WI-436): Excludes secrets (`.env*`, `secrets/`, `*credentials*`), local state (`*.sqlite*`, `.git/`, `node_modules/`), and non-essential files to minimize image context and prevent leaking secrets into build artifacts
- **Container pre-flight doctor probes** (WI-437): Four new probes in `conduit doctor`:
  - **project-root-present**: Validates `CONDUIT_PROJECT_ROOT` — fails if path is set and missing, passes if unset or set to empty string (engine-only sentinel), checked after existsSync for local-only failures
  - **docker-available**: Checks `docker version` and socket availability (engine depends on Docker for deterministic subprocess dispatch)
  - **bun-available**: Verifies `bun --version` and binary compatibility with container architecture
  - **prerequisites-installed**: Validates each declared prerequisite is in the system (`apt list --installed | grep <pkg>` for Debian-based, fallback to `which <cmd>`), enables proactive detection before run
- **conduit build command** (WI-438): New `conduit build <flow.yaml>` CLI subcommand that loads the flow, generates the per-flow Dockerfile, and outputs to stdout for piping to `docker build -`; integrates with engine image (env var `CONDUIT_ENGINE_IMAGE`, default `conduit:engine`); includes defensive COPY form and flow-dir fallback
- **docker-compose.dev.yml** (WI-439): Dev-iteration stack with engine service (privileged, `/conduit` + project-root bind-mounts, TTY for interactive debugging), LLM sidecar (OpenAI-compatible endpoint), and persistent `conduit.sqlite` volume; enables local iteration without image rebuilds
- **docker-compose.operator.yml** (WI-440): Reference operator deployment stack with long-lived listener service (ingress webhook/Slack adapters), per-run kernel services (spawn-and-exit), persistent state volume, and sidecar; documents production topology (listener as control plane, kernel as worker pool)
- **docs/installation.md** (WI-441): End-to-end install guide covering system prerequisites (Docker, Bun 1.0+), source build, engine image build, per-flow image generation via `conduit build`, `docker run` examples for both engine and per-flow containers, `docker-compose` quickstart for dev and operator stacks, troubleshooting the four pre-flight probes, and appendix on `CONDUIT_PROJECT_ROOT` semantics and per-flow override

### Changed

- **Loader rejects unsupported fields in prerequisites** (WI-434): `prerequisites` list is validated at load; each string is checked against a known pattern (alphanumeric + `-._:`), fail-closed on suspicious values to prevent injection into `apt-get` commands

### Fixed

- **Project root probe handles empty-string sentinel** (WI-437): `buildProjectRootProbe()` short-circuits on empty string (engine-image container marker) before filesystem checks, so engine containers never FAIL on a missing path
- **Per-flow image generated correctly on resume** (WI-438): Engine Dockerfile's `flow.sh` is sourced, then generated per-flow `flow.sh` is appended; per-flow COPY + prerequisites are applied BEFORE entrypoint, so resumed runs inherit the same environment
- **Prerequisites probe uses correct package manager** (WI-437): For Debian/Ubuntu containers (standard in distroless), checks via `apt list --installed`; fallback to `which` for executables, enabling flexibility across distributions

### Technical Details

- **Build order step 7.7** (Docker packaging): Non-agentic surface changes; all Docker mechanics are pure (Dockerfile generation, environment setup, probe validation). No Law changes, no new worker seams.
- **Distroless non-root execution**: Engine runs as `conduit:conduit` (non-root) in a distroless image; deterministic subprocess dispatch (Bun.spawn vfork) is not affected by root status
- **Prerequisite safety**: Listed prerequisites are validated at load and rendered into Docker RUN; no shell metacharacters, fail-closed pattern matching
- **Container-aware probes**: Probes detect running environment via `CONDUIT_ENGINE_CONTAINER` and adjust validation (project-root check skipped in engine, prerequisite check only in final image)
- **Test coverage**: 1285 tests (up from 1185); 100 new tests covering prerequisites loading/validation, Dockerfile generation (engine + per-flow), four container probes, docker-compose fixtures, and end-to-end docker run integration

### Migration Notes

This release ships **build-order step 7.7** (Docker packaging): the distribution surface is now Docker-first. Flows are deployed as distroless multi-arch images with prerequisites auto-installed. The CLI `conduit build` command generates per-flow Dockerfiles from a shared engine base.

To upgrade:
1. Build or pull the engine image: `docker pull/build conduit:engine`
2. For each flow, generate its Dockerfile: `conduit build prd/my-flow.yaml > Dockerfile`
3. Build the flow image: `docker build -t my-flow:latest .`
4. Run: `docker run -v $(pwd):/conduit -e OPENAI_API_KEY=... my-flow:latest`

For development, use `docker-compose -f docker-compose.dev.yml up` to spin up the engine with an LLM sidecar.

---

## [Unreleased] — explain Command & Flow Visualization (CLI Enhancement)

This cycle delivers **the `conduit explain` CLI command** for ASCII flow diagram visualization and **metadata extensions** to capture flow names and worker roles for diagnostic output. The explain renderer reads a validated FlowConfig and produces a deterministic, human-readable lane-graph diagram with flow-ordered routing, fan-out/fan-in structure, check/rank markers, and an adaptive legend.

### Added

- **explain-renderer module** (WI-443, WI-444, WI-446): New `renderFlow(flow, opts?): string` function produces vertical lane-graph diagrams from FlowConfig. Stations render in **flow order** (a depth-first walk from the entry station via `happyPathNext`, never declaration order); **fan-out** parents annotate the rail with their child hand-off and render the child sub-path as its own block; **fan-in** stations carry an inline `(fan-in: ...)` note; back-edges (gate rejection paths) render as rework lines; terminal lanes are summarized on one line; check/rank/effectful markers and column-aligned node labels round out each node; the legend is adaptive — only markers actually present are listed. Two output styles: the default **pure-ASCII fallback** (no non-ASCII glyphs, no ANSI — clean for pipes/scripts, AC9) and an opt-in **rich TUI** (`{ rich: true, color?: true }`) that frames the flow in a Unicode box-drawing panel with a titled header, section dividers for child sub-paths, node glyphs (●/◇/◎), and optional ANSI color keyed by station kind (AC1–9, FR-1)
- **explain CLI command** (WI-445): `conduit explain <flow.yaml> [--color auto|always|never]` wired into dispatcher; loads and validates the flow, renders the diagram via explain-renderer, and prints to stdout. Output style auto-detects the terminal: the rich color TUI on a TTY, the clean ASCII fallback when piped/redirected; `--color` overrides the detection and `NO_COLOR` is honored. Closes the user-facing gap where humans inspecting a flow had no tool to visualize routing (FR-2)
- **Flow.name field** (WI-442): Optional `flow:` top-level field in flow.yaml now populated into `FlowConfig.name` for diagnostics and log attribution; preserved verbatim, absent when not declared (load-bearing for explain header); complements existing usage at startup logs and dogfood examples
- **StationConfig.role field** (WI-442): Optional `role` field on station worker config (e.g. `worker: { model: gpt-4o, role: planner }`) surfaces the worker role in prompts and diagnostics without renaming the station id; role is absent when not declared, never empty; carried verbatim through the loaded config and rendered in explain output (AC1–2)
- **StationGateConfig.criticRole field** (WI-442): Optional `role` field on gate check blocks (e.g. `check: { kind: gate, role: auditor }`) distinguishes the critic's role from the station id; when present, criticRole is preferred over criticModel for back-edge labels in explain diagrams (AC3, AC6)

### Changed

- **FlowConfig, StationConfig, StationGateConfig types extended** (WI-442, WI-443, WI-444): `FlowConfig` gains optional `name` field; `StationConfig` gains optional `role` field; `StationGateConfig` gains optional `criticRole` field — all absent when not declared, maintaining backward compatibility with existing flows and minimal literals (WI-289)
- **Flow loader wires metadata** (WI-442): `loadFlow` now extracts the optional `flow:` field from raw YAML and surfaces it on the assembled `FlowConfig.name`; wires `worker.role` (if present) into `stationConfig.role`; wires `check.role` (if present) into `stationGateConfig.criticRole`

### Technical Details

- **Build order**: CLI enhancement, no kernel changes to SPEC §1–7
- **Diagram determinism**: No randomness, no Date.now(); glyph selection and edge labeling are deterministic functions of FlowConfig shape
- **Explain tests** (WI-443, WI-444, WI-446): Covering node rendering (worker vs no-worker, check/rank/effectful markers), flow-order traversal (routing-ordered, not declaration-ordered), fan-out hand-off + child sub-path block, inline fan-in note, edge routing, back-edge labeling, terminal-lane summary, adaptive legend, and full flow rendering for reference + synthetic test flows; plus the rich TUI (uniform box-line widths, ANSI gated on `color`, layout invariant under ANSI-strip, pure-ASCII default)
- **Output styles** (AC9): The default (and piped/redirected) render is pure ASCII with no ANSI — script- and grep-friendly; the rich TUI is opt-in and TTY-gated, so terminals get the framed color panel while pipelines get clean text. `renderFlow(flow, opts)` is backward compatible — the no-opts call is unchanged
- **No-worker station detection** (AC5): Stations with no `model` and no `command` render with id + markers only; check markers (gate/rank) and effectful markers are independent and compose correctly
- **Back-edge label precedence** (AC3, AC6): gate stations contribute back-edge labels from `criticRole` (preferred) then `criticModel`; rank stations are unlabeled (never read from rankCheck), and a gate critic with neither role nor model renders no label rather than an empty `[]`. Glyph (`<~`) clearly distinct from forward arrows (`->`)
- **Backward compatible**: Existing flows without `name`, `role`, or `criticRole` fields continue to load and function; explain output adapts (e.g. '(unnamed)' when `name` is absent)

### Migration Notes

This release adds the **explain command** and flow metadata for diagnostics. No breaking changes — flows without the new fields work unchanged. The `conduit explain` command is now available for visualizing flow topology without a flow run.

---

## [Unreleased] — Multimodal Transform Input (Build-Order Step 7.6)

This cycle delivers **image inputs for transform stations**, enabling LLM vision capabilities directly from the flow config. Transform stations now declare images via `image_inputs`, images are loaded from disk with format detection, byte-hashed into the binding stamp for skip-on-resume, and attached as multimodal content parts in the model call — all deterministically, with fail-closed payload guards. Text-only models safely fast-scrap on vision rejection without burning execution attempts. Full suite green at **1055 tests** (up from 918).

### Added

- **ImageInput type and loader** (WI-413): New `ImageInput` interface carries resolved path, raw bytes (non-enumerable to prevent log leaks), and detected media type; `loadImageInput(projectRoot, declaredPath)` loads a declared image path into the shape with path-traversal guard (NFR-2) and clear format-rejection errors; `hashImageInputs()` contributes image-byte hashes to the binding stamp (AC3: changed image invalidates checkpoint)
- **Image-input declaration in flow.yaml** (WI-414): `StationConfig` gains optional `image_inputs` field, a bounded list of `ImageInputDeclaration` objects (max 5 per station); load-time validation ensures list is non-empty when declared and count is within limit
- **Image placeholder guard in prompt renderer** (WI-416): `renderPrompt` rejects placeholders that name declared image inputs with a clear image-specific error — images are attached to model calls (ModelCall.images), never substituted as text (FR-4a, AC2)
- **Image hashing for binding stamp** (WI-417): `hashImageInputs()` produces one SHA-256 hex digest per image, folded into `inputArtifactHashes` alongside text inputs; image-byte changes invalidate the checkpoint so skip-on-resume is image-aware (AC3)
- **OpenAI adapter multimodal support** (WI-415): When `ModelCall.images` is present, user message switches to OpenAI content-parts shape: one text part + one image_url per image in declared order, each carrying a base64-encoded data URI with detected media type; text-only calls preserve legacy string-content shape byte-for-byte (NFR-1)
- **Per-call image payload guard** (WI-420): `assertImagePayloadWithinLimits(images)` rejects oversized (>20MB) or too-many (>5 per call) images with clear kernel errors before adapter dispatch, so pathological images surface immediately rather than as opaque gateway 400s
- **Executor image loading and wiring** (WI-419): Images declared in `stationConfig.image_inputs` are loaded once before binding stamp computation and model call, missing declared images surface immediately (AC6 / FR-7), and loaded images are passed to adapter only when non-empty (NFR-1: text-only calls have no images field)
- **Vision-unsupported fast-scrap classification** (WI-421): Text-only models that reject multimodal calls are classified with `vision-unsupported` status (distinct from generic `model-incompatible`), fast-scrapped without burning execution attempts, enabling graceful fallback to text-only stations on the same flow (FR-10)

### Changed

- **ModelCall seam extended with images field** (WI-413): `ModelCall` gains optional `images?: ImageInput[]` field to carry loaded image inputs alongside text prompt; text-only transform stations see no images field (NFR-1)

### Fixed

Post-merge code-review hardening (branch `feat/multimodal-transform-input`):

- **Dangling outbox intent on non-retryable scrap**: an `effectful` transform station that fast-scraps (vision-unsupported / model-incompatible) now abandons the PENDING outbox intent it wrote before the call via the new `discardIntent()`, instead of leaving it dangling for a later replay to `escalate_hold` on an effect that never landed
- **Image inputs silently dropped on stations that can't consume them**: `image_inputs` declared on a check-only or non-transform (e.g. deterministic) station are now rejected at load (`UNSUPPORTED_IMAGE_INPUTS_ON_STATION`) instead of loading successfully and being dropped at runtime
- **Duplicate image-input paths**: a path listed twice within one station is rejected at load (`DUPLICATE_IMAGE_INPUT`) rather than being loaded, hashed (double stamp contribution), and uploaded twice
- **Symlink-escape in image path guard**: `loadImageInput` now resolves real paths (`realpathSync`) and re-checks containment before reading, so a symlink inside the project root that points outside it can no longer launder an out-of-root read past the lexical guard

### Technical Details

- **Build order step 7.6** (multimodal transform input): Extends the MVP transform-only surface to include vision inputs; deterministic loading + binding-stamp hashing + adapter wiring, zero agentic surface changes
- **Image safety guarantees** (NFR-2, NFR-3): Path-traversal guard at load time; non-enumerable bytes prevent log leaks; serialisation hooks (toJSON/toString/Bun.inspect) return path-only references
- **Binding stamp determinism**: Image hashes folded at computation time, stamp invalidation on image changes enables checkpoint skip-on-resume image awareness
- **Adapter shape evolution**: Multimodal content parts fully compatible with text-only adapters via conditional shape (images present → content parts; images absent → string)
- **Test coverage**: 1055 tests (up from 918); 137 new tests covering image loading, format detection, path traversal + symlink-escape guards, binding stamps, placeholder rejection, multimodal content parts, payload guards, vision-unsupported classification, outbox-intent discard on scrap, unsupported/duplicate image-input rejection, and crash-recovery idempotency

---

## [Unreleased] — Ingress Trigger-Listener (Build-Order Step 8.2)

This cycle delivers **ingress HTTP adapters** for webhook and Slack events, **deterministic event deduplication and recovery**, and the **listener process** that spawns conduit runs from external triggers. The listener boots with validation (flow allowlist, binding well-formedness, route collision detection), recovers accepted-but-unspawned events on restart bounded by attempt caps, and serves authenticated webhook and Slack adapters that each spawn exactly one conduit run per distinct event. Full suite green at **918 tests** (up from 745).

### Added

- **Ingress event durability and spawn state machine** (WI-401): Extended `ingress_events` table with `spawn_state` (accepted/spawned/failed) and `spawn_attempts` counters, plus atomic `acceptIngressEvent` that prevents concurrent re-spawn of the same event_id (NFR-2); migration ladder v2→v3→v4 is idempotent and additive, preserving shipped MVP databases
- **Ingress binding schema and boot validation** (WI-402): Defined `IngressBinding` type for per-flow event sources (webhook/slack/cli), routes, auth config, and event_id derivation methods (header/json_path/content_hash/require); `validateIngressBindings` fails loud at boot on malformed bindings, missing required fields for a binding type, or route collisions across active flows (FR-9, FR-6)
- **Deterministic substrate envelope** (WI-403): Implemented `buildEnvelope` and `projectSubstrate` that produce the canonical, deterministic substrate for the spawned conduit run—with zero model calls, secret-filtered headers (NFR-5), optional JSON-path projection per binding, and byte-identical output on repeated calls
- **Append-only ingress_log observability table** (WI-404): Added journal-backed `ingress_log` table recording every event outcome (accepted, duplicate, rejected_auth, rejected_unknown_flow, rejected_malformed, spawn_failed, redriven) with secret filtering, queryable independently of the dedup ledger (FR-11, D5)
- **Stable event_id derivation with smart defaults** (WI-405): Implemented `deriveEventId` for per-binding event sourcing—explicit header/json_path/content_hash modes, Slack native-id default, webhook well-known-header probing (X-Conduit-Delivery-Id, Idempotency-Key, X-GitHub-Delivery, X-Shopify-Webhook-Id, X-Request-Id, Stripe body.id), fallback content-hash with one-time degraded-dedup warning, and fail-closed require mode (FR-8, D2)
- **Core accept-dedup-spawn orchestration** (WI-406): Implemented `runSpawnPath` that atomically records event_id as 'accepted' before spawning (D1, NFR-2), writes the envelope substrate, spawns conduit run via Bun.spawn, marks 'spawned' or 'failed' with alert on failure, logs outcome to ingress_log, and suppresses re-spawn for already-accepted/spawned events (FR-1, FR-2, FR-3, FR-7, FR-10)
- **Bounded boot re-drive and escalation** (WI-407): Implemented `redriveOnBoot` that on listener startup recovers rows in spawn_state 'accepted' or 'failed' whose spawn_attempts is under a configured cap, re-attempts with attempt-counting before each spawn, marks rows at-cap or with permanent failures as non-retryable, and logs outcome 'redriven' (D1, FR-7, NFR-3)
- **Webhook ingress adapter with mandatory signature auth** (WI-408): Implemented `handleWebhookRequest` that rejects unsigned/invalid-secret requests fail-closed with rejected_auth (FR-5, NFR-4), resolves route to flow binding, derives event_id per binding (WI-405), maps body to envelope (WI-403), and invokes core accept-spawn path (FR-4, FR-5, FR-6)
- **Slack-events adapter with request-signature auth** (WI-409): Implemented `handleSlackEvent` that verifies Slack request signatures using HMAC-SHA256 (timingSafeEqual, configurable replay window), acks Slack within 3s window, then asynchronously derives native event_id, extracts message and attachments, invokes core spawn path, deduplicating Slack retries (FR-4, FR-5, risk mitigation)
- **Listener process assembly and boot validation** (WI-410): Assembled `listener.ts` that loads explicit flow allowlist, validates all bindings at boot (WI-402), resolves per-flow spawn-failure alert channels (flow-owns + listener fallback), runs boot re-drive (WI-407), wires webhook and Slack adapters, and refuses to start on invalid config (FR-1, FR-9, D4, NFR-1, NFR-6)
- **Secret-filter export for ingress and channels** (WI-411): Exported `filterAttributes` and `isSensitiveKey` from `src/persistence/db.ts` for use by ingress adapters and envelope builder; no secrets (Authorization, *_token keys) leak into substrate or logs (NFR-5)
- **'conduit listen' CLI command** (WI-412): Wired `conduit listen` into the CLI dispatcher; loads flow allowlist and config, boots the listener with validation, spawns the long-lived process that serves webhook/Slack adapters, and surfaces boot errors fail-loud (user-facing entry point for the ingress surface)

### Fixed

- **Ingress event recovery on restart** (WI-407): A crash between acceptIngressEvent and spawn no longer orphans the event—redriveOnBoot recovers it bounded by the attempt cap, ensuring accepted-but-unspawned events never silently drop (D1)
- **Exactly-once dedup across retries and crashes** (WI-401, WI-406): Event accept is atomic and happens before spawn; already-spawned events are never re-spawned even on listener restart, and attempt counting is bounded to prevent unbounded retry loops (NFR-2, NFR-3)

### Technical Details

- **Build order step 8.2** (ingress listener): Deterministic ingress adapters (webhook, Slack), event durability with spawn state machine, bounded re-drive recovery, boot validation with fail-closed route collision detection
- **Spawn state machine** (WI-401): Transitioned ingress_events from simple dedup table (event_id PRIMARY KEY) to durability ledger with spawn_state {accepted|spawned|failed} and spawn_attempts count, enabling recovery and bounded re-drive
- **Deterministic substrate** (WI-403): Envelope determinism is load-bearing—no Date.now(), no randomness, no model calls; JSON-path projection is pure; secret filtering uses the exported db.ts regex to prevent leaks
- **Attempt counting semantics** (WI-406, WI-407): spawn_attempts incremented BEFORE every spawn attempt (including the first), so cap=N bounds TOTAL attempts; a row at attempt N-1 is re-driven once (→N), a row at N is not re-driven (boundary deterministic)
- **Fail-closed auth** (WI-408, WI-409): Invalid signature/secret is rejected before any database write; unknown routes and malformed bodies are logged as rejected_* but never accept an event (FR-5, FR-6)
- **Slack 3s ack window** (WI-409): `handleSlackEvent` returns 200 synchronously, defers processing via `await Promise.resolve()` to yield tick, absorbs Slack re-deliveries via dedup (acceptance of identical event_id logs 'duplicate')
- **Test coverage**: 918 tests (up from 745); 173 new tests covering ingress binding/envelope/event-id/spawn/recovery/webhook/slack/listener items, plus crash-recovery and integration suites

### Migration Notes

This release ships **build-order step 8.2** (ingress listener): the external-trigger surface is now production-ready for webhook and Slack events. Flows must opt-in to ingress via the allowlist (explicit, not auto-discovery); each flow declares its channels.ingress binding (type, route, auth, event_id source); boot validation is fail-closed on any config error.

The listener is a long-lived process separate from per-run kernels; it loads once at boot and spawns conduit runs on incoming events. A crash or restart between event acceptance and spawn is safely recovered on next boot, bounded by the attempt cap—never silently dropped or unboundedly retried.

---

## [Unreleased] — Branching Flows & Human-in-the-Loop (Build-Order Step 8.1)

This cycle delivers **deterministic fan-out/fan-in wiring** into the production executor, **human-in-the-loop rank selection via Slack**, and a **real branching example flow** exercising the complete pipeline. The executor now routes child card creation, quorum fan-in evaluation, and HITL prompt posting through its deterministic tick — with no LLM in the control path — and crash-recovery is proven exactly-once across all new seams. Full suite green at **745 tests** (up from 660).

### Added

- **Branching topology schema validation** (WI-393): Extended `flow.yaml` with optional `child_entry`, `child_terminal`, and `resume_at` fields on fan-out/fan-in stations; loader validates fail-closed that all topology targets name known stations or terminals before the run starts, unblocking the executor wiring items
- **conduit reply CLI command** (WI-394): Maintainers can now run `conduit reply --correlation-id <id> --selection <choice>` to durably record a human selection against a held HITL card, enabling manual injection of human choices into paused branching runs
- **Production Slack transport** (WI-395): Implemented `SlackTransport` (HTTP `chat.postMessage` via bot token) conforming to the existing egress channel interface; posts HITL prompts to configured Slack channels and returns correlation IDs for parked cards; bot token never appears in logs or errors
- **Fan-out executor wiring** (WI-396): Wired `validateExpansion` + `commitFanOut` from `dag/expand.ts` into `runExecutor` so a fan-out station's worker output proposes child cards, the kernel validates acyclic + disjoint ownership, and valid children are seeded at the topology-declared `child_entry` station; fixed critical gate+fan-out interaction bug (gate pass must check `isFanOutStation` before `INTEGRITY_PASS`)
- **Quorum fan-in executor wiring** (WI-397): Wired `evaluateFanIn` into `runExecutor` so when all children reach terminal outcomes, the executor applies the declared quorum policy (`k` best_effort/all survivors advancing, or fewer survivors → hold, never deadlock); extends the awaiting-children polling seam introduced by WI-396
- **Rank station + HITL hold wiring** (WI-398): Wired rank-check stations into `runExecutor` to rank fan-in survivors, post the short-list to Slack via the outbox-guarded transport, move the card to held with a surfaced correlation ID, and exit cleanly; fixed critical crash-recovery double-post bug by using stable `correlationId=hitl::<cardId>::<stationId>::<attempt>` with direct `egressSend`; conduit resume reads recorded selections and advances held cards — no code path ever auto-selects
- **Real branching example flow** (WI-399): Added `examples/branching/flow.yaml` with real prompt templates exercising the complete fan-out → rank → HITL pipeline end-to-end; demonstrates that branching is pure config + prompts, zero kernel-code changes required (flow-is-config verified)
- **Crash-resume exactly-once across branching seams** (WI-400): Extended crash-oracle test harness with mid-fan-out, mid-publish, and HITL-post crash seams; proved exactly-once on resume: no duplicate child seeding, no double-publish, no re-post to Slack; fixed two atomic-commit bugs (commitFanOut non-transactional inserts + missing idempotency guard in handleFanOutComplete)
- **HITL hold-timeout enforcement** (WI-398 follow-up): Wired the previously library-only `applyHoldTimeout` into `runExecutor` via a new `pollHeldTimeouts` poll in the main loop's terminal check. A held rank card whose `hold_timeout_seconds` window elapses with no recorded selection is now resolved by the egress channel's `on_timeout` policy (`scrap` / `proceed_with_findings` / `escalate`) — enforced opportunistically on each run/resume past the deadline (the synchronous executor holds-then-exits). "Held since" is stamped on the injected clock via a durable `hitl.held_at` journal span, so the deadline is deterministic and survives crash/resume; a recorded reply always beats a timeout, and the kernel never auto-picks a winner (FR-14). Closes the gap where `hold_timeout_seconds`/`on_timeout` were validated by the loader and tested in isolation but never acted on in production
- **Loader rejects unrecognised `on_timeout`** (WI-398 follow-up): `loadFlow` now fails closed (`INVALID_ON_TIMEOUT`) on any `on_timeout` value outside the three legal policies, instead of silently no-op'ing at timeout

### Fixed

- **Slack bot token redaction in network errors** (WI-395): Network error messages from HTTP clients sometimes embed the Authorization header; now redacted via `replaceAll(botToken, '[REDACTED]')` before surfacing to prevent leaks
- **Fan-out + gate order bug** (WI-396): Gate check 'pass' branch now calls `isFanOutStation` BEFORE `INTEGRITY_PASS` so a gated fan-out station correctly routes to `handleFanOutComplete` (→ awaiting_children) instead of merging the parent to done with zero children
- **commitFanOut non-atomic inserts** (WI-400): Wrapped child card insertions in a single `db.transaction()` so a crash mid-fan-out rolls back all partial children atomically; on resume, the idempotent parent-status guard prevents duplicate seeding
- **HITL post idempotency on crash-recovery** (WI-398): Replaced dynamic nonce generation with stable `correlationId=hitl::<cardId>::<stationId>::<attempt>`, enabling the existing outbox (`writePendingIntent`/`commitIntent`/`reconcileOnResume`) to suppress duplicate posts across crash→resume

### Technical Details

- **Build order step 8.1** (deterministic branching): wired existing dag/expand + quality/rank modules into the executor (no new modules, all library-only → driven conversion)
- **Exactly-once proves across 8 new crash seams**: mid-fan-out (atomic rollback), mid-publish (reconcileOnResume skip), HITL post→commit (idempotency key), post-selection (durable read-after-write)
- **Correlation ID scoped to attempt**: `hitl::<cardId>::<stationId>::<attempt>` ties the HITL key to the execution context, surviving crash/reclaim/re-dispatch
- **Test coverage**: 739 tests (up from 660); 50 new integration + crash-recovery tests covering all branching + HITL seams
- **HITL flow is deterministic**: Slack posts, selection recording, and hold-timeout evaluation happen in the tick loop, not in the worker — human picks are data, not code

### Migration Notes

This release ships **build-order step 8.1** (deterministic branching + HITL): fan-out/fan-in routing is now kernel-driven and crash-safe. Flows can now declare branching topology in `flow.yaml` (no Python/YAML changes needed to the loader schema) and express HITL gates through rank stations with `on_timeout` policies — humans participate in the deterministic flow without breaking the contract that LLMs sit only at the stations, never in the control loop.

Rank stations with `on_timeout: escalate` or omitted `on_timeout` (default hold-indefinitely) require `conduit reply` (WI-394) or Slack API callbacks (future work) to advance. The correlation ID is now stable and scoped to attempt, making HITL resume idempotent across multiple crashes.

---

## [Unreleased] — Code-Review Remediation, Real-Run Hardening & Launch Briefs

This cycle resolves a two-pass code review (diff + whole-codebase) of the real-run path, hardens crash-recovery against findings from a live gateway run, and adds a multi-provider gateway config plus a launch-brief input to the dogfood example. Full suite green at **660 tests** (up from 521).

### Fixed

- **FSM is now the runtime source of truth**: the executor routes every post-work transition through `statemachine/transitions.ts` instead of ad-hoc inline logic, so the flow↔kernel contract test validates the code that actually runs.
- **`cap_policy` honored**: `flow.defaults.{capPolicy,onDepScrap}` are surfaced on `FlowConfig` (validated at load) and applied via the FSM — `proceed_with_findings` now advances a card at the rework cap instead of always scrapping.
- **Effectful-station outbox wired** into both station kinds (gated on `station.effectful`): `writePendingIntent → perform → commitIntent`, fail-closed on resume so a billed/irreversible effect is never double-fired.
- **Progress-monotonicity guard enforced** (SPEC §6 guard #3): a rework whose critic findings hash matches the prior attempt scraps immediately instead of burning the cap.
- **DB migration + self-heal**: additive `v2→v3` migration (adds `rework_count`); the journal DDL runs idempotently so an existing DB gains `card_log` instead of bricking. State DB now opens in **WAL** mode (SPEC §11).
- **Checkpoint skip-on-resume**: a matching binding-stamp checkpoint is reused before dispatch, so an interrupted pure transform is not re-billed on resume.
- **Model adapter survives transient gateway errors**: bounded retry with capped backoff on `429` and transient `5xx` (502/503/504) — a single `503` was previously a fatal halt; non-transient errors (404/401) still surface immediately. The `429` retry-after delay is clamped.
- **Resume recovers crashed-mid-work cards**: a fresh resume process reclaims orphaned `claimed`/`working` cards regardless of lease (`reclaimOrphanedWorkers`), and the executor re-dispatches `interrupted` cards — previously a card crashed under a long lease stayed stuck in `working`, never re-run.
- **Liveness watchdog** now reports the real blocking reason instead of `unknown`.
- **Output-path confinement** (symlink-aware) on transform outputs; in-station escalations are surfaced on `io.err` for parity with the planner's escalation path.

### Changed

- Renamed `src/law/hooks.ts` → `src/law/contract.ts` — it is the flow↔kernel **contract checker**, not Law enforcement (which lives in `worker/deterministic.ts`).
- Removed the dead `productionRunEngine` stub (the real `runExecutor` is always wired).

### Added

- **LiteLLM multi-provider gateway config** for the dogfood example (`examples/tiktok-shoppable-ideas/litellm.config.yaml`): one OpenAI-compatible endpoint routes each station's `model:` to its upstream provider (Gemini→Google, gpt-4o→OpenAI, optional local Ollama) with no flow/kernel change. README documents the setup.
- **Optional `creative_brief` input** in the dogfood flow: a free-text directive (threaded `request.json` → `context.json` via `fetch.sql`, backward-compatible) lets `ideate` feature a **net-new drop** not yet in the sales data; the critic treats briefed items as intentional launches. `top_hooks` guidance made null-safe.
- **CLAUDE.md** "built-as-library vs driven-in-production" guidance — documents which kernel modules are tested-but-not-yet-driven (wave budget, integrity hook, dag/expand, rank, planDrain) so they aren't mistaken for dead code.

## [Unreleased] — Card Transition Log + Rework Feedback Loop

### Added

- **Per-card append-only transition log** (WI-378): New `card_log` table tracks every lane entry, gate verdict (with findings), and terminal reason (scrap/hold), keyed by `card_id` and strictly ordered; logged atomically with card state transitions so history and state never diverge
- **Feedback rendering in maker prompts** (WI-379): `renderPrompt()` accepts optional `feedback` parameter that substitutes into reserved `{{feedback}}` placeholder; enables the maker to address the prior gate's findings on rework instead of re-running blind
- **Fail-closed feedback validation** (WI-380): Flow loader rejects prompts declaring `{{feedback}}` input on stations with no `check.on_reject` back-edge — the feedback input is only meaningful on reworkable stations; invalid wiring caught at load, not runtime
- **Transition logging at executor seams** (WI-381, WI-382): Executor appends `entered_lane` entries on every card advance and `gate_verdict` entries on every check (capturing verdict, findings text, return_to target, and attempt count); all appends keyed to `(card_id, station, attempt)` for idempotent resume
- **Feedback folded into binding stamp** (WI-383): Rendered feedback participates in the checkpoint binding stamp, so resumed stations treat pre- and post-feedback runs as distinct checkpoints; prevents resume from skip-replaying a stale pre-feedback output as if it satisfied the new feedback inputs
- **Card log inspection via CLI** (WI-384): `conduit journal inspect <cardId>` surfaces ordered transition log entries for human triage at `hold`/`scrap` terminals
- **Dogfood prompt feedback integration** (WI-385): `examples/tiktok-shoppable-ideas/prompts/ideate.md` updated to consume feedback block; "acknowledge the gap" instruction now conditional on `days_since_last_video > 30`, eliminating false-freshness hooks the gate correctly rejects

### Changed

- **Rework feedback loop enabled** (WI-383, WI-386): Gate verdicts no longer discarded in `gate-rework.ts` — findings text persisted to `card_log` and rendered into next attempt; accumulated feedback enables rework to converge instead of burning the cap by repeating identical inputs
- **GateReworkDecision expanded** (WI-382): All rework branches now carry `findings` (the critic's text), `verdict` (pass/reject), `returnTo` (target lane), and `attempt` (execution count); findings text feeds the feedback-rendering path
- **gitignore expanded** (WI-378): Added `conduit.*.sqlite*` (journal/state DB ephemeral files) and `examples/**/context.json|idea.json|request.json` (dogfood artifacts) to prevent runtime/dogfood noise in the tree

### Technical Details

- **Build order steps 1–7 MVP + real-run path**: Deterministic + transform stations only; flow config surface completed; production executor implemented with atomic dispatch, schema validation, and bounded rework
- **Binding stamp + checkpoint soundness**: Changed `prompt_version` in flow.yaml invalidates checkpoints, forcing re-run of affected stations; exactly-once semantics via outbox + idempotency key on resume
- **Fail-closed validation**: Invalid flows (unknown topology targets, missing prompts, undeclared prompt inputs, missing output schemas) rejected at load time, never at runtime
- **Token tracking**: Real per-call token/cost spans recorded in journal; consumption andon halts runaway flows on token or wall-clock budget
- **Test coverage**: 521 tests (up from 304); added controller-driven e2e, dogfood conformance suite, real-run oracle, crash-and-resume proof
- **Security**: OpenAI API key read only at call time; never logged or included in errors; credential hygiene maintained across late-binding adapter

### Migration Notes

This release ships the **minimal real-run path** (build-order step 7.5): a fully deterministic production executor for transform + deterministic flows, with real model calls, prompt rendering, schema validation, and bounded rework. Crash-and-resume uses existing binding-stamp and outbox machinery.

See [`docs/build-order.md`](../../docs/build-order.md) for post-MVP roadmap (steps 8–10: ingress listener, agentic Tool-Bridge, kaizen).

## [0.1.0] — 2026-06-03

### Added

- **Kernel domain types** (WI-289): Lane/status FSM, card structure, flow contract — the data model for a deterministic flow-shop
- **Persistence layer** (WI-290): Split architecture with state DB (SQLite WAL) + append-only journal for correctness and cost attribution
- **Flow validation** (WI-292): `flow.yaml` loader with fail-closed checks (unknown targets, unreachable terminals, cyclic deps, overlapping owned paths, hold_timeout without on_timeout)
- **Atomic claim + heartbeat lease** (WI-294): Single-point dispatch (deps AND WIP AND free slot in one BEGIN IMMEDIATE txn) with lease-based reconcile on resume
- **Deterministic tick planner** (WI-295): Pure action-plan controller — no LLM in the routing loop, replays deterministically from SQLite
- **Worker runtimes** (WI-296, WI-297):
  - **transform** — one kernel-mediated model call + coercive schema parse (no tools, no loop)
  - **deterministic** — subprocess dispatch with positive command allowlist + output capture
  - **MARK_DONE integrity hook** — separate from QC; resolves symlinks, validates owned-path containment, enforces schema
- **Checkpoint binding stamp + outbox** (WI-298): Skip completed stations only on input/prompt/flow-version match; effectful stations never re-execute on resume (idempotency key + outbox)
- **Rework engine** (WI-299): Four independent guards (per-card cap → scrap, per-execution-attempt cap, findings-hash monotonicity, budgets at card/wave/run scope)
- **QC stations** (WI-300): gate (converge findings via back-edge rework) and rank (curate, never auto-pick — human-in-the-loop)
- **Liveness watchdog + consumption andon** (WI-301): Distinct semantics — watchdog catches deadlock (claimed w/o worker + no progress); andon drains on budget/wall-clock runaway
- **Dynamic fan-out/fan-in** (WI-302): all/quorum/best_effort policies with dependency-wave validation (DFS cycle detection, Kahn topological sort)
- **Output adapter + channels** (WI-303): Slack egress channel with correlation IDs, outbox-guarded to prevent double-posts; hold_timeout on_timeout support
- **Work Bench** (WI-304): Single-station fixture runner for offline skill-lab validation
- **Law-lite hooks + tests** (WI-305): Owned-path containment (symlink + `..` resolution), command allowlist (no shell metacharacters), secret-key journal filter — all with unit tests
- **CLI lifecycle** (WI-306): `conduit run`, `conduit resume`, `conduit doctor` (prereq probes), `conduit journal` (read-only inspect/tail)
- **E2E reference flow** (WI-307): Synthetic golden flow exercise every branch (clean path, gate back-edge, rank HITL, fan-in quorum, scrap at cap, hold-timeout)
- **Crash-recovery oracle** (WI-308): Injected-crash proof — verifies zero re-bill, exactly-once effects, no blind-retry, byte-identical artifact across resume

### Technical Details

- **Build order steps 1–7** (MVP kernel): deterministic + transform stations only, no agentic surface (Law applies only to agentic)
- **Test coverage**: 304 tests across 21 test files
- **Typecheck**: `tsc --noEmit` clean, strict mode
- **Recovery soundness**: Crash oracle proves exactly-once semantics across 4 injection seams
- **Security**: Owned-path containment + command allowlist tested; secret hygiene enforced in worker context + journal filter

### Project Structure

```
src/
├── types/             — kernel domain types + FSM
├── persistence/       — split DB + journal schema
├── flow/              — loader + validator + DAG utils
├── dispatch/          — atomic claim + reconcile
├── controller/        — deterministic tick planner
├── worker/            — transform/deterministic runtimes + integrity hook
├── checkpoint/        — binding stamp + outbox
├── quality/           — rework engine + gate/rank stations
├── control/           — watchdog + andon
├── dag/               — fan-out/fan-in policies
├── output/            — adapter + asset tagging
├── channels/          — Slack egress
├── law/               — hooks: path ownership, command allowlist
├── bench/             — Work Bench fixture runner
├── cli/               — run/resume/doctor/journal
├── integration/       — reference flow + crash oracle
└── index.ts           — kernel exports

fixtures/
├── flows/reference.flow.yaml     — golden synthetic reference flow
└── flows/invalid/                — 4 fail-closed validation fixtures
```

### Migration Notes

This is the first release of the Conduit kernel (build-order steps 1–7). The kernel itself is stable and production-ready for transform + deterministic flows. The agentic surface (Tool-Bridge, Law full-strength, kaizen calibration) comes in steps 8–10.

See [`docs/build-order.md`](../../docs/build-order.md) for the post-MVP roadmap.
