---
missionId: ~
---

# Conduit - Data-Fetch Station Drivers

**Author:** Josh Owens  **Date:** 2026-06-16  **Status:** Draft

> Scope note: this PRD adds **standard deterministic station drivers for fetching
> external data into artifacts**. It is not a database product, an ORM, a workflow-node
> marketplace, or an n8n-style app automation canvas. The goal is narrower: a flow author
> should not need to hand-write a shell command every time a station needs to read from an
> existing SQL database or API. This builds on the shipped real-run path
> ([`real-run-path.md`](../done/real-run-path.md)), the station taxonomy in
> [`ADR-0005`](../../adr/0005-station-taxonomy.md), and the Docker/env secret posture in
> [`docker-packaging.md`](../done/docker-packaging.md).

## 1. Context & Background

Conduit already has the right high-level station taxonomy:

- `transform` stations call a model through the kernel's OpenAI-compatible adapter.
- `deterministic` stations run non-model work under Law-lite controls.
- `agentic` stations are deferred to the Tool-Bridge.

The current deterministic surface is safe but too low-level. The dogfood flow fetches
context by allowlisting `duckdb` and hand-writing a command:

```yaml
worker:
  kind: deterministic
  command: duckdb
  args: ["-readonly", "fixtures/fixture.duckdb", "-f", "fetch.sql"]
```

That works, but it forces every flow author to think in shell arguments, allowlists, and
output-file side effects. The same problem appears as soon as a flow needs to fetch from
Postgres, call an HTTP API, or turn a response into a JSON artifact. Most users already
have their data somewhere; Conduit should make "read this data into an artifact" boring.

This is especially important because Conduit's adoption story is **flow authoring**. A
builder should express the production line: "fetch context, ideate, verify, deliver."
They should not need to invent a safe DuckDB/Postgres/HTTP wrapper for every flow.

## 2. Problem Statement

Deterministic stations currently expose the escape hatch (`shell.command`) before the
common case. A user who wants to read from an existing database or API must hand-write a
command or script, decide where secrets live, ensure outputs are declared, avoid secret
leaks in logs, and make the journal useful. That repeats across flows and pushes authors
toward unsafe glue code.

Conduit needs built-in, typed **data-fetch drivers** that preserve Conduit semantics:
fetch external data, write declared artifacts, participate in checkpointing, avoid secret
leaks, and produce useful journal spans.

## 3. Target Users & Use Cases

**Primary user - a flow author.** Has an existing database/API and wants to turn selected
data into an input artifact for a later model station.

**Secondary user - an operator deploying flows in Docker.** Wants to inject connection
secrets as environment variables, not edit `flow.yaml` or store credentials in Conduit.

**Key use cases:**

- A flow reads a product/customer/order context from DuckDB or Postgres into
  `context.json`.
- A flow calls a read-only HTTP API and writes the response to an artifact.
- A flow author swaps a connection from local fixture DuckDB to production Postgres
  without changing downstream stations.
- `conduit doctor` can report that required connection env vars are present without
  printing their values.
- The journal shows what data-fetch station ran, how many rows/bytes it wrote, how long
  it took, and the output hash - never passwords, tokens, or Authorization headers.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| SQL fetch is first-class | A flow can fetch SQL results into JSON without a shell wrapper | Yes |
| HTTP fetch is first-class | A flow can call a read-only API into JSON without a custom script | Yes |
| Secrets are not stored | Secret values committed to `flow.yaml`, SQLite, journal, or artifacts by the driver | 0 |
| Existing examples get simpler | `tiktok-shoppable-ideas` no longer needs a raw DuckDB command for its fetch step | Yes |
| Driver output is observable | Journal records driver type, connection name, duration, row/byte count, output hash | 100% of driver runs |
| Conduit does not become n8n | Mutating app automation nodes added by this PRD | 0 |

## 5. Scope

### In Scope

- A top-level `connections:` block in `flow.yaml` containing **connection metadata and
  secret references**, not secret values.
- A deterministic `driver` field for standard station drivers.
- A `sql.query` driver that reads from an existing SQL source and writes a JSON artifact.
- V1 SQL connection types:
  - `duckdb` - local fixture / file-backed analytics database.
  - `postgres` - production warehouse/application database via env-ref URL or structured
    env-ref fields.
- An `http.request` driver for read-oriented API fetches into JSON artifacts.
- Env-ref secret resolution (`*_env`) at runtime.
- `conduit doctor` checks for required connection env vars.
- Secret filtering for driver config, errors, logs, journal attributes, and spawned
  substrate.

