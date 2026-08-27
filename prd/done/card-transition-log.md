---
missionId: ~
---

# Conduit — The Card Transition Log (Carried History + Rework Feedback)

**Author:** Josh Owens  **Date:** 2026-06-08  **Status:** Draft

> Scope note: this PRD adds a **per-card, append-only transition log** that travels with the
> card through the flow — every lane it enters, every gate verdict (with the critic's findings),
> and every terminal reason (scrap/hold). The log serves two jobs at once: (1) it **closes the
> quality loop** by feeding the previous gate's findings back into the maker on rework, so a
> rejected card can actually improve instead of re-running on identical inputs; and (2) it gives
> a **human-readable history** to anyone inspecting a card at `scrap`/`hold` — "why is this card
> here?". It builds directly on the shipped real-run path
> ([`prd/done/real-run-path.md`](real-run-path.md)) and the MVP kernel
> ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)): the state machine, atomic claim, gate
> checks + the four rework guards, checkpoint binding stamps, and the journal are all built and
> tested. This work **adds a new durable surface (the log) and wires it into prompt rendering and
> the binding stamp** — it does not change the routing kernel. The *how* lives in
> [`SPEC.md`](../../SPEC.md) (§3, §5, §6); this document defines *what must be true* and *why*,
> and stays implementation-free.

## 1. Context & Background

The real-run path shipped and was dogfooded on a real flow (`examples/tiktok-shoppable-ideas`)
against real Arcane Layer TikTok-shop data. The first real run on the "Mini Cooler Can Cozy"
product (`product_id 1732409268412453496`) drove a card cleanly through `fetch_context → ideate →
verify gate`, but the card **scrapped at the rework cap**: the gate critic rejected the idea three
times and the card died at `lane=scrap, status=scrapped, rework_count=2`.

The rejection was *correct* — the critic (deterministic at temperature 0) caught a factual error in
the generated hook ("it's been a minute since I showed off our Mini Cooler" when the last video was
only 8 days prior). But the run exposed a structural gap, not a model failure: **the rework loop has
no feedback channel.** `runGateCheck` parses the critic's `{verdict, findings[], return_to}`, and
then `gate-rework.ts` discards the findings — only their *hash* survives (as the no-progress
signal). On rework, the maker (`ideate`) re-renders its prompt from the **identical** `context.json`,
produces a near-identical idea, the deterministic critic returns identical findings, and the card
scraps. The maker never learns *why* it was rejected, so bounded rework — Conduit's quality engine —
cannot converge. It can only burn the cap.

The same gap has a second face: a card at `scrap` or `hold` carries **no record of why**. The
findings text is computed and thrown away; the journal records token/cost spans but not the
reasoning; `station_outputs` stores `findings_hash` but not the findings themselves. An operator
triaging a held card today has nothing to read.

Both faces are the same missing thing: a durable, card-carried history of what happened to the card
as it moved through stations. This is the right time to build it because every component it touches
(gate verdicts, rework guards, prompt rendering, binding stamps) is already built and proven — what
is missing is the carried record and the wiring that feeds it back.

## 2. Problem Statement

Conduit's quality thesis is **quality comes from `work → check → bounded rework`, not one smart
call.** That thesis is currently unprovable on real data: rework is "bounded" but never
*productive*, because the maker re-runs blind to the critic's findings, guaranteeing the same output
and an eventual scrap. Separately, Conduit's escalation principle — "escalate ambiguity; never
guess," surfacing contradictory state to a human at `hold` — is hollow when the surfaced card
carries no history explaining how it got there. Until a card carries its own transition history,
fed back into the maker on rework and readable by a human at a terminal, the rework loop cannot
converge and human triage cannot function. This work makes the card carry its history.

## 3. Target Users & Use Cases

- **The flow author** running a gated flow: wants reworks to actually fix the rejected work, so a
  card reaches `done` instead of scrapping at the cap — and wants to see, after a scrap, the chain
  of findings that led there so they can fix the prompt or the gate.
- **The operator** triaging a `hold`/`scrap` card: opens the card and reads its transition log —
  which lanes it passed through, every gate verdict and finding, and the terminal reason — without
  reconstructing it from token spans.
- **The kernel itself** (the controller): reads the most recent gate findings for a card and renders
  them into the next maker call as a first-class, hashed input.

Primary use case: re-running the dogfood cooler flow and watching a rejected idea **converge to a
passing one within the rework cap**, because the maker now sees and addresses the critic's findings.

