# ADR-0010: Thread-address convention for egress sends — conventional substrate field, resolved per run

Status: Accepted
Date: 2026-07-12

## Context

Slack Egress File Delivery (`prd/ready/slack-file-egress.md`) needed a way for both a
station's file delivery and the existing HITL rank-selection prompt to land as a **threaded
reply** on the message that triggered the run, when one exists. PRD decision 4 settled the
high-level shape early: "thread addressing rides the existing ingress substrate projection...
the `deliver` block (and text sends) read it back. No new ingress mechanism." What that
decision did **not** settle — and what the item Context for both WI-599 and WI-600 got
factually wrong when written — is *where the substrate actually lives* and *what a text send
with no `deliver` block reads*.

The original item Context assumed the ingress-projected substrate was stored **per card**.
It is not: `ingress_events` persists `substrate_json` keyed by `run_id` (from the ingress run-identity
attribution schema, v9), not by card. A card's own row carries no substrate column at all.
This was caught during WI-599 implementation and corrected by the team lead (Option A,
2026-07-12) before any code shipped against the wrong assumption.

A second question followed immediately: the station-level `deliver` block has a `thread_from`
field the flow author declares (naming *which* substrate key addresses the reply). The HITL
rank-selection prompt (WI-600) has no `deliver` block at all — so what does *it* read? There
is no per-declaration config surface for a bare text send.

## Decision

**Two-tier resolution, both funneled through one helper:**

- **`resolveThreadAddress(db, card, threadFrom)`** (`src/controller/executor.ts`, exported for
  reuse) is the single source of truth for thread-address resolution. It resolves the run's
  substrate via `getIngressSubstrateForRun(runId)` — a `ConduitDB` accessor that reads the
  **earliest** (`received_at ASC`) `ingress_events` row for that `run_id` (the originating
  trigger, in case of redrive duplicates) — JSON-parses `substrate_json`, and reads the named
  field. No ingress event, no field, or malformed JSON all resolve to `undefined` — never a
  thrown error.
- **File delivery (`deliver.thread_from`)** is flow-author-declared: the YAML names which
  substrate key carries the address (e.g. `thread_from: thread_ts`). This is a per-station,
  per-flow decision because a flow may bind different ingress adapters, or choose not to
  thread a given delivery at all (the field is optional).
- **Text/HITL sends with no `deliver` block** (the rank-selection prompt) have no declaration
  surface to read a field name *from*, so the convention is fixed: they resolve the literal,
  conventional substrate key `'thread_ts'` unconditionally. This is a deliberate narrowing —
  not a gap — for the one send site that predates the `deliver` schema.
- **Absence is always a degrade, never an error** (PRD decision 6, extended to the HITL case
  by this ADR): a CLI-triggered run, or a substrate missing the field, sends unthreaded and
  journals the skip (`delivery.sent`'s `threadResolution` / the HITL path's
  `hitl.thread_resolution` span) so the degrade is diagnosable in `conduit explain`, not silent.

## Alternatives considered

### A. Channel-level `thread_from` (declared once on the egress channel binding) — *rejected*
A single flow can deliver from several stations at different points in a conversation, or
choose to thread some deliveries and not others. A channel-level field name can't express
"reply to the file from station A on thread X, but station B's delivery is unthreaded" —
per-station declaration is the correct unit, and it's also where the flow author already
declares everything else about a delivery (`files`, `caption`).

### B. No threading in this mission (defer to a later item) — *rejected*
The PRD's core UX ask is the produced file landing back in the conversation that requested
it — an unthreaded delivery into a busy channel defeats that. Threading was in scope from the
first drafted `deliver` schema (PRD decision 4).

### C. Store a denormalized substrate copy on the card at spawn time — *rejected*
Substrate is a property of the **run's** triggering event, not any one card within it — copying
it onto every spawned card duplicates data that can only ever agree with the run's own
`ingress_events` row, and risks staleness for children spawned later in a fan-out. Reading it
live via `run_id` (this ADR's approach) has one source of truth and costs one indexed SELECT.

### D. A configurable field name for the HITL/text-send case too — *rejected (for now)*
Symmetry with the `deliver` block's `thread_from` was considered, but there is currently no
station-level declaration surface a bare `egressSend` call (the rank prompt) belongs to — it
fires from the executor's rank-check machinery, not a YAML-declared `deliver` block. Fixing the
convention avoided inventing a new config surface for a single call site. Revisit if a second
text-only send site needs a *different* field name than `thread_ts`.

## Consequences

**We gain**
- One resolution helper (`resolveThreadAddress` + `getIngressSubstrateForRun`), reused
  identically by WI-599 (file delivery) and WI-600 (HITL prompt) — no duplicated substrate
  access, and any future egress send site adopts the same pattern for free.
- A corrected, durable record of where substrate actually lives (`ingress_events.run_id`, not
  per-card) — the item Context for both consuming work items originally had this wrong, and
  future contributors reading the code should not re-derive that mistake.
- Threading degrades safely by construction: absence is structurally `undefined`, never a
  thrown error, so a CLI-triggered run can never fail a delivery or a HITL prompt over a
  missing thread address.

**We pay**
- The HITL/text-send path has a hardcoded field name (`'thread_ts'`) with no per-call override.
  A flow needing a differently-named field for that one send site would need a new
  configuration decision, not a YAML tweak.
- Two send sites (`deliver` file uploads and the bare HITL prompt) now have two *slightly*
  different resolution invocations (one passes a flow-declared field name, one hardcodes it) —
  documented here specifically so a future reader doesn't "fix" the asymmetry without first
  reading this ADR.

**Revisit triggers**
- A second bare-text egress send site (beyond the rank-selection prompt) needing a thread
  address from a *different* substrate field — that's the signal to make the HITL path
  configurable too (Alternative D).
- Any future ingress adapter whose substrate shape can't express "the reply-to timestamp" as a
  single flat JSON field — `resolveThreadAddress`'s `JSON.parse` + flat-key read would need to
  widen.

## References

- PRD: `prd/ready/slack-file-egress.md` §9 (resolved decisions 4 and 6), §10 (edge case
  "Substrate has no `thread_ts`").
- SPEC §4A (channel egress, HITL round-trip, effectful outbox).
- Implementation: `src/controller/executor.ts` (`resolveThreadAddress`,
  `performStationDelivery`, the rank `await_selection` egress path), `src/persistence/db.ts`
  (`getIngressSubstrateForRun`). Tests: `src/controller/executor-file-delivery.test.ts` (AC2),
  `src/controller/executor-text-threading.test.ts`.
