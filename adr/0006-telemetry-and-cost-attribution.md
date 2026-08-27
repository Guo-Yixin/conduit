# ADR-0006: Telemetry & cost attribution — OTel GenAI conventions, kernel-sourced

Status: Accepted
Date: 2026-05-30

## Context

Conduit must attribute token and cost spend **per station**: the cost model (SPEC §12) needs
it, the consumption andon trips on it (SPEC §8), and kaizen's substitutability filter ranks
crystallization candidates by `cost × repetition` (SPEC §13). So per-station cost is
first-class telemetry, not a nice-to-have dashboard.

Two questions have to be answered the same way for every provider and every flow: **what
schema** do we record it in, and **what is the source of truth**? Two tempting answers are
wrong: a bespoke internal schema (doesn't port, reinvents a moving target) and parsing the
provider's response/transcript for usage (brittle, and unnecessary).

## Decision

**Record per-station token/cost telemetry in the journal, aligned to OpenTelemetry GenAI
semantic conventions, sourced from the kernel's own per-model-adapter accounting — never by
parsing provider transcripts.**

- **OTel GenAI conventions** so the data ports to standard observability backends rather than
  locking cost into Conduit-specific tooling. **Pin the convention version; expect churn**
  (SPEC §17 F4 flags GenAI conventions as still-evolving).
- **Kernel-sourced.** The kernel makes *every* model call through its per-model adapter
  (SPEC §7), so it already holds authoritative usage. The journal — not a provider response
  body — is the source of truth (SPEC §11).
- The journal can emit the per-station cost table for any run on demand, including the
  parse-miss rate as a first-class metric.

## Alternatives considered

### A. Parse provider transcripts / response bodies for usage — *rejected*
Every provider reports usage differently and changes formats without notice; a content
worker's transcript may be adversarial substrate anyway. The kernel already has the
authoritative number from the adapter call it made — scraping the transcript adds fragility to
re-derive data we already hold. The journal is the source of truth.

### B. A bespoke internal telemetry schema — *rejected*
Faster to write, but it doesn't port to standard backends, forces Conduit-specific dashboards,
and reinvents a standard that already exists (and is converging). We'd own a schema we don't
want to own.

### C. Defer telemetry until after the MVP — *rejected*
Cost attribution drives the andon and the kaizen substitutability filter; retrofitting
attribution after the fact is far harder than emitting it from the first run. Note the split:
the kaizen *consumer* of this data is deferred (SPEC §13, §16 step 10), but the *emission* of
attributable per-station cost is not — it ships with the kernel.

## Consequences

**We gain**
- Portability to standard observability backends; authoritative cost without transcript
  scraping; a first-class cost/parse-miss journal queryable per run.
- Telemetry that survives a provider changing its response shape.

**We pay**
- OTel GenAI conventions are still evolving — a pinned version plus expected mapping
  maintenance as the spec moves.
- Adapters must emit normalized usage uniformly across providers (part of the per-model
  adapter contract).

**Revisit triggers**
- A breaking change in the OTel GenAI conventions large enough to force a migration.
- A multi-host / different-store future (ADR-0001, SPEC §17 F1) that wants a different
  telemetry pipeline or aggregation backend.

## References

- SPEC §11 (the journal, cost attribution, "never parse provider transcripts"), §12 (cost
  model), §13 (kaizen substitutability filter), §17 F4 (OTel GenAI churn), §8 (consumption
  andon), §7 (per-model adapter).
- ADR-0001 (own runtime, per-station model choice — the reason cost attribution must be
  per-station and provider-neutral).