### Out of Scope

- Running or hosting a database.
- ORM behavior, migrations, schema management, connection pooling as a product surface.
- Visual query building.
- A marketplace of app integrations.
- Mutating HTTP methods or DB writes as a v1 feature. Mutation requires explicit
  `effectful: true` semantics and outbox/idempotency design, and should be specified
  separately.
- Replacing `shell.command`; raw deterministic commands remain the escape hatch.

## 6. Proposed Authoring Surface

### Connections

Connection definitions live at the top level and are named. A station references a
connection by name.

DuckDB:

```yaml
connections:
  sales_fixture:
    type: duckdb
    path: fixtures/fixture.duckdb
    readonly: true
```

Postgres via URL env ref:

```yaml
connections:
  warehouse:
    type: postgres
    url_env: WAREHOUSE_DATABASE_URL
    ssl: require
    readonly: true
```

Postgres via structured env refs:

```yaml
connections:
  warehouse:
    type: postgres
    host: db.internal
    port: 5432
    database: analytics
    user_env: WAREHOUSE_USER
    password_env: WAREHOUSE_PASSWORD
    ssl: require
    readonly: true
```

HTTP API:

```yaml
connections:
  product_api:
    type: http
    base_url: https://api.example.com
    auth:
      bearer_env: PRODUCT_API_TOKEN
```

### SQL Query Station

```yaml
stations:
  - id: fetch_context
    worker:
      kind: deterministic
      driver: sql.query
      connection: warehouse
      query_file: fetch.sql
      params:
        product_id: "{{request.product_id}}"
      output: context.json
      format: json
    next: ideate
```

The driver reads the query, binds params, executes read-only, and writes the result as the
declared output artifact. For single-output drivers, `worker.output` is accepted as the
author-facing shorthand and compiled to the station's canonical `outputs` list:

```yaml
outputs: [context.json]
```

If both `worker.output` and `outputs` are present, they must agree exactly; otherwise the
loader fails closed.

### HTTP Request Station

```yaml
stations:
  - id: fetch_company
    worker:
      kind: deterministic
      driver: http.request
      connection: product_api
      method: GET
      path: /companies/find
      query:
        domain: "{{request.domain}}"
      output: company.json
      format: json
    next: summarize
```

For v1, `http.request` is read-oriented and supports `GET` only. If `HEAD` later becomes
useful for freshness checks, or if `POST`, `PATCH`, or `DELETE` are ever added, they must
be specified separately. Mutating methods must be modeled as effectful stations with
outbox/idempotency semantics.

### Parameter Interpolation

V1 interpolation is allowed only in structured value positions:

- SQL `params`
- HTTP `query`
- HTTP non-secret headers

V1 interpolation is not allowed in raw SQL strings, arbitrary URL strings, or path
segments. Those can be added later with explicit escaping/encoding rules, but the first
driver pass should keep interpolation easy to validate and secret-safe.

## 7. Requirements

### Functional Requirements

1. The flow loader shall parse a top-level `connections:` map and validate that every
   station `connection:` references a known connection.
2. The loader shall reject inline secret-looking values for connection passwords, tokens,
   API keys, and authorization headers. Flow config may contain env var names, not secret
   values.
3. The runtime shall resolve env refs at station dispatch or process boot and shall keep
   secret values in memory only.
4. `sql.query` shall execute a query from `query_file` or inline `query` against the named
   connection and write a JSON artifact.
5. `sql.query` shall support bound params from station config and shall not require string
   interpolation inside SQL for user input.
6. `sql.query` shall run read-only by default. DuckDB connections shall use read-only mode
   when configured; Postgres should use read-only transaction/session posture where
   practical.
7. `http.request` shall support `GET` in v1 and shall reject mutating methods at load.
8. `http.request` shall call a named HTTP connection and write the JSON response body as a
   declared artifact.
9. `http.request` shall redact Authorization headers and token values from all logs,
   errors, journal spans, and artifacts produced by driver metadata.
10. Driver stations shall append journal spans containing driver type, connection name,
   query/request identifier, duration, row count or byte count, output path, output hash,
   and cost/tokens as zero.
11. Driver failures shall surface actionable errors naming the connection and station, but
    not the secret value.
12. `conduit doctor` shall report missing required env vars for every configured
    connection using present/missing status only.
13. `worker.output` shall be accepted as shorthand for a single declared output. If both
    `worker.output` and station-level `outputs` are present, they shall match exactly.
