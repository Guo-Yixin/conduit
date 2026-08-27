---
missionId: ~
---

# Conduit — Docker Packaging & Install Docs

**Author:** Josh Owens  **Date:** 2026-06-15  **Status:** Done  _(open questions resolved 2026-06-16, D1–D8)_

> Scope note: this is a **post-MVP, packaging** PRD. The architectural decision is already
> made and accepted in [`ADR-0003`](../../adr/0003-packaging-and-distribution.md) (Docker-first,
> Bun baked into the image); this PRD turns that decision into **shippable artifacts** — the
> Dockerfile(s), the volume/secrets posture, and the install documentation that ADR-0003
> *explicitly deferred* to `docs/installation.md`. It depends on the shipped MVP kernel
> ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) and the ingress listener
> ([`prd/done/ingress-listener.md`](../done/ingress-listener.md)). It directly closes
> **launch-readiness item #2** ([`docs/launch-readiness.md`](../../docs/launch-readiness.md)) —
> the most-cited adoption gap across reviews. The *why* lives in ADR-0003; this document defines
> *what must be true* and *why*, and stays as implementation-free as a packaging spec can.

## 1. Context & Background

Conduit ships **two distinct artifacts** ([ADR-0001](../../adr/0001-build-vs-buy-the-orchestration-substrate.md),
[ADR-0003](../../adr/0003-packaging-and-distribution.md)): **the engine** (kernel + `conduit`
CLI) and **a flow** (the user's `flow.yaml` + station prompts + hooks + adapters + `.env` +
`conduit.sqlite`). ADR-0003 decided the distribution: **Docker images with Bun baked in**, so an
operator runs a container and never installs a runtime, while three load-bearing properties stay
intact — user `.ts` hot-loads (Bun is present, no `--compile`), crash-safe resume (`conduit.sqlite`
+ project root persist on a mounted volume), and the Law gets container-level blast-radius
isolation for agentic tool loops.

The decision is accepted; the **artifacts do not exist**. There is no `Dockerfile`, no compose
file, and no `docs/installation.md` anywhere in the repo. ADR-0003 itself defers the "install
recipe (Dockerfile, run command, volume/secrets/prereqs checklist)" to `docs/installation.md`,
and the launch-readiness review flags that doc as the single most-cited gap — it gates the
adoption test ("a useful example running in 10 minutes") and is the prerequisite for anyone
deploying their own flow. Today the kernel is fully runnable from source (`bun` + the CLI), but a
non-developer operator (e.g. a customer running the Studio flow) has no supported path to run it, and a
developer has no canonical container to iterate in.

This PRD specifies the packaging artifacts and the install documentation that make ADR-0003 real.

## 2. Problem Statement

ADR-0003 committed Conduit to Docker-first distribution but shipped none of it. A would-be
operator cannot run a flow without cloning the repo and hand-managing Bun, secrets, and the SQLite
volume — exactly the friction Docker-first was meant to remove. Worse, the **sharpest operational
footgun** ADR-0003 names — putting `conduit.sqlite` + the project root on the container's ephemeral
filesystem instead of a mounted volume, which *silently* destroys resume/checkpoint/cost-recovery
on the next restart — has no guardrail, no documented run command, and no boot-time check. And the
secrets discipline ("never `COPY .env`; runtime injection only") is currently just prose in an ADR,
enforced by nobody. Conduit needs **buildable, documented Docker artifacts** — an engine image, a
per-flow image pattern, the correct volume/secrets posture, and an install walkthrough — so an
operator can `docker run` a flow turnkey and a developer can iterate against a mounted project,
without anyone learning the state-loss footgun the hard way.

## 3. Target Users & Use Cases

**Primary user — the flow operator (a customer).** Non-technical. Wants to run a finished flow
(Studio ad-factory, the branching example) without installing Bun, Conduit, or wrangling a
runtime. Runs a container, supplies secrets via env, points it at a volume, and interacts through
the egress channels. Cares only that it runs, survives a restart, and never silently eats state.

**Secondary user — the flow developer (engineer).** Builds and iterates on a flow. Wants a
canonical engine image to mount their project into for fast iteration (edit `flow.yaml`/hooks →
re-run, no rebuild), plus a clear path to bake a turnkey per-flow image to hand to an operator.
Cares about reproducible per-flow prerequisites (ffmpeg, git) and a sane secrets story.

