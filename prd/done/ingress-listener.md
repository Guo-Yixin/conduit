---
missionId: ~
---

# Conduit — Ingress Trigger-Listener

**Author:** Josh Owens  **Date:** 2026-05-31  **Status:** Done

> Scope note: this is a **post-MVP** PRD — build-order step 8
> ([`docs/build-order.md`](../../docs/build-order.md#after-the-mvp)). It depends on the
> shipped MVP kernel ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)): a working
> `conduit run`, the per-run daemon process model, and the egress channels are all
> assumed present. The *how* lives in [`SPEC.md §4A`](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery)
> and [`§10A`](../../SPEC.md#10a-process-model--a-resident-per-run-daemon); this document
> defines *what must be true* and *why*, and stays implementation-free.

## 1. Context & Background

The MVP ships with egress wired and ingress manual: a flow is triggered by a human typing
`conduit run <flow.yaml>`. That is deliberate. Egress needs no long-lived listener — the
running kernel posts status, solicits HITL, and delivers directly. Ingress is the one place
where "listen continuously" collides with the kernel's process model.

That collision is **the one architectural fork** in the channel design
([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery)). Listening
on Slack or a webhook endpoint wants a process that stays up indefinitely. But the kernel is
a **per-run daemon** ([SPEC §10A](../../SPEC.md#10a-process-model--a-resident-per-run-daemon)):
it is spawned for a flow, drives it to a terminal state, and exits. An always-on multi-flow
kernel service (`conduitd`) is explicitly deferred — it hits the multi-host boundary and the
SQLite single-writer ceiling ([SPEC §17](../../SPEC.md#17-future-watch-tracked-not-yet-designed) F1).

The SPEC resolves the fork by **splitting the concern**: a thin, long-lived trigger-listener
whose *only* job is "receive an external event → `conduit run`." It stays up cheaply because it
holds no flow state, runs no tick, and bills no tokens; the heavy per-run kernel is still
spawned per flow. This PRD specifies that listener.

## 2. Problem Statement

Without an ingress listener, every Conduit run requires a human to invoke the CLI. Real flows
are triggered by external events — a Slack message in a watched channel, a webhook POST from
an upstream system, a dropped file. Builders cannot wire these up without either (a) writing a
bespoke receiver per flow, re-solving event auth, dedup, and process-spawning each time, or
(b) making the kernel always-on, which breaks the per-run process model and inherits the
multi-host/single-writer problems the project deliberately defers. Conduit needs **one** thin,
reusable listener that maps an external event onto a parent card's substrate and spawns
`conduit run` — hands-off triggering **without** making the kernel a resident service, and
without ever double-billing a run because an event was delivered twice or the listener
restarted mid-event.

## 3. Target Users & Use Cases

**Primary user — the flow builder (engineer).** Has a working flow and wants it to fire on an
external event instead of a manual CLI call. Declares an ingress channel in `flow.yaml`
(`channels.ingress`), points the listener at it, and relies on the listener for event auth,
dedup, and clean spawn. Cares that a duplicate delivery never costs a second billed run.

**Secondary user — the flow operator (a customer).** A non-technical person who triggers a flow
simply by acting in the world they already use — posting in a Slack channel, or an upstream
tool firing a webhook — and then interacts with the run through the existing egress channels.
They never touch the CLI.

**Key use cases:**

- A builder wants a flow to **fire when a message lands in a watched Slack channel**, mapping
  the message (and any attachments) onto the parent card's substrate.
- A builder wants a flow to **fire on a webhook POST** from an upstream system, with the
  request body becoming the parent card's substrate.
- A builder needs the listener to **survive a restart without re-triggering** any run whose
  event it already accepted — a deploy or crash must not re-bill in-flight or completed work.
- An operator needs to **trigger a flow hands-off**, by acting in Slack, and then watch and
  steer the run entirely through the egress channels already shipped in the MVP.

## 4. Goals & Success Metrics

The listener is graded on **trigger correctness and dedup**, not throughput. It is a thin
shim; its whole value is that an external event maps to *exactly one* run, exactly once.

| Goal | Metric | Target |
|------|--------|--------|
| Map event → run | A valid event on a watched ingress spawns `conduit run` for the right flow with the event mapped onto the parent card's substrate | 100% of valid events |
| Dedup is exactly-once | Duplicate deliveries of the same `event_id` (incl. across a listener restart) that spawn a second billed run | 0 |
| Kernel stays per-run | An always-on resident kernel introduced by this work (the listener spawns and forgets; it does not host the tick) | 0 |
| Fail-closed on bad input | Malformed / unauthenticated / unknown-flow events that spawn a run instead of being rejected and logged | 0 |
| Spawn failures surface | Accepted events whose `conduit run` spawn fails silently (no alert, no recoverable record) | 0 |

**Explicitly NOT a goal:** high-throughput event ingestion, a queue/backpressure system, an
always-on multi-flow `conduitd`, or any change to how a run executes once spawned. The listener
ends its responsibility the moment `conduit run` is spawned.

## 5. Scope

### In Scope (build-order step 8)

- **A thin, long-lived listener process**, separate from the per-run kernel, whose only job is
  map event → substrate → spawn `conduit run`. It holds no flow state and runs no tick.
  ([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery),
  [§10A](../../SPEC.md#10a-process-model--a-resident-per-run-daemon))
- **Two ingress adapters: `webhook` and `slack`-events.** The `cli` adapter (manual trigger)
  already ships in the MVP and is the existing default in `channels.ingress`.
- **Event → substrate mapping** onto the parent card via a canonical deterministic **envelope**
  (D3), with an optional per-binding JSON-path projection; this kicks Wave 1
  ([SPEC §9](../../SPEC.md#9-dynamic-dag--waving)) when the spawned kernel starts.
- **Ingress dedup + recovery** via the `ingress_events` table (`event_id` PRIMARY KEY), extended
  with `spawn_state` + `spawn_attempts` (D1), so a listener restart or a duplicate delivery never
  re-triggers a billed run, and a recorded-but-never-spawned event is re-driven (not lost).
  ([SPEC §11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite))
- **An explicit flow allowlist** (D4) — the listener serves only the `flow.yaml` paths it is told
  to; binding details come from each flow's `channels.ingress`.
- **Event authentication** appropriate to each adapter (Slack request signing; a webhook
  shared secret/signature) and rejection of unauthenticated events.
- **A dedicated `ingress_log`** (D5) recording every event outcome (accepted / duplicate /
  rejected / spawn_failed / redriven), queryable and secret-filtered.
- **Spawn-failure surfacing** — an accepted event whose `conduit run` fails to spawn produces
  an alert over an egress/alert channel and leaves a recoverable `failed` record (D1).

### Out of Scope

- **Making the kernel always-on.** The `conduitd` multi-flow service is deferred (SPEC §10A,
  §17 F1). This work must not introduce a resident kernel.
- **Event queueing / backpressure / retry-with-delay.** The listener spawns and forgets; a
  durable queue between event and run is a future concern, not step 8.
- **New egress behavior.** Status, HITL, alerts, and delivery already ship in the MVP; this
  work only *triggers* runs.
- **Agentic stations and the Law** (build-order step 9) — orthogonal.
- **Additional ingress adapters** beyond `webhook` and `slack`-events (e.g. `email`, a watched
  dropped-file inbox). The adapter seam should not preclude them, but they are not built here.
- **Multi-host listener HA / failover.** Single listener instance, single host (consistent with
  the SQLite single-writer constraint).

## 6. Requirements

Requirements describe observable listener *behavior*; mechanism lives in `SPEC.md`.

### Functional Requirements

1. The listener **shall** run as a process **separate from** the per-run kernel, and its only
   side effect on a valid event **shall** be to spawn `conduit run` for the resolved flow; it
   **shall not** host the deterministic tick, drive any card, or hold flow state.
2. On a valid, authenticated event for a known flow, the listener **shall** map the event onto
   the parent card's substrate and spawn `conduit run <flow.yaml>` so the spawned kernel starts
   Wave 1; the listener's responsibility **shall** end once the spawn succeeds.
3. The listener **shall** record each accepted event's `event_id` in the `ingress_events` table
   (`event_id` PRIMARY KEY) with an initial `spawn_state` of `accepted` **before** spawning, and
   **shall** treat any event whose `event_id` is already present in `spawn_state` `accepted` or
   `spawned` as a duplicate — logged and **not** re-spawned. A row in `spawn_state` `failed` (D1)
   is re-drivable and **shall not** suppress a re-delivery of the same event.
4. The listener **shall** support a `webhook` adapter (an HTTP endpoint whose request body
   becomes the parent card's substrate) and a `slack`-events adapter (a watched channel whose
   message, including attachments, becomes the substrate).
5. The listener **shall** authenticate every inbound event per its adapter (Slack request
   signature; webhook shared secret/signature) and **shall** reject and log — never spawn — any
   event that fails authentication.
6. The listener **shall** resolve each event to a flow via its configured `channels.ingress`
   binding and **shall** reject and log — never spawn — an event that resolves to no known flow.
7. When a `conduit run` spawn fails (non-zero exit on launch, missing binary, unreadable
   `flow.yaml`), the listener **shall** set the event's `spawn_state` to `failed`, increment its
   `spawn_attempts`, raise an alert over a configured alert channel, and **never** silently drop
   the event. On startup the listener **shall** auto-re-drive rows in `spawn_state` `accepted` (a
   crash between record and spawn) and `failed` rows still under a bounded attempt cap; a row that
   exceeds the cap — or hits a classified-permanent failure (e.g. unreadable `flow.yaml`) —
   **shall** remain `failed` and be surfaced for explicit human re-drive rather than retried
   indefinitely. Each re-drive **shall** increment `spawn_attempts` **before** re-spawning, so a
   crash mid-re-drive stays bounded by the cap (D1).
8. The listener **shall** derive a stable `event_id` from a per-binding `event_id` source
   declared in `channels.ingress` — a named header, a JSON path into the body, or an explicit
   `content_hash` opt-in — such that the same external event yields the same `event_id` across
   retries and restarts. For the `slack` adapter the source **shall** default to Slack's native
   event id. For a `webhook` binding that declares **no** `event_id` source, the listener **shall**
   apply a smart default: probe a built-in ordered list of well-known delivery-id headers (e.g.
   `X-Conduit-Delivery-Id`, `Idempotency-Key`, `X-GitHub-Delivery`, `X-Shopify-Webhook-Id`,
   `X-Request-Id`) and a Stripe-style body `id`; on no match it **shall** fall back to a content
   hash of the body and emit a **one-time warning** that intentional-duplicate detection is
   degraded. A binding **may** set `event_id: { from: require }` to reject — never spawn — any
   event lacking an explicit id (D2).
9. The listener **shall** load its active flows from an explicit allowlist of `flow.yaml` paths
   (a listener config file or `--flows` argument); a flow **shall not** be triggerable unless named
   in the allowlist. All binding details (route, auth, `event_id`, `substrate`) **shall** come from
   each flow's own `channels.ingress`. The listener **shall** refuse to start if an allowlisted
   `flow.yaml` is absent, its `channels.ingress` is malformed, or two active flows collide on a
   route — fail loudly at boot, consistent with the kernel's config-is-validated principle (D4).
10. The listener **shall** write a canonical, deterministic **substrate envelope** for every
    accepted event — `{ source, event_id, received_at, auth_verified, headers (secret-filtered),
    body, attachments[] }` — onto the parent card's substrate before spawning. A binding **may**
    additionally declare a deterministic JSON-path `substrate` mapping that projects envelope
    fields onto named substrate fields; absent a mapping, the flow consumes the raw envelope (a
    head `transform` station is the flow author's tool for freeform normalization). The listener
    **shall not** run a model call when producing substrate (D3).
11. The listener **shall** record every event outcome — `accepted`, `duplicate`, `rejected_auth`,
    `rejected_unknown_flow`, `rejected_malformed`, `spawn_failed`, `redriven` — as an append-only,
    secret-filtered row in a dedicated `ingress_log` table, distinct from both the `ingress_events`
    dedup ledger and the per-run journal DB, so accepted, rejected, and duplicate events are all
    queryable. The per-run journal DB **shall not** carry listener events (D5).

### Non-Functional Requirements

1. **Cheap at rest.** The listener **shall** consume no model tokens and negligible CPU while
   idle; it holds no run and runs no tick (it is the cheap half of the ingress/always-on split).
2. **Dedup is durable and atomic.** The `event_id` uniqueness check and the accept-record write
   **shall** be a single atomic operation against `ingress_events`, so two concurrent deliveries
   of the same event cannot both spawn a run.
3. **Restart-safe.** A listener restart at any point — including mid-event, after recording an
   `event_id` but before spawning — **shall not** result in a duplicate billed run; the recorded
   `event_id` plus the spawn-failure record (FR-7) **shall** make recovery deterministic.
4. **Fail-closed.** Malformed, unauthenticated, or unknown-flow events **shall** default to
   rejection with a logged reason; the listener never guesses a flow or fabricates substrate.
5. **Secret hygiene.** Adapter secrets (Slack signing secret, webhook secret) **shall not** be
   logged and **shall not** be passed into the spawned kernel's worker context beyond what the
   run legitimately needs ([SPEC §11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite)).
6. **Single-host / single-writer.** The listener **shall** operate correctly as a single
   instance on the host owning `conduit.sqlite`; multi-host listener HA is out of scope and
   **shall not** be implied.

### Edge Cases & Error States

- **Duplicate event delivery** (Slack/webhook re-delivers the same event) → second arrival
  matches an existing `event_id`, is logged as a duplicate, and **does not** spawn a second run.
- **Listener restart mid-event** → if the `event_id` was recorded but the spawn never happened,
  the event is re-driven from its recoverable record; if the spawn did happen, the recorded
  `event_id` blocks a re-spawn. Net effect: exactly-once.
- **Malformed / unauthenticated event** → rejected at the adapter boundary, logged with a
  reason, never recorded as accepted, never spawned (an attacker cannot trigger a billed run).
- **Event for an unknown flow** → no `channels.ingress` binding resolves it; rejected and logged,
  never spawned.
- **Listener up but `conduit run` spawn fails** → alert raised, recoverable record left
  (FR-7); the event is not silently lost and can be re-driven once the cause is fixed.
- **Burst of distinct events** → each spawns its own per-run kernel; the listener does not queue
  or throttle (backpressure is out of scope) — at extreme bursts the host's process/SQLite
  limits are the natural ceiling, an accepted constraint for step 8.

## 7. Design Principles

- **The kernel stays per-run.** The listener exists *specifically* to avoid an always-on kernel.
  It spawns `conduit run` and forgets; it never becomes a resident multi-flow service.
- **Thin shim, not a framework.** The listener's whole job is event → substrate → spawn. Routing,
  scheduling, and execution remain the kernel's; the listener owns none of it.
- **Exactly-once or nothing.** A billed run must follow an external event at most once. Dedup is
  the listener's load-bearing guarantee, enforced durably in `ingress_events` — not best-effort.
- **Fail-closed at the edge.** Unauthenticated, malformed, or unroutable events are rejected and
  logged, never guessed into a run. The listener is an internet-facing surface; it assumes hostile
  input.
- **Config is validated, not trusted.** Ingress bindings are checked at listener boot; a missing
  flow or malformed `channels.ingress` stops the listener from starting.

## 8. Technical Considerations / Dependencies

**Dependencies:**

- **The shipped MVP kernel** ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) — a working
  `conduit run`, the per-run daemon process model ([SPEC §10A](../../SPEC.md#10a-process-model--a-resident-per-run-daemon)),
  and the egress/alert channels. The listener builds on top; it does not modify the kernel.
- **The `ingress_events` table** in the state DB
  ([SPEC §11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite)) — already
  defined as the ingress dedup log; this work is its first consumer and **extends it** with
  `spawn_state` + `spawn_attempts` (D1) for recovery.
- **A new `ingress_log` table** (append-only, on the journal connection) — the listener's
  observability store for every event outcome (D5). Distinct from `ingress_events`; the per-run
  journal DB is not touched.
- **A listener allowlist config** (a config file / `--flows` argument) — the explicit list of
  active `flow.yaml` paths the listener serves (D4). Binding details still live in each flow's
  `channels.ingress`.
- **The `channels.ingress` config seam** in `flow.yaml`
  ([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery)) — `cli` exists;
  `webhook` and `slack` are activated here, each carrying its route, auth, `event_id` source (D2),
  and optional `substrate` mapping (D3).
- **Bun runtime** for the listener process and `Bun.spawn` for launching `conduit run`
  ([ADR-0002](../../adr/0002-bun-as-the-kernel-runtime.md)).
- **A Slack app** (events API + request signing) and an HTTP endpoint for the webhook adapter.
- **Docker-first packaging** ([ADR-0003](../../adr/0003-packaging-and-distribution.md)) — the
  listener and the spawned kernels must share the mounted volume holding `conduit.sqlite` and the
  project root.

**Integration points:**

- Slack Events API (ingress) and webhook senders — the external trigger sources.
- `conduit run` — the spawn target; the listener invokes it exactly as a human would.
- `conduit.sqlite` (`ingress_events`) — the dedup authority, shared with spawned kernels.

**Constraints:**

- **Single writer to `conduit.sqlite`.** The listener writes `ingress_events`; spawned kernels
  write everything else. The dedup write must be atomic and must not contend pathologically with
  in-flight runs.
- **Internet-facing.** The webhook and Slack adapters are public surfaces; auth is mandatory, not
  optional.

## 9. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A restart between recording `event_id` and spawning loses the run (recorded-but-never-ran) | Medium | High | D1 spawn-state machine: `ingress_events` carries `spawn_state` + `spawn_attempts`; boot auto-re-drives `accepted`/`failed`-under-cap rows, escalates at-cap to human re-drive (FR-7) |
| Duplicate delivery races two spawns before either records the `event_id` | Low | High | Atomic insert-or-reject on the `event_id` PRIMARY KEY (NFR-2); the loser is rejected as a duplicate |
| An unauthenticated webhook triggers a billed run (cost/abuse) | Medium | High | Mandatory adapter auth (FR-5), fail-closed default; reject-and-log before any record or spawn |
| Listener becomes a de-facto always-on kernel through scope creep (queueing, retries, HA) | Medium | Medium | Hard scope line: spawn-and-forget only; queue/backpressure explicitly deferred |
| Slack event re-delivery semantics (3s ack, retries) cause perceived duplicates | Medium | Medium | `event_id` from Slack's native event id; ack fast, spawn async, dedup absorbs Slack retries |

### Resolved Decisions

The five open questions are settled (2026-06-11). Each maps to the FR(s) that make it testable.

- **D1 — Recovery for a recorded-but-never-spawned event → hybrid state machine.** `ingress_events`
  gains `spawn_state ∈ {accepted, spawned, failed}` + `spawn_attempts`. Accept records `accepted`
  atomically *before* spawning; success → `spawned`; spawn failure → `failed` + alert. On boot the
  listener auto-re-drives `accepted` rows and `failed` rows under a bounded attempt cap, and
  escalates at-cap / classified-permanent failures to explicit human re-drive — never an unbounded
  retry loop. Dedup suppresses only `accepted`/`spawned` rows; a `failed` row is re-drivable.
  *(FR-3, FR-7; NFR-2, NFR-3.)*
- **D2 — `event_id` for keyless webhooks → per-binding source with a smart default.** Bindings
  declare `event_id: { from: header | json_path | content_hash }`. Slack defaults to its native
  event id. A webhook with no declared source auto-probes well-known delivery-id headers (and a
  Stripe-style body `id`); the residual keyless case falls back to a body content hash **with a
  one-time degraded-dedup warning**. `from: require` is the strict opt-in (reject if no explicit
  id). Rationale: fail-closed-by-default, zero-config for real providers, and the content-hash
  footgun becomes an explicit, surfaced choice rather than a silent global fallback. *(FR-8.)*
- **D3 — Substrate mapping → layered, envelope as the floor.** The listener always writes a
  canonical deterministic envelope (the only required build); a binding *may* add an optional
  deterministic JSON-path `substrate` mapping for structured sources; freeform sources normalize
  via a head `transform` station (existing kernel machinery, no listener LLM). *(FR-10.)*
- **D4 — Binding location → flow owns it, allowlist activates it.** Binding details live in each
  flow's `channels.ingress` (single source of truth); a minimal listener allowlist of `flow.yaml`
  paths controls which flows are live (explicit opt-in, not disk auto-discovery). Boot validates
  existence, well-formedness, and route-collision. *(FR-9.)*
- **D5 — Observability → dedicated append-only `ingress_log`.** A new `ingress_log` table records
  every outcome (accepted / duplicate / rejected_* / spawn_failed / redriven), queryable and
  secret-filtered — distinct from the `ingress_events` correctness ledger (current-state, PK'd for
  atomic dedup) and from the per-run journal DB (untouched). `ingress_log` subsumes rejection
  analytics; it lives on the append-only/journal connection so it never contends the dedup write
  path. *(FR-11.)*
