---
missionId: ~
---

# Conduit — Run Namespacing (many jobs, one shared DB)

**Author:** Josh Owens  **Date:** 2026-06-23  **Status:** Done

> Scope note: this is the **kernel substrate** that lets multiple independent runs ("jobs") coexist
> in one shared `conduit.sqlite` and be driven/queried independently by a caller-supplied id. It is
> the prerequisite for the planned **API channel**, programmatic HITL, and resume-on-reply work, as well as the concurrent, shared-DB
> case that [`run-api.md`](../drafts/run-api.md) assumes. `run-api.md` notes it "changes no kernel semantics"
> — that holds for a single run; **concurrent** API jobs in a shared DB do require the kernel changes
> below. This PRD deliberately stops at the substrate: no HTTP surface, no channel schema, no
> resume-on-reply. Sequenced **before** the API channel.

## 1. Context & Background

Conduit was built one-run-per-database: `conduit run` seeds a single entry card under a fixed id,
drives the whole DB to terminal, and exits. That was right for a CLI batch tool and the
fire-and-forget ingress listener.

We now have a documented need to use Conduit as an **API-callable per-job worker**: an external
TypeScript + Postgres orchestrator drives a print farm, submitting many small flows (e.g. a VLM
color-match: maker → checker → gate → human hold) and retrieving each result by id. The design pass
for that API settled on a **shared database** with **caller-supplied run ids** (the orchestrator's
own job id, doubling as the idempotency key) — chosen over database-per-job so the farm UI can list
open human-gate holds across all jobs and share a single state store.

A spike confirmed the gap empirically: distinct-id runs already coexist in one DB at the data layer,
but the kernel assumes a single run everywhere it matters. Two concurrent jobs in one DB collide on
a fixed entry-card id, silently overwrite each other's checkpoints, and interfere through whole-DB
scheduling and resume. Until the kernel is run-aware, the shared-DB API channel cannot be built.

## 2. Problem Statement

