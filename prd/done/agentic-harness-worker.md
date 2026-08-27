---
missionId: ~
---

# Conduit — The Agentic Harness Worker (headless-harness stations)

**Author:** Josh Owens  **Date:** 2026-07-07  **Status:** Done

> Scope note: this PRD defines the **harness-delegated agentic worker** — a station kind
> whose worker is an external **headless agent harness** (`claude -p`, `codex exec`,
> anything CLI-shaped) wrapped in Conduit's transform contract: declared inputs, typed
> `output_schema`, owned paths, `check:` gates, kernel bounds, and per-attempt
> journaling. It realizes the *capability* of build-order **step 9** for the flows that
> need it today,
> while making a **deliberately weaker containment claim** than the in-kernel
> **Tool-Bridge + Law** defined in [`agentic-tool-bridge.md`](../drafts/agentic-tool-bridge.md)
> (SPEC §7). **Decision (2026-07-07):** this is the **precursor tier** of step 9 —
> and if it proves sufficient in practice it may simply become the long-term strategy
> (why build an in-kernel tool loop if we never have to?). The Tool-Bridge PRD stays
> in `drafts/` as the Law-grade fallback, unbuilt unless a flow demands per-call
> gating. The station kind is **`kind: harness`**, so `agentic` keeps its Law-grade
> meaning in SPEC §7.

## 1. Context & Background

The kernel's thesis is that quality comes from `work → check → bounded rework`, with the
whole loop **visible to the kernel**: journaled attempts, journaled verdicts, rework
guards, budgets, binding stamps. Steps 1–8.2 shipped that for `deterministic` and
`transform` stations. What changed is that **real flows now need tool-using workers** —
and they are working around the kernel instead of through it:

- The content repo's `post` flow needs a **research maker** that reads cited sources
  (repos, blog posts, the web) and assembles a curated source document, and an
  **adversarial research gate** that independently re-derives the document's claims —
  quote-diffing excerpts against primaries, re-fetching links, attacking attribution.
  Both require tools (filesystem read, web fetch/search). `kind: transform` — one call,
  no tools — cannot do either.
- The workaround running today is a `kind: deterministic` station wrapping `claude -p`
  in a bash script, with the maker → adversary → rework loop run *inside* the script.
  It works, and the kernel sees none of it: **no per-attempt journal rows, no
  `gate_verdict` entries, no rework accounting, no binding stamps, no token/cost
  attribution**. The budgets and andons are blind to the most expensive calls in the
  flow, and the quality loop — the thing the kernel exists to make legible — happens
  off the books.

Two prior production defects sharpen the timing. One showed what happens when a gate
the author believes exists silently never runs; the off-books harness loop is the
same failure mode built on purpose. Another taught the watchdog to treat multi-minute
model calls as liveness — the exact latency profile harness attempts have. The
kernel substrate is now ready for this worker kind; the
flows are already paying for its absence.

This PRD is the **pragmatic tier of step 9**: the tool loop is delegated to a harness
that already has one, and Conduit owns everything around it. The **full Tool-Bridge**
(kernel-owned loop, the Law as a pre-execution gate on every tool call) remains the
eventual Law-grade tier and is out of scope here.

## 2. Problem Statement

Flow authors need stations whose worker uses tools across multiple turns — research,
adversarial verification, code-adjacent work — and Conduit offers no station kind that
can do it. The only path is smuggling an agent CLI inside a deterministic station,
which strips the work of everything Conduit promises: journaled attempts, gate
verdicts, rework bounds, budget attribution, and checkpoint soundness. The kernel's
own design commitment — *the check is the quality engine* — is currently violated by
its own recommended workaround.

## 3. Target Users & Use Cases

**Primary user — the flow author** (today: the content repo's `post`/`research` flows;
tomorrow: any flow needing tool-using makers or critics). Wants to declare an agentic
station in `flow.yaml` the same way they declare a transform — prompt, inputs, outputs,
schema, gate — pick a harness by name, and get the full kernel contract: bounded,
journaled, resumable, gated.

**Secondary user — the kernel's own feedback loops.** Kaizen (step 10) and the
Skill-Lab eval harness consume journaled attempts, verdicts, and
parse-miss/variance signals. An off-books loop produces none of these; a first-class
agentic worker feeds them for the highest-value stations in the fleet.

**Tertiary user — the cost owner.** Wants the most expensive calls in any flow (3–4
minute harness attempts) attributed in the journal and counted by the run/wave budgets
and the consumption andon, not invisible inside a bash script.