**Tertiary user — the deployer/ops.** Stands the listener up as a long-lived container, wires a
local-model sidecar, and runs `conduit doctor` to confirm the volume and prereqs before going live.

**Key use cases:**

- An operator **runs a baked per-flow image turnkey** (`docker run studio …`) with secrets
  injected at runtime and state on a named volume, and the run survives a container restart.
- A developer **mounts their project into the engine image** for fast iterate-without-rebuild.
- A developer **bakes a per-flow image** that includes the flow's files and its system
  prerequisites (`apt-get` ffmpeg/git as the flow needs).
- A deployer **runs the ingress listener (`conduit listen`) as its own long-lived container**
  sharing the same `conduit.sqlite` volume as the per-run kernels it spawns.
- A deployer **stands up a local model as a sidecar** (not baked into the image) the adapter
  reaches over HTTP, keeping the engine image lean and model-agnostic.
- Any user **follows `docs/installation.md` to get the branching example running end-to-end** —
  build/pull, run, supply secrets, mount the volume, verify with `conduit doctor` — in ~10 minutes.

## 4. Goals & Success Metrics

The packaging is graded on **turnkey operability and state safety**, and on the **install docs
being good enough that a stranger can run a flow from them**. It is not graded on image-size
micro-optimization or registry/CI sophistication.

| Goal | Metric | Target |
|------|--------|--------|
| Operator runs without a host runtime | A flow runs via `docker run` with no Bun/Conduit installed on the host | 100% |
| State survives restart | A run interrupted by a container restart resumes correctly when state is on the documented volume | 100% |
| State-loss footgun is guarded | A container started **without** the state volume mounted is caught (boot check / `conduit doctor` non-zero) rather than silently running on ephemeral FS | Caught, never silent |
| Secrets never in an image layer | Secrets present in any built image layer (`docker history` / layer inspection) | 0 |
| Install docs are sufficient | A person following `docs/installation.md` only can get the branching example running end-to-end | Yes, ≤ ~10 min |
| User `.ts` hot-loads in-image | Flow hooks / transform stations (`.ts`) load and run inside the container with no `--compile` step | 100% |

**Explicitly NOT a goal:** a compiled single-binary distribution ([ADR-0003](../../adr/0003-packaging-and-distribution.md)
alt A — deferred), multi-host orchestration / k8s manifests, a published registry pipeline as the
deliverable (a reproducible *build* is in scope; *publishing* is not), image-size golf, or baking
any model into an image.

## 5. Scope

### In Scope

> The eight open questions are now resolved (D1–D8, §9). The in-scope items below reflect those
> decisions: a debian-slim pinned base, multi-arch, a non-root user, a single dispatching
> entrypoint with a `conduit doctor` pre-flight, a `prerequisites:` field in `flow.yaml`, a
> `conduit build` helper, and two compose files.

- **An engine image** — a single image built `FROM oven/bun:1.3.11-slim` (debian-slim, pinned —
  D1), built **multi-arch for `amd64` + `arm64`** (D2), running as a **non-root user** (D3),
  containing the kernel + `conduit` CLI and able to execute arbitrary user `.ts` at runtime (no
  `bun --compile`). Its **entrypoint dispatches** to the `conduit` subcommands — `run` / `listen` /
  `doctor` — so one artifact serves the per-run kernel and the listener (D7).
- **A `conduit doctor` entrypoint pre-flight** — the container runs `conduit doctor` at start,
  before `run`/`listen`; a non-zero result aborts the container with a clear remedy (D4). This is
  the loud guard for the state-volume footgun and missing prereqs/model endpoint.
- **A `prerequisites:` field in `flow.yaml`** (e.g. `prerequisites: [ffmpeg, git]`) — the single
  source of truth for a flow's system packages, validated at load. Both the per-flow image build
  and `conduit doctor` read it, so they cannot drift (D5).
- **A `conduit build` helper command** — scaffolds and/or builds a flow's per-flow image
  `FROM conduit:<version>`, baking the flow's `flow.yaml`/stations/hooks/adapters and `apt-get`-ing
  the packages from its `prerequisites` field (D6). This is a new CLI surface (it expands the PRD
  beyond pure packaging) that makes a turnkey `docker run <flow>` image reproducible without a
  hand-authored Dockerfile.
