# tiktok-shoppable-ideas — Dogfood Run Measurements

Spike measurement record for the real-run path PRD (section 11).
Captured: 2026-06-07. Platform: Linux x86-64, Bun v1.3.11.

---

## Flow validation (AC1 — loader contract)

```
bun run src/cli/main.ts doctor
```

| Check | Result |
|---|---|
| `flow.yaml` loads cleanly | ✓ 0 validation errors |
| `happyPathNext` | `{ fetch_context: "ideate", ideate: "done" }` |
| `back_edges` | `[{ from: "ideate", to: "ideate" }]` |
| `ideate.model` | `gpt-4o-mini` |
| `ideate.gateCheck.criticModel` | `gpt-4o` |
| `ideate.gateCheck.reworkCap` | `2` |
| `fetch_context.command` | `duckdb` |
| `fetch_context.args` | `["-readonly","fixtures/fixture.duckdb","-f","fetch.sql"]` |
| `budgets.run.max_tokens` | `100000` |
| `budgets.run.wall_clock_minutes` | `10` |

---

## Deterministic station — fetch_context (AC2 — Law-lite + DuckDB)

Exercises the real `duckdb` deterministic station against the committed synthetic fixture.

```bash
cd examples/tiktok-shoppable-ideas
cp request.example.json request.json
time duckdb -readonly fixtures/fixture.duckdb -f fetch.sql
```

| Measurement | Value |
|---|---|
| Wall-clock time | **23 ms** |
| `context.json` size | **3 633 bytes** |
| Exit code | `0` |
| Law-lite verdict | `allowed` (`duckdb` is in `security.bash.allow`) |

`context.json` sample (first 200 chars):
```json
{"product_id":"999000111222333444","clock":{"today":"2026-06-07","last_video_date":"2026-06-01",
"days_since_last_video":6},"display_name":"Galaxy Mug Buddy – 3D Printed Cup Companion",...}
```

Fields produced: `product_id`, `clock`, `display_name`, `ad_performance`, `top_hooks` (3),
`recent_videos` (3), `sales.best_colorways` (6), `sales.rising_stars` (6).

---

## CLI seeding and flow start

```bash
CONDUIT_STATE_DB=/tmp/conduit-run.sqlite \
CONDUIT_JOURNAL_DB=/tmp/conduit-journal.sqlite \
CONDUIT_API_KEY=<key> \
CONDUIT_BASE_URL=<gateway> \
bun run src/cli/main.ts run flow.yaml --input request.example.json
```

Without `CONDUIT_API_KEY`, the CLI fails at the first model call with:

```
fatal: No model API key configured — set CONDUIT_API_KEY or OPENAI_API_KEY
```

This is correct fail-closed behavior (NFR-5 — credentials read at call time, never at construction).

---

## End-to-end run (requires CONDUIT_API_KEY + gateway)

> **PENDING** — complete with real credentials. Template below.

Expected run sequence:

1. CLI seeds entry card at `fetch_context`, status=`ready`
2. `runExecutor` dispatches `fetch_context` → `duckdb` runs (~23 ms) → `context.json` written
3. Card advances to `ideate`, status=`ready`
4. `runTransformStation` renders `prompts/ideate.md` against `context.json`, POSTs to `gpt-4o-mini`
5. Response parsed and schema-validated (`featured_variant`, `hook`, `filming_idea` strings)
6. `idea.json` written under project root
7. Gate critic: `runGateCheck` renders `prompts/verify.md` against `idea.json + context.json`, POSTs to `gpt-4o`
8. Gate passes → card advances to `done`, status=`complete`, exit code `0`

### Measurements to capture

| Metric | Value |
|---|---|
| `ideate` transform wall-clock | _(fill)_ ms |
| `ideate` input tokens | _(fill)_ |
| `ideate` output tokens | _(fill)_ |
| `ideate` cost (from `x-litellm-response-cost`) | $_(fill)_ |
| gate critic wall-clock | _(fill)_ ms |
| gate critic input tokens | _(fill)_ |
| gate critic output tokens | _(fill)_ |
| gate critic cost | $_(fill)_ |
| **Run total tokens** | _(fill)_ |
| **Run total cost** | $_(fill)_ |
| Rework cycles needed | _(fill)_ |
| Parse-miss rate (`model-incompatible` scraps) | _(fill)_ / 4 attempts |
| `idea.json` produced | _(yes/no)_ |

Journal query after run:
```sql
SELECT station, SUM(input_tokens) AS in, SUM(output_tokens) AS out, SUM(cost_usd) AS cost
FROM journal
WHERE card_id = 'conduit-run-entry'
GROUP BY station;
```

---

## Crash-and-resume proof (NFR-2 — exactly-once)

> **PENDING** — complete with real credentials. Architecture documented below.

### Mechanism

