---
missionId: ~
---

# Multi-Flow Engine: Ingress Run Identity, Per-Run Workspaces, and Flow Composition

**Author:** Josh Owens  **Date:** 2026-07-10  **Status:** Implemented (v1) on `feature/multi-flow-engine` — see Resolved Decisions

## 1. Context & Background

The multi-flow proposal asks Conduit to evolve from one-process-per-flow into a **long-running engine that
loads N flow definitions**: owns the channel connections, routes ingress to the right flow,
amortizes idle memory across rarely-firing flows, and lets a flow invoke another flow as a
station. The motivating consumer is the Slack Product Studio (ArcaneLayer `naming-flow`):
several small chained flows, each firing a handful of times a day, on one box, behind one
Slack app.

**Where the code already is.** More of that proposal exists than its initial framing assumes. The ingress
listener (`startListener`, `src/ingress/listener.ts`) already hosts an **N-flow allowlist**
(`conduit listen --flows name=path,name=path,...`), routes webhook routes and Slack channels
to their owning flow, and — with Slack Socket Mode support — creates **one Socket Mode connection per distinct app
token, shared across all flows using that app** (`listener.ts:228-231`). The round-robin
envelope-splitting problem in the proposal is already solved *structurally* for flows hosted
in one listener process. The listener spawns a `conduit run` subprocess per event — which is
exactly the supervisor model suggested to resolve the isolation trade-off.

**Where it actually breaks.** The multi-flow listener is unusable in production because run
identity and filesystem identity are global, not per-event:

1. **Shared default run id.** The spawn seam launches `conduit run <flowPath>
   --input-inline <json>` with **no `--run-id`** (`src/cli/main.ts` spawn seam). Two events
   arriving close together collide on the default run; the per-run advisory lease correctly
   fails the second — and that event stays dropped until someone restarts the listener,
   because re-drive is **boot-only** (`redriveOnBoot`, `src/ingress/recovery.ts`).
2. **`ingress_events` persists almost nothing.** The row is `(event_id, received_at,
   spawn_state, spawn_attempts)` (`src/persistence/db.ts:210-215`). No flow attribution →
   multi-flow re-drive is impossible (the production respawn seam marks every failed event
   **permanently failed** when the allowlist has >1 flow, `main.ts` respawn seam). No
   persisted payload → even single-flow re-drive relaunches the flow **with no input**
   (latent bug: the re-driven run gets an empty seed, not the event envelope).
3. **Concurrent runs clobber each other's files.** Flow-declared paths (`work/input.jpg`,
   `outputs:`) are project-root-relative and static, so N concurrent runs of one flow write
   the same files. Run namespacing partitions the DB, not the filesystem.

**The seam that makes this cheap.** The adapter-registration work made `projectRoot` a **per-run**
value threaded through every consumer — runner cwd confinement, `owned_paths` resolution,
the integrity gate, artifact resolution — and `registerRun` persists it per run. A per-run
workspace therefore does not need a new path-rewriting layer: it is *a per-run projectRoot
pointed at a per-run directory*. The real-world case behind the run-identity bug (5 photos posted in ~1s = 5
events, 1 run, 4 silently dropped) is fixed by run-id derivation + workspace isolation +
live re-drive, all through existing seams.

**Composition** (flow-as-station) is the genuinely new surface: the studio flow currently
inlines a copy of pic-edit's stations because a flow cannot call a flow.

## 2. Problem Statement

An operator cannot put N flows behind one Slack app and have events reliably become runs:
concurrent events collide on the default run id and are silently dropped until a listener
restart; a re-driven event loses its payload; failed events in a multi-flow listener are
unrecoverable by construction; and two concurrent runs of one flow corrupt each other's
working files. Separately, a flow cannot invoke another flow — forcing station-graph
copy-paste, which breaks the "flow is config" premise as soon as two flows share a segment.

## 3. Target Users & Use Cases