- **The state-on-a-volume posture, enforced, not just documented** — `conduit.sqlite` + the
  project root live on a named volume / bind mount; the `conduit doctor` pre-flight (D4) fails
  loudly when the state directory is not a writable mount, so the ephemeral-FS footgun cannot
  happen silently.
- **Runtime secrets discipline** — a `.dockerignore` that excludes `.env`; the image build never
  `COPY`s secrets; secrets arrive via `-e` / mounted `.env` / Docker secrets at run time. A check
  that the build is secret-free.
- **A local-model sidecar pattern** — models are endpoints, not image contents (incl. local
  models); the operator compose (below) stands a local model up as a sidecar/host-reachable
  endpoint the adapter calls.
- **The listener as its own container** — `conduit listen` runs as a long-lived container (the same
  engine image, `listen` subcommand) sharing the per-run kernels' `conduit.sqlite` volume (the
  ingress/always-on split from [`ingress-listener`](../done/ingress-listener.md)).
- **`conduit doctor` extensions** — probes for the container context: state dir is a writable
  mount, project root present, the flow's `prerequisites` present, model endpoint reachable. Builds
  on the existing `conduit doctor` (`src/cli/cmdDoctor`).
- **A pinned Bun version** — `1.3.11` pinned in the base image (contains
  [ADR-0002](../../adr/0002-bun-as-the-kernel-runtime.md) churn), in one authoritative place with a
  documented bump procedure.
