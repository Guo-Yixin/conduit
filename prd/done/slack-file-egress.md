---
missionId: M-20260712-001
Status: Completed
---

# Slack Egress File Delivery (Outbox-Guarded)

**Author:** Josh Owens  **Date:** 2026-07-11  **Status:** Completed

## 1. Context & Background

The Slack egress channel (WI-303, SPEC §4A) can post **text**: HITL short-lists and delivery notices go out through `chat.postMessage`, guarded by the effectful outbox so a crash never double-posts and a resume never re-asks an approval. That guarantee — write a pending intent, fire the side effect, commit — is one of the kernel's core promises for anything billed or externally visible (SPEC §5).

Files have no such path. A flow whose terminal artifact is a binary — an edited image, a PDF, a render — cannot deliver it through a declared egress channel at all. The real-world driver is **pic-edit**: someone posts a photo in a Slack thread, the flow produces `work/edited.jpg`, and delivery *is* uploading that JPEG back into the triggering thread. Today that takes a deterministic tail station shelling a custom uploader (or an external wrapper doing Slack's three-step upload by hand), which bypasses the egress channel abstraction and — more importantly — bypasses the outbox. The upload is exactly the kind of effectful, externally visible side effect the outbox exists for, and it currently runs naked.

Two adjacent gaps compound this:

- Egress channels can declare `uses: [delivery]` in `flow.yaml`, but nothing in the engine reads that value — only `uses: [hitl]` is consumed. `delivery` is decorative today.
- There is no way to address a Slack **thread** from egress. Ingress bindings already project fields from the triggering event into the card's substrate envelope, but no egress path reads them back, so even text notices land as fresh channel messages instead of threaded replies.

Why now: pic-edit is blocked on this as its delivery leg, and it is the model case for the broader claim in the issue — *any* flow producing binary artifacts can't complete its delivery inside the kernel's exactly-once guarantees.

## 2. Problem Statement

A flow whose product is a file has no first-class way to deliver it: the Slack egress channel speaks text only, so binary delivery must escape the kernel — losing the outbox's exactly-once guarantee, the channel abstraction, and journal/explain visibility. Additionally, no egress send (text or file) can target the Slack thread that triggered the run, so deliveries don't land where the requester is looking.

## 3. Target Users & Use Cases

**Primary users:**

- **Flow authors** (first: pic-edit) — want to declare "when this station finishes, deliver these files to the egress channel, threaded on the triggering message" in `flow.yaml`, and trust the kernel's crash-recovery semantics for it.
- **Operators** — care that a crash or resume never posts a file into a channel twice, and that a genuinely reworked artifact *is* re-delivered.
- **End users in Slack** — posted the original request; expect the result to arrive as a reply in their thread, not as an unthreaded message they have to hunt for.

**Key use cases:**

- A flow author needs the pic-edit flow to upload `work/edited.jpg` back into the thread where the raw photo was posted, so the requester gets their result in context.
- A flow author needs a rework loop (QC rejects, station re-runs, new `edited.jpg`) to deliver the **new** artifact, while a crash-and-resume of the *same* attempt delivers nothing twice.
- A flow author needs text delivery notices to thread on the triggering message the same way files do.
- An operator needs a delivery that fails ambiguously (crash between upload completion and outbox commit) to escalate to `hold` rather than blind-retry — matching the existing text-send recovery discipline.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Files are first-class egress | A flow declares file delivery in `flow.yaml` and the kernel performs it | pic-edit-shaped flow delivers a JPEG end-to-end with no custom uploader station |
| Exactly-once holds for files | Crash injected between upload completion and outbox commit | Zero double-posts across resume; ambiguous outcomes escalate to hold, never blind-retry |
| Rework re-delivers | QC back-edge produces a new artifact on a later attempt | New attempt's file is delivered; same-attempt resume is skipped |
| Threaded delivery | File and text sends carry the triggering message's thread address from the ingress substrate | Reply lands in the originating thread in a live Slack test |
| `uses: [delivery]` is real | Channel resolution for delivery sends | Delivery routes to the channel declaring `uses: [delivery]`, mirroring the existing `hitl` lookup |
| No regression | Existing egress behavior (HITL holds, text sends) | Existing test suite stays green; flows without a `deliver` block behave byte-identically |

## 5. Scope

### In Scope

- A **station-level `deliver` block** in `flow.yaml`: the terminal work station declares which produced file(s) to deliver and, optionally, how to thread the send (e.g. from a substrate field captured at ingress). Delivery is part of the station's completion, visible in the lane graph, the journal, and `explain`.
- **Slack file upload** via the external-upload three-step (`files.getUploadURLExternal` → raw byte POST → `files.completeUploadExternal`) as a new capability of the Slack egress transport, alongside text posting.
- **Outbox guarding of the completion step only**: steps 1–2 are invisible to the channel and safely re-runnable; the completion call is the effectful edge and gets the pending-intent / commit / reconcile-on-resume treatment text sends already have.
- **`uses: [delivery]` channel resolution**: delivery sends route to the egress channel that declares the `delivery` use (same lookup pattern as `hitl` today), with the same first-channel fallback for configs that declare no `uses`.
- **Thread addressing from the ingress substrate** for both file uploads and text posts: a delivery can reference a substrate field (e.g. the triggering message's `thread_ts`) so replies land in-thread. Text-only sends gain the same threading option.
- **Optional delivery caption**: a `deliver` block may carry a text caption that rides the upload-completion call (Slack's `initial_comment`), so the file arrives with context rather than bare.
- **Attempt- and content-aware idempotency**: the delivery's idempotency key incorporates the execution attempt and the file's content fingerprint, so rework attempts re-deliver while crash-retries of the same attempt do not.
- **Config validation at load** (config is validated, not trusted): a `deliver` block on a flow with no delivery-capable egress channel fails at load — not at first dispatch. (A thread address the *runtime* substrate can't supply is not a load error: the same flow may be triggered by Slack or CLI; see FR-8.)

### Out of Scope

- **Non-Slack egress transports** (email, Discord, webhook file POST). The channel contract change should not preclude them, but only Slack is implemented here.
- **Ingress file handling.** Downloading the *incoming* photo is the ingress/multimodal side, already shipped (build-order 7.6 / ingress listener); this PRD is egress only.
- **HITL attachments** — putting files *into* HITL hold prompts (e.g. rank candidates as images). Natural follow-up, separate PRD.
- **Multi-channel fan-out delivery** (same file to several channels) and delivery retry policies beyond the existing outbox/reconcile discipline.
- **File lifecycle management** — retention, deletion, or re-hosting of uploaded files after delivery.

## 6. Requirements

### Functional Requirements

1. A station shall be able to declare, in `flow.yaml`, one or more produced files to deliver upon successful completion of that station.
2. The engine shall deliver declared files through the flow's egress channel that declares `uses: [delivery]`; if no channel declares any `uses`, the first egress channel shall be used (matching existing HITL fallback behavior).
3. File delivery shall be performed via Slack's external-upload sequence, and shall be recorded in the outbox such that: a committed intent is never re-fired; a pending intent on resume is reconciled (skip / fire / escalate-to-hold) and never blindly re-posted.
4. Only the upload-completion step shall be treated as the effectful edge; the engine shall be free to re-run the URL-acquisition and byte-transfer steps on retry, as they produce no channel-visible effect.
5. The delivery idempotency key shall be deterministic from the run, card, station, execution attempt, declared file, and the file's content fingerprint — so a later rework attempt (or a changed artifact) is a new delivery, and a resume of the same attempt with the same bytes is a duplicate.
6. A `deliver` block shall be able to reference a substrate field captured at ingress as the thread address; when present, the upload shall land as a threaded reply on that message.
7. Text egress sends shall support the same optional thread addressing.
8. When a `deliver` block references a thread address the run's substrate cannot supply (e.g. a CLI-triggered run of a Slack-shaped flow), the file shall be delivered unthreaded to the channel and the skipped threading shall be journaled — delivery shall not be blocked on a missing address.
9. A `deliver` block may declare an optional text caption; when present, it shall accompany the file on the upload-completion call (not as a separate send or outbox intent).
10. When a station declares multiple files, they shall be uploaded sequentially in declared order; the thread shall receive them in that order, and a resume after a partial delivery shall continue from the first unlanded file.
11. A card whose station work succeeded but whose delivery cannot be completed unambiguously shall hard-pause to `hold` (escalate ambiguity; never guess) — station work shall not be silently re-run to force a re-delivery.
12. Delivery attempts, outcomes, and outbox decisions shall be journaled per attempt, and visible in `explain` output like other effectful sends.
13. Flow load shall reject: a `deliver` block naming zero files; a `deliver` block when the flow declares no egress channel. (A `thread_from` field the substrate cannot supply is a *runtime* condition handled by FR-8, not a load error — the same flow may be triggered by Slack or CLI.)
14. A delivered file shall be one the station legitimately produced: when the flow enforces path ownership, the declared file paths shall fall within the card's owned paths.

### Non-Functional Requirements

1. The bot token shall never appear in logs, journal entries, error messages, or thrown-error properties, including errors raised by the byte-transfer step (parity with the existing FR-11 redaction contract on text sends).
2. File bytes shall never be stored in the database or journal — only paths, sizes, and content fingerprints.
3. A missing or unreadable file at delivery time shall produce a load-bearing, diagnosable error naming the path, and shall hold the card rather than scrapping the completed work.
4. Delivery shall respect the run's consumption accounting: wall-clock spent in delivery counts against the same andon/watchdog surfaces as other effectful sends.

### Edge Cases & Error States

- **Crash between byte-POST and completion call** — nothing is channel-visible; resume re-runs the full three-step safely.
- **Crash between completion call and outbox commit** — the dangerous window; resume must reconcile ("did the file land?") and escalate to hold if unanswerable, never re-fire blind.
- **Upload URL expired** on retry (Slack URLs are short-lived) — re-acquire from step 1; must not be treated as a delivery failure.
- **Rework loop**: attempt N delivered, QC rejects, attempt N+1 produces a new file — N+1 must deliver (attempt in the key); the thread may legitimately receive both versions.
- **Substrate has no `thread_ts`** (e.g. flow triggered by CLI, not Slack ingress) — deliver unthreaded and journal the skipped threading (FR-8); never block delivery on a missing address.
- **Declared file missing/empty at delivery time** (station "succeeded" but didn't produce it) — hold with a naming error; do not scrap.
- **File exceeds Slack's size limit** — fail diagnosably at delivery, not with a raw API error.
- **Multiple files declared** — each is its own outbox intent, uploaded sequentially in declared order (FR-10); partial delivery (2 of 3 landed, crash) must resume from the first unlanded file without re-posting the landed ones.
- **Channel declares `uses: [hitl]` only** — delivery routing must not hijack the HITL channel when a delivery channel is absent but `uses` is declared; load-time validation should catch this (FR-13).

## 9. Technical Considerations

**Resolved decisions** (design discussions, 2026-07-11/12):

1. Delivery attaches as a **station-level `deliver` block** on the terminal work station — not a flow-level on-done hook (invisible to the lane graph) and not a new station kind (ceremony without benefit).
2. The outbox intent guards **only the upload-completion call**; URL acquisition and byte transfer are re-runnable preludes.
3. The Slack transport gains a file-upload capability **alongside** its existing text posting, and the existing outbox-send protocol is **reused, not duplicated**. This work makes `uses: [delivery]` meaningful for the first time.
4. Thread addressing rides the **existing ingress substrate projection** — ingress stashes the triggering message's timestamp on the card; the `deliver` block (and text sends) read it back. No new ingress mechanism.
5. The idempotency key includes the **execution attempt number and the file's content fingerprint** as delivery discriminators (belt-and-braces: rework re-delivers, and a changed artifact is never mistaken for an already-landed one).
6. **Missing thread address is a runtime degrade, not an error**: deliver unthreaded and journal it (FR-8). Load validation does not reject `thread_from` — the same flow may be Slack- or CLI-triggered.
7. **Captions are in scope**: an optional caption on the `deliver` block rides the upload-completion call (FR-9) — same effectful edge, no second intent.
8. **Multi-file delivery is sequential in declared order** (FR-10) — deterministic thread order, prefix-resumable recovery.

**Dependencies / integration points:**

- The effectful outbox (`writePendingIntent` / `commitIntent` / `reconcileOnResume`) — existing, reused as-is.
- Ingress substrate projection on bindings — existing; pic-edit's binding must project the thread timestamp.
- The `uses:` field on egress channels — existing in the schema, consumed for `hitl` only today.
- Slack API: `files.getUploadURLExternal`, `files.completeUploadExternal`, and `files.info` (candidate reconciler probe); bot scopes `files:write` (new — deployments need a scope update).

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Reconciling "did the completion land?" is harder than for text (no message `ts` in hand) | Medium | Ambiguous crashes escalate to hold more often | Investigate `files.info` / thread-history probe as the reconciler; hold is the safe default either way |
| Slack upload URLs are single-use/short-lived, complicating retry sequencing | Medium | Retries fail confusingly | Treat steps 1–2 as one re-runnable unit; never persist the URL as durable state |
| `files:write` scope missing on existing bot installs | High | Delivery fails at runtime in already-deployed workspaces | Diagnosable error naming the scope; document in deployment guide |
| Large files (video) hit size/time limits | Low (pic-edit is images) | Delivery leg fails for heavy flows | Enforce a size check with a clear error; defer chunking/resumable upload |

### Open Questions

None — the four questions raised in the initial draft (missing thread address, fingerprint in the idempotency key, captions, multi-file ordering) were resolved on 2026-07-12 and are recorded as decisions 5–8 in §9.