## 4. Goals & Success Metrics

- **Rework converges.** On the real cooler flow, a first-attempt idea that the gate rejects is
  reworked into a passing idea **within the existing rework cap** (no kernel/guard changes) — the
  maker demonstrably addresses the prior findings rather than repeating them.
- **History is carried.** Every card that reaches a terminal carries a complete, ordered log of the
  lanes it entered, the gate verdicts (with findings) it received, and its terminal reason —
  queryable via the existing inspect surface.
- **No-progress guard gains teeth.** When feedback fails to change the output, the
  progress-monotonicity guard (findings hash) fires as designed — the log makes the difference
  between "improved" and "stuck" observable.
- **Zero routing-kernel change.** The transition log and feedback are added without changing the
  tick planner, transition matrix, or atomic claim; routing remains a pure function of state +
  config.

## 5. Scope

### In Scope

- A new **append-only `card_log` table** keyed by `card_id`, strictly ordered, recording one entry
  per significant transition: **entered-lane**, **gate verdict** (pass/reject, with the critic's
  findings and `return_to`), and **terminal reason** (scrap reason / hold reason).
- Writing log entries at the existing transition seams in the executor / gate-rework path, inside
  the same durable step that advances the card, so the log and the card state never diverge.
- **Rework feedback rendering:** on re-entry to a maker station via a back-edge, the most recent
  gate findings for that card are rendered into the maker's prompt as a declared, hashed input.
- **Checkpoint soundness:** the rendered feedback participates in the station's binding stamp, so a
  resume cannot skip-replay a stale pre-feedback output.
- **Idempotent logging under resume:** replaying a checkpointed station after a crash does not
  duplicate its log entries.
- Surfacing the log on card lookup and via the existing `conduit journal inspect <cardId>` (or a
  sibling inspect command) for human triage.
- Re-running the dogfood cooler flow as the acceptance spike; an `ideate.md` prompt change to
  consume the feedback block (and to make the "acknowledge the gap" instruction conditional, so it
  stops manufacturing false freshness claims).

### Out of Scope

- Changing the routing kernel (tick planner, transition matrix, atomic claim) or the four rework
  guards themselves.
- Agentic-station history (the multi-turn Tool-Bridge) — this is the `transform`/gate surface only;
  the log schema should not preclude agentic entries later, but they are not built here.
- A UI/dashboard for the log; inspection is CLI/journal only.
- Carrying arbitrary user-defined metadata on the card; the log records kernel transitions, not a
  general key-value store.
- Cross-card / epic-rollup history (parent card aggregation) — single-card log only.

### The dogfood flow — convergence on real data

The acceptance spike re-runs `examples/tiktok-shoppable-ideas` against the real Arcane DuckDB for
the cooler product. The expected, observable change versus today: the first `ideate` output is
rejected by `verify` (e.g. the false-freshness hook), the rejection's findings are written to the
card log and rendered into the next `ideate` call, and the reworked idea **addresses them and
passes the gate**, driving the card to `done` — all within the rework cap.

## 6. Requirements

### Functional Requirements

1. The kernel **shall** maintain a per-card, append-only transition log in a dedicated `card_log`
   table keyed by `card_id` and strictly ordered (by sequence and/or timestamp), separate from the
   hot `cards` row so it is never read or written by the atomic-claim dispatch transaction.
2. The kernel **shall** append a log entry when a card **enters a lane** (recording source lane,
   destination lane, and the reason class: forward / rework-back-edge / scrap / hold), so the log
   reconstructs the card's full path through the flow.
3. The kernel **shall** append a **gate-verdict** entry for every gate check — capturing
   `verdict` (pass/reject), the critic's **findings text**, the `return_to` target, and the
   attempt — so a rejected card carries the reason it was reworked, not merely a hash.
4. The kernel **shall** append a **terminal-reason** entry when a card reaches `scrap` or `hold`
   (e.g. `rework_cap`, `no_progress`, `model-incompatible`, `invalid_verdict`, andon/liveness
   halt, escalation), so an operator can read why the card stopped.
5. On re-entry to a maker station via a back-edge (rework), the kernel **shall** render the **most
   recent gate findings** for that card into the maker's prompt as a **declared input** (e.g. a
   `{{feedback}}` / `{{findings}}` block), so the maker addresses the rejection rather than
   re-running blind; on the first (non-rework) entry the block is absent.
