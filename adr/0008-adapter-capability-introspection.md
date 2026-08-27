# ADR-0008: Adapter capability introspection — a static, offline-queryable surface on HarnessAdapter

Status: Accepted
Date: 2026-07-07
Deciders: Face + Sosa (mission M-20260707-002, Agentic Harness Worker)

## Context

The agentic Tool-Bridge (build-order step 9) introduces `kind: harness` stations, each backed
by a named `HarnessAdapter` that spawns a real CLI (e.g. `claude-headless`, and later `codex`).
Three separate consumers need to reason about an adapter's *capabilities* before — or entirely
without — invoking it:

- **Load-time validation** (WI-563) must decide whether an adapter can enforce or narrow a
  station's declared `tools` allowlist, and must fail-closed (or honor the `unrestricted_tools`
  waiver) at load, before any card runs.
- **`conduit explain` / `conduit doctor`** (WI-573) must render an adapter's identity, whether
  it reports usage (the usage-blind indicator), and whether its binary is present/invocable —
  all as a static description of the flow, not a side effect of running it.
- **Usage journaling** (WI-567) must know whether an adapter can report usage at all, so a
  usage-blind adapter is journaled as explicitly UNKNOWN rather than silently zero.

These three call sites are deterministic, offline, and table-testable by requirement
(NFR-Op-1/2). They cannot depend on spawning a process to learn what an adapter can do.

## Decision

**Adapter capabilities are declared as static, introspectable members of the `HarnessAdapter`
interface — queryable offline, never runtime-probed.**

The seam item (WI-560) owns the *whole* contract, and every adapter implements it:

- A per-call `invoke` that returns produced-output references plus **structured usage or an
  explicit unknown-usage signal**.
- A static **`reportsUsage` / usage-blind capability flag**, queryable without invoking the
  adapter and distinct from the per-call unknown-usage signal.
- A **binary presence/executability probe** reporting present/invocable vs missing/non-executable
  for the configured binary.
- A **tools-narrowing / expressibility query** answering whether the adapter can enforce or
  narrow a given `tools` allowlist.

Load validation, `explain`, and `doctor` consult these static members directly; none of them
needs to run the adapter to do its job.

## Alternatives considered

### A. Probe capabilities by invoking the adapter at runtime — *rejected*
A runtime probe cannot fail a flow at **load** — the whole point of load validation is to reject
a bad flow before anything runs. It is also non-deterministic and not table-testable, violating
NFR-Op-1/2, and it turns `explain`/`doctor` (pure descriptions) into effectful operations.

### B. Scatter the individual signals across the consuming items — *rejected*
Letting WI-563, WI-567, and WI-573 each derive "can this narrow tools / does it report usage /
is the binary there" independently lets the three call sites **drift**: the same adapter could be
judged tools-safe by the validator but rendered differently by `explain`, or journaled as
usage-capable while doctor reports it blind. Centralizing the contract on the interface keeps one
source of truth.

## Consequences

**We gain**
- One authoritative capability contract. Load validation, `explain`, `doctor`, and journaling
  all read the same static surface — no divergence, no per-consumer re-derivation.
- Deterministic, offline, table-testable capability checks that satisfy NFR-Op-1/2.
- A clear default for future decomposition: **a new adapter capability is added to the
  interface's static surface**, not derived ad hoc at each consumer.

**We pay**
- Every adapter — including the deterministic test-fake — must implement the full surface
  (`invoke`, `reportsUsage`, binary probe, tools-narrowing query), even when a given adapter has
  a trivial answer. This is the intended cost of a single seam contract.

**Revisit triggers**
- A future capability that genuinely *cannot* be known without running the adapter (a true
  runtime-only property). That is the signal to add a narrow, explicit runtime-probe path
  alongside the static surface — not to move the static members onto it.

## References

- Mission M-20260707-002 (Agentic Harness Worker); SPEC §16 build-order step 9 (Tool-Bridge).
- NFR-Op-1 (deterministic + table-testable), NFR-Op-2 (usage from structured adapter result,
  never scraped text), NFR-Security-3 (`unrestricted_tools` waiver).
- Work items: WI-560 (seam — owns the contract), WI-563 (load validation), WI-567 (usage
  journaling), WI-573 (`explain`/`doctor`), WI-574 (codex adapter — future implementor of the
  same contract).
- Related: ADR-0005 (station taxonomy), ADR-0006 (telemetry and cost attribution).