**Primary users:**

- **Operators** (first: the Decker team's single-box magi deployment) — run one daemon
  hosting several flows behind one Slack app; care that a new flow is cheap to add, that
  one flow's bad config doesn't take the others down, and that no event is silently lost.
- **Flow authors** — compose flows from other flows instead of inlining copies; care that
  budget, failure, and HITL semantics through the composition boundary are predictable.
- **The kernel team** — needs ingress identity fixed before any ingress binding whose event
  rate can exceed one-at-a-time (for Slack channels: the normal case, not the edge case).

**Key use cases:**

- An operator posts an album of 5 product photos to a bound Slack channel: 5 events → 5
  runs with distinct ids and disjoint workspaces, all 5 complete; none require a restart.
- A spawn fails transiently (box under load): the event re-drives automatically within the
  re-drive interval, with its original payload, without a listener restart.
- An operator adds Flow 2 to the running deployment: add one entry to the engine manifest,
  restart the daemon; Flow 1's in-flight state is unaffected (checkpoint resume + boot
  re-drive cover the gap).
- The studio flow declares `kind: subflow` station `edit-photo` pointing at the pic-edit
  flow; pic-edit iterates independently; the studio flow picks up improvements on its next
  run; the journal records parent-run → child-run lineage.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| No silent event loss under concurrency | The 5-photo album case: N near-simultaneous events on one channel | N runs complete; 0 dropped; 0 restarts needed |
| Re-drive without restart | A transiently-failed spawn recovers | Within one re-drive interval, with its original envelope payload |
| Multi-flow re-drive attribution | Failed events in an N-flow listener | Re-driven to their owning flow (no permanent-failure-by-ambiguity) |
| Filesystem-disjoint concurrent runs | Two concurrent runs of one flow with per-run workspace | Zero shared writable paths; both integrity gates anchored at their own workspace |
| One daemon, N flows | The Decker deployment: studio + pic-edit + Flow 2 behind one Slack app | One `conduit engine` process, one socket connection, correct routing |
| Composition without copy-paste | Studio calls pic-edit as a station | Child run spends parent budget; child scrap fails the calling station named; lineage in journal |
| No regression for single-flow CLI users | Existing `conduit run` / single-flow `listen` behavior | Byte-identical without new flags/config |

## 5. Scope

### In Scope

**Slice A — ingress run identity:**

- Spawn seam passes `--run-id` derived from the event id (sanitized to the run-id charset
  `[A-Za-z0-9_-]{1,128}`, collision-safe via content hash suffix).
- `ingress_events` gains flow attribution (`flow_id`, `flow_path`), the derived `run_id`,
  and the projected substrate payload, so re-drive is faithful: right flow, right input,
  same run id (idempotent with the original attempt via the run lease + checkpoint skip).
- Periodic re-drive: the listener re-runs the (existing) bounded re-drive sweep on an
  interval, not only at boot. Same attempt caps; no unbounded retry.
- The multi-flow respawn permanent-failure workaround in `main.ts` is deleted (obsoleted
  by attribution).

**Slice B — per-run workspaces:**

- Opt-in per flow (`defaults.workspace: per_run` in flow.yaml): the kernel materializes a
  per-run directory `<project_root>/.conduit/runs/<run-id>/` and binds it as the run's
  effective projectRoot through the existing per-run seam (runner confinement,
  owned_paths, integrity gate, artifact resolution all follow automatically).
- Seed staging, station inputs/outputs, and `work/` files resolve inside the workspace;
  flow-adjacent read-only assets (prompt templates) keep resolving against the flow
  directory as today.
- Workspace lifecycle: created at run registration, retained on completion (operator
  cleanup / retention policy is a documented convention, not a reaper — v1).

**Slice C — the engine surface:**