- **`docs/installation.md` — a first-class deliverable, not an afterthought (launch-readiness #2).**
  The install recipe: obtain/build the engine image, build a per-flow image via `conduit build`,
  the canonical `docker run` command, the volume/secrets/prereqs checklist (incl. the non-root
  bind-mount permission note), the local-model sidecar, running the listener container, `conduit
  doctor` verification, and a **complete end-to-end walkthrough that runs the shipped branching
  example** ([`examples/branching/`](../../examples/branching/)) from a clean machine. This doc is
  its own work item with its own acceptance criteria (see FR-11) and is required for the PRD to be
  considered done.
- **Two `docker-compose` files** (D8): a **dev-iteration** stack (engine image with the project
  bind-mounted + local-model sidecar + named state volume → edit-and-re-run, no rebuild) and a
  **reference operator** stack (listener container + per-run kernel + model sidecar + shared volume,
  wired correctly) that doubles as living documentation of the listener/volume topology.

### Out of Scope

- **The compiled single binary** ([ADR-0003](../../adr/0003-packaging-and-distribution.md) alt A) —
  deferred to a local-CLI convenience; run the "compiled binary loads user `.ts`" spike first
  ([build-order](../../docs/build-order.md)). Not this work.
- **A published registry / CI image-build-and-push pipeline as a deliverable.** Images must build
  reproducibly and the Dockerfile must be CI-buildable, but standing up the registry and the
  publish workflow is a separate ops concern.
- **Multi-host / k8s / Compose-as-production-orchestration**, HA, run-per-container via the Docker
  API — the multi-host revisit (SPEC §17 F1) is deferred.
- **Baking any model into an image** — explicit non-goal (ADR-0003); models stay endpoints.
- **Changing how a run executes once started** — this is packaging only; the kernel, the Law,
  ingress, and egress are unchanged.
- **Windows/host-native install paths** beyond what Docker Desktop provides.

## 6. Requirements

Requirements describe observable, testable outcomes of the packaging; the Dockerfile mechanics are
the implementation.

### Functional Requirements

1. The project **shall** provide a single **engine image** built `FROM oven/bun:1.3.11-slim`
   (debian-slim, pinned — D1), **multi-arch for `amd64` + `arm64`** (D2), running as a **non-root
   user** (D3). It **shall** contain the kernel + `conduit` CLI and **shall** execute user flow
   `.ts` (hooks, transform stations) at runtime without a `bun --compile` step (the hot-load
   property ADR-0003 requires). Its **entrypoint shall dispatch** to `conduit` subcommands —
   `run` / `listen` / `doctor` — so one image serves both the per-run kernel and the listener (D7).
2. The image **shall**, on container start, run `conduit doctor` as a **pre-flight** before
   `run`/`listen`; a non-zero result **shall** abort the container with a clear remedy and **shall
   not** proceed to a run (D4). This is the loud gate for FR-7/FR-8.
3. A flow **shall** declare its system prerequisites in a `prerequisites:` field in `flow.yaml`
   (e.g. `prerequisites: [ffmpeg, git]`), validated at load (config-is-validated). This field
   **shall** be the single source of truth consumed by **both** the per-flow image build (FR-4) and
   `conduit doctor` (FR-8), so the image and the probe cannot drift (D5).
4. The project **shall** provide a **`conduit build` helper command** that produces a per-flow
   image `FROM` the engine image — baking the flow's `flow.yaml`, stations, hooks, and adapters, and
   installing the packages from its `prerequisites` field (FR-3) — such that a flow author can
   produce a turnkey `docker run <flow>` image without hand-authoring a Dockerfile (D6). (New CLI
   surface; see §5.)
5. The image build **shall not** include any secret in any layer — no `COPY .env`, no secret in a
   build arg that lands in history. A `.dockerignore` **shall** exclude `.env` (and equivalent
   secret files), and secrets **shall** be injectable only at run time (`-e` / mounted file /
   Docker secret).
6. A running container **shall** read and write `conduit.sqlite` and the project root **only** from
   a mounted volume / bind mount, never the ephemeral container FS, so resume/checkpoint/cost
   recovery survive a container restart.
7. When the state directory is **not** a writable mount (the ephemeral-FS footgun), the `conduit
   doctor` pre-flight (FR-2) **shall** detect it and fail loudly with a clear remedy rather than
   running silently on ephemeral storage. State loss **shall not** be a silent outcome.
8. `conduit doctor` **shall** be extended to validate the container deployment context: the state
   directory is a writable mount (FR-7), the project root is present, the flow's `prerequisites`
   (FR-3) are present, and the configured model endpoint is reachable — each probe reported
   individually, non-zero exit on any failure (consistent with the existing `conduit doctor`).
9. The packaging **shall** treat models as endpoints, not image contents (including local models),
   and **shall** ship a sidecar/host-endpoint pattern (the operator compose, FR-12) the per-model
   adapter reaches over HTTP. No model **shall** be baked into the engine image.
10. The ingress listener (`conduit listen`) **shall** be runnable as its own long-lived container
    (the same engine image, `listen` subcommand) that shares the same `conduit.sqlite` volume as the
    per-run kernels it spawns, consistent with the ingress/always-on split. (The container = run
    model holds for the per-run kernel.)
11. The project **shall** ship **`docs/installation.md`** covering, at minimum: (a) obtaining/
    building the engine image; (b) building a per-flow image **via `conduit build`**; (c) the
    canonical `docker run` command with volume + secrets + prereqs (incl. the **non-root bind-mount
    permission** note from D3); (d) running the listener container; (e) the local-model sidecar;
    (f) `conduit doctor` verification; (g) the Bun-version bump procedure (FR-13); and (h) a
    **complete, copy-pasteable end-to-end walkthrough that runs the shipped branching example from a
    clean machine**. The walkthrough **shall** be accurate against the actual artifacts (a reviewer
    following it on a clean environment reaches a running flow). This doc is a tracked deliverable
    with its own acceptance criteria, **not** a documentation footnote to the Dockerfile work.
12. The project **shall** ship **two `docker-compose` files** (D8): (a) a **dev-iteration** stack —
    the engine image with the project bind-mounted + a local-model sidecar + the named state volume,
    such that editing a flow's `.ts`/`flow.yaml` and re-running does **not** require an image
    rebuild; and (b) a **reference operator** stack — listener container + per-run kernel + model
    sidecar + the shared `conduit.sqlite` volume, wired correctly, doubling as living documentation
    of the listener/volume topology.
13. The Bun version (`1.3.11`) **shall** be pinned in exactly one authoritative place in the base
    image, with the bump procedure documented in `docs/installation.md` (FR-11g).

### Non-Functional Requirements

1. **State safety is the headline guarantee.** The volume posture (FR-6) and the loud-failure guard
   (FR-7) **shall** make silent state loss impossible in the documented happy path; the docs
   **shall** call the footgun out everywhere it matters (ADR-0003 names this the sharpest risk).
2. **Reproducible builds.** Given the same inputs, the engine and per-flow images **shall** build
   deterministically; the Bun version and per-flow prereqs are pinned, not floating.
3. **Lean, model-agnostic engine image.** The engine image **shall not** carry models or per-flow
   prerequisites; those belong to per-flow images (prereqs) and sidecars/endpoints (models).
4. **Secret hygiene is verifiable.** It **shall** be possible to demonstrate (e.g. `docker history`
   / layer inspection in a test or doc step) that no secret is present in a built image layer.
5. **Docs accuracy is testable.** The end-to-end walkthrough (FR-11) **shall** be verifiable by
   following it on a clean environment; doc steps that drift from the real artifacts are defects.
6. **Containerization as the agentic-flow isolation posture** **shall** be documented as the
   recommended deployment for agentic flows (blast-radius containment complementing the Law), per
   ADR-0003.

### Edge Cases & Error States

- **Container started without the state volume** → boot guard / `conduit doctor` fails loudly with
  a remedy; the kernel does not silently run on ephemeral storage (FR-7).
- **State volume mounted read-only / unwritable** → detected and reported, not discovered mid-run.
- **`.env` accidentally present in the build context** → excluded by `.dockerignore`; if a secret
  still reaches a layer, the secret-free check (FR-5/NFR-4) catches it.
- **Per-flow prerequisite missing** (e.g. ffmpeg not baked but the flow needs it) → `conduit
  doctor` reports it before the run hits a deterministic-station failure.
- **Model endpoint unreachable** (sidecar not up / wrong host) → `conduit doctor` reports it; the
  run does not start blind.
- **Bun version drift** between docs and the image → single pinned source of truth (FR-13) so the
  doc cannot silently diverge.
- **Listener and per-run kernels on different volumes** → the listener's `ingress_events` dedup
  authority and the kernels' state must share one `conduit.sqlite`; a split is a misconfiguration
  the docs and `conduit doctor` must steer against.

## 7. Design Principles

- **Decision is settled; this is execution.** ADR-0003 made the architectural calls (Docker-first,
  Bun in the image, two-layer images, state on a volume, runtime secrets, models as endpoints).
  This PRD does not relitigate them — it ships them and documents them.
- **State safety over convenience.** The volume posture is non-negotiable and *enforced*, not just
  advised; silent state loss is the one outcome the packaging must make impossible.
- **The image is invisible runtime, not a framework.** The operator manages a container and
  nothing else; the engine image stays lean and model-agnostic; per-flow specifics live in per-flow
  images and sidecars.
- **Config and environment are validated, not trusted.** `conduit doctor` is the boot gate — volume,
  prereqs, and model endpoint are checked loudly before a run, consistent with the kernel's
  config-is-validated ethos.
- **Docs are part of the product.** The install walkthrough is a graded deliverable with its own
  acceptance criteria; an inaccurate install doc is a defect, not a nicety.

## 8. Technical Considerations / Dependencies

**Dependencies:**

- **[ADR-0003](../../adr/0003-packaging-and-distribution.md)** — the accepted decision this PRD
  executes (Docker-first, Bun baked, two-layer images, volume, secrets, models-as-endpoints,
  pinned Bun, container=run, agentic isolation).
- **[ADR-0002](../../adr/0002-bun-as-the-kernel-runtime.md)** — Bun runtime; the base image is
  `oven/bun:<pinned>`, and the hot-TS-load property is why a compiled binary is *not* the operator
  path.
- **The shipped MVP kernel** ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)) — `conduit run`,
  `conduit doctor`, the per-run daemon model, and SQLite-as-authority (resume/checkpoint).
