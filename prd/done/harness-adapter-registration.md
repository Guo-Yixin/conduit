---
missionId: ~
---

# Harness Adapter Registration (Engine-Config, Per-Run Binding)

**Author:** Josh Owens  **Date:** 2026-07-09  **Status:** Done

## 1. Context & Background

The agentic harness precursor tier (build-order step 9c) introduced `kind: harness` stations, two real adapters (`claude-headless`, `codex-exec`), the bounded process runner, the env allowlist, the mandatory owned-paths integrity gate, gate composition, journaling, and resume-sound binding stamps. All of it is implemented and tested — and none of it can run in production, because the production adapter registry deliberately ships empty (`buildHarnessRegistry()` returns an empty registry, fail-closed).

The deferral was principled, not accidental: constructing a real adapter requires two values the engine's configuration surface doesn't yet model —

- **`projectRoot`**, which anchors the runner's cwd confinement, is a **per-run** value (resolved at `conduit run` time from `--project-root` ?? `flow.project_root` ?? the flow directory), while the registry is built once at process boot and shared by all seven entry points.
- **The child-env allowlist** (secrets-by-allowlist-only, NFR-Security-2) is **per-deployment** operator configuration that must never live in flow.yaml.

Registering adapters with placeholder values would have silently weakened both containment properties, so the registry shipped empty instead.

Why now: the Phase-1 exit criterion — *"the research flow (maker + adversarial harness critic) runs end-to-end"* — is explicitly **not met** in the CHANGELOG's known limitations. And the first external consumer is already waiting: a team building an overnight PRD pipeline (GitHub issue → harness writes PRD → human approves label → mission runs in a fresh git worktree → test gate → draft PR) has posted concrete requirements and offered a same-day smoke test against a branch build. This PRD is the single unlock between "feature complete" and "feature usable."

## 2. Problem Statement

Operators cannot enable `kind: harness` stations in any real deployment: every flow that declares one fails closed at load with `UNKNOWN_HARNESS_ADAPTER`, because there is no supported way to tell the engine which adapters to register, which environment variables its child processes may see, or how to bind each run's project root into the adapter's containment. The full harness feature set is inert until this configuration seam exists.

## 3. Target Users & Use Cases

**Primary users:**

- **Operators** (self-hosting or Docker-deploying conduit) — configure which harness adapters are available and which secrets their child processes may read; care that misconfiguration fails loudly and that secrets can't leak.
- **Flow authors** (first: the overnight-PRD-pipeline team) — declare `kind: harness` stations by adapter name and have them actually run; care that containment is kernel-enforced, not prompt-enforced.
- **The kernel team** — needs the Phase-1 exit criterion closed with real end-to-end evidence before building Phase-2 on top.

**Key use cases:**

- An operator needs to enable `claude-headless` with a minimal env allowlist (`HOME`, `PATH`, the credential variable) so that flows using it load and run instead of failing with `UNKNOWN_HARNESS_ADAPTER`.
- A flow author needs each mission run's project root to be a freshly created git worktree, so that cwd confinement, `owned_paths`, and the mandatory integrity gate all anchor at the worktree boundary (the team's stated blast-radius stance).
- An operator needs `conduit doctor` to show which adapters are registered and whether their binaries are present, so a broken deployment is diagnosed before the first dispatch, not during an overnight run.
- A flow author needs an unconfigured or misconfigured deployment to fail closed at load with an error naming what's missing, so a half-configured engine never silently runs a harness with weakened containment.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Harness flows run in production | A `kind: harness` flow loads and executes on a configured deployment | Works for both shipped adapters (`claude-headless`, `codex-exec`) |
| Phase-1 exit criterion met | Research-shaped flow (harness maker + adversarial harness critic) completes end-to-end on a real binary | 1 documented run, with journal evidence (per-attempt rows, usage, gate verdicts) |
| First consumer unblocked | The consumer team's PRD-writer smoke flow runs against a branch build (exercising subscription auth by construction) | Corroborating evidence, **non-gating** — the self-serve exit-criterion run above gates Phase-1 |
| Containment preserved | Unconfigured deployments behave byte-identically to today | Zero behavior change without explicit operator opt-in; existing test suite stays green |
| Misconfiguration is diagnosable | Load/doctor errors name the missing configuration element | No harness misconfiguration surfaces only at first dispatch |

## 5. Scope

### In Scope

