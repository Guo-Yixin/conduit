# ADR-0011: File-egress reconciliation — a real `files.info` probe narrows the hold window; ambiguity still holds

Status: Accepted
Date: 2026-07-12

## Context

A file delivery's outbox intent can be in one of three states on resume (SPEC §5's effectful
outbox, extended to `egressSendFile` by WI-598): `none` (safe to fire), `committed` (skip —
already landed), or `pending` (a prior attempt started the send and crashed somewhere before
commit). The PRD's edge case table calls out the dangerous window explicitly: "Crash between
completion call and outbox commit — resume must reconcile ('did the file land?') and escalate
to hold if unanswerable, never re-fire blind." PRD Risk row: "Reconciling 'did the completion
land?' is harder than for text (no message `ts` in hand)."

WI-598 shipped the `egressSendFile` outbox machinery with the hold-only base case: no
reconciler passed means every `pending` intent unconditionally escalates to hold. That is
**safe** (never a double-post) but needlessly costly for the common case — a crash before the
upload ever reached Slack's completion call means *nothing* landed, and that outcome is
provable without a human. Every crash in that safe window would otherwise park a card waiting
on an operator to notice and manually resolve it.

Unlike a text `chat.postMessage`, Slack's file-upload completion returns no content hash to
reconcile against later, and there is no cheap, single "did message X land" lookup the way
there is for text (a `ts` you can re-check) — the PRD Risk table flagged this reconciliation
as the harder half of the whole feature.

## Decision

**Ship a real reconciler this mission (`createFilesInfoReconciler`, `src/channels/slack.ts`),
narrowing — never eliminating — the hold-only default.**

- The reconciler probes the delivery's target channel/thread via Slack's `files.list`
  (unthreaded) or `conversations.replies` (threaded) and matches the pending intent's
  persisted `path`/`size` against the probed files on **`basename(path)` + `size`** — the
  content fingerprint stays the **outbox's own** idempotency key; Slack exposes no content
  hash to probe by, so basename+size is the best available signal.
- **Exactly one match → `landed`** (skip; the row is now committed — see the parity bug this
  ADR's own review round caught, below).
- **No match, but the probe answered → `not_landed`** (fire: safe to re-upload exactly once,
  reusing the existing pending row).
- **Multiple matches, or the probe itself fails (`ok:false` / thrown network error) →
  `unknown`** — fail-closed, **never guess `landed`**. This is the one rule the whole design
  hangs on: an ambiguous or unanswerable probe still escalates to hold, exactly as the
  hold-only base case did. The reconciler narrows *which* pending intents need a human; it does
  not change what happens when the probe itself can't resolve the question.
- `egressSendFile`'s pending branch **awaits** the reconciler inline (bypassing the existing
  *synchronous* `reconcileOnResume` used by text sends) precisely so a real network probe is
  possible here — a sync `Reconciler` remains valid too (a non-promise return trivially awaits
  to itself), so this is a widening, not a fork, of the outbox's reconciliation contract.
- The bot token is never inspected or logged on a probe failure (parity with every other
  transport failure mode in this mission, NFR-1) — a hostile or misconfigured `ok:false`
  response embedding the token has nowhere to leak through, because the `unknown` fail-closed
  path never reads the error detail at all.

**A parity bug found during review is itself part of this decision's record:** the first
implementation of the `landed` branch returned `{posted:false, reconcileDecision:'skip'}`
without committing the outbox row — unlike the `not_landed`/`fire` branch immediately below it,
which correctly commits. A `landed` verdict is exactly as strong a proof of delivery as this
call's own successful upload; the row must converge to `committed` either way, or every future
resume re-probes Slack for an outcome already conclusively proven. Fixed to call `commitIntent`
on `landed` too, mirroring `fire`.

## Alternatives considered

### A. Ship hold-only permanently (no reconciler, defer WI-602 indefinitely) — *rejected*
Safe, but every transient crash in the safe window (before the completion call even reached
Slack) would otherwise need a human to unblock a card that could have resumed on its own. The
PRD scoped this mission specifically to close that gap, not defer it — the Risk mitigation is
"investigate `files.info`... hold is the safe default either way," which is exactly what
shipped: the probe, with hold preserved as the fallback.

### B. Reconcile via content hash (download the file and hash it) — *rejected (for now)*
Would give a stronger match than basename+size, but costs a full file download per
reconciliation attempt for marginal precision gain in the common case, and still needs a
fail-closed `unknown` path when the download itself fails — it does not remove the core
invariant this ADR establishes, only strengthens one input to it. Left as a future
strengthening if basename+size proves insufficiently precise in practice (e.g. two same-size,
same-named files legitimately in the same channel — which is exactly the "multiple matches"
case this design already fails closed on).

### C. Guess `landed` on any plausible (including ambiguous) match — *rejected outright*
The one rule this design cannot bend on. A false `landed` guess silently drops a real delivery
obligation at precisely the moment an operator is relying on the kernel to have handled it —
strictly worse than an unnecessary hold, which merely costs a human's attention.

### D. Auto-retry blindly on any pending intent, no probe at all — *rejected*
This is the original double-post hazard the outbox pattern exists to prevent (SPEC §5): the
completion call may well have succeeded before the crash, and a blind re-fire would deliver the
same file twice with no way to tell after the fact.

## Consequences

**We gain**
- The safe crash window (nothing posted to Slack yet) now auto-resumes without operator
  involvement — verified end-to-end against the real production call chain (not just mocked
  unit tests): a simulated mid-upload crash holds the card, and on resume the genuine reconciler
  probes Slack, proves the file did not land, and re-fires to completion with zero human
  intervention.
- The `unknown`-is-fail-closed invariant is enforced at exactly one decision point
  (`createFilesInfoReconciler`'s return value), so every future caller of `egressSendFile`
  inherits the same safety property for free — there is no second place a "guess landed"
  shortcut could be quietly added.

**We pay**
- One additional real Slack API call (`files.list`/`conversations.replies`) per resume attempt
  against a `pending` intent — an explicit, accepted cost against the alternative of an
  unattended crash requiring a human.
- The truly-ambiguous window (multiple matches, or Slack itself unreachable) still needs a
  human. This is a **permanent** property of the design, not a gap scheduled to close later —
  Slack's probe surface offers no stronger signal (no content hash) to fully disambiguate every
  case.

**Revisit triggers**
- Slack ships a content-hash-bearing files API — Alternative B becomes cheap enough to replace
  basename+size as the primary match signal, tightening the `unknown` window further.
- The "multiple matches" case proves common in practice (e.g. flows that legitimately deliver
  many same-named files to one channel) — would need a richer match key or per-flow
  disambiguation, not just basename+size.

## References

- PRD: `prd/ready/slack-file-egress.md` §10 (Risk: "Reconciling 'did the completion land?' is
  harder than for text"), §10 edge case ("Crash between completion call and outbox commit").
- SPEC §5 (effectful outbox, exactly-once via the idempotency key).
- Implementation: `src/channels/slack.ts` (`FileReconciler`, `createFilesInfoReconciler`,
  `egressSendFile`'s pending-intent branch), `src/checkpoint/checkpoint.ts`
  (`getPendingIntentPayload`), `src/controller/executor.ts` (`performStationDelivery`'s
  reconciler wiring + `delivery.reconcile`/`delivery.sent` journaling). Tests:
  `src/channels/slack-file-reconciler.test.ts`, the WI-602 case in
  `src/controller/executor-file-delivery.test.ts`.