- `conduit engine` (or `listen` grown; naming decided at decision walk) driven by an
  **engine manifest file** declaring the hosted flows (name → path, per-flow overrides),
  replacing unwieldy comma-joined `--flows` for real deployments (which stays for
  single-flow/dev use).
- **Per-flow fail-closed loading**: a flow that fails validation is quarantined with a loud
  boot report + alert; the remaining flows serve. `conduit doctor --engine <manifest>`
  validates all flows strictly (CI/deploy-time gate).
- Reload = restart (v1): documented operator flow; boot re-drive + checkpoint resume +
  Slack retry cover the connection gap. Hot-swap is out of scope.
- Supervisor process model pinned: the engine routes and spawns per-run `conduit run`
  subprocesses (current listener shape). True in-process execution of N flows is
  explicitly rejected for v1 (isolation).

**Slice D — flow-as-station composition:**

- New station `kind: subflow` naming a child flow by path. Executor runs the child flow as
  a subprocess (`conduit run`) with a derived child run id (`<parent-run>--<station>--<attempt>`),
  a per-run workspace, and the station's input artifact as seed.
- **Budget:** the child is launched with the parent's *remaining* run budget as its run
  cap; on completion the child's journaled spend is attributed into the parent's run/wave
  budgets (one ceiling per user intent).
- **Failure:** child terminating in `scrap`/`hold`-timeout fails the calling station as a
  normal named attempt failure (attempt-cap path applies; rework guards unchanged).
- **HITL:** v1 — a child hold surfaces through the child's own egress channels, and the
  parent's calling station simply remains in-flight until the child resolves or times out;
  parent-context (thread) surfacing is a fast-follow once resume-on-reply lands.
- **Cycles/depth:** flow load resolves `subflow` references recursively; A→B→A dies at
  load (DFS, same discipline as station-graph cycle detection), plus a hard depth cap.
- Journal lineage: parent run id + station recorded on the child run; `conduit explain`
  renders the parent→child edge.

### Out of Scope

- **Hot-swap / watch-mode reload** of flow definitions (restart is the v1 story).
- **In-process multi-flow execution** (rejected: supervisor model instead).
- **Workspace retention/GC policy** beyond documentation (v1 retains; a reaper is follow-up).
- **Parent-thread HITL surfacing for child holds** (depends on resume-on-reply; fast-follow).
- **Cross-engine distribution** (N boxes) — single-host only, per `docs/single-host-concurrency.md`.
- **The agentic Tool-Bridge** (step 9b) and **kaizen** (step 10).
- **Array projection** — adjacent ingress work, separate feature.

## 6. Requirements

### Functional Requirements

**Slice A — run identity**

1. Every ingress-spawned run shall carry a run id derived deterministically from its event
   id: sanitize to the run-id charset, truncate, and suffix with a short content hash of
   the raw event id so distinct event ids never map to one run id. Re-drives of the same
   event shall reuse the same run id (idempotent resume, not a fresh run).
2. `ingress_events` shall persist, per event: owning flow name and flow path, the derived
   run id, and the projected substrate JSON passed as `--input-inline`. Migration is an
   additive `ALTER TABLE` rung on the existing `PRAGMA user_version` ladder; pre-migration
   rows (no attribution) remain re-drivable only in single-flow listeners, as today.
3. The re-drive sweep shall run at listener boot AND on a configurable interval
   (default 60s) while the listener serves. Both paths share one implementation and one
   attempt cap; a row at cap is never re-driven. The interval sweep shall tolerate
   concurrent live deliveries of the same event (the accept-gate dedup already covers this).
4. Re-drive shall launch the event's *owning* flow with its *persisted* substrate and its
   *derived* run id — never a bare `conduit run <flowPath>` with no input. The multi-flow
   permanent-failure-by-ambiguity path shall be removed.
5. If two distinct events legitimately race on one derived run id (hash collision), the
   second shall fail the run lease as today but remain re-drivable — never permanently
   failed by the collision.

**Slice B — workspaces**