- An **engine-config surface** (operator-owned, never flow.yaml) that declares which harness adapters to register and, per adapter: the child-env allowlist, and optionally the binary command/path and a model override.
- **Per-run `projectRoot` binding**: the adapter's runner confinement uses the project root resolved for *that run* (CLI flag ?? `flow.project_root` ?? flow directory), including when that path is a git worktree. One engine process must support successive runs with different project roots.
- **Registration of both shipped adapters** (`claude-headless`, `codex-exec`) through this surface, replacing the empty `buildHarnessRegistry()` for all seven existing entry points (CLI commands, worker entry, ingress listener) so they keep resolving against one definition.
- **`doctor`/`explain` visibility**: registered adapter names, capability flags, and binary-probe results.
- **End-to-end exit-criterion evidence**: a real research-shaped flow run on a real binary, plus the consumer smoke test.
- Documentation: operator setup guide (Docker and bare-metal), recommended minimal env allowlists per adapter and **per claude credential mode** (subscription auth: `HOME,PATH`; API-key auth: `HOME,PATH,ANTHROPIC_API_KEY`) — claude-headless verified by the exit-criterion run in at least one mode, with the consumer smoke test covering subscription auth by construction; codex-exec's documented as **assumed, verify in your deployment** (no codex verification is mission scope; doctor's binary probe is the deployment-time check).

### Out of Scope

- **New adapters** beyond the two shipped ones (the seam must make adding one easy, but none are added here).
- **Per-station `cwd:` override** inside a single run — the per-run project root covers the worktree use case; a station-level knob waits for a concrete need.
- **Harness-critic usage metering** — Phase-2 FR-5 (critic usage is currently journaled `{unknown: true}`; separate work).
- **The Law-grade Tool-Bridge** (step 9b) and kaizen (step 10).
- **Ingress concurrency fixes** — the consumer's pipeline deliberately uses serial timer-sweep ingress to avoid depending on this.
- Secrets *management* (vaults, rotation) — the engine consumes env vars per ADR-0003; how they get there stays the operator's concern.

## 6. Requirements

### Functional Requirements