- **The ingress listener** ([`ingress-listener.md`](../done/ingress-listener.md)) — `conduit
  listen` as the long-lived container that shares the state volume.
- **The existing `conduit doctor`** (`src/cli/cmdDoctor`, tested in `src/cli/cli.test.ts`) — this
  work extends its prereq probes for the container context; it is not built from scratch.
- **The shipped branching example** ([`examples/branching/`](../../examples/branching/)) — the
  concrete flow the end-to-end install walkthrough drives.

**Integration points:**

- `oven/bun:<pinned>` base image; the Docker build/run toolchain; named volumes / bind mounts.
- `conduit run` / `conduit listen` / `conduit doctor` — the CLI entrypoints the images expose.
- The per-model adapter's HTTP boundary — the seam to the model sidecar/endpoint.

**Constraints:**

- **Single-writer SQLite.** The listener container and the per-run kernels must share one
  `conduit.sqlite` on one host (multi-host is out of scope; the volume is the shared authority).
- **Docker required on the host** — the accepted cost of this distribution (the deferred binary is
  the local-no-Docker escape hatch, not built here).
- **Secrets must never enter a layer** — a hard build constraint, not a guideline.

## 9. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Operator runs without the state volume → silent resume/checkpoint loss | Medium | High | FR-7 loud-failure guard + `conduit doctor` (FR-8); docs call it out everywhere (NFR-1) |
| A secret lands in an image layer | Medium | High | `.dockerignore`, no `COPY .env`, runtime-only injection (FR-5), verifiable secret-free check (NFR-4) |
| Install docs drift from the real artifacts → "works on my machine" | Medium | Medium | Docs accuracy is testable on a clean env (NFR-5); walkthrough drives the real branching example (FR-11) |
| Engine image bloats / couples to a model or flow prereqs | Low | Medium | Lean model-agnostic engine image (NFR-3); prereqs → per-flow images, models → sidecars |
| Bun pin drifts between image and docs | Low | Low | Single authoritative pin (FR-13) |
| Scope creep into a registry/CI/k8s pipeline | Medium | Medium | Hard scope line: reproducible *build* in, publish/orchestration out (§5) |

