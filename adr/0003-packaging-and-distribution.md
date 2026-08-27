# ADR-0003: Packaging & distribution — Docker-first, Bun in the image

Status: Accepted
Date: 2026-05-30

## Context

Conduit ships **two distinct artifacts** (see [ADR-0001](./0001-build-vs-buy-the-orchestration-substrate.md)):

1. **The engine** — the kernel + the `conduit` CLI.
2. **A flow (a project)** — the user's `flow.yaml` + station prompts + hooks (`.ts`) +
   adapters + `.env` + `conduit.sqlite`.

We need to deliver this to an **operator** (e.g. a customer running the Studio ad-factory flow) who
should not have to install or manage a runtime, while keeping three properties intact:

- **User TS hot-loads.** Hooks (the Law), the Work Bench, and transform stations are `.ts`
  the engine loads at runtime ([ADR-0002](./0002-bun-as-the-kernel-runtime.md)). The
  distribution must be able to execute arbitrary user TS, not just a pre-bundled entrypoint.
- **Crash-safe resume.** The kernel is a resident per-run daemon whose authority is SQLite
  (SPEC §10A/§11). Whatever we ship must persist `conduit.sqlite` + the project root across
  restarts, or the resume/checkpoint/cost-recovery story silently breaks.
- **The Law needs isolation.** Agentic stations run tool loops; the Law (Bash allowlist,
  path ownership) is the guardrail, and a deployment-level sandbox is valuable defense in
  depth (SPEC §7).

## Decision

**Distribute Conduit as Docker images, with Bun baked into the image.** The operator runs a
container; they never install Bun or Conduit on a host.

- **Bun is forced into the image** (`FROM oven/bun:<pinned>`), which both removes operator
  runtime-management *and* lets the engine execute user `.ts` natively — no `bun --compile`
  needed.
- **Two-layer images.** An **engine base image** (`conduit:<version>`) and **per-flow images**
  built `FROM` it that bake the flow's `flow.yaml`/stations/hooks/adapters. Operators get a
  turnkey baked image (`docker run studio …`); developers use the engine image with the
  project mounted as a volume for fast iteration. Both fall out of the same multi-stage build.
- **State lives on a mounted volume — non-negotiable.** `conduit.sqlite` + the project root
  are a named volume / bind mount, never the container's ephemeral filesystem. (Skipping this
  silently destroys resume/checkpoint on restart.)
- **Secrets at runtime, never in a layer.** `SLACK_BOT_TOKEN`, model API keys, etc. come via
  `-e` / mounted `.env` / Docker secrets. The image build must not `COPY .env`.
- **Per-flow system prerequisites are baked** (`apt-get` ffmpeg/git/… as the flow needs) and
  validated at boot by `conduit doctor`.
- **Models are endpoints, not image contents — including local models.** Consistent with
  [ADR-0002](./0002-bun-as-the-kernel-runtime.md)'s boundary (models reached over HTTP via the
  per-model adapter), a **local** model (e.g. the prompted/coercive adapter the MVP requires per
  the kernel PRD) is **not** baked into the engine image. It runs as its own concern — a sidecar
  container or a host-reachable endpoint (`OLLAMA_HOST`-style) the adapter calls. This keeps the
  engine image lean and model-agnostic (the model-independence thesis), and lets CI stand up the
  local model as a sidecar service. Baking a model into the image is an explicit non-goal.
- **The Bun version is pinned** in the base image (contains ADR-0002's churn risk).
- **Process model:** for the egress-first MVP, **container = run** — `docker run <flow> --idea
  …` per campaign (batch), triggered by CLI/cron with Slack for egress. The ingress webhook
  (`conduit listen`) becomes a separate long-lived container later.
- **Containerization is the recommended deployment isolation for agentic flows** — it bounds
  the blast radius of a tool loop to the container, complementing the Law.

## Alternatives considered

### A. Compiled single binary (`bun build --compile`) — *deferred, not chosen*
Attractive (one file, no runtime install) and thesis-aligned ("one fast binary"). Rejected
as the operator path for two reasons: (1) whether a `--compile` binary can transpile-and-load
*arbitrary external user `.ts`* at runtime is an open question, and our userland is hot TS;
(2) for a server-deployed factory, a container is the more natural operator artifact anyway
(reproducible env, baked prereqs, isolation). **The binary is explicitly deferred to a
local-CLI convenience** for developers who want `conduit` on `$PATH` without Docker — *not*
the operator distribution. Revisit only if a no-Docker local audience emerges (and run the
"compiled binary loads user TS" spike then).

### B. Bun package on the host (`bun add -g @conduit/cli`) — *rejected for operators*
Fine for *developers* (and we'll still publish it for them), but it forces the operator to
install and manage Bun and the package. Docker forces Bun into the *image* instead, which is
the whole point.

### C. Global npm install / Node — *rejected*
Inherits ADR-0002's Node friction (native SQLite driver, build step) on top of forcing a
host runtime. Superseded by Docker.

## Consequences

**We gain**
- The operator manages nothing but a container; the runtime is invisible to them.
- User `.ts` hot-loads natively (Bun present in the image) — the Work Bench and the Law work
  unchanged.
- Reproducible environments: per-flow prerequisites are baked and version-pinned.
- A deployment sandbox for the Law (blast-radius containment), strongest exactly where it
  matters (cheap-model agentic stations).
- Standard ops surface: registry, CI image builds, `docker run`, volumes, secrets.

**We pay / risks**
- **Requires Docker on the host.** Fine for a server-deployed factory; a real constraint for
  pure-local CLI use — which is precisely the gap the deferred binary (A) would fill.
- **The volume must be right or state is silently lost.** This is the sharpest operational
  footgun; it's called out everywhere it matters and belongs in the (future) install doc and
  `conduit doctor`.
- **Secrets discipline is on us** — the Dockerfile must never bake `.env`; runtime injection
  only.
- **Image build/size maintenance** and keeping the pinned Bun version current.

**Revisit triggers**
- A no-Docker, local-CLI audience → resurrect the compiled-binary spike (alternative A).
- Multi-host / orchestrated scale → container orchestration (Compose/k8s), the ingress
  listener as its own container, and possibly run-per-container via the Docker API
  (ties to ADR-0001 / SPEC §17 F1 multi-host revisit).

## References

- SPEC §1 (Runtime), §7 (the Law / sandbox), §10A (process model), §11 (persistence / state
  must persist), §4 (prerequisites, `conduit doctor`).
- ADR-0001 (build-vs-buy), ADR-0002 (Bun runtime).
- Install recipe (Dockerfile, run command, volume/secrets/prereqs checklist): deferred to
  `docs/installation.md`.
