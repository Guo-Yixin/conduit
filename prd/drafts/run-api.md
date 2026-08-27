---
missionId: ~
---

# Conduit — Run API (async job + poll)

**Author:** Josh Owens  **Date:** 2026-06-07  **Status:** Draft

> Scope note: a **light** PRD for exposing a flow as an HTTP job API — `POST` a request, get a
> `run_id` back, `poll` until the run reaches a terminal state, then read the result. It builds on
> two earlier pieces: the **real-run path** ([`real-run-path.md`](../done/real-run-path.md)) — a
> flow must actually run to completion before an API over it means anything — and the **ingress
> trigger-listener** ([`ingress-listener.md`](../done/ingress-listener.md)), whose `webhook`
> adapter + dedup are the trigger half. This PRD is the **read/response half**: return an id, and
> serve status + result over the journal. It changes no kernel semantics. Sequenced **after**
> real-run-path (and alongside / on top of ingress-listener). Stays implementation-free.

## 1. Context & Background

Today a flow is triggered by `conduit run` (CLI) or, with the listener, by a webhook that **spawns
and forgets** — results come back over an egress channel (Slack). That fits event-driven triggers,
but not a **programmatic caller** that wants a request/response contract: "kick off this flow for
this input, hand me an id, let me poll until it's done, then give me the output." That's the
standard async-job shape, and it's the natural way to integrate a flow into another app or service.

Conduit already has the parts: the listener can stay up cheaply and spawn a per-run kernel; a run's
state is a card's `(lane, status)` in `conduit.sqlite`; and the journal already records per-run
progress (`conduit journal inspect/tail <cardId>`). The missing piece is exposing an **id on
trigger** and a **read endpoint** over that existing state — a thin HTTP surface, not new kernel
machinery.

## 2. Problem Statement

A programmatic caller can't run a Conduit flow and get its result back through a normal API. The CLI
is interactive; the listener is fire-and-forget with Slack delivery. There is no "submit → id →
poll → result" contract, so a flow like the dogfood (`tiktok-shoppable-ideas`) can't be called from
another app. This PRD adds that contract as a thin read/response layer over the existing run state.

## 3. Target Users & Use Cases

**Primary user — an integrating developer.** Has a deployed Conduit flow and wants to call it from
their own app/service: `POST` an input, get a `run_id`, poll, and read the result JSON — without
the CLI and without wiring Slack.

**Key use cases:**

- A caller **submits a run** for a flow with a JSON input and immediately receives a `run_id`.
- A caller **polls** the `run_id` and sees a coarse status (`queued` / `running` / `awaiting_human`
  / `completed` / `failed`).
- On `completed`, the caller **reads the run's result** (the terminal output artifact).
- A caller **re-submits the same request idempotently** (a duplicate does not start a second run).

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Submit returns a usable id | A valid `POST` spawns exactly one run and returns its `run_id` | 100% |
| Poll reflects real state | `GET` status matches the run's actual `(lane,status)`/journal | 100% (no divergence) |
| Result is retrievable | A `completed` run's terminal artifact is served via the API | 100% |
| Idempotent submit | Duplicate submits (same idempotency key) that start a second billed run | 0 |
| Kernel stays per-run | An always-on resident **kernel** introduced by this work | 0 |

**Explicitly NOT goals:** streaming/websocket progress, a rich auth/identity system, a job queue or
backpressure, multi-host scale-out, or a UI. This is a thin job-API over one host.

## 5. Scope

### In Scope

- **A submit endpoint** that accepts a flow name + JSON input, seeds the run (via the listener's
  webhook/ingress path), and returns a `run_id` (the parent card id or a stable run id).
- **A status endpoint** that maps a run's `(lane, status)` + journal to a coarse API status:
  `queued`, `running`, `awaiting_human` (a `hold`), `completed` (`done`), `failed` (`scrap`).
- **A result endpoint** (or status payload field) that, on `completed`, returns the run's terminal
  output artifact.