The checkpoint layer (`src/checkpoint/checkpoint.ts`) writes a `binding_stamp` row to the
`checkpoints` table on each completed station. On `conduit resume`, `decideResume` compares the
stored stamp against the current configuration hash:

```
binding_stamp = SHA-256([modelId, promptTemplateVersion, sorted(inputArtifactHashes), flowVersion])
```

- **Stamp matches** → station is skipped (no re-bill)
- **Stamp mismatch** → station is re-executed (config changed)
- **Pending outbox entry** → escalated to `hold` (never blind-retried, SPEC §5)

### Crash procedure (to exercise manually)

```bash
# 1. Start the run
CONDUIT_STATE_DB=/tmp/conduit-run.sqlite \
CONDUIT_JOURNAL_DB=/tmp/conduit-journal.sqlite \
CONDUIT_API_KEY=<key> CONDUIT_BASE_URL=<gw> \
bun run src/cli/main.ts run flow.yaml --input request.example.json &
RUN_PID=$!

# 2. Kill after fetch_context completes (duckdb exits ~23ms; give ideate ~1s to start)
sleep 1.5
kill $RUN_PID

# 3. Resume
CONDUIT_STATE_DB=/tmp/conduit-run.sqlite \
CONDUIT_JOURNAL_DB=/tmp/conduit-journal.sqlite \
CONDUIT_API_KEY=<key> CONDUIT_BASE_URL=<gw> \
bun run src/cli/main.ts resume flow.yaml
```

Expected behavior:
- `fetch_context` checkpoint stamp present → station **skipped** (no duckdb re-run)
- `ideate` was interrupted → re-dispatched from `interrupted` status
- No model re-bill for `fetch_context` (deterministic, no journal usage row)
- Resume exits 0 with card at `done`

### Measurements to capture

| Measurement | Value |
|---|---|
| `fetch_context` re-executed on resume | _(no — deterministic, checkpointed)_ |
| `ideate` re-billed if killed after its model call | _(depends on kill timing)_ |
| Binding stamp stable across resume (no config change) | _(yes)_ |
| Outbox entries escalated (none in this flow — no `effectful: true` stations) | `0` |

---

## Spike measurements (vs frontier-agent baseline)

> **PENDING** — complete with real credentials.

### 1. Parse-miss rate

`runTransformStation` retries up to `max_execution_attempts=4` on parse/validation failure.
The ideate output schema has 3 required string fields. Expected miss rate for `gpt-4o-mini`: ~0%.

| Model | Attempts | Misses | Miss rate |
|---|---|---|---|
| `gpt-4o-mini` (ideate) | _(fill)_ | _(fill)_ | _(fill)_% |
| `gpt-4o` (gate critic) | _(fill)_ | _(fill)_ | _(fill)_% |

### 2. Token / cost vs frontier-agent baseline

A frontier-agent approach (single Claude Opus call) for the same task: ~2 000–4 000 tokens, ~$0.06–0.12.

| Approach | Tokens | Cost |
|---|---|---|
| Conduit flow (ideate + gate) | _(fill)_ | $_(fill)_ |
| Frontier-agent baseline | ~3 000 est. | ~$0.09 est. |
| Delta | _(fill)_ | _(fill)_ |

### 3. Prefix-cache behavior

LiteLLM with OpenAI-compatible backends reports prefix cache hits in usage metadata.
Relevant for the gate critic whose prompt shares a large `context.json` prefix with `ideate`.

| Station | Cache hits reported | Source |
|---|---|---|
| `ideate` | _(fill)_ | `x-litellm-response-cost` header |
| gate critic | _(fill)_ | gateway usage metadata |

---

## Findings / flow-is-config gaps

Issues surfaced during the real-run path implementation:

| Finding | Item | Status |
|---|---|---|
| `security.deny_shell_metachars` field validated at load time but stored in loader only — not surfaced on `StationConfig` | Cosmetic (validation happens at load) | Deferred |
| `network_egress: deny` declared in YAML but not enforced at kernel level (requires `unshare --net` at worker spawn, SPEC §7 step 9) | Architecture gap | Deferred — agentic stations only |
| `project_root: '.'` resolves relative to flow file directory (absolute via loader) | Working correctly | Closed in WI-357 |
| Gate critic prompt template (`verify.md`) references `idea.json` which must be written before gate call | Implemented in WI-356 executor | Closed |

---

## How to complete this document

1. Set `CONDUIT_API_KEY` and `CONDUIT_BASE_URL` (LiteLLM or direct OpenAI endpoint)
2. Run `conduit run flow.yaml --input request.example.json` from this directory
3. After completion, query the journal DB for token/cost totals
4. Repeat with a kill+resume to verify exactly-once semantics
5. Fill in the `_(fill)_` fields above
6. Record any additional gaps discovered