6. A flow with `defaults.workspace: per_run` shall have each run's effective project root
   bound to `<resolved_project_root>/.conduit/runs/<run-id>/`, created at run
   registration. All per-run path consumers (seed staging, station inputs/outputs,
   `owned_paths` resolution, integrity gate, harness cwd confinement) shall anchor there
   via the existing per-run projectRoot binding — no consumer may resolve against the
   outer root while the workspace is bound.
7. Two concurrent runs of one `workspace: per_run` flow shall be filesystem-disjoint by
   construction (acceptance-tested with genuinely concurrent runs, not sequential).
8. `conduit resume` of a workspace run shall re-anchor at the *recorded* workspace path
   (the recorded-projectRoot behavior covers this; acceptance-tested).
9. Flows without the opt-in shall behave byte-identically to today.

**Slice C — engine**

10. The engine shall accept a manifest file (YAML) declaring hosted flows (name → path,
    optional per-flow settings). `--flows name=path` stays as the inline form; supplying
    both is an error.
11. A flow failing load/validation shall be quarantined per-flow: the engine boots the
    valid subset, reports each quarantined flow loudly at boot (stderr + the flow's alert
    channel if resolvable, else global), and serves 503-equivalents / drops-with-log for
    the quarantined flow's routes. An engine whose manifest yields zero valid flows shall
    fail boot.
12. `conduit doctor --engine <manifest>` (exact surface at decision walk) shall validate
    every declared flow strictly and exit non-zero on any failure — the CI/deploy gate that
    keeps per-flow quarantine from hiding config rot.
13. Ingress routing across N flows shall remain per-channel/per-route with collision
    detection at boot (existing `validateIngressBindings` behavior, now load-bearing for
    the engine story).
14. One Socket Mode connection per distinct app token shall serve all hosted flows (already
    true; pinned by an engine-level acceptance test so it survives refactors).

**Slice D — composition**

15. A station may declare `kind: subflow` with a `flow:` path. Load validation shall
    resolve the child flow transitively, failing on: unresolvable path, invalid child
    flow, reference cycles (A→B→A at any depth), or nesting deeper than the cap
    (default 3).
16. Dispatching a subflow station shall run the child flow to terminal state as a
    subprocess with: a derived child run id (`FR-1` discipline, parent-run-scoped), the
    station's input artifact as seed, a per-run workspace, and the parent's remaining run
    budget (tokens and wall-clock) as the child's run budget.
17. On child completion: child `done` → the station's declared outputs are taken from the
    child's terminal artifacts and the station completes; child `scrap` (or budget halt) →
    the station attempt fails named with the child's scrap reason; the normal
    per-card attempt cap and rework guards apply unchanged.
18. The child's journaled token/cost spend shall be attributed into the parent's run and
    wave budget accounting (spend is counted once at each scope, no double-count within
    the child).
19. The child run shall record parent lineage (parent run id, calling station, attempt);
    `conduit explain` shall render the parent→child relationship.
20. A child run hitting `hold` shall follow its flow's HITL semantics (its own egress +
    `hold_timeout`); the parent station stays in-flight; a child hold timing out to scrap
    follows FR-17's failure path.

### Non-Functional Requirements

1. **No LLM in any new control path** — routing, re-drive, workspace binding, and child
   dispatch are all deterministic kernel decisions.
2. **Fail-closed validation stays load-time**: every new config surface (manifest,
   `workspace:`, `kind: subflow`) is validated before anything runs; quarantine (FR-11) is
   loud, never silent.
3. **Exactly-once discipline preserved**: re-drive reuses run ids so checkpoint
   skip-on-resume and the effectful outbox keep their guarantees across re-driven runs;
   the accept-gate dedup remains the single ingress entry gate.
4. **Migration additive**: schema changes ride the existing user_version ladder;
   downgrade-incompatible changes are rejected as today.