**Key use cases:**

- A flow author needs a **research maker** with `tools: [read, web_fetch, web_search]`
  behind an **adversarial critic gate** with `{{feedback}}` threading, so a rejected
  source document is reworked with the adversary's findings — all journaled.
- A flow author needs an **agentic critic** on a transform or deterministic maker — the
  adversary itself needs tools to re-fetch and re-derive claims.
- A flow author needs to **swap harnesses by config** (`claude-headless` → a Codex or
  local-model harness) with no flow changes beyond the adapter name — the
  no-provider-lock-in commitment, kept.
- An operator needs a crashed run to **resume without re-billing** completed agentic
  attempts — binding stamps and checkpoints must hold for the most expensive stations,
  not just the cheap ones.

## 4. Goals & Success Metrics

The bar is **contract parity with transform stations** — an agentic station must be as
legible, bounded, and resumable as a transform, with the tool loop as the only new
freedom.

| Goal | Metric | Target |
|------|--------|--------|
| The quality loop is on the books | Agentic maker behind a `check:` gate produces journaled `gate_verdict` rows and honors the four rework guards, identically to a gated transform | 100% of gated runs |
| Every attempt is journaled | Per-attempt journal rows carrying harness identity, model, duration, output-artifact hashes, and usage (when the harness reports it) | 100% of attempts, including failures |
| Resume is sound | Completed agentic stations skipped on resume iff the binding stamp matches; stamp mismatch invalidates and cascades downstream | 100%; 0 re-billed completed attempts |
| Nothing runs unbounded | Agentic attempts exceeding wall-clock timeout, execution-attempt cap, or tripping the consumption andon that are not terminated/scrapped/halted accordingly | 0 |
| Containment holds at the boundary | Harness writes outside the card's `owned_paths` that advance the card instead of hard-pausing to `hold` | 0 |
| No provider lock-in | Harness adapters demonstrating config-only swap on the same flow (e.g. `claude-headless` + one other, one of which may be a test-fake) | ≥ 2 |
| The watchdog stays honest | Liveness false-stalls during in-flight harness attempts | 0 |

**Explicitly NOT a goal:** per-tool-call pre-execution gating (that is the Tool-Bridge's
claim, impossible by construction here), agentic cost *reduction*, or interactive
mid-attempt conversation.

## 5. Scope

### In Scope

- **A first-class `kind: harness` station** declared in `flow.yaml`: harness adapter name,
  model, `prompt_file`/`prompt_version`, a `tools:` allowlist passed to the harness,
  declared `inputs`/`outputs`, typed `output_schema`, and per-station bounds.