1. The engine shall register harness adapters from `CONDUIT_HARNESS_*` environment variables (the existing engine-config convention — no config file): `CONDUIT_HARNESS_ADAPTERS` names the enabled adapters; per-adapter variables carry the child-env allowlist (required), a binary command/path override (optional), and a model override (optional). Per-adapter variable names derive from the adapter name by uppercasing and mapping hyphens to underscores (`claude-headless` → `CONDUIT_HARNESS_CLAUDE_HEADLESS_*`); configured adapter names that collide under this mapping shall fail at startup naming both. A deployment with no such configuration shall behave exactly as today (empty registry, fail-closed at load).
2. Both shipped adapters (`claude-headless`, `codex-exec`) shall be registrable through this surface; configuration naming an adapter the engine does not ship shall fail at startup naming it.
3. Adapter identity and capability flags (`canRestrictTools`, `reportsUsage`) shall be resolvable at flow-load time — load validation (`UNKNOWN_HARNESS_ADAPTER`, `HARNESS_TOOLS_UNEXPRESSIBLE`) and binary probing shall work without any per-run value.
4. Each harness invocation shall be confined to the project root resolved for the run being executed — never a project root captured at engine boot, and never another run's. Two concurrent runs with different project roots shall each bind their own (acceptance-tested, not assumed).
5. A run whose project root is a git worktree shall have cwd confinement, `owned_paths` resolution, and the mandatory integrity gate all anchored at the worktree path.
6. The child-env allowlist shall be **explicit-only**: the operator's list is the entire child environment — the engine shall never inject a baseline (`HOME`/`PATH` included). Allowlists shall come only from engine configuration, never from flow.yaml; allowlisted-but-unset variables shall be omitted (never empty-injected), preserving the WI-562 contract.
7. `conduit doctor` shall report each registered adapter's name, capabilities, and binary-probe result, and shall **warn when a registered adapter's allowlist omits `HOME` or `PATH`** (the CLI's credential lookup and tool subprocesses will likely fail), naming the recommended minimum. Doctor shall also **warn when a `_COMMAND` override is not an absolute path**: the harness binary resolves against the engine's environment at both probe and spawn (never the scrubbed child env), but a *relative* path resolves against the engine's cwd at probe time and the run's project root at dispatch time — a "doctor green, first dispatch fails" hole. Documentation shall recommend absolute paths for command overrides. `conduit explain` shall continue rendering harness stations against the configured registry.
8. Invalid registration configuration (unknown adapter name, malformed allowlist, unresolvable binary when probed) shall fail at load/startup with an error naming the offending element — never at first dispatch.
9. `conduit resume` shall continue to use the run's **recorded** project root by default; when an explicit `--project-root` override differs from the recorded root, resume shall warn on stderr naming both paths (containment re-anchoring is never silent) and proceed. Worktree-rooted resume reusing the recorded root shall be acceptance-tested.
10. A station's declared `model:` shall take precedence over the adapter's configured `_MODEL` override — engine config is the deployment default; the flow states intent. The model actually passed to the harness CLI shall be the same effective model the binding stamp records. (Today a station's model is folded into the stamp but never reaches the CLI — the two shall be made consistent.)
11. Both claude credential modes shall be supported and documented minimums: **subscription auth** (`HOME,PATH` — credentials under `~/.claude`) and **API-key auth** (`HOME,PATH,ANTHROPIC_API_KEY`). Doctor's allowlist warning (FR-7) shall not treat a missing credential variable as an error — `HOME`/`PATH` are the universal floor; the credential mode is the operator's choice.

### Non-Functional Requirements

1. No secret values shall appear in flow.yaml, in baked image layers, or in journal rows — only env var *names* are configuration (ADR-0003).
2. The runner's existing containment properties (cwd confinement inside project root, process-group termination, env scrubbing) shall not be weakened by any registration path; the existing containment test suites shall pass unchanged.
3. All seven entry points shall keep resolving adapters against a single registry definition (no per-entry-point drift), preserving the WI-576 guarantee.
4. The configuration surface shall follow the existing `CONDUIT_*` engine-config conventions and be expressible in the Docker deployment model (env/`-e`, mounted volume).

### Edge Cases & Error States

- **Allowlisted variable unset at runtime** — omitted from the child env (existing WI-562 behavior); if the harness then fails (e.g. missing credential), the failure surfaces as a normal named attempt failure, not a containment change.
- **Adapter configured but binary absent** — `probeHarnessBinaries` fails at load/doctor with `HARNESS_BINARY_NOT_FOUND` naming adapter and probed path (existing behavior, now reachable in production).
- **Empty env allowlist configured** — legal but almost certainly wrong for real CLIs (no `HOME`/`PATH`); doctor should warn, documentation states the recommended minimum per adapter.
- **Two runs with different project roots against one engine/DB** — supported: the run lease serializes only the *same run id*; `docs/single-host-concurrency.md` explicitly supports N concurrent `conduit run`/`resume` processes against one shared state DB and already recommends distinct `--project-root` per concurrently-seeded run. The FR-4 acceptance test (each concurrent run binds its own root) is therefore writable as specced — this pins existing documented behavior, it does not discover new ground.
- **Worktree deleted mid-run** — the runner's confinement resolution fails; the attempt fails named, and the card follows the normal attempt-cap path (never a silent pass).
- **Flow declares an adapter that exists in code but is not configured** — fail-closed `UNKNOWN_HARNESS_ADAPTER` at load, same as today; the error should hint that registration is configuration-driven.
- **Configuration names an adapter the engine doesn't ship** — startup/load error naming the unknown adapter (fail closed, don't skip silently).

## 8. Solution Approach

Split adapter resolution into the two phases the values naturally live in:

- **Config-time (engine boot):** the operator's configuration determines *which* adapters exist, their capabilities, binaries, and env allowlists. This is everything flow-load validation and `doctor` need.
- **Run-time (dispatch):** the run's resolved project root is bound into the adapter's invocation context at the moment a run starts, so the same engine process serves successive runs — including worktree-rooted mission runs — without rebuilding its configuration.

The operator experience: set the documented `CONDUIT_HARNESS_*` variables (e.g. `CONDUIT_HARNESS_ADAPTERS=claude-headless,codex-exec`, `CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH,ANTHROPIC_API_KEY`), run `conduit doctor` to see adapters registered, binaries probed green, and any allowlist warnings, then run flows. Nothing else about authoring or running flows changes; an unconfigured engine is indistinguishable from today's.

## 9. Technical Considerations

**Constraints:** Bun runtime; Docker-first distribution (ADR-0003: secrets via env, state on mounted volumes); the Law/containment posture of `docs/harness-containment.md` is a floor, not a negotiable.

**Dependencies:** none upstream — step 9c is implemented. Downstream, the consumer smoke test depends on the team's availability (they've offered same-day turnaround) and on a real `claude` binary; the exit-criterion run needs a credentialed environment, so it is operator-run evidence, not CI.