### Resolved Decisions (2026-06-16)

The eight open questions are settled. None reopen ADR-0003; each maps to the FR(s) that make it
testable.

- **D1 — Base image variant → `oven/bun:1.3.11-slim` (debian-slim, pinned).** `apt` is available
  so per-flow images can install prerequisites (ffmpeg/git), while staying smaller than full debian.
  Alpine/distroless rejected for the engine base: distroless has no `apt`/shell (breaks per-flow
  prereqs) and Alpine's musl has Bun edge cases. The Bun patch is pinned (ADR-0003). *(FR-1, FR-13.)*
- **D2 — Architectures → multi-arch `amd64` + `arm64`.** amd64 for servers/CI, arm64 for Apple
  Silicon dev machines and Graviton. One-time buildx setup avoids slow emulation for Mac devs and a
  painful migration later. *(FR-1.)*
- **D3 — Container user → non-root.** A dedicated non-root UID for defense-in-depth, complementing
  the Law's blast-radius containment for agentic flows. The bind-mount permission wrinkle (host dir
  must be writable by that UID) is handled in the install docs. *(FR-1, FR-11c.)*
- **D4 — `conduit doctor` wiring → entrypoint pre-flight (fail-fast).** The container runs `conduit
  doctor` once at start, before `run`/`listen`; non-zero aborts immediately with a remedy. Chosen
  over a periodic `HEALTHCHECK` (which can't stop an already-exited per-run container) and over
  manual-only (which leaves the state-loss footgun ungated). A `HEALTHCHECK` may be added later for
  the long-lived listener. *(FR-2, FR-7, FR-8.)*
- **D5 — Per-flow prereqs → a `prerequisites:` field in `flow.yaml`.** One source of truth, validated
  at load; both the per-flow image build and `conduit doctor` read it, so the image and the probe
  cannot drift. *(FR-3, FR-4, FR-8.)*
- **D6 — Per-flow image ergonomics → a `conduit build` helper command.** Scaffolds/builds the
  per-flow image from the flow dir, reading `prerequisites` (D5). Chosen over a copy-paste Dockerfile
  template for UX; **this is an accepted scope expansion** — a new CLI surface with its own
  tests — beyond pure packaging. *(FR-4.)*
- **D7 — Entrypoint shape → one image, dispatching entrypoint.** A single engine image whose
  entrypoint passes args to the `conduit` CLI (`run`/`listen`/`doctor`); the per-run kernel and the
  listener are the same image invoked differently. Fewest artifacts to build/pin/publish; matches
  how `conduit` already dispatches subcommands. *(FR-1, FR-10.)*
- **D8 — Compose scope → two files: dev-iteration + reference operator.** (1) Dev: engine image with
  the project bind-mounted + model sidecar + named volume (edit-and-re-run, no rebuild). (2)
  Operator: listener + per-run kernel + model sidecar + shared volume, doubling as living
  documentation of the listener/volume topology and the install walkthrough's backbone. *(FR-12.)*