- **The harness adapter seam**: harnesses are named adapters whose invocation templates
  live in **engine configuration, not flow.yaml** — the flow references a harness by
  name; the engine defines how it is executed. Adapters ship **pre-made with the
  engine** — no user-extensible adapter surface in v1 (build more when someone asks,
  don't pre-optimize). Shipping adapter(s): `claude-headless`; the seam proven by at
  least one more (real or test-fake).
- **Transform-contract parity**: rendered/mounted declared inputs; `{{feedback}}`
  threading on rework; typed output validation with coercive parsing; parse misses and
  failed attempts counted against `max_execution_attempts` → scrap as model-incompatible
  on exhaustion.
- **`check:` gates in both directions**: an agentic maker behind any critic, and an
  agentic critic checking any maker — with `gate_verdict` journaling and the four
  rework guards intact.
- **Kernel bounds**: per-attempt wall-clock timeout with process(-group) termination;
  execution-attempt caps; harness-reported usage flowing into card/wave/run budgets and
  the consumption andon; liveness integration so an in-flight attempt counts as
  progress through the adapter-activity liveness seam.
- **Per-attempt journaling and binding stamps**: attempt rows as specified in Goals;
  the binding stamp extended so harness identity and prompt version participate in
  checkpoint skip/invalidate semantics.
- **The harness containment profile** (honest, documented, weaker than the Law):
  mandatory owned-paths integrity gating for agentic stations, secrets passed by
  explicit allowlist only, deployment-level containment guidance (the ADR-0003
  container), and harness-native permission narrowing passed through where the harness
  supports it.
- **Failure legibility**: harness missing/hung/crashed, unparseable output, and missing
  declared outputs each surface as distinct, named failure states — never a silent
  advance, applying the earlier silent-failure lessons from day one.

### Out of Scope

- **The in-kernel Tool-Bridge and the full Law** — kernel-owned tool loop, per-call
  pre-execution gating, Bash positive allowlist, `unshare --net` egress denial. That
  remains [`agentic-tool-bridge.md`](../drafts/agentic-tool-bridge.md) (see OQ-1).
- **A kernel tool protocol / per-model tool adapters** — the harness brings its own
  loop and its own model access.
- **Interactive mid-attempt HITL** — attempts are non-interactive by design, and
  station prompts **should instruct the harness to complete or fail rather than pause
  for input**; holds happen between stations (rank/HITL), never inside an attempt.
  HITL flows via a harness are an anti-pattern, not a roadmap item.
- **Multi-turn state across attempts** — each attempt is fresh: inputs + feedback in,
  artifacts out. No conversation resumption.
- **Kaizen (step 10) and the Skill-Lab runner** — this PRD produces the
  signals they consume; it does not build them.
- **Streaming transcript UI / live observation** of a running attempt.

## 6. Requirements

### Functional Requirements

1. A flow **shall** be able to declare an agentic station whose worker is a named
   harness adapter, with the same declared-inputs / typed-outputs / owned-paths
   contract as a transform station; the flow loader **shall** validate the declaration
   (known adapter name, prompt file exists, schema well-formed, tools allowlist
   recognized) at load time, before anything runs.
2. Harness invocation definitions **shall** live in engine configuration and be
   referenced from `flow.yaml` by name only; a flow **shall not** be able to supply an
   arbitrary command line (config is validated, not trusted).
3. An agentic attempt **shall** receive its rendered inputs and — on rework — the
   gate's `{{feedback}}`, exactly as a transform attempt does; its declared outputs
   **shall** be validated present and schema-conformant before the card advances, with
   coercive parsing and bounded retry identical in spirit to the transform path.
4. An agentic station **shall** compose with the existing `check:` gate construct in
   both roles (maker under a gate; critic over any maker), producing journaled
   `gate_verdict` rows and honoring all four rework guards.
5. Every attempt — success or failure — **shall** produce a journal row carrying the
   harness identity, model, wall-clock duration, hashes of produced artifacts, and
   usage where reported; budget accounting **shall** consume that usage.
6. The checkpoint binding stamp for a harness station **shall** incorporate the
   harness **adapter name**, model id, and prompt version such that a change to any
   of them invalidates the checkpoint and cascades downstream on resume; an unchanged
   station **shall** be skipped on resume without re-invoking the harness. The
   harness **binary version is deliberately excluded** from the stamp — upgrading the
   installed harness does not invalidate checkpoints, and documentation **shall**
   state that the operator owns harness upgrades and their behavioral consequences.
7. Each attempt **shall** be bounded by a per-station wall-clock timeout; on expiry the
   kernel **shall** terminate the harness process tree, record the attempt as failed,
   and count it against the execution-attempt cap.
8. An in-flight harness attempt **shall** register as liveness progress (no false
   watchdog stall) while remaining subject to the consumption andon and its own
   timeout — the two-andons distinction preserved.
9. Writes by the harness outside the card's `owned_paths` **shall** hard-pause the card
   to `hold` via the integrity gate; for agentic stations this integrity check **shall**
   be mandatory, not opt-in.
10. A missing or non-executable harness binary **shall** fail at startup/load for flows
    that declare it — never mid-run at first dispatch.
11. An effectful agentic station **shall** use the inherited outbox + idempotency
    discipline; a resume **shall never** blind-re-fire a completed effectful attempt.

### Non-Functional Requirements — Security & Containment

> This kind makes a **weaker containment claim than the Law** and must say so plainly:
> the harness owns its tool loop, so Conduit cannot gate individual tool calls
> pre-execution. Containment is a documented **profile** at the process boundary.

1. **Boundary integrity is mandatory.** The owned-paths integrity gate (FR-9) **shall
   not** be disableable for agentic stations; ambiguity in path resolution fails
   closed.
2. **Secrets by allowlist only.** The harness child environment **shall** contain only
   explicitly allowlisted variables (e.g. the harness's own auth token); the kernel's
   environment **shall not** be inherited wholesale, and allowlisted names **shall**
   be declared in engine configuration, not flow.yaml.
3. **Permission narrowing is passed through, or explicitly waived.** Where a harness
   supports tool/permission restriction (e.g. an allowed-tools flag), the station's
   declared `tools:` allowlist **shall** be translated and enforced via the harness's
   own mechanism. A declared allowlist the adapter cannot express **shall** fail at
   load — unless the station carries an explicit acknowledgment flag (e.g.
   `unrestricted_tools: true`), in which case the flow loads and the waiver renders
   as a warning in `conduit explain`. Fail-closed by default; conscious opt-out, never
   silent degradation.
4. **Deployment containment is the outer wall.** Documentation **shall** state that
   agentic flows belong in the ADR-0003 container and that the container — not the
   kernel — is the blast-radius boundary for what the harness does inside its loop.
5. **Network posture: full egress in v1, stated plainly.** A harness station has
   network access — the harness must reach its model provider, and research tools
   exist to fetch. v1 **shall not** attempt kernel-level egress restriction for this
   kind, and documentation **shall** say so in exactly those words rather than imply
   otherwise. What makes this acceptable is the rest of the profile holding together:
   the env allowlist (NFR-2) keeps the exfiltratable surface to the harness's own
   auth token; the container (NFR-4) is the operator's network-policy boundary; and
   the journal stores artifact hashes and usage, never raw transcripts. An
   allowlisted egress proxy is a possible later tier, not a v1 promise.
6. **Blast-radius floor at the process boundary.** The harness child **shall** run
   with its working directory inside the project root and **shall** be terminated as
   a process group (never a lone pid) on timeout or halt; documentation **shall**
   recommend a dedicated non-root container user for agentic flows.

### Non-Functional Requirements — Operability

1. Enforcement decisions (load validation, integrity, bounds) **shall** be
   deterministic and table-testable — never judged by a model.
2. Usage/cost **shall** be read from the harness's structured output where available,
   never scraped from free-text transcripts. A harness that reports no usage **shall**
   be bounded by wall-clock and attempt caps, its usage journaled as explicitly
   *unknown* — never zero — and the station flagged as usage-blind in
   `explain`/`doctor`. (Both launch adapters report usage; this is the exceptional
   path.)
3. The harness adapter seam **shall** be testable without network or a real harness —
   a test-fake adapter drives the full station lifecycle in CI, in the spirit of the
   existing fake-adapter transform tests.
4. `conduit explain` **shall** render agentic stations, their gates, and their harness
   identity so the flow author's mental model matches the runtime (the earlier lesson:
   explain/validate/runtime must agree).

### Edge Cases & Error States

- **Harness binary missing / not executable** → load/startup failure naming the
  adapter and the path probed (FR-10); never discovered at first dispatch.
- **Harness hangs** → wall-clock timeout kills the process tree; attempt journaled as
  timed out; counts against the attempt cap; card scraps on exhaustion.
- **Harness exits non-zero** → attempt journaled with exit state; bounded retry; never
  a silent advance.
- **Harness completes but a declared output is missing or fails `output_schema`** →
  coercive-parse/retry path; on exhaustion scrap with a reason that names the contract
  violation, distinct from "the model is incapable."
- **Harness writes outside `owned_paths`** → integrity gate hard-pauses to `hold`
  naming the paths; the effect already happened, so a human reconciles — never
  auto-reverse.
- **Kernel crashes mid-attempt** → on resume, a pure station's incomplete attempt
  re-runs (bounded by the stamp/checkpoint rules); an effectful station's pending
  intent follows the outbox reconciliation path — unknown outcome escalates, never
  blind-retries.
- **Two agentic critics/makers race on cost** → wave/run budgets and the consumption
  andon see harness usage like any other usage; an over-budget subtree scraps without
  halting the run (existing guard #4 semantics).
- **The harness itself is prompt-injected by fetched content** (a research station
  reading a hostile page) → the kernel does not claim to prevent it; the containment
  profile bounds the blast radius (owned-paths integrity, env allowlist, container),
  and the adversarial gate exists precisely to catch corrupted output. Documented
  honestly as residual risk (OQ-2).

## 7. Design Principles

- **Parity before novelty.** An agentic station is a transform with a longer leash —
  every kernel promise (journal, gates, bounds, stamps, recovery) holds identically;
  the tool loop is the only new freedom.
- **The harness is labor, not architecture.** Adapter names in config, invocation in
  the engine, zero kernel dependency on any vendor's CLI. Swapping harnesses is a
  config edit.
- **Claim only what you enforce.** This kind cannot gate tool calls; it must never
  imply it does. The containment profile is documented as a boundary contract
  (owned-paths, env allowlist, container), and the Law-grade tier remains a separate,
  explicitly-named future.
- **Loud beats silent, from day one.** Every failure state in this surface gets a
  distinct, named, journaled outcome. The earlier silent-failure cluster is the
  cautionary tale; none of those classes ship here.
- **Deterministic flow, non-deterministic labor.** The harness decides nothing about
  routing; the kernel decides what is legal next. No LLM in dispatch — unchanged.

## 8. Solution Approach

An agentic station behaves, from the kernel's seat, like a transform whose single
"model call" is replaced by "spawn the named harness with the rendered prompt and
declared inputs; wait, bounded; collect declared outputs and usage." Everything
upstream (claim, dispatch, checkpoint skip) and downstream (output validation, gate,
rework, journaling, budgets) is the existing machinery, extended to carry harness
identity where the model id alone used to suffice.

The flow author's experience: declare the station like a transform, add
`harness: claude-headless` and a `tools:` allowlist, attach a `check:` gate as usual.
The operator's experience: the journal shows each attempt with duration, cost, and
artifact hashes; `conduit explain` shows the station, its harness, and its gate;
resume skips what's stamped and re-runs what isn't; the andons and budgets see
everything.

Phasing is deliberately maker-first (the research station is the driving use case),
critic-second (the adversary gate), effectful-last (nothing in the driving flows needs
an effectful agentic station on day one).

## 9. Technical Considerations / Dependencies

**Constraints:**

- **Harness latency reshapes the runtime envelope.** 3–4 minute attempts are the norm;
  every timeout, lease, and liveness default must be sane at that scale (the long-call liveness fix is
  the prerequisite, already shipped).
- **Harness output stability is an operator-owned dependency.** A harness CLI's
  output format can change under it; adapters lean on the harness's *structured*
  output modes and ship contract tests against recorded outputs. The harness binary
  version is deliberately not part of the binding stamp — the operator owns harness
  upgrades (FR-6).
- **The harness needs network** (its own model calls, and research tools by design) —
  the SPEC's "egress denied by default for content workers" posture does not apply to
  this kind; v1 is full-egress-in-the-container, stated plainly (NFR-Security-5).

**Dependencies:**

- The shipped kernel substrate: FSM, atomic claim, checkpoint + binding stamps +
  cascade invalidation, outbox, four rework guards, budgets, both andons, owned-paths
  integrity gate, and adapter-activity liveness.
- Engine configuration as the home for adapter definitions and env allowlists
  (trusted), vs `flow.yaml` (validated, untrusted).
- ADR-0003 Docker packaging as the containment wall and the place harness binaries are
  baked/mounted.
- The existing unified gate machinery (`runGateCheckOrAdvance`) — the
  agentic path should compose with it, not fork it.

**Integration points:**

- The journal (attempt rows, gate verdicts, usage) — consumed later by kaizen
  and the Skill-Lab eval harness.
- `conduit explain` / `validate` / `doctor` (render the station; probe the harness).
- The worker-pool seam: agentic stations stay on the synchronous in-process path
  initially, like every other non-plain station today.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Containment expectations gap — readers assume Law-grade guarantees | High | High | Distinct `kind: harness` naming keeps `agentic`'s Law-grade meaning; explicit "containment profile" + full-egress-in-v1 documentation; SPEC §7 gains a short harness-tier note |
| Harness output/format drift breaks the adapter mid-flight | Medium | Medium | Adapters consume structured output modes only; contract tests with recorded outputs; failures surface as named contract violations, never silent |
| Cost runaway from multi-minute, tool-looping attempts | Medium | High | Wall-clock timeout per attempt; attempt caps; usage → budgets + consumption andon; usage-blind harnesses journal *unknown* (never zero) and are flagged in explain/doctor |
| Zombie harness process trees after timeout/crash | Medium | Medium | Kill the process group, not the pid; reap-and-verify on timeout; crash-resume reconciliation journaled |
| Secrets leak into the harness env or its transcript | Low | High | Env allowlist only; engine-config-declared names; no kernel env inheritance; journal stores hashes/usage, not transcripts |
| Prompt injection via fetched content produces corrupted artifacts | Medium | Medium | Adversarial gate as the quality control; containment profile bounds blast radius; residual risk documented, not hidden |
| Two step-9 PRDs confuse the roadmap | Medium | Low | Resolved: this is the precursor tier (possibly permanent); the Tool-Bridge PRD stays in `drafts/` as the unbuilt Law-grade fallback; build-order updated to name both tiers |

### Resolved (2026-07-07)

- [x] **OQ-1 — Relationship to the Tool-Bridge PRD.** **Precursor tier** — and if the
  harness tier proves sufficient in practice, it may simply be the long-term strategy
  (why build an in-kernel tool loop if we never have to?). `agentic-tool-bridge.md`
  stays in `drafts/` as the unbuilt Law-grade fallback; build-order names both tiers.
- [x] **OQ-2 — Naming.** **`kind: harness`.** `agentic` keeps its Law-grade meaning in
  SPEC §7; SPEC gains a short note naming the harness tier and its containment
  profile. The safety thinking for "no Law in the loop" lives in the
  NFR-Security profile (integrity gate, env allowlist, process-group bounds,
  container wall, adversarial gate as the quality control).
- [x] **OQ-3 — Network posture.** **Full egress in v1**, documented in exactly those
  words (NFR-Security-5). Safety comes from the profile holding together — minimal
  env surface, container network policy as the operator control, hashes-not-
  transcripts in the journal — not from pretending to restrict. Allowlisted proxy is
  a possible later tier.
- [x] **OQ-5 — Binding-stamp identity.** Adapter name + model id + prompt version.
  The harness **binary version is excluded** — upgrades don't cascade-invalidate
  checkpoints; the operator owns harness upgrades (FR-6).
- [x] **OQ-8 — Mid-attempt interactivity.** Never. HITL-via-harness is an
  anti-pattern; station prompts should instruct the harness to complete or fail
  rather than pause for input. Holds live between stations only.
- [x] **OQ-9 — Adapter extensibility.** Pre-made, engine-shipped adapters only for
  v1. Build more when someone asks — don't pre-optimize an extensibility surface
  that is also an arbitrary-command-execution surface.
- [x] **OQ-10 — Qualification gate.** None. Prompt/station quality is the flow
  author's responsibility, supported by the Skill-Lab eval harness when it
  ships. Load-time probing covers "is the harness present and invocable."

- [x] **OQ-4 — Usage-blind harnesses.** Wall-clock + attempt-cap bounds; usage
  journaled as explicitly *unknown* (never zero); station flagged in
  `explain`/`doctor`. Both launch adapters report usage (`claude -p` emits structured
  usage/cost; Codex emits token counts in its JSON stream), so this is the
  exceptional path — don't overbuild it.
- [x] **OQ-6 — Harnesses that can't narrow tools.** Fail-closed with explicit opt-in:
  load fails unless the station carries an acknowledgment flag (e.g.
  `unrestricted_tools: true`), which also renders as a warning in `conduit explain`
  (NFR-Security-3).
- [x] **OQ-7 — Feedback shape.** Prompt-threaded `{{feedback}}`, exactly like
  transforms — zero new machinery, full parity. Guard #3 hashes the critic's findings
  from the verdict regardless of delivery, so nothing about the rework guards
  changes. A findings-file artifact can be added later without breaking this if
  findings outgrow prompts in practice.

### Open Questions

*None.* All ten discovery questions are resolved above; the PRD is decision-complete
and ready for promotion to `prd/ready/` when the roadmap calls for it.

## 11. Rollout & Measurement

**Phasing:**

- **Phase 1 — Pure agentic maker + gate (the research flow).** The `claude-headless`
  adapter, maker stations behind existing critic gates, bounds, journaling, stamps,
  containment profile. Ships when the content repo's `research` flow runs on-the-books
  end to end.
- **Phase 2 — Agentic critics + second adapter.** The adversary gate as an agentic
  critic; the second harness adapter proving the seam; `explain`/`doctor` coverage.
- **Phase 3 — Effectful harness stations.** Outbox-disciplined effectful stations
  (e.g. a committing coder). Prompt/station quality validation stays with the flow
  author and the Skill-Lab eval harness — there is no kernel qualification gate
  for harness+model pairs.

**Measurement plan:**

- The driving flow's journal is the acceptance artifact: after Phase 1, every research
  attempt, verdict, and rework in the content repo's flow appears in the journal with
  cost attribution — the "off the books" delta goes to zero.
- Track parse-miss rate and attempt-duration distribution for agentic stations from
  day one (the same signals the Skill-Lab runner will consume).
- Rollback criterion: if the containment profile proves insufficient in practice (an
  integrity hold or secrets incident traced to the harness boundary), agentic stations
  are disabled by config while the profile is revised — the flows fall back to the
  deterministic-wrapper workaround they run today.