**Integration points:** the seven `loadFlow`/registry call sites (CLI run/resume/explain/doctor/build, worker entry, ingress listener); `probeHarnessBinaries`; the doctor prerequisite probes; the per-run `projectRoot` resolution in `cmdRun`/`cmdResume`.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Per-run binding forces a registry-shape refactor across all seven call sites | Medium | Wider diff than "just registration"; regression surface in load/doctor paths | The WI-576 callsites test suite already pins all seven; extend it rather than hand-checking |
| Env-var-only config grows unwieldy (per-adapter allowlists, paths, models) | Medium | Operator confusion, misconfiguration | Keep the v1 surface minimal (two adapters, few keys); document exhaustively; doctor renders the effective config |
| Over-broad allowlists quietly leak secrets into harness children | Low | Credential exposure to an agentic process | Document recommended minimums; doctor warns on suspicious breadth (e.g. wildcard-like lists); never a default-allow |
| Exit-criterion evidence blocked on external team or credentialed env | Low | Phase-1 sign-off delayed | The kernel-side research flow run is self-serve evidence; the consumer smoke test is additive, not gating |
| Worktree-rooted runs surface latent assumptions (paths assumed repo-relative) | Medium | Integrity gate or artifact resolution misbehaves on first real mission | Make a worktree-rooted run an explicit acceptance test, not an afterthought |

### Resolved Decisions (2026-07-09, decision walk with Josh)

- [x] **Config shape: env vars only** (`CONDUIT_HARNESS_*`), no engine-config file in v1. Matches every existing `CONDUIT_*` knob, ADR-0003's secrets-via-env Docker posture, and `conduit build`'s ENV emission; a file can be added later without breaking env deployments. (→ FR-1)
- [x] **Env allowlist is explicit-only, no injected baseline.** The operator's list is the entire child env — preserves the WI-562 audit invariant ("what you list is exactly what the child sees"). The `HOME`/`PATH` foot-gun is caught by a doctor warning naming the recommended minimum, not papered over by hidden injection. (→ FR-6, FR-7)
- [x] **Register both adapters; codex minimums ship documented as assumed/unverified.** Claude's minimum is verified live by the exit-criterion run; codex verification is explicitly not mission scope (no consumer waiting, and it would add a real-binary + OpenAI-credential dependency). Doctor's binary probe is the deployment-time check. (→ FR-2, Scope, Documentation)
- [x] **Per-run project root: recording is sufficient; add tests + an override-mismatch warning.** `registerRun` already persists the root and `resume` already prefers the recorded value; the mission adds acceptance tests (concurrent different-root runs; worktree-rooted resume) and a stderr warning when an explicit `--project-root` override re-anchors a run's containment — respected, but never silent. (→ FR-4, FR-9)

### Review Round (2026-07-09, consumer review — approve with clarifications)

Five clarifications from the consumer's pre-start review, all folded in without reopening a decision:

- [x] **Both claude credential modes are documented minimums** — their deployment uses subscription auth (`~/.claude` under `HOME`, no API-key var); an `ANTHROPIC_API_KEY`-assuming minimum would have failed their first overnight mission. (→ FR-11, Documentation, Goals)
- [x] **Concurrent-runs doubt resolved by citation, not hedging** — the run lease serializes only the same run id; `docs/single-host-concurrency.md` explicitly supports N concurrent runs. The FR-4 test is writable as specced. (→ Edge Cases)
- [x] **`_MODEL` precedence: station wins; engine config is the deployment default.** Review bonus: the current code folds a station's model into the binding stamp but never passes it to the CLI — FR-10 requires stamp and invocation to agree on the effective model. (→ FR-10)
- [x] **`_COMMAND` probe hole corrected and closed**: the binary resolves against the *parent* env at both probe and spawn (their child-env framing was a non-hole), but a *relative* command path resolves against different cwds at probe vs dispatch — docs recommend absolute paths, doctor warns on relative overrides. (→ FR-7)
- [x] **Goals/Risks aligned on the smoke test** (corroborating evidence, non-gating) and the adapter-name → env-var mapping rule spelled out with collision behavior. Section numbering (§6→§8) kept — the template's section numbers are stable across this repo's PRDs (§7 Design Principles deliberately omitted).