14. Driver interpolation shall be limited to structured SQL params, HTTP query values, and
    non-secret HTTP headers in v1.

### Non-Functional Requirements

1. **Secret-safe by construction.** Secret values shall never be stored in `flow.yaml`,
   SQLite, the journal, or spawned substrate.
2. **Artifact-first.** Drivers exist to produce declared artifacts for downstream
   stations, not to mutate external systems.
3. **Boring deployment.** Docker users inject secrets as env vars; Conduit does not need
   its own secret store for v1.
4. **Driver configs are typed.** Each driver has a finite, validated config shape. Unknown
   driver fields should be rejected or warned on rather than silently ignored.
5. **Escape hatch remains.** Users can still use raw deterministic commands when a
   built-in driver is not enough.

## 8. Determinism, Freshness, and Checkpoints

Fetching from an external database or API is deterministic in **execution**, but not
necessarily deterministic in **source contents**. A query can return different rows later
without the flow file changing. This must be explicit rather than hidden.

V1 default:

```yaml
freshness:
  mode: once_per_run
```

For data-fetch stations, `once_per_run` means:

- A new run fetches current source data.
- A resume/re-dispatch inside the same run reuses the already-produced artifact/checkpoint
  for that run/station/attempt instead of re-fetching.
- Downstream checkpoints still bind to the produced artifact hash, so downstream model
  calls are safely invalidated when fetched data changes on a future run.

This gives run-scope idempotency without pretending an external database/API is globally
deterministic across time.

Optional later mode:

```yaml
freshness:
  mode: checkpoint
  stamp_query: "select max(updated_at) from orders"
```

`stamp_query` would let the driver compute a stable freshness stamp and reuse a checkpoint
only if the source stamp is unchanged. This is useful but not required for the first win.

## 9. Security & Secret Handling

The v1 rule is simple: **Conduit references secrets; it does not store them.**

Allowed:

```yaml
url_env: WAREHOUSE_DATABASE_URL
password_env: WAREHOUSE_PASSWORD
bearer_env: PRODUCT_API_TOKEN
```

Not allowed:

```yaml
url: postgres://user:<inline-secret>@db.internal/analytics
password: <inline-secret>
authorization: Bearer <inline-secret>
```

Docker makes env-ref injection straightforward:

```bash
docker run \
  -e WAREHOUSE_DATABASE_URL \
  -e PRODUCT_API_TOKEN \
  ...
```

Driver spans should record:

- connection name
- connection type
- query file or request path
- duration
- row/byte count
- output path
- output hash

Driver spans should not record:

- database URLs
- passwords
- bearer tokens
- Authorization headers
- full request headers unless filtered
- full response headers unless filtered

## 10. Edge Cases & Error States

- **Missing env var** -> fail before station execution with an actionable error and no
  partial artifact.
- **Unknown connection name** -> flow load fails closed.
- **Unsupported driver** -> flow load fails closed.
- **SQL returns zero rows** -> successful artifact with empty result plus row count `0`.
- **SQL syntax error** -> station failure with query file named, secret-safe message.
- **HTTP non-2xx** -> station failure naming status code and response class, with body
  redacted/truncated.
- **HTTP response is not JSON but `format: json`** -> station failure; do not write a
  misleading artifact.
- **Output path overlaps another station** -> existing owned-path validation applies.
- **Attempted mutating method in v1** -> load-time rejection.

## 11. Dependencies

- **Real-run path** - driver stations execute inside the existing executor.
- **Checkpoint/outbox** - fetch outputs become artifacts; future mutating drivers must
  use outbox semantics.
- **Secret filtering** - existing sensitive-key filtering should be reused and extended
  for connection configs and HTTP headers.
- **Docker packaging** - env refs are easiest to operate once the Docker run/compose docs
  show secret injection.

## 12. Resolved Design Decisions

- **Single-output shorthand:** `worker.output` is supported for easy authoring and is
  compiled to canonical station `outputs`.
- **SQL backends:** v1 includes both DuckDB and Postgres behind the generic
  `driver: sql.query` / `connection:` shape.
- **HTTP method:** v1 `http.request` supports `GET` only.
- **Interpolation:** v1 allows interpolation only in structured SQL `params`, HTTP
  `query`, and non-secret HTTP headers.
- **Freshness:** data-fetch stations default to `freshness.mode: once_per_run`, caching
  the result within a run for resume/re-dispatch idempotency while fetching fresh data on
  a new run.
