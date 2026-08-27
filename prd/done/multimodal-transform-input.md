---
missionId: ~
---

# Conduit — Multimodal Transform Input

**Author:** Josh Owens  **Date:** 2026-06-13  **Status:** Done

> Scope note: this is a **kernel feature** PRD, not a flow or a doc task. It is the one
> net-new capability the [Autocut migration analysis](../../docs/autocut-migration.md)
> identified (gap #1) and the only kernel-level gap across all three pre-launch reviews.
> It depends on the shipped real-run path ([`prd/done/real-run-path.md`](../done/real-run-path.md))
> — the `transform` station, the kernel-mediated model adapter, binding-stamped
> checkpoints — and changes how a `transform` worker is fed, not how the kernel routes.
> The *what* and *why* live here; the *how* belongs in the mission's design step.

## 1. Context & Background

Every `transform` station today sends the model a single string: the rendered prompt
(`src/worker/adapter.ts` — `ModelCall.prompt: string`; `src/worker/openai-adapter.ts:166`
— `messages: [{ role: 'user', content: req.prompt }]`). That is sufficient for text-in,
text-out critics and briefers, which is most of Studio and the tiktok dogfood flow.

It is **not** sufficient for any station that must *look at an image to judge it*. Two
of Autocut's stages need exactly that, and the migration analysis showed they are the
only thing blocking an Autocut rebuild on the kernel:

- **B-roll captioning** — a vision model describes extracted keyframes so the narrative
  stage has legible B-roll to pick from.
- **VLM visual review** — a critic looks at rendered graphics and judges them against the
  brand spec (the optional pass gated by `quality-policy.json`).

Studio's image-grading critics want the same capability. Without it, every vision-critique
station is impossible, and "rebuild my flows on the kernel" stalls on its first
image-shaped flow. This is the highest-leverage kernel addition on the roadmap precisely
because it unblocks whole flows rather than improving one that already runs.

Note what this is **not**: image *generation* (an effectful output side effect — Studio's
image-executor) is a separate concern handled by effectful deterministic/adapter stations
and the outbox. This PRD is about a transform *reading* images, not *producing* them.

## 2. Problem Statement

A `transform` station cannot accept an image as input. The model call seam carries only a
rendered text prompt, so a flow author has no way to put a keyframe, a rendered graphic, or
any other image in front of a vision model and get a typed judgment back. Vision-critique
stations — captioning, visual QC, image grading — are unbuildable on the kernel today, and
they are the gating dependency for migrating Autocut and for Studio's image-review stages.

## 3. Target Users & Use Cases

**Primary user — the flow author building a vision-critique station.** They already write
`transform` stations; they want to declare one or more image inputs alongside (or instead
of) text inputs and have the model actually see them. They care that resume and checkpoint
skipping stay correct when an image input changes — the same guarantee text inputs have.

**Key use cases:**

- An author declares a `transform` whose worker is a vision model and whose input is an
  extracted keyframe; the model returns a typed caption. (Autocut B-roll indexing.)
- An author declares a `gate` check whose critic looks at a rendered graphic plus the
  text brief and emits `{approved, findings}` for brand violations. (Autocut VLM review,
  Studio image grading — a critic is a `transform`, so it inherits the capability.)
- An author mixes a text artifact and an image in one station — the text renders into the
  prompt, the image is attached — and both reach the model in one call.
- An author re-runs after a crash; a station whose image input is byte-for-byte unchanged
  is skipped from checkpoint, and a station whose image changed is re-executed.

## 4. Goals & Success Metrics

The feature is graded on whether vision stations become buildable *and* keep every
determinism guarantee a text transform has — not on how many image formats are supported.

| Goal | Metric | Target |
|------|--------|--------|
| Images reach the model | A `transform` with a declared image input produces a call in which the model receives that image | 100% of declared image inputs |
| Resume stays sound | Changing an image input changes the station's binding stamp; an unchanged image input does not | Verified by test, both directions |
| Vision stations buildable | Autocut B-roll captioning and VLM review can be expressed as Conduit stations with no kernel change beyond this feature | Both expressible |
| No regression to text flows | Existing text-only transforms are byte-for-byte unaffected | Full suite green; text-only call shape unchanged |
| Fail-loud on capability mismatch | An image input sent to a text-only model is caught with a clear error, not a silent drop or an opaque provider 400 | Validated at load or classified at call |

## 5. Scope

### In Scope

- A way to declare **image inputs** on a `transform` station, distinct from text artifacts
  that render into the prompt.
- Carrying image references through the kernel model-call seam to the adapter.
- Building a multimodal (content-parts) request in the OpenAI-compatible adapter.
- **Binding-stamp coverage of image inputs** — image bytes hashed into the stamp exactly
  as text input bytes are today, so checkpoint skip-on-resume stays sound.
- Mixed text + image inputs on one station.
- Validation/error handling: capability mismatch (image → text-only model), missing image
  file, unsupported format/oversize — each surfaced clearly, never silently dropped.
- Correct token/cost accounting for vision calls (image tokens counted, never `NaN`).

### Out of Scope

- **Image generation / any image *output*.** That is an effectful side effect (Studio's
  image-executor) handled by the outbox and a separate adapter; not this PRD.
- **Agentic vision** (an agentic station with image tools) — step 9, the Tool-Bridge.
- **Video/audio inputs.** Autocut extracts keyframes via a deterministic `ffmpeg` station
  first, so the transform only ever sees still images. Whisper transcription is likewise a
  deterministic station, not a multimodal transform.
- **Image inputs rendered *into* the prompt text** (e.g. inline markdown). Images are
  attached parts, not substituted strings — keep the two input kinds distinct.
- **Provider-specific vision features** beyond a basic image part (detail levels, bounding
  boxes, etc.). Start with "here is an image, look at it." The image-input *declaration*
  is nonetheless an extensible object (not a bare string) so a `detail`/resolution hint can
  be added later without a breaking schema change (see Resolved Q4).
- **Runtime-variable / globbed image sets** (e.g. "caption all `keyframe_*.png`"). Image
  inputs are statically declared paths; variable cardinality (N clips) is handled by
  fan-out at the card level, not a glob (see Resolved Q2). Globbing is a possible later
  extension.

## 6. Requirements

### Functional Requirements

1. A `transform` station shall be able to declare a bounded list of image inputs as
   statically-declared file paths, distinguishable from text artifact inputs at config
   load. (Image inputs are an extensible declaration object, not a bare string — see
   Resolved Q4.)
2. The kernel shall pass declared image inputs to the model adapter as part of the model
   call, alongside the rendered text prompt.
3. The OpenAI-compatible adapter shall construct a content-parts message containing the
   text prompt and the image(s), in the provider's expected multimodal shape.
4. Image inputs shall be hashed into the station's binding stamp on the same footing as
   text inputs, so that a changed image invalidates the checkpoint and an unchanged image
   permits skip-on-resume.
5. A station shall support text and image inputs together: text inputs render into the
   prompt; image inputs attach to the call.
6. Declaring an image input on a station whose worker model lacks vision capability shall
   be surfaced as a **classified, non-retryable** error at call time (capability behind a
   model gateway cannot be known at load — see Resolved Q1). It shall scrap as
   `model-incompatible` immediately, NOT consume the execution-attempt retry budget — a
   capability mismatch is deterministic, not transient. Recovery is by config fix +
   resume, not retry.
7. A declared image input whose file is missing or unreadable at dispatch shall follow the
   same failure path as a missing text input (clear error, no guess).
8. Token and cost accounting shall account for image input tokens; a provider response that
   omits or malforms usage shall be handled per the gateway-validation hardening (see
   Dependencies), never producing `NaN`.
9. The kernel shall apply a per-call payload guard — a maximum image byte size and a
   maximum image count per call, with sensible configurable defaults near the provider's
   documented limits — and reject an over-limit call with a clear kernel error rather than
   surfacing an opaque provider rejection. The per-run token budget remains the cost
   ceiling; this guard only catches a single pathological input (see Resolved Q3).

### Non-Functional Requirements

1. Existing text-only transforms shall be unaffected — the call shape for a station with no
   image inputs is unchanged.
2. The image-input mechanism shall respect the existing input-scope discipline: only
   declared inputs are read; an undeclared image is never opened (mirrors the text-input
   scope guard in `src/flow/render.ts`).
3. Image bytes shall not leak into logs, journal, or error messages beyond a path/hash
   reference — consistent with the project's secret-handling posture.
4. The feature shall not weaken the network-egress boundary: the kernel still makes the
   model call on the worker's behalf; the worker reaches no network.

### Edge Cases & Error States

- **Image declared, model is text-only** → classified non-retryable call-time error,
  immediate `model-incompatible` scrap; does not burn execution attempts (FR-6).
- **Mixed inputs where the prompt template references an image name as `{{image}}`** →
  reject: images are attached, not substituted; a placeholder pointing at an image input is
  a config error with a clear message.
- **Oversized or unsupported-format image** → validated/clear error, not a provider 400
  surfaced raw, and not a silent truncation.
- **Image input under rework** → feedback is still text; images are re-attached each
  attempt; the binding stamp includes both the image hash and the feedback hash.
- **Vision response with no/odd `usage`** → finite token accounting, never `NaN` (ties to
  the consumption-andon safety fix).
- **Provider returns the image back / echoes it** → adapter reads only the text completion,
  as today.

## 8. Solution Approach

Images are a **second kind of station input**, parallel to text artifacts — not a new
worker kind and not a routing change. The kernel already reads each declared input's bytes
to compute the binding stamp; the change is to (a) let a station mark certain inputs as
images, (b) carry those image references through the model-call seam instead of dropping
them after hashing, and (c) have the adapter assemble a content-parts request.

The two input kinds stay deliberately separate because they are consumed differently: a
text input is *rendered into* the prompt string (template substitution), while an image
input is *attached alongside* it. Keeping them distinct preserves the prompt-scope guard
(undeclared names are never read) and avoids the category error of trying to substitute
binary bytes into a text template.

Determinism is the part that must not regress. The binding stamp is what makes
skip-on-resume sound; image inputs must be hashed into it exactly as text inputs are, so an
edited keyframe invalidates its station (and cascades downstream via input re-hashing) just
like an edited text artifact. This is a small extension of existing behavior, not a new
mechanism.

From the author's seat, a vision-critique station should read almost like a text critic:
the same `worker`/`check` shape, a vision-capable `model`, and image inputs declared
alongside text ones. The migration target is that Autocut's B-roll captioner and VLM
reviewer drop in as ordinary `transform`/`gate` stations.

## 9. Technical Considerations

**Constraints:**

- OpenAI-compatible content-parts format is the target wire shape (the existing adapter is
  OpenAI-compatible via the configured base URL). Other providers' vision shapes are out of
  scope for v1.
- The model-call seam (`ModelCall` in `src/worker/adapter.ts`) currently exposes only
  `prompt: string`; extending it is the central interface change and must stay
  test-stubbable (the seam exists so tests inject a stub with no network).
- Vision capability is model-dependent and not always knowable from the model id alone;
  the validation strategy (load-time list vs. call-time classification) is a design-step
  decision called out in FR-6.

**Dependencies:**

- **Gateway response validation** (pre-launch review §1.3 / launch-readiness checklist) —
  vision calls make malformed/absent `usage` more likely; FR-8 assumes that hardening
  lands first or alongside, so image-token accounting can't silently zero out the andon.
- **Autocut migration** ([`docs/autocut-migration.md`](../../docs/autocut-migration.md))
  is the consuming work; this feature is its gating dependency. Autocut also needs
  deterministic-command timeouts and a dynamic-fan-out test, which are separate items.

**Integration points:**

- `src/worker/adapter.ts` (the seam), `src/worker/openai-adapter.ts` (request assembly +
  usage parsing), `src/controller/executor.ts` (binding-stamp input hashing, ~lines
  725-748), `src/flow/load.ts` and `src/flow/schema.ts` (declaring + validating image
  inputs), `src/flow/render.ts` (ensuring image names are not treated as text placeholders).

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Binding stamp silently misses an image input → stale checkpoint reuse on a changed image | Low | A vision station skips when it should re-run; wrong output shipped | FR-4 with a both-directions test (changed → re-run, unchanged → skip) is the acceptance gate |
| Capability mismatch surfaces as an opaque provider 400 | Medium | Confusing author experience, looks like a kernel bug | Classify at call time as non-retryable `model-incompatible`; clear message; recover via config fix + resume (FR-6) |
| Capability mismatch retries to cap before scrapping | Medium | Wasted token/attempt budget on a deterministic failure | FR-6 requires fast-scrap, not retry — the error is non-transient |
| Image bytes leak into journal/logs/error text | Low | Secret-posture regression | NFR-3: path/hash references only |
| Seam change ripples into the agentic adapter (step 9) prematurely | Low | Scope creep into the Tool-Bridge | Keep the change to the transform seam; agentic vision is explicitly out of scope |

### Resolved (2026-06-13)

- [x] **Q1 — Vision-capability validation → call-time, non-retryable.** Capability behind
      a model gateway (LiteLLM-style proxy) isn't kernel-knowable, so no load-time
      allowlist to maintain. Classify the provider's images-to-text-model rejection at call
      time as a non-transient `model-incompatible` error and **fast-scrap** — do not feed
      the retry loop (retrying a deterministic failure just burns the attempt budget).
      Recovery is config fix + resume: swapping the model bumps `flow_version`, invalidates
      only that station's binding stamp, and reuses every upstream checkpoint. (FR-6.)
- [x] **Q2 — Image source → statically-declared file paths; no glob; fan-out for
      cardinality.** "Image from an upstream station" and "image file under `project_root`"
      are already the same thing — station outputs are files read by path downstream
      (Autocut's keyframe-extract is a deterministic `ffmpeg` station writing files). So no
      new "upstream image" mechanism. Variable clip counts are handled by fan-out at the
      card level; a station may declare a bounded list of image inputs. Runtime-variable /
      globbed image sets are deferred. (Scope, FR-1.)
- [x] **Q3 — Payload caps → light per-call guard.** Max image bytes + max images per call,
      configurable defaults near provider limits, clear kernel error on over-limit. The
      token budget stays the real cost ceiling; the guard only catches a single pathological
      input. (FR-9.)
- [x] **Q4 — `detail`/resolution hint → deferred, declaration kept extensible.** Don't ship
      the knob in v1, but make the image-input declaration an extensible object so `detail`
      can be added later without a breaking change. (Scope.)

### Open Questions

None blocking — all four resolved above. Remaining choices (exact default byte/count
limits in FR-9, the precise content-parts wire shape) are design-step details for the
mission, not product decisions. This PRD is ready for `/ai-team:plan`.