6. The rendered feedback **shall** participate in the maker station's **checkpoint binding stamp**
   (alongside model id, prompt-template version, input-artifact hashes, and flow version), so that
   a resume **shall not** skip-replay a pre-feedback output as if it satisfied the post-feedback
   inputs ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
7. Log appends **shall** be idempotent under crash/resume: replaying a checkpointed station or
   re-applying a transition **shall not** produce duplicate log entries (keying consistent with the
   existing `(card_id, station, attempt)` checkpoint identity).
8. The log entry and the card-state transition that produces it **shall** be written in the **same
   durable step** (atomic with respect to the card advance), so the log can never claim a
   transition the card did not take, nor miss one it did.
9. The kernel **shall** surface a card's transition log on lookup and via the existing
   `conduit journal inspect <cardId>` (or a sibling command), rendered in transition order, for
   human triage at `hold`/`scrap`.
10. The feedback feeding the maker **shall** make the existing progress-monotonicity guard
    meaningful: when a rework produces materially different findings the card progresses; when it
    produces identical findings (no improvement) the no-progress guard **shall** fire as already
    specified — this work changes inputs to the guard, not the guard.
11. The log surface **shall** require **zero changes to the routing kernel** (tick planner,
    transition matrix, atomic claim) and to the four rework guards.

### Non-Functional Requirements

1. **Hot-path isolation.** Reading or writing the transition log **shall not** add work to the
   atomic-claim dispatch transaction; the `cards` row scanned on every tick **shall not** grow with
   history.
2. **Determinism preserved.** No LLM enters the control loop; the log is written by the controller
   from observed transitions, and feedback rendering is a pure function of the prior logged
   findings + the template. Routing remains a pure function of state + config.
3. **Exactly-once preserved.** The log **shall not** weaken the existing exactly-once/outbox
   guarantees; logging is additive and idempotent under resume (FR-7), and never blind-retries an
   effect.
4. **Bounded growth.** A single card's log **shall** be bounded by the rework guards in the normal
   case; the design **shall** cap or otherwise bound pathological growth so the log cannot grow
   without limit even under unexpected churn.
5. **Secret hygiene.** Log entries **shall not** contain model credentials or other secrets; the
   findings text is model output and is permitted, but the feedback-rendering path **shall not**
   leak the API key into the log or the prompt beyond the legitimate call.
6. **Fail-closed config.** A maker prompt that declares a feedback input it cannot be supplied, or
   a flow whose feedback wiring is malformed, **shall** fail at load, not mid-run, consistent with
   the existing config-validation contract.

### Edge Cases & Error States

- **First attempt (no prior findings)** → the feedback block is absent from the maker prompt; the
  binding stamp reflects "no feedback" and differs from a rework stamp, so the two runs are distinct
  checkpoints.
- **Rework produces identical findings** → progress-monotonicity guard fires (no_progress scrap);
  the log records both the repeated findings and the no-progress terminal reason.
- **Crash between the card advance and the log append (or vice-versa)** → resume reconciles to a
  single consistent record; neither a phantom log entry without a transition nor a transition
  without its entry survives (FR-8, FR-7).
- **Gate passes on first attempt** → a pass verdict is logged (findings may be empty); no feedback
  is ever rendered; behavior is identical to today plus the log entry.
- **Prompt template references the feedback input but the station has no back-edge** → fail-closed
  at load (a feedback input only makes sense on a reworkable station).
- **Findings text is large** → the rendered feedback and the stored entry are bounded so a verbose
  critic cannot blow the maker's context or the log's size budget.

## 7. Design Principles

- **The card carries its own history.** History is an attribute of the card, surfaced wherever the
  card is looked up or passed around — not reconstructed from side tables after the fact.
- **The check is the quality engine — so close the loop.** A back-edge without feedback is a retry,
  not rework. Feeding the critic's findings to the maker is what makes bounded rework converge.
- **Feedback is an input, not a side channel.** Anything that changes a model's output must be a
  first-class, hashed input, or checkpoint soundness silently breaks.
- **Escalate with evidence.** A card surfaced to a human at `hold`/`scrap` must arrive with the
  record of why — escalation without history is just a dead end.
- **Additive, not invasive.** The log wraps the existing transition seams; it does not touch the
  routing kernel or the rework guards.

## 8. Solution Approach

