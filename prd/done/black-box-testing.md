# Black-Box Testing: One Golden Studio Journey + Fault Variants

**Status:** Done

## Problem

Every existing test drives Conduit through internal seams — `runExecutor`, injected
adapters, in-process module calls. Those seams are covered heavily and they are the
wrong instrument for the bug class we keep discovering in production: wedged runs,
silent exit-1s, duplicate deliveries — failures that only exist where the real
processes, real SQLite files, real HTTP, and real process lifecycles meet. Nothing
today proves the shipped binary works end-to-end.

Slice 1 (the CI test gate, `.github/workflows/test.yml`) already landed on this
branch. This PRD is slice 2.

## The crucial rule (non-negotiable, applies to every item)

The black-box suite **must spawn the production binary** (`conduit` via
`src/cli/main.ts`) and must **not**:

- import any Conduit internal module,
- call `runExecutor` or any exported function,
- inject an adapter, transport, or seam object,
- inspect internal state except through public surfaces (CLI output, exit codes,
  `conduit explain`, artifact files on disk, and the fake servers' observed traffic).

If an assertion cannot be made through a public surface, that is a product
observability gap — fix the product (a CLI flag, an explain field), not the rule.

## FR-1 — Golden Studio journey (the spine)

One test, no internal imports, that:

1. Starts `conduit listen` as a real child process (temp state/journal SQLite DBs,
   temp project workspace, flow allowlist via manifest/flags).
2. Sends a **signed** Slack event (correct `X-Slack-Signature`/timestamp HMAC) to the
   listener's webhook endpoint.
3. Lets the listener spawn a **real** `conduit run` child.
4. Routes ALL Slack Web API and model-gateway traffic to controllable local fake
   servers (model side: `CONDUIT_BASE_URL` already exists; Slack side: see OQ-1).
5. Observes the HITL rank prompt arrive at the fake Slack server.
6. Submits a button (interactive) response for the ask's correlation id (see OQ-2
   for transport).
7. Verifies the listener spawns `conduit resume` automatically.
8. Asserts, through public surfaces only:
   - terminal run status (exit code / CLI output / `conduit explain`),
   - the output artifact exists in the workspace with expected content,
   - journal evidence of the full journey (`conduit explain` shows ask → selection
     → resume → done),
   - **exactly-once** Slack effects: the fake Slack server saw exactly one ask post
     and one delivery upload — no dupes across the resume boundary.

## FR-2 — Fault variants (same journey, one knob turned each)

Each variant reuses the golden-journey harness:

- **F-1 Stalled Slack connection:** the fake Slack server accepts and never
  responds. Expect: bounded timeout (`SLACK_FETCH_TIMEOUT_MS`), a NAMED failure on a
  public surface, no wedged process (listener and run both exit/hold cleanly).
  This validates the production fetch-timeout behavior.
- **F-2 Deterministic station exits nonzero:** expect bounded attempts then terminal
  scrap, visible in exit code + `conduit explain`. Scrap/hold must not be silent.
- **F-3 Duplicate Slack event AND duplicate button tap:** redeliver the same signed
  event; double-tap the same ask. Expect: exactly one run spawned, exactly one
  selection applied, duplicates journaled as such. This validates the production
  deduplication and first-pick-wins behavior.
- **F-4 Kill/restart around HITL:** SIGKILL the listener (and/or the parked state)
  after the ask posts, restart `conduit listen` against the same DBs, then answer.
  Expect: held work survives, the reply still resumes it, exactly-once effects hold
  across the crash. (Production origin: outbox/reconciler crash-window work.)

## FR-3 — Bug-to-fault-variant pipeline (standing rule)

Every future production-discovered bug gets converted into a fault variant of this
journey as part of its fix. Candidate backlog: a watchdog killing a legitimately
in-flight call, an implicit fetch timeout being misreported, a silent scrap/hold
exit, and swallowed gateway error bodies.

## Decided questions (resolved with Josh, 2026-07-18)

- **DQ-1 — Slack routing: `SLACK_API_BASE_URL` env override.** New env knob on the
  transport, default `https://slack.com`, validated at read with fallback — same
  convention and documentation home (docs/slack-channel.md env-knobs table) as
  `SLACK_FETCH_TIMEOUT_MS` / `SLACK_MAX_UPLOAD_BYTES`. The suite sets one env var on
  the spawned child; no injected seam. Also independently useful for
  Slack-compatible gateways.
- **DQ-2 — Button transport: fake Socket Mode server.** The fake Slack server owns
  `apps.connections.open` (via DQ-1) and hands the listener a local `ws://` URL,
  then speaks the envelope protocol (hello → interactive envelope → ack). This
  exercises the SHIPPED interactive path — socket adapter, ack-before-processing,
  correlation routing. No HTTP interactivity route gets built; all new moving parts
  live in the fake, not the product.
- **DQ-3 — CI placement: separate `blackbox` job, promoted later.** Runs on every PR
  from day one but is NOT required; after a burn-in window of consecutive green runs
  (~two weeks or ~50 PRs), flip it into the required set alongside `tests`.
  Regressions stay visible per-PR without letting a timing flake block unrelated
  merges while the suite earns trust.

## Non-goals

- Replacing or thinning the existing seam-level tests (they stay).
- Multi-flow, fan-out, or agentic-harness journeys — one Studio journey only.
- Load/perf testing.

## Acceptance criteria (suite-level)

- AC-1: golden journey passes against the production binary with zero internal
  imports (enforced: the test files import nothing from `src/` except none at all —
  lint/grep gate in the suite itself).
- AC-2: all four fault variants pass and each asserts the NAMED public-surface
  evidence, not just "didn't crash".
- AC-3: the suite is deterministic across 10 consecutive local runs (no timing
  flakes; fake servers are controllable, never sleep-and-hope).
- AC-4: total suite wall-clock under ~2 minutes so it can join CI.
