# ADR-0002: Bun as the kernel runtime

Status: Accepted
Date: 2026-05-30

## Context

The kernel (the deterministic conveyor of [ADR-0001](./0001-build-vs-buy-the-orchestration-substrate.md))
needs a runtime that does five things well, simultaneously:

1. **Spawn many subprocesses, fast and cheap** — worker harnesses and external CLIs (`git`,
   `gh`, `ffmpeg`), with low-latency live stdout/stderr piping to the War Room.
2. **IPC between kernel and workers** — `START_WORK` / `MARK_DONE` signals without a network
   broker or serialization tax.
3. **An in-process, fast SQLite** — the Journal of Truth is queried on *every* tick,
   transition, and heartbeat; a blocking, out-of-process driver would dominate latency.
4. **Execute user TypeScript with no build step** — hooks (the Law), adapters, and transform
   stations are `.ts` that get edited and re-run constantly (the Work Bench).
5. **High prompt-iteration velocity** — this is an LLM-workflow tool; you tweak prompts and
   hooks all day. A compile cycle per change kills the loop.

## Decision

**Bun** is the kernel and worker-harness runtime. It provides the entire foundational layer
in one binary: `Bun.spawn` (native, vfork-based), zero-config IPC via `process.send`,
in-binary `bun:sqlite`, and direct `.ts` execution with native-fast `Bun.file`/`Bun.write`.
No external DB driver, build tool, or message broker. (SPEC §1, §10A, §11.)

**Boundary:** Bun runs the *kernel and the worker harness*; it does **not** constrain the
*models or tools*. Models are reached through the kernel's per-model adapter (HTTP to any
provider); external tools run as subprocesses. Betting on Bun does not bet on the labor.

## Alternatives considered

### Node.js — *rejected (friction)*
Viable but it's death by a thousand dependencies: `child_process` has heavier spawn overhead
and clunkier stream piping; SQLite means a native-compiled `better-sqlite3` (C++ bindings,
install friction) or an async driver; TS needs a build step or `tsx`/`ts-node`; and you pull
in a server lib, a DB driver, and a bundler. Bun collapses all of that into the runtime.

### Deno — *rejected, but the closest call*
Deno shares Bun's best traits: native TS, web-standard APIs, good tooling, secure-by-default.
The edge goes to Bun on the exact trifecta we lean on hardest: `Bun.spawn` + `process.send`
IPC ergonomics and **in-binary SQLite**. Deno's SQLite/subprocess/IPC story is workable but
less unified, and Bun's npm compatibility is currently smoother. Reasonable people could pick
Deno; we optimize for the spawn/IPC/SQLite path being first-class.

### Go / Rust — *rejected (splits the kernel from userland)*
Compiled systems languages win on raw spawn/concurrency and ship a single static binary —
genuinely attractive for a kernel. Two reasons against:
- They **slow prompt iteration**: a compile cycle per hook/station/adapter tweak fights the
  Work Bench's whole purpose.
- They **split the kernel from userland.** Conduit's hooks, adapters, and transform stations
  are TS/JS; a Go/Rust kernel would still have to shell out to a JS runtime to execute them —
  two languages, a boundary to marshal across. Bun makes the kernel *and* the userland one
  language, hot-loadable.

### "But A(i)-Team's controller is Go — why not Go here?" — *the contexts differ*
A(i)-Team's controller is a **stable, rarely-changed decision engine** compiled once, talking
to a *separate* API/DB over HTTP — Go is perfect for that bounded CLI. Conduit is the
opposite shape: an **integrated runtime that hosts and hot-reloads user TS** (the Law, the
Bench, transform stations) *and* owns the in-process SQLite, the subprocess fleet, and the
IPC. That integration is exactly Bun's sweet spot and Go's seam. Same family of system,
different cut — and Conduit even reuses A(i)-Team's *logic* (the transition matrix, the tick),
just hosted in Bun rather than re-implemented in Go.

## Consequences

**We gain**
- One fast binary for runtime + spawn + IPC + SQLite + TS execution — no driver/bundler/broker
  dependencies.
- Instant hook/station iteration (no build step) — the Work Bench works as designed.
- Kernel and userland in one language, hot-loadable.

**We pay / risks**
- **Bun is younger than Node.** Some npm packages with native addons may not load; production
  maturity is improving but less battle-tested. We mitigate by keeping the dependency
  footprint near-zero (the whole point) and reaching models/tools over process/HTTP
  boundaries, not in-process native modules.
- **Version churn.** Bun moves fast; pin the version and test upgrades.
- **`bun:sqlite` is synchronous and SQLite is single-writer** — fast, but the "query every
  tick" pattern needs the WAL + state/journal split from SPEC §11, and caps us to one host
  for now (§17 F1). This is a SQLite property, not a Bun one.

**Revisit triggers**
- A hard, unavoidable dependency that ships only as a Node native addon Bun can't load.
- Multi-host scale forcing a different store/runtime (ties to ADR-0001's revisit trigger).
- A Bun stability/maturity problem that blocks production.

## References

- SPEC §1 (Runtime — why Bun, the four reasons + two boundaries), §10A (process model),
  §11 (persistence / SQLite WAL split).
- ADR-0001 (build-vs-buy) — Bun is the substrate for the kernel we chose to build.