Introduce a durable `card_log` append-only table keyed by `card_id`, ordered, with an entry kind
(`entered_lane` | `gate_verdict` | `terminal`) and a typed payload (source/dest lane + reason; or
verdict + findings + return_to + attempt; or terminal reason). Append entries at the transition
seams that already exist in the executor and `gate-rework` path, inside the same durable step that
advances the card, with append idempotency keyed consistently with the `(card_id, station, attempt)`
checkpoint identity so resume cannot double-write.

On rework re-entry to a maker, read the most recent `gate_verdict` findings for the card and render
them into the maker prompt as a declared feedback input; fold the rendered feedback into the
station's binding-stamp input set so resume treats pre- and post-feedback runs as distinct
checkpoints. Surface the log via card lookup and the existing journal-inspect command, in transition
order.

Stop discarding the critic's findings in `gate-rework`: instead of mapping the verdict to a bare
decision, persist the findings into the log as part of producing the rework/scrap decision. The
no-progress guard continues to operate on the findings hash; the only change is that the maker now
acts on the findings text between attempts.

Validate the dogfood cooler flow end-to-end: a rejected idea reworks into a passing one within the
cap. Update `examples/tiktok-shoppable-ideas/prompts/ideate.md` to consume the feedback block and to
make the "acknowledge the gap" instruction conditional on a genuinely large
`days_since_last_video`, so it stops generating false-freshness hooks the critic correctly rejects.

## 9. Technical Considerations / Dependencies

- **Depends on shipped surface:** the real-run executor (`src/controller/executor.ts`), the gate +
  rework path (`src/controller/gate-rework.ts`, `src/quality/gate.ts`), prompt rendering
  (`src/flow/render.ts`), the checkpoint binding stamp (SPEC §5), and the persistence layer
  (`src/persistence/db.ts`). All are built and unit-tested.
- **Schema:** a new `card_log` table alongside `cards` / `station_outputs` / `journal`; the `cards`
  row is unchanged (hot-path isolation, NFR-1).
- **Binding stamp:** the stamp's input set must be extended to include rendered feedback for maker
  stations on rework (FR-6); this is the load-bearing soundness change and needs explicit tests.
- **Idempotency:** log appends must align with the existing `(card_id, station, attempt)` checkpoint
  keying so crash-recovery tests cover double-write (FR-7).
- **Prompt rendering:** `renderPrompt` must support an optional feedback input present only on
  rework, and the loader must validate a feedback-declaring prompt against a reworkable station
  (FR-5, NFR-6).
- **CLI/journal:** reuse `conduit journal inspect <cardId>`; the journal DB (`work_summaries` is
  currently empty) may host the rendered log, or a dedicated inspect path reads `card_log`.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Feedback not folded into the binding stamp → resume skip-replays a stale pre-feedback output | Medium | High | FR-6 makes feedback a hashed input; include a crash-and-resume-across-rework test |
| Log append and card advance diverge under crash | Low | High | FR-8 writes both in one durable step; FR-7 keys appends to the checkpoint identity |
| Verbose critic findings blow the maker context or the log budget | Medium | Medium | Bound rendered feedback + stored entry size (NFR-4, edge case) |
| Feedback still doesn't converge on real data (model ignores findings) | Medium | Medium | No-progress guard fires as designed (FR-10); the spike measures the real convergence rate |
| Scope creep into a general per-card metadata store | Low | Medium | Out-of-scope: log records kernel transitions only |

### Open Questions

- Should the rendered log surface live in the journal DB (`work_summaries`) or be read directly from
  `card_log` by a dedicated inspect command?
- Does the feedback rendered to the maker carry **only the latest** rejection's findings, or the
  **accumulated** findings across all prior reworks? (Latest is simpler and matches the no-progress
  hash; accumulated may converge faster but risks context bloat.)
- Should `entered_lane` entries record the WIP/wave context, or is lane source/dest + reason enough
  for triage?

## 11. Rollout & Measurement

Ship behind the existing example flow as the acceptance spike: re-run the dogfood cooler flow and
confirm a rejected idea converges to a passing one within the rework cap, with the full transition
log readable via `conduit journal inspect`. Measure the real rework-convergence rate (how often
feedback turns a reject into a pass before the cap) and the no-progress fire rate — these are the
first real numbers on whether bounded rework, with feedback, is the quality engine the design
claims. No flag is needed; the log is additive and the feedback only changes maker behavior on
rework, which is currently a guaranteed scrap.
