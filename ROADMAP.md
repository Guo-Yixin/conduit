# Conduit Roadmap

Conduit is an open-source quality-control runtime for AI workflows. It turns
model calls, deterministic work, human review, and delivery into inspected,
retryable, auditable production steps.

This roadmap is directional. It describes the shape of the project and the
current launch bar, not a promise that every item will land in this exact order.

## Current Status

The core runtime is implemented for deterministic and transformation flows:

- `flow.yaml` loading and validation
- deterministic stations for command-based work
- transformation stations for typed model calls
- gate checks with bounded rework
- checkpoint binding stamps and crash/resume recovery
- fan-out, fan-in, and rank selection
- Slack human-in-the-loop selection
- webhook and Slack ingress
- journal and card-log persistence
- Docker-first packaging with per-flow image builds
- flow explanation through `conduit explain`

The kernel is useful today for developers who are comfortable running local
commands, reading logs, and working directly with examples. The next launch work
is about making that value easier to try, inspect, and explain.

## Developer Preview

The developer preview is the first public OSS milestone. Its goal is simple: an
interested developer should be able to clone the repo, run a real example,
understand the quality loop, and see where Conduit fits.

Preview launch bar:

- clean repository state and current `main`
- normal CI for tests and typecheck
- clear license, contribution, security, and environment-example files
- README quickstart that can be followed from a clean checkout
- one canonical example flow that runs end to end
- Docker walkthrough for engine and per-flow images
- channel docs that explain ingress, HITL, alerts, and delivery
- `conduit doctor` documented as the pre-flight check
- public positioning for "Why Conduit?" and "Why not Temporal/n8n/LangGraph?"

War Room is allowed to be a clearly marked upcoming feature for developer
preview, but the repo should not imply it is already shipped if it is still only
a design prototype.

## OSS Launch

The broader OSS launch should make Conduit feel like a real library and runtime,
not just a kernel project.

OSS launch bar:

- local War Room MVP through a `conduit watch`-style command
- read-only projection over the journal and state DB
- single-run live view and replay
- visible stations, gates, rework, held cards, terminal outcomes, and andons
- first-class channel story in README and docs
- one polished demo flow with screenshots or a short video
- tagged release, changelog, and published Docker engine image
- stable enough docs for outside contributors to open useful issues or PRs

The War Room should remain open source. It is the fastest way for users to feel
Conduit's core idea: AI work should be visible, inspected, and bounded.

## After Launch

Post-launch work should be driven by real usage. Likely areas:

- additional deterministic station drivers, especially SQL and HTTP/API fetch
- easier secrets and environment reference patterns
- richer channel adapters
- run API for embedding Conduit in other products
- better journal queries and export tools
- parallel execution hardening and operator ergonomics
- self-hosted and private deployment patterns
- agentic Tool-Bridge with stronger sandboxing and path ownership
- kaizen loops that mine repeated rework and propose improvements

## Non-Goals

Conduit is not trying to become:

- a general no-code automation canvas
- a replacement for durable workflow engines
- a model-provider platform
- an observability vendor
- a prompt-management tool
- an agent that reasons forever inside the control loop

Conduit's lane is narrower: deterministic control around non-deterministic AI
labor.