- **Idempotency** via a caller-supplied key, reusing the existing ingress dedup (`ingress_events`).
- **The HTTP server is the (already long-lived) listener**, extended — it holds no flow state and
  runs no tick; each run is still a spawned per-run kernel.

### Out of Scope

- **Streaming / websockets / push** — polling only (a progress stream is a later concern).
- **Auth/identity beyond a shared key** — a single API key/secret; no per-user accounts/RBAC.
- **Queue / backpressure / retry** — submit spawns a run; at high concurrency the host's SQLite
  single-writer ceiling is the natural limit (F1 multi-host is future-watch).
- **HITL completion *via* the API** — a `hold` is **surfaced** as `awaiting_human`; resolving it
  still happens through the existing HITL channel (e.g. Slack reply + resume), not this API.
- **A UI / dashboard.**

## 6. Requirements

### Functional Requirements

1. The API **shall** expose a **submit** operation that takes a flow identifier and a JSON input,
   seeds the run through the ingress path, and **shall** return a stable `run_id` for polling.
2. The API **shall** expose a **status** operation keyed by `run_id` that returns a coarse status
   derived from the run's `(lane, status)` and journal: `queued`, `running`, `awaiting_human`,
   `completed`, or `failed`.
3. On a `completed` run, the API **shall** make the run's **terminal result artifact** retrievable
   (inline in the status payload or via a result operation).
4. A run that reaches a `hold` lane **shall** report `awaiting_human`; the API **shall not** attempt
   to resolve the human decision (that stays on the existing HITL channel).
5. The API **shall** accept a caller-supplied **idempotency key** and **shall not** start a second
   run for a duplicate key, reusing the existing ingress dedup; a duplicate **shall** return the
   original `run_id`.
6. An unknown `run_id` **shall** return a not-found result; a malformed or unauthenticated submit
   **shall** be rejected and **shall not** spawn a run (fail-closed, consistent with the listener).
7. The HTTP server **shall** spawn a per-run kernel per submit and **shall not** host the tick or
   hold flow state (it is the thin listener, extended — not a resident kernel).

### Non-Functional Requirements

1. **Reuse, don't duplicate, run state.** Status **shall** be read from the existing
   `conduit.sqlite` card state + journal — the API holds no separate job store.
2. **Fail-closed & secret-safe.** Consistent with the listener: reject bad input before spawning;
   never log the API key or leak it into worker context.
3. **Single-host honesty.** The API **shall** operate correctly as a single instance on the host
   owning `conduit.sqlite`; multi-host HA is out of scope and not implied.

### Edge Cases & Error States

- **Poll before the run has progressed** → `queued`/`running`, never a fabricated result.
- **Run scrapped (e.g. rework cap)** → `failed` with a reason from the journal.
- **Run holds for a human** → `awaiting_human`; polling continues to reflect it until resolved
  out-of-band, then advances.
- **Duplicate submit mid-run** → same `run_id`, no second run.
- **Result requested before completion** → not-ready, not an empty/partial artifact.

## 7. Dependencies

- **The real-run path** ([`real-run-path.md`](../done/real-run-path.md)) — runs must drive to a
  terminal state and produce a result artifact.
- **The ingress trigger-listener** ([`ingress-listener.md`](../done/ingress-listener.md)) — the
  long-lived process, the `webhook` ingress path, and the `ingress_events` dedup. This PRD extends
  it with an id-returning submit and the status/result read surface.
- **`conduit.sqlite`** (card state + journal) — the single source of run state the API reads.

## 8. Open Questions

- **Extend the listener, or a sibling process?** The submit half overlaps the listener's webhook
  adapter; the read half is new. One process or two?
- **`run_id` identity.** Use the parent card id directly, or mint a separate run id mapped to it?
- **Result shape.** Always the single terminal artifact, or a small envelope (status + artifact +
  cost/usage from the journal)?
- **Where results live.** The API needs to resolve a run's terminal artifact path under
  `project_root` — settled with the real-run path's delivery model.
