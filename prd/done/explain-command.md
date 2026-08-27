---
missionId: ~
---

# Conduit — `explain` Command (flow visualization)

**Author:** Josh Owens  **Date:** 2026-06-16  **Status:** Done

> Scope note: this is a **CLI / developer-experience** PRD, not a kernel-routing change.
> It adds one read-only subcommand — `conduit explain <flow.yaml>` — that renders a loaded
> flow as an ASCII lane-graph plus a compact legend. It changes nothing about how the kernel
> dispatches, claims, or checkpoints; it only *reads* the already-validated `FlowConfig` and
> prints it. It models exactly on the existing `conduit build` command
> (`src/cli/main.ts` — `cmdBuild`: load flow → emit text → exit), and mirrors that command's
> test pattern (`src/cli/build-command.test.ts`). The *what* and *why* live here; the *how*
> (renderer module shape, exact glyphs) belongs in the mission's design step.

## 1. Context & Background

Conduit's premise is that **the flow becomes config, not code** — a `flow.yaml` is the
artifact a user authors, reads, and reasons about. But today there is no way to *see* a flow.
To understand a flow's shape — which stations route where, where the gate back-edges loop, what
each station's worker kind and model are, which lanes are terminal — a user must read raw YAML
top to bottom and assemble the graph in their head, or paste the file into an LLM and ask it to
draw one. We did exactly the latter to visualize `examples/tiktok-shoppable-ideas/flow.yaml`,
and the result was genuinely useful — useful enough that it should be a first-class command
rather than an ad-hoc prompt.

The cost of *not* having this compounds as flows grow past the linear three-station dogfood
example into fan-out/fan-in topologies (`prd/done/branching-and-hitl.md`) with multiple
gates and back-edges, where reading YAML to recover the graph is genuinely error-prone. A
flow author iterating on routing has no fast feedback loop that answers "did I wire the
back-edge to the lane I meant?" short of running the flow.

The reusable substrate already exists: `loadFlow()` returns a validated, frozen `FlowConfig`
with a resolved `happyPathNext` routing map, `back_edges` extracted from gate `on_reject`
targets, `terminal_lanes`, and per-station `kind`/`effectful`/`model`/`command` — everything a
diagram needs. The work is a pure renderer over that structure plus a thin CLI command, not
new parsing.

## 2. Problem Statement

A flow author or operator cannot see the shape of a flow without manually reading YAML and
reconstructing the routing graph in their head. There is no command that answers "what does
this flow *do* — which stations, routed how, gated where" at a glance. As flows grow beyond
the linear example into branching topologies with multiple back-edges, this manual
reconstruction is slow and error-prone, and it is precisely where mis-wired routing hides.

## 3. Target Users & Use Cases

**Primary user — the flow author** iterating on a `flow.yaml`. They have just edited routing
or added a gate and want immediate confirmation that the graph matches intent, without running
the flow or eyeballing YAML.

