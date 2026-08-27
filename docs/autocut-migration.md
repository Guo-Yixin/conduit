# Autocut → Conduit: migration findings

Gap analysis for rebuilding **Autocut**, the video pipeline that transcribes footage,
indexes B-roll, narrates, renders graphics, and compiles FCPXML, as a Conduit flow.
Autocut is one of the three systems whose convergent architecture Conduit extracts
([philosophy](./philosophy.md), SPEC Appendix B); this doc records what the rebuild
actually needs from the kernel.

## Verdict

**Autocut rebuilds on Conduit's existing primitives (steps 1–8).** Every stage decomposes
into `deterministic` + `transform` + `gate` stations ([glossary — station taxonomy](./glossary.md#station-taxonomy)).
No `agentic` (Tool-Bridge, [build-order step 9](./build-order.md)) stations are needed.

Autocut's design doc describes 8 Claude Code agents plus an Executive Producer
orchestrator — but the actual dataflow is typed artifacts at every hand-off
(autocut `src/types/edit-plan.ts`, `graphics-plan.ts`, `transcript.ts`). The "agents"
are **transforms in disguise**: one model call, typed data in, typed data out, no tools,
no loop. The EP orchestrator dissolves into the kernel — tick
([SPEC §10](../SPEC.md#10-the-controller--the-deterministic-tick-adopted-from-ai-team)),
`(lane, status)` FSM ([SPEC §3](../SPEC.md#3-the-state-machine-the-centerpiece)),
and binding-stamped checkpoints ([SPEC §5](../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).

One kernel feature gap (multimodal transform input, [gap 1](#1-multimodal-transform-input--the-kernel-feature-gap)),
two known roadmap items, one confirming test, one minor workaround. Nothing structural.

## Stage mapping

| Autocut (today) | Conduit station(s) | Notes |
|---|---|---|
| EP orchestrator, `project.json` stage enum, `/autocut resume` | Kernel: tick + FSM + checkpoint skip-on-resume | Binding stamps are **stronger** than autocut's filename-convention resume ("draft exists without critique → dispatch critic on existing draft") — a stamp mismatch invalidates and cascades; a stale file can't be mistaken for progress |
| `ingesting` — Transcriber: whisper.cpp per A-roll clip, 4-way concurrency, per-clip resume | `deterministic` station, per-clip fan-out, fan-in `policy: all` | Gaps [2](#2-within-station-concurrency)–[4](#4-dynamic-fan-out-n) |
| `indexing` — B-Roll Indexer: ffmpeg keyframes → vision-model captions | `deterministic` (keyframes) → `transform` (caption) | Blocked by [gap 1](#1-multimodal-transform-input--the-kernel-feature-gap) (multimodal) |
| `narrating` — Draftsman ↔ Editor-in-Chief, 3 rounds max, ship round-3 draft with unresolved findings | `transform` + `gate` check, `on_reject` back-edge, `rework_cap: 3`, `cap_policy: proceed_with_findings` | **Exact policy match** — autocut-design.md §6: "Halt-on-cap is *not* the policy"; that is literally Conduit's `proceed_with_findings` ([SPEC §6](../SPEC.md#6-the-quality-system)) |
| `rendering` — Motion Designer ↔ Brand Manager, optional VLM visual review gated by `quality-policy.json` | `transform` (graphics plan) → `deterministic` (render command) → `gate` | VLM pass blocked by gaps [1](#1-multimodal-transform-input--the-kernel-feature-gap) and [5](#5-policy-gated-optional-stations-minor) |
| `compiling` — Assembler ↔ QC Engineer, FCPXML validation | `transform` (timeline plan) → `deterministic` (`autocut compile`) → `gate` | Part of QC (frame math, asset-reference resolution) should be a **deterministic validator**, not an LLM critic — cheaper and stricter |
| Critic/Creator write-boundary hooks (`block-critic-draft-writes` etc.) | **Unnecessary by construction** | Conduit transforms don't write files; the executor writes declared outputs. The boundary is structural, not hook-enforced |
| `DECISIONS.md` (per-stage + top-level debate logs) | Journal + gate-verdict log | `DECISIONS.md` becomes a deterministic egress/render station reading the journal |
| Black-Letter Rules, `style.json`, `style.md`, cutting-rhythm guide | Critic/maker `prompt_file` inputs; per-project values as flow inputs | Hashed into the binding stamp — a style change correctly invalidates downstream checkpoints |
| Token telemetry (recorded, no ceiling) | Budgets + consumption andon + liveness watchdog ([SPEC §8](../SPEC.md#8-flow-control-scale--the-two-andons)) | Strict upgrade: autocut can observe a runaway; Conduit halts it |

## Gaps

### 1. Multimodal transform input — *the* kernel feature gap

**Evidence:** the transform adapter sends string-only content —
[`src/worker/openai-adapter.ts:166`](../src/worker/openai-adapter.ts):

```ts
messages: [{ role: 'user', content: req.prompt }],
```

B-roll keyframe captioning and the VLM visual-review gate both need image
content-parts in the request.

**Needed:**
- Image paths as declared station inputs in `flow.yaml`.
- Image bytes **hashed into the binding stamp** ([SPEC §5](../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)) — a re-rendered keyframe must invalidate its caption checkpoint.
- Content-parts request shape in the adapter (string + image-part array).

**Size:** small-medium PRD. Adapter change is mechanical; the binding-stamp and
`flow.yaml` input-declaration surface is the design work. This is the only item
that is a genuinely *new* kernel capability.

### 2. Within-station concurrency

**Evidence:** autocut runs up to 4 whisper.cpp workers in parallel
(autocut-design.md §4: hard cap, configurable via `AUTOCUT_TRANSCRIBE_CONCURRENCY`).
Conduit's executor is single-in-flight — the tick loop awaits each station serially
([`src/controller/executor.ts:365`](../src/controller/executor.ts)):

```ts
const laneChanged = await executeStation({
```

**Needed:** concurrent in-flight workers under the per-station `wip` cap. This is a
**known roadmap item**, not a discovery — `watchdog.planDrain` (drain-and-checkpoint on
andon trip) is already built library-only, blocked on exactly this
(see [CLAUDE.md — built-as-library table](../CLAUDE.md)).

**Size:** already planned; Autocut adds a concrete forcing function. Serial
transcription of a multi-clip shoot is a real wall-clock regression vs. autocut today,
so this should land before or with the Autocut flow, not after.

### 3. Deterministic command timeouts

**Evidence:** [`src/worker/deterministic.ts:123`](../src/worker/deterministic.ts)
spawns via `Bun.spawn([cmd.command, ...cmd.args], { stdout: 'pipe', stderr: 'pipe', ... })`
with **no timeout**, then awaits `proc.exited`.

A hung `whisper.cpp` is lethal twice over:
- It counts as an **active worker**, so the liveness watchdog never trips — the
  watchdog requires *no progress AND no active worker* ([SPEC §8](../SPEC.md#8-flow-control-scale--the-two-andons)).
- The synchronous executor (gap 2) blocks forever behind the `await`.

**Needed:** per-station `timeout_seconds` for `deterministic` workers — kill the
process, fail the attempt, let the rework/scrap guards take over.

**Size:** small PRD or a work item folded into gap 2's PRD. Cheap, and it closes a
watchdog blind spot that exists for *every* deterministic flow, not just Autocut.

### 4. Dynamic fan-out N

**Evidence:** clip count is discovered at runtime (ls the A-roll directory); the
branching example pins `fan_out: 3` statically. But the validator comment at
[`src/flow/load.ts:480`](../src/flow/load.ts) — "Absent fan_out → unbounded upper" —
indicates omitting `fan_out` permits worker-determined child counts.

**Needed:** **one confirming test**, not a feature — an executor-path test that a
fan-out station without `fan_out` expands to N runtime-discovered children and fan-in
`policy: all` collects them. Per the project convention, point it at the real
`runExecutor` path, not the test harness.

**Size:** one test. If it fails, *then* it's a small work item.

### 5. Policy-gated optional stations (minor)

**Evidence:** autocut's `quality-policy.json` toggles the VLM visual review on/off
per project; `flow.yaml` has no conditional routing.

**Workarounds (acceptable for v1):** a no-op-when-disabled station (the gate reads the
policy input and passes unconditionally when off), or two flow variants. Neither
needs kernel work. Revisit only if conditional routing recurs across flows.

**Size:** zero for v1; note for the flow.yaml schema backlog.

## What Conduit adds that Autocut lacks

Beyond parity, the rebuild upgrades several things autocut handles by convention:

- **Resume correctness** — binding stamps vs. "does the file exist". A changed prompt,
  model, or style.json invalidates exactly the affected checkpoints
  ([SPEC §5](../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
- **Bounded runaway** — budgets + consumption andon + liveness watchdog replace
  observe-only token telemetry ([SPEC §8](../SPEC.md#8-flow-control-scale--the-two-andons)).
- **Structural write boundaries** — the critic-can't-write-drafts hooks become moot;
  transforms produce data, the executor materializes outputs.
- **Atomic dispatch** — the single-transaction claim replaces the EP's in-process
  bookkeeping ([SPEC §3](../SPEC.md#3-the-state-machine-the-centerpiece)).
- **Cheaper QC where determinism suffices** — frame math and asset-reference
  resolution move from an LLM critic to a deterministic validator station.

## Suggested sequencing

| Item | Vehicle | When |
|---|---|---|
| Gap 1 — multimodal transform input | **New PRD** (`prd/drafts/multimodal-transform.md`) | Before the Autocut flow; the only new kernel capability |
| Gap 2 — within-station concurrency | **Already-planned roadmap item** (unblocks `watchdog.planDrain` wiring too) | With or before the Autocut flow |
| Gap 3 — deterministic timeouts | **Small work item**, fold into gap 2's PRD or stand alone | With gap 2 — same executor surface |
| Gap 4 — dynamic fan-out | **One contract test** against `runExecutor` | Anytime; cheap de-risk |
| Gap 5 — policy-gated stations | **No-op workaround**, schema-backlog note | v1 ships without it |
| The Autocut flow itself | `flow.yaml` + prompts + deterministic commands — a builder artifact, not kernel work | After gaps 1–3 |

## Strategic note

Autocut joins Studio and Nitpick as the third transform-only flow — **three of
Conduit's four originating flows ship before the agentic Tool-Bridge
([step 9](./build-order.md)) exists**. This is the station-taxonomy bet
([SPEC §4](../SPEC.md#4-the-routing--flowyaml-the-engineconfig-seam)) paying out:
the highest-risk surface stays deferred while real production lines run, and the
dogfood pressure on the kernel comes from `transform`+`deterministic` flows where the
blast radius is data, not a filesystem.