5. **Docker posture unchanged** (ADR-0003): manifest + workspaces live on the mounted
   volume; secrets stay env-only.

### Edge Cases & Error States

- **Same Slack event delivered twice while the first spawn is in flight** — accept-gate
  dedup returns `duplicate`; no second run (existing behavior, retested with run ids).
- **Re-drive fires while the original run is still alive** (slow spawn, not dead) — same
  run id → the per-run lease makes the re-driven process fail fast as a *transient* failure;
  the sweep retries later; when the original completes, re-drive finds the run terminal
  and marks the event spawned (needs an explicit "run already terminal" check → treat as
  success, not attempt-burn).
- **Workspace directory creation fails** (permissions, disk) — run registration fails
  named before any station dispatches; the event's spawn is a transient failure, re-drivable.
- **Pre-migration ingress rows after upgrade** — no attribution/payload: excluded from
  multi-flow re-drive with a one-time loud log naming the count; single-flow behavior
  unchanged.
- **Manifest declares two flows with the same name** — boot error naming both (config
  validated, not trusted).
- **Every flow in the manifest quarantined** — engine refuses to boot (an "engine serving
  nothing" is a misconfiguration, not a service).
- **Child flow's own budget declared larger than parent's remainder** — the effective
  child budget is `min(child_declared, parent_remaining)`; the tighter ceiling always wins.
- **Parent killed (andon/watchdog) while child in flight** — the parent's drain path kills
  the child subprocess group; the child's checkpoints make its partial work resumable if
  the parent resumes.
- **Subflow child is itself `workspace: per_run`** — workspaces nest under the child's own
  run id; no interaction with the parent workspace (disjoint by run id).
- **Depth-cap hit via a chain of otherwise-legal references** (A→B→C→D, cap 3) — load
  error naming the full chain.

## 8. Solution Approach

Three moves, in dependency order:

1. **Make run identity per-event** (slice A): widen `ingress_events` additively, derive
   run ids in `runSpawnPath`, extend `SpawnInvocation` with `runId`, generalize
   `redriveOnBoot` into a sweep invoked at boot + on interval, and rewrite the production
   respawn seam to use persisted attribution. Pure extension of the existing seams; every
   piece is unit-testable against the fake spawn seam the ingress tests already use.
2. **Bind workspaces through the recorded-root seam** (slice B): resolve the effective per-run
   projectRoot at `registerRun` time (`workspace: per_run` → materialize + record the
   workspace path), and let the recorded-root machinery carry it everywhere,
   including resume. The owned-paths disjointness validation runs against
   workspace-relative paths, giving per-run (not global) disjointness for free.
3. **Grow the listener into the engine** (slice C), then **compose** (slice D): the
   engine is the listener + manifest + per-flow quarantine + periodic sweep; composition
   is a new executor station kind whose "worker" is a child `conduit run` — the same
   supervisor pattern the ingress spawn path already uses, so budgets, leases, checkpoints,
   and workspaces all apply to children with no new machinery.

Slices A and B ship together (A alone makes clobbering *more* likely, as the run-identity analysis notes).
C is independently shippable after A+B. D depends on A (run-id discipline) and B
(workspaces) but not C — matching the proposal's observation that composition could ship before
the engine.

## 9. Technical Considerations

**Constraints:** Bun runtime; SQLite state DB with the user_version migration ladder;
Docker-first (ADR-0003); single-host concurrency model (`docs/single-host-concurrency.md`);
the per-run advisory lease is the concurrency backstop for everything here.

**Dependencies:** per-run projectRoot support is implemented and required by slices B/D.
Resume-on-reply gates only the parent-thread HITL fast-follow, not this PRD. The ingress analysis's
external Socket-Mode wrapper workaround retires when slices A+B ship.

**Integration points:** `src/ingress/spawn.ts` (`SpawnInvocation`, `runSpawnPath`),
`src/ingress/recovery.ts` (sweep generalization), `src/ingress/listener.ts` (interval
timer, quarantine), `src/persistence/db.ts` (ingress_events migration + accessors),
`src/cli/main.ts` (spawn/respawn seams, engine command, manifest loading),
`src/flow/load.ts` (workspace/subflow validation, transitive resolution),
`src/controller/executor.ts` (subflow dispatch), `registerRun` (workspace materialization),
`src/quality/rework.ts` / wave-budget aggregation (child spend attribution).

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Run-id derivation from arbitrary event ids collides or leaks weird charsets | Low | Cross-event state bleed | Sanitize + content-hash suffix; property-test the derivation; FR-5 keeps collisions re-drivable |
| Workspace binding misses a path consumer (something still resolves against the outer root) | Medium | Clobbering returns through a side door | Enumerate consumers from the project-root threading tests (they already pin the seam); acceptance test = two truly concurrent runs diffing each other's trees |
| Child-budget attribution double-counts or undercounts at wave scope | Medium | Andon fires wrongly / runaway hides | Single attribution point (child terminal → one parent journal span); property test: parent total == own spend + Σ child spend |
| Subflow subprocess lifecycle leaks (parent dies, child orphaned) | Medium | Zombie runs burning tokens | Process-group kill in the existing drain path; child holds its own lease so a re-parented child is at least visible |
| Per-flow quarantine hides config rot (operators stop noticing) | Low | Slow config decay | FR-12 strict doctor as the deploy gate; quarantine alerts on the flow's own channel |
| Engine manifest becomes a second config dialect drifting from flow.yaml conventions | Low | Operator confusion | Keep it minimal (name→path + few overrides); validate with the same loader machinery |

### Resolved Decisions (2026-07-10, v1 implementation on `feature/multi-flow-engine`)

- [x] **Command surface: grew `conduit listen`** — `--manifest <engine.yaml>` (quarantine
  mode) and `--validate` (strict dry boot, CI gate); no separate `engine` command. One
  long-running-process story, less surface. (→ FR-10/11/12)
- [x] **Workspace default: opt-in** (`defaults.workspace: per_run`); flipping the default
  for ingress-bound flows stays a v2 decision. (→ FR-6..9)
- [x] **Re-drive interval: 60s default**, `CONDUIT_REDRIVE_INTERVAL_MS` override; sweeps
  serialize (an overlapping tick is skipped, attempts stay bounded). (→ FR-3)
- [x] **Subflow output contract: shared-root declared outputs.** v1 runs the child in the
  PARENT's project root (deviation from the FR-16 draft, which said per-run child
  workspace): the subflow station's `outputs:` are paths the child writes directly, read
  by the parent with no copy step. A child that reports done without producing them fails
  the attempt named (`subflow-output-missing`). Filesystem isolation between subflow
  siblings can come later by nesting child roots — the seam already carries projectRoot.
  Interaction rule making this robust: an explicit `--project-root` (what the parent
  passes) suppresses the child's own `workspace: per_run` derivation — a child flow that
  runs standalone with a per-run workspace still lands its outputs exactly where the
  calling parent reads them.
- [x] **Child HITL/hold ownership: the parent's attempt burns.** A child that terminates
  `halted` (stall or hold outlasting the child process) is a named attempt failure —
  one escalation surface per level. Parent-thread hold surfacing stays a
  fast-follow. (→ FR-20 narrowed for v1)
- [x] **Channel collisions fail loud everywhere**: `CHANNEL_COLLISION` added to strict
  validation (the Slack transport follow-up); in quarantine mode every claimant is quarantined —
  never a silent last-wins winner. (→ FR-13)
- [x] **`explain` parent→child rendering deferred**: lineage is journaled (per-attempt
  `<station>.subflow` spans carry `child_run_id`; `getRunUsageTotals` exposes whole-run
  spend); the renderer edge is a small follow-up. (→ FR-19 partially met)