**Secondary user — the operator / reviewer** encountering an unfamiliar flow (in a PR, an
example, a teammate's project) who needs to grasp its structure in seconds before running or
reviewing it.

**Key use cases:**

- An author runs `conduit explain flow.yaml` after editing a `next:`/`on_reject:` target and
  sees, in the diagram, exactly which lane each edge points to — catching a back-edge wired to
  the wrong station before running the flow.
- A reviewer reading a PR that adds a flow runs `conduit explain` to understand the station
  topology (kinds, models, terminals) at a glance instead of parsing YAML.
- An author runs `explain` on a flow with a validation error and gets the same fail-closed
  error report `conduit build` produces — never a half-drawn or misleading diagram.
- A user reads the legend once and thereafter recognizes the kind/effectful markers in any
  flow's diagram without re-reading it.

## 4. Goals & Success Metrics

The feature is graded on whether a user can correctly recover a flow's structure from the
command's output faster and more reliably than from raw YAML — not on diagram aesthetics.

| Goal | Metric | Target |
|------|--------|--------|
| Recover flow structure without reading YAML | A user can answer "where does station X route, and where does its gate reject to" from `explain` output alone | Yes, for every station in the dogfood + branching example flows |
| Trustworthy output | Diagram reflects the *parsed* `FlowConfig` (routing from `happyPathNext`/`back_edges`), never re-derived from YAML order | 100% — no field is echoed from raw YAML |
| Fail-closed parity with `build` | An invalid flow yields the same validation-error report and non-zero exit as `conduit build`, with no diagram printed | Exact parity |
| Zero side effects | Command opens no database, makes no model call, needs no API key, writes no files | Verified by test |

## 5. Scope

### In Scope

- A new `conduit explain <flow.yaml>` subcommand, dispatched in `main()` alongside
  `run`/`build`/`doctor`, with `usage:` text and fail-closed flow loading mirroring `cmdBuild`.
- A **pure renderer** (flow config in → string out) so the rendering is unit-testable without
  the CLI shell, the same seam `cmdBuild` uses with `generateFlowDockerfile`.
- **A small, additive loader change to preserve human names** (resolves OQ1). The loader
  already *parses* the top-level flow name (`RawYaml.flow`, `src/flow/load.ts:173`) and each
  worker/critic `role` (`RawWorker.role`/`RawCritic.role`, `:74`/`:108`) but discards them when
  it assembles `FlowConfig`/`StationConfig`. This PRD stops discarding them: add an optional
  `name` to `FlowConfig`, an optional `role` to `StationConfig`, and a critic role to the gate
  config — each populated from the value the loader already reads. No new YAML parsing; the
  diagram still renders strictly from the parsed `FlowConfig` (the "never read raw YAML"
  principle holds — the names now simply *survive* into the config).
- **The lane graph, laid out vertically** (top-to-bottom; resolves OQ2 — chosen so fan-out /
  fan-in topologies and back-edges stay legible as they grow). Every station rendered as a node
  showing its id, worker `kind`, `role` (the human label), an `effectful` marker, and
  model/command; happy-path edges (`station → next lane`) drawn from `happyPathNext`; gate
  back-edges (`on_reject`) drawn from `back_edges`/`gateCheck` (including the critic role) and
  visually distinguished from forward edges; terminal lanes (`done`/`scrap`/`hold`) shown as
  the graph's sinks. A header line carries the flow name.
- **A compact, adaptive legend** (resolves OQ3) that defines only the markers the rendered
  diagram actually uses (worker kind glyphs, the pure-vs-effectful marker, and the back-edge
  marker only when the flow has a gate), so the output is self-describing without noise.
- Output to stdout; exit 0 on success, non-zero on validation failure.
- Renders correctly for both the linear dogfood flow and a branching (fan-out/fan-in) flow.

### Out of Scope

- **The full annotated "explain" panels** — budgets/liveness guards, the Law/security
  allowlist, defaults, prerequisites. The hand-drawn version included these side-panels; this
  PRD deliberately ships **graph + legend only**. A richer `explain --verbose` that adds the
  guard/Law panels is a follow-up, not this PRD. (Decision recorded with the author.)
- Non-ASCII / graphical output (Graphviz/DOT/Mermaid/SVG export). Possible later; not now.
- Live/animated views of a *running* flow's card positions — that is War Room territory
  (`prd/drafts/war-room.md`), not a static config render.
- Any change to `flow.yaml` schema, the loader, or kernel routing. `explain` is a pure reader.

## 6. Requirements

### Functional Requirements

1. The command `conduit explain <flow.yaml>` shall load the flow via the same `loadFlow()`
   path `conduit build` uses, and on any validation failure shall print the validation errors
   (code + message) and exit non-zero **without** printing a diagram.
2. Invoked with no flow path (or only flags), the command shall print a `usage:` line and exit
   non-zero, matching the convention of the other subcommands.
3. The command shall render every station in the flow as a node labeled with at least: the
   station id, its worker `kind` (`deterministic` / `transform` / `agentic`), its worker `role`
   (the human label, when present), an `effectful` indicator, and the worker's model
   (transform/agentic) or command (deterministic).
4. The command shall draw a forward edge from each station to its happy-path successor lane,
   using the flow's resolved `happyPathNext` map — never the YAML insertion order.
5. The command shall draw each gate back-edge (a station's `on_reject` target) as an edge
   visually distinct from forward edges, sourced from the flow's `back_edges` / `gateCheck`,
   and shall label it with the critic's role/model where available.
6. The command shall render the kernel terminal lanes that the flow routes into
   (`done`, `scrap`, `hold`) as terminal sinks distinguishable from work stations.
7. The command shall lay the graph out **vertically** (top-to-bottom), so back-edges and
   fan-out/fan-in branches remain legible as the flow grows.
8. The command shall print an **adaptive** legend that defines only the markers the rendered
   diagram actually uses, so the output is self-describing without listing irrelevant glyphs.
9. The command shall render from the structured `FlowConfig` only; no field shall be read from
   the raw YAML text. (The flow `name` and station `role` are made available by preserving them
   on the config during load, not by re-reading the YAML.)
10. The loader shall preserve the flow `name` and each station/critic `role` on the returned
    `FlowConfig`/`StationConfig`/gate config, populated from the values it already parses.

### Non-Functional Requirements

1. The command shall be a pure read: it shall not open or write the state/journal database,
   make any model/network call, require an API key, or write any file. (`build`/`doctor` already
   establish this no-key, no-DB-for-validation pattern.)
2. The rendering logic shall live in a pure function (config → string) that is unit-testable in
   isolation from the CLI, process I/O, and the filesystem.
3. Output shall be plain ASCII that renders correctly in a standard terminal and in a copied
   text block (no reliance on a specific terminal width or color support).
4. The command shall complete effectively instantly (bounded by `loadFlow`), with no
   long-running work.

### Edge Cases & Error States

- **Invalid flow** → validation-error report + non-zero exit, no diagram (FR-1).
- **Missing / unreadable file path** → clear error + non-zero exit (parity with `build`).
- **A station with no `next`** (terminal-routing or fan-out parent whose continuation is via
  `child_entry`/`resume_at`) → rendered without a dangling/“to nowhere” forward edge.
- **A flow with no gates / no back-edges** (e.g. a pure linear transform flow) → renders a
  clean forward-only chain; the legend need not advertise edge types the flow doesn't use, or
  may show them greyed — design call.
- **A branching flow** (fan-out → child sub-path → fan-in/resume) → the fan-out, the child
  entry, the child terminal, and the parent resume point are all legible as distinct nodes/edges.
- **Long station ids or many stations** → output stays readable (wrapping or vertical layout) —
  it must not silently truncate a station or an edge.

## 7. Design Principles

- **Render the parsed truth, not the source.** The diagram's value is that it shows what the
  *kernel* understood — routing from `happyPathNext`, back-edges from extracted `on_reject`
  targets. If the YAML and the parsed config ever disagree, `explain` must show the config.
  This is also what makes it a debugging tool, not a pretty-printer.
- **Fail-closed, exactly like `build`.** Same loader, same error report, same exit semantics.
  A user should never get a diagram for a flow that wouldn't run.
- **Self-describing output.** The legend is a requirement, not a nicety: a diagram whose
  markers need external explanation has failed its one job.
- **Pure function at the core.** The renderer is config-in/string-out so its correctness is
  pinned by unit tests over real example flows, with the CLI command a thin shell around it —
  mirroring `cmdBuild` / `generateFlowDockerfile`.

## 8. Solution Approach

`conduit explain` follows the established shape of `conduit build`: parse the positional
flow path, run it through the shared fail-closed `loadFlow()` gate, and on success hand the
resulting validated `FlowConfig` to a pure renderer whose returned string is written to
stdout. The renderer walks the stations and the flow's routing maps to lay out a top-to-bottom
lane graph — work stations as labeled nodes, forward edges to successor lanes, gate back-edges
as a distinct return path, and the kernel terminals as sinks — followed by a short legend that
defines the markers in use. Because the renderer consumes the same structured config the
executor routes on, the picture a user sees is the picture the kernel will run.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ASCII layout for branching/multi-gate flows gets visually tangled | Medium | Diagram hard to read on complex flows | Design step pins a layout strategy (e.g. vertical stations with labeled edges) and tests it against the branching example flow, not just the linear one |
| Diagram drifts from kernel reality if it reads YAML for convenience fields (e.g. role, flow name the config drops) | Low | "Explain" lies — the worst failure for a debugging tool | Resolved by FR-9/FR-10: rather than re-read YAML, preserve `name`/`role` on the config (the loader already parses them), so the renderer reads only `FlowConfig` and cannot drift |
| Loader change to preserve `name`/`role` touches kernel types (`FlowConfig`/`StationConfig`) and their tests | Low | A CLI feature reaches into kernel-type surface | Change is purely additive (optional fields populated from already-parsed values); no existing field or behavior changes, no minimal-literal test breaks |
| Scope creep back toward the full guards/Law panels | Medium | Misses the agreed "graph + legend" target | Out-of-scope is explicit; the verbose variant is a separate follow-up |

### Resolved Questions

All three open questions were resolved with the author (2026-06-16):

- [x] **Flow name / station role → render real names.** Preserve the flow `name` and station/
      critic `role` on the config (the loader already parses all three; it just discards them at
      assembly). Folded into scope as FR-9/FR-10 — an additive loader change, *not* a raw-YAML
      read, so the "render the parsed truth" principle is upheld.
- [x] **Layout direction → vertical (top-to-bottom).** Chosen explicitly to support fan-out /
      fan-in topologies and keep back-edges legible as flows grow. (FR-7.)
- [x] **Legend → adaptive.** The legend defines only the markers the rendered diagram actually
      uses (e.g. the back-edge marker appears only when the flow has a gate). (FR-8.)