Two or more runs cannot safely share one Conduit database. A second submission collides on the
fixed entry-card id; same-flow runs silently overwrite each other's checkpoints and collide on
outbox idempotency keys; and one run's executor or resume touches every other run's cards (driving,
completing, and reclaiming work that isn't its own). The result is that Conduit can drive exactly
one job per database — which blocks every shared-DB, multi-job API use case the orchestrator needs.

## 3. Target Users & Use Cases

**Primary users:**

- **Integrating engineer** building the external orchestrator — needs Conduit to behave as a
  reliable multi-job worker against one shared database, with each job independently addressable and
  fully isolated from its neighbors.
- **Conduit operator** running the shared kernel — needs many jobs in one database without them
  corrupting or stalling one another, and without losing today's single-run behavior.

**Key use cases:**

- The orchestrator submits Job A and Job B against the same database; each runs, completes, and
  yields its own result with no interference. (Isolation)
- The orchestrator re-submits a job with an id it already used; Conduit recognizes the id rather than
  creating a duplicate or erroring. (Idempotent addressing)
- Job A parks at a human gate (`hold`) while Job B runs to completion; resolving/resuming Job A later
  does not disturb Job B's in-flight work. (Independent lifecycle)
- An existing single-run flow (`conduit run flow.yaml`) keeps working unchanged, with no id required.
  (Back-compat)

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Multiple jobs coexist in one DB | Concurrent runs in one DB completing correctly with no cross-run interference | 1 → N (verified by the adversarial concurrency test) |
| No silent cross-run corruption | Checkpoint/outbox collisions across same-flow runs | Eliminated (0) |
| Independent run lifecycle | Resuming one run that touches another run's cards | 0 cross-run reclaims/drives |
| Addressable by id | Runs queryable/driveable by their run id | 100% of runs |
| No regression to single-run | Existing single-run flows and the full suite | 100% pass, behavior unchanged |

## 5. Scope

### In Scope

- A **run identity** concept: every card belongs to exactly one run, identified by a run id supplied
  by the caller (or defaulted for back-compat).
- **Isolation of scheduling**: a run's executor only promotes, dispatches, completes, counts, and
  applies liveness/terminal logic to its own run's cards.
- **Isolation of durable state**: checkpoints and the effectful outbox are keyed per run, so two
  runs of the same flow cannot overwrite or collide with each other.
- **Run-scoped resume**: resuming a run only reclaims and re-drives that run's in-flight work.
- **A unique per-run entry card** in place of the fixed entry-card id.
- **Back-compat**: a single run with no id behaves exactly as today.
- An **adversarial concurrency acceptance test** that pins isolation (see Requirements).

### Out of Scope

- The API channel HTTP surface (submit / `GET /runs/:id` / resolve / result callback) — downstream
  ([`run-api.md`](../drafts/run-api.md) and the API-channel PRD).
- The bidirectional `api` channel schema in `flow.yaml`.
- Programmatic (non-Slack) HITL, binary approve/reject gates, and resume-on-reply wiring.
- Postgres or any storage-engine change. Run-namespacing is engine-agnostic application logic; the
  write-concurrency ceiling of shared SQLite is noted under Technical Considerations but not addressed
  here.
- Cross-run aggregate queries (e.g. "list all open holds") — a thin read concern for the API layer.

## 6. Requirements

### Functional Requirements

1. Every card shall belong to exactly one run, identified by a run id, recorded durably at card
   creation.
2. **Card identity shall be per-run**: two runs of the same flow may contain the same internal
   (flow-authored) card ids — e.g. fan-out children `p01` — without collision; uniqueness is per run.
3. `conduit run` shall accept a caller-supplied run id; when none is supplied it shall use a stable
   default so existing single-run usage is unchanged. A caller-supplied run id shall be validated to
   a safe, bounded character set and rejected fail-closed if invalid.
4. Re-submitting with a run id already present shall be **idempotent**: no new work is started and
   the run's current state is returned (in-flight → status; terminal → result). If the re-submit's
   flow or input differs from what is recorded for that id, it shall be rejected as a conflict rather
   than returning or mutating the existing run.
5. A run's executor shall promote, dispatch, complete, count (held/stuck/WIP), and evaluate
   liveness and terminal/exit conditions **only** over its own run's cards.
6. A run shall reach terminal/exit based solely on its own cards' states; another run's non-terminal
   or held cards shall not keep it running, nor shall its completion be falsely declared because
   another run finished.
7. Checkpoints shall be isolated per run: two runs of the same flow with the same card/station shall
   not read or overwrite each other's checkpointed output.
8. The effectful outbox shall be isolated per run: two runs shall not collide on an idempotency key
   nor observe each other's pending/committed intents.
9. Fan-out children shall belong to the same run as their parent, recorded at creation (not derived
   by walking ancestry at read time).
10. `conduit resume --run <id>` shall reclaim and re-drive only that run's in-flight cards. Bare
    `conduit resume` (no run) shall perform operator crash-recovery by driving every non-terminal
    run, each scoped independently — never a single un-scoped whole-DB sweep.
11. Run state shall be retrievable by run id (the substrate for a later status/result endpoint),
    distinguishing at least: running, held (and on what), and terminal (with outcome).
12. A run's entire footprint (cards, checkpoints, outbox, journal) shall be deletable as a single
    unit by run id. No retention policy or prune command is built here — this only guarantees that
    cleanup is cheap and complete for a later operations/API decision.

### Non-Functional Requirements

1. **No regression**: existing single-run flows shall behave identically; the full test suite shall
   pass.
2. **No silent failure**: any cross-run collision that cannot be isolated shall fail loudly, never
   silently overwrite or mis-attribute (a missed isolation point must be detectable, not corrupting).
3. **Durability/recovery preserved**: crash/resume soundness (binding-stamp skip, exactly-once
   effects) shall continue to hold per run.
4. **Schema migration**: an existing single-run database shall upgrade in place without data loss and
   without manual intervention.

### Edge Cases & Error States

- Re-submitting an id that already reached a terminal state — recognized, not re-run from scratch.
- Two runs of the **same flow** with overlapping internal card names (e.g. identical fan-out child
  ids) — isolated, no collision.
- A run with a parked `hold` while another run completes — neither disturbs the other; the holding
  run remains resumable.
- Resume invoked for a run id with no in-flight cards — a safe no-op, not a reclaim of other runs.
- A legacy (pre-migration) database with un-namespaced cards — adopted under the default run id.
- A crash with two runs in flight — resume recovers each run independently, reclaiming only that
  run's orphaned work.

## 8. Solution Approach (strategy)

**Per-run scoping, not a scheduler daemon.** Each run is driven by its own executor process scoped to
its run id — the model the worker pool and the API channel's spawn-per-submit already assume. Every
place the kernel reasons about "the cards" becomes "this run's cards," and the durable stores
(checkpoints, outbox) gain a run dimension. The alternative — a single long-lived daemon multiplexing
all runs — was rejected for this iteration: it would force per-run budget/andon state (today cleanly
process-local) into a shared, restart-fragile in-memory map, a much larger change for no near-term
need.

The run id is **caller-owned**: the orchestrator passes its existing job id, which doubles as the
idempotency handle and the query handle. Absent an id, a stable default preserves today's single-run
behavior verbatim. Identity is **per-run, not global**: card ids stay the flow-authored local ids
(`p01`, the entry card), and uniqueness is the pair of (run, card) — so two runs of the same flow
reuse the same readable internal ids without collision. The run id is the dimension every scoped
query, checkpoint, and outbox key carries.

Isolation is the whole game, so the load-bearing deliverable is an **adversarial concurrency test**:
two runs of the same flow in one database, one parked in `hold` while the other runs to completion,
then the held run resumed — asserting no shared checkpoint/outbox state, no cross-run promotion,
completion, or reclaim, and correct independent results. This test is what makes "we didn't miss an
isolation point" a verified claim rather than a hope.

## 9. Technical Considerations

**Dependencies / sequencing:**
- This PRD is a **prerequisite** for the API channel and the concurrent path of [`run-api.md`](../drafts/run-api.md).
- It depends on no other unshipped work; it builds on the existing FSM, atomic claim, checkpoint, and
  outbox.

**Migration:**
- Introduces a storage migration (a run dimension on cards, plus run-keyed checkpoints and outbox).
  Must upgrade an existing single-run database in place with legacy rows adopted under the default
  run id. Bumps the schema version.

**Known constraint (explicitly deferred):**
- Shared SQLite serializes writes (one writer at a time, even in WAL). With per-run processes, many
  concurrent jobs contend on a single write lock; the kernel is the sole writer through one
  connection today. This is fine for a single-host farm at tens of concurrent jobs but is a
  throughput ceiling at higher concurrency. Removing it implies a storage-engine change (e.g.
  Postgres with `FOR UPDATE SKIP LOCKED`), which is a separate, larger initiative — out of scope
  here. Run-namespacing is engine-agnostic and does not preclude that later move.

**Integration points:**
- Touches the executor scheduling loop, the dispatch/claim + resume path, the checkpoint and outbox
  stores, fan-out child creation, and the `conduit run`/`resume` CLI surface.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A single missed scoping point → silent cross-run interference | Medium | High (data corruption / wrong results) | The adversarial concurrency test is the gate; non-functional req: any un-isolatable collision must fail loudly, never silently overwrite |
| Schema migration corrupts/loses existing single-run data | Low | High | In-place migration with legacy rows adopted under the default run id; tested against a real pre-migration DB |
| SQLite write-lock contention under many concurrent jobs | Medium | Medium (throughput, not correctness) | Acceptable for the single-host farm target; documented; Postgres is the later lever |
| Default-run back-compat subtly changes single-run behavior | Low | Medium | Full suite must pass unchanged; default id path treated as the existing behavior |

### Resolved Decisions

The discovery open questions were walked and decided; they are now firm requirements above and are
recorded here for traceability:

- **Re-submit of a known id → idempotent** (Req 4): return existing (in-flight → status, terminal →
  result); reject as a conflict if the flow/input differs. Chosen for at-least-once retry safety —
  re-running would re-execute effectful work on a mere network retry.
- **Bare `conduit resume` → recover-all, scoped per run** (Req 10): `--run <id>` for one run;
  no-flag resume drives every non-terminal run independently, never an un-scoped whole-DB sweep
  (the cross-run reclaim hazard this PRD fixes).
- **Card identity → composite (run_id, card_id)** (Req 2): flow-authored local ids stay readable and
  meaningful; uniqueness is per run. Rejected prefixing ids (leaky at every owned-path/journal
  boundary) and generated global ids (largest churn, least readability).
- **Retention → deferred; per-run deletion guaranteed** (Req 12): no prune/TTL in this PRD, but a
  run's full footprint is deletable as a unit by run id. The retention *window* is an API/ops
  decision coupled to how long results stay fetchable — designed downstream.

### Open Questions

- [ ] None blocking. The run-id charset/length specifics (Req 3) are a planning detail, not a design
      fork.
