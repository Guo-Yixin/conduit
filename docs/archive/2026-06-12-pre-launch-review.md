# Pre-Launch Review: Conduit v0.1.x

- **Status:** Proposed (findings awaiting triage)
- **Date:** 2026-06-12
- **Scope:** Full review of docs (SPEC, README, ADRs, docs/, prd/) and `src/` against the
  guarantees those docs claim. Four parallel review passes: docs-vs-implementation
  consistency, kernel correctness (executor / checkpoint / claim / FSM), the security and
  ingress surface, and the quality system + workers + flow loading.
- **Format:** ADR-style — each finding is a mini-decision: context, evidence, recommendation.

## Context

Conduit is at build-order steps 1–8.2 (MVP kernel + real-run path + branching/HITL +
ingress listener) and approaching a public launch. The kernel makes strong claims —
exactly-once effectful execution, crash-safe resume via binding stamps, four independent
rework guards, fail-closed escalation — and because it runs its own runtime with no
provider safety net, those claims are load-bearing.

The headline result: **the core kernel claims hold.** The review specifically hunted for
crash-window bugs in the outbox/checkpoint discipline, atomicity violations in the claim
path, binding-stamp blind spots, rework-guard bypasses, and state-machine strandings — and
found the implementations sound (see "Verified sound" at the end). The real findings
cluster at the *edges*: spec drift, the LLM gateway boundary, one SQL-hygiene lapse, and
operational gaps (rate limiting, log pruning, install docs) that matter once strangers run
this.

Findings are grouped: **§1 fix before launch**, **§2 worrisome architecture** (decisions to
make, not bugs to fix), **§3 better-solution suggestions** (non-blocking).

---

## 1. Fix before launch

### 1.1 SPEC contradicts code on fan-in `k`: ratio vs. count — HIGH (doc-critical)

**Evidence:** `SPEC.md:586-587` — "**`k` is a ratio (0.0–1.0):** the minimum fraction of
children… `k: 0.9` = at least 90% must succeed", and the example at `SPEC.md:393`
(`fan_in: { policy: quorum, k: 0.9 }`). The code disagrees everywhere:
`src/dag/expand.ts:305` ("k is the minimum number of surviving children (count, integer
≥ 1)"), `src/flow/load.ts:475` (validates `1 <= k <= fan_out` as an integer), and the
shipping example `examples/branching/flow.yaml:92` uses `k: 2`.

A user who copies the SPEC's `k: 0.9` gets a load-time rejection at best; at worst a
future loosening of the validator silently floors it to 0. This is the kind of drift that
erodes trust in a spec that otherwise tracks the code closely.

**Recommendation:** Keep the code's semantics — an integer count is simpler, has no
rounding ambiguity (does 90% of 7 children mean 6 or 7?), and is already validated against
`fan_out` at load. Fix SPEC §6 and the §4 example. One-line doc change; decide and record
it (a sentence in ADR-0005 or the SPEC changelog is enough).

### 1.2 String-interpolated SQL in `cmdRun` — HIGH

**Evidence:** `src/cli/main.ts:211-214`:

```ts
const terminalSql = [...terminalLanes].map((l) => `'${l}'`).join(', ');
stateDb.prepare(`SELECT COUNT(*) AS n FROM cards WHERE lane NOT IN (${terminalSql}) …`)
```

`terminal_lanes` comes from `flow.yaml`, and the loader checks referential integrity but
imposes **no character restrictions** on lane names (`src/flow/load.ts:323` builds the set
straight from YAML strings). A lane name containing `'` breaks the query; a crafted one
rewrites it. This is operator-controlled config, not a remote attack surface — but the
project's own principle is "config is validated, not trusted," and this is the one place
in the codebase that builds SQL by interpolation. It will also be the first thing a
security-minded reader greps for after launch.

**Recommendation:** Use `?` placeholders (`map(() => '?').join(', ')` + spread bind).
Optionally also add a lane-name charset rule (`^[a-z0-9_-]+$`) to the loader — lane names
flow into file paths, journal entries, and Slack messages too, so a boring identifier
grammar pays for itself beyond this query.

### 1.3 LLM gateway responses are trusted unguarded — and a malformed `usage` silently disarms the consumption andon — HIGH

**Evidence:** `src/worker/openai-adapter.ts:242-249`:

```ts
const data = (await response.json()) as { choices: …; usage: … };
const text = data.choices[0]!.message.content;
const inputTokens = data.usage.prompt_tokens;
```

Two failure modes:

1. A gateway returning HTTP 200 with `choices: []` (LiteLLM does this for some upstream
   error conditions) crashes the worker with a TypeError instead of a classified,
   retryable-or-not error.
2. A missing/null `usage` makes `inputTokens` `undefined`. Token accounting then
   accumulates `NaN`, and every `tokensSpent > maxTokens` comparison is false — **the
   consumption andon can never trip on tokens for the rest of the run.** The cost header
   is handled defensively right below (`Number.isFinite` check, NFR-6), so the gap is an
   inconsistency, not a pattern: the same care wasn't applied to the body.

This matters more here than in a typical app because Conduit's whole safety story for
runaway flows is the two andons. A single quirky proxy response shouldn't quietly remove
one of them.

**Recommendation:** Validate the response shape before use — non-empty `choices`, string
`content`, finite numeric `usage` fields — and throw a classified error on mismatch.
Mirror the NFR-6 stance: explicit failure, never NaN, never a silent guess. Add a unit
test for `choices: []` and `usage: null` responses.

### 1.4 No installation/deployment doc, but the volume mount is load-bearing — HIGH (launch-blocking for an OSS release)

**Evidence:** `adr/0003-packaging-and-distribution.md:114` defers the install recipe to
`docs/installation.md`, which does not exist. README describes Docker-first distribution
but gives no runnable steps. ADR-0003 itself calls out that "the volume must be right or
state is silently lost" — i.e., the single biggest operational footgun (running with
`conduit.sqlite` on the ephemeral container FS, losing crash-recovery state on restart)
is documented only as a risk, not as a checklist a new user follows.

**Recommendation:** Write `docs/installation.md` before launch: Dockerfile/run command,
required volume mounts (`conduit.sqlite` + project root), secret injection via env, and a
"run the branching example end-to-end" walkthrough. This is also the natural place to
state the ingress listener's deployment posture (reverse proxy, TLS, body-size limits —
see §2.3).

### 1.5 `no_selection_policy` and the `rank` station are effectively undocumented — MEDIUM

**Evidence:** `no_selection_policy` is implemented (`src/flow/load.ts:109,266-276`) and
used by the shipping example (`examples/branching/flow.yaml:105`) but appears nowhere in
SPEC, README, or any ADR. The `rank` station itself gets two sentences in SPEC §6
(`SPEC.md:549-550`) while its actual config surface (HITL hold interaction, timeout
policies, selection recording) is substantially richer. Same pattern for
`progress_signal` (`SPEC.md:375` mentions one value; the loader accepts free text).

**Recommendation:** Add a SPEC §6 subsection for rank stations covering the full config
surface and enumerating `no_selection_policy` / `progress_signal` values; constrain
`progress_signal` to a validated enum in the loader while you're there. Launch users will
build from the SPEC and the examples — right now those two sources don't agree on what
exists.

---

## 2. Worrisome architecture — decisions to make before they calcify

### 2.1 Checkpoint invalidation cascade is implicit, and its soundness rests on an unvalidated assumption

**Evidence:** SPEC §5 promises explicit cascade: "on mismatch the checkpoint is
invalidated and the invalidation cascades downstream." The code never calls
`cascadeInvalidation` (defined in `src/checkpoint/checkpoint.ts`, zero call sites). What
actually happens: each station's binding stamp hashes its input artifacts from disk at
dispatch time (`src/controller/executor.ts:730-743`), so a re-executed upstream station
changes downstream input hashes and downstream stamps mismatch *naturally*.

This is elegant and currently correct — but only because every station's `inputs:` list
happens to cover everything it actually reads. The invariant "a station reads only its
declared inputs" is enforced for prompt templates (`src/flow/render.ts:89-98` rejects
undeclared placeholders) but **not for agentic stations** (build step 9), which will read
the filesystem freely. When the Tool-Bridge lands, the implicit cascade silently stops
being sound for exactly the station kind where stale reuse is most dangerous.

**Recommendation:** Decide now, record it as an ADR: either (a) commit to the implicit
hash-freshness design, document it in SPEC §5 as the actual mechanism, delete
`cascadeInvalidation`, and add a loader/integrity rule that agentic stations must declare
a read-scope that the stamp hashes over; or (b) wire explicit cascade invalidation before
step 9. Option (a) is less code but needs the read-scope rule to stay honest.

### 2.2 The secret filter is a deny-list guarding an append-only journal

**Evidence:** `src/persistence/db.ts:107-112` — `SENSITIVE_KEY_RE` blocklist, recursively
applied (good) but inherently incomplete: a vendor field like `session_jwt`,
`x_signature_nonce`, or a bare `key_material` sails through into `ingress_log` /
envelope storage. The journal is append-only and exported (`secret-filter-export` tests
exist precisely because export leaks were a worry), so a missed pattern is persisted
indefinitely and re-leaked on every export.

**Recommendation:** Two cheap moves before launch: (1) let bindings declare
`additional_sensitive_keys` in `flow.yaml` so operators can extend the filter per
webhook vendor without a code change; (2) log (once per key name) what the filter drops,
so operators can audit what it's catching and infer what it isn't. The full fix —
allow-listing which envelope fields are persisted per binding — fits naturally in the
ingress maturation step; consider it for the SPEC.

### 2.3 The ingress listener has no resource ceilings

**Evidence:** No rate limiting per route/IP/flow (`src/ingress/listener.ts`; acknowledged
in `docs/ingress-listener.md` §Limitations), no `ingress_log` retention/pruning, and no
documented request-body size cap. A public webhook endpoint with none of these is a
disk-fill DoS waiting for a misconfigured upstream (one Shopify store stuck in a retry
loop is enough — no attacker required). The redrive cap (recent commit `ec1efeb`)
bounds *spawn* retries but not *arrival* volume.

**Recommendation:** Minimum for launch: a body-size limit on the listener and a
documented stance ("run behind a reverse proxy; here's the nginx snippet") in the
installation doc. Per-flow pending-spawn caps and `ingress_log` retention can follow, but
write the limitation into README/docs so it's a known trade-off rather than a surprise.

### 2.4 Content-hash dedup degradation is a console warning, not a recorded fact

**Evidence:** `src/ingress/event-id.ts:142-152` — when no event-id source matches, dedup
falls back to a raw-body content hash with a once-per-binding `console.warn`. Two
semantically different events with identical bytes dedup silently; nothing in
`ingress_log` records that an event was accepted under degraded dedup, so it's
post-hoc undiagnosable.

**Recommendation:** Record the dedup mode on the ingress-log entry (one column:
`explicit | content_hash`). Consider a per-binding `dedup: require_event_id` opt-in for
flows where dropping a real event is worse than processing a duplicate. This aligns with
the project's own "escalate ambiguity, never guess" principle — a silent fallback is a
guess.

### 2.5 The executor is sequential, but the machinery around it is shaped for concurrency

**Evidence:** `src/controller/executor.ts:365` — `await executeStation(...)` inside the
tick loop; exactly one card in flight, ever. Meanwhile the codebase carries atomic claim,
WIP caps, per-station active counts, heartbeat leases, and `watchdog.planDrain` (blocked
on concurrency per CLAUDE.md). None of this is wrong — it's the documented build order —
but two launch implications deserve eyes-open acknowledgment:

1. **Throughput:** a fan-out of 10 transform children executes serially; wall-clock cost
   of the branching example scales linearly with `fan_out`. Worth a sentence in README so
   early adopters don't read "flow-shop" as "parallel."
2. **Two processes, one DB:** the atomic claim protects against concurrent *claims*, but
   nothing stops an operator from starting two `conduit run` processes against the same
   volume (the ingress listener already spawns runs — `src/ingress/spawn.ts`). If a
   spawned run and a manual run can coexist, the single-writer assumptions in the tick
   loop (e.g., reading `perStationActive` then acting on it) deserve a re-audit; if they
   can't, add a run-lock (a `BEGIN EXCLUSIVE` lease row or a pid/lease file) and fail the
   second process loudly.

**Recommendation:** Add the run-lock now (small, cheap, closes a real operator footgun);
defer true concurrency to its build-order step as planned.

### 2.6 HITL correlation ids piggyback on the `terminal` card-log kind

**Evidence:** `src/controller/executor.ts:1456-1462` writes the HITL correlation id as a
`kind: 'terminal'` card-log entry with `reason: 'hitl::…'`, and recovery greps for that
prefix (`executor.ts:1922`). It works (INSERT OR IGNORE keeps it idempotent), but
`terminal` semantically means "why this card died," and the journal is the system's
audit log — every consumer of it (kaizen, step 10, is *built on* reading this journal)
now needs to know that some `terminal` entries aren't terminal.

**Recommendation:** Add a dedicated `kind: 'hitl_posted'` entry before the journal schema
has external consumers. Migrating the journal format after kaizen ships against it is 10×
the cost.

---

## 3. Better solutions / non-blocking suggestions

| # | Suggestion | Evidence | Why |
|---|---|---|---|
| 3.1 | Reject `stream: true` in the adapter's param allowlist | `src/worker/openai-adapter.ts` param filter | A flow author setting it gets a JSON-parse scrap with a misleading `model-incompatible` reason; reject at load with a clear message instead. |
| 3.2 | Reject future timestamps in the Slack replay window | `src/ingress/adapters/slack-events.ts:101-106` uses `Math.abs` | `now - ts ∈ [0, tolerance]` is strictly tighter for free. |
| 3.3 | Validate the `sha256=` prefix explicitly in webhook signature parsing | `src/cli/main.ts:350-358` | Current length-compare happens to reject other algorithms, but parse-then-compare is self-documenting and robust to format drift. |
| 3.4 | Enumerate known ingress auth types and reject unknowns by name | `src/ingress/binding.ts:223-252` | Today an unknown `auth.type` fails only via the missing-`secret_env` path; a direct "unknown auth type" error is clearer and survives future type additions. |
| 3.5 | Extract HITL card ids with an anchored regex | `src/channels/slack.ts:164-166` splits on `::` | Kernel-generated ids make this theoretical today; one line makes it non-theoretical forever. |
| 3.6 | Guard `stationOutput.payload` with an explicit null check before artifact writes | `src/controller/executor.ts:900` | Unreachable-null today, but only by control-flow distance; a refactor away from a crash. |
| 3.7 | Roll the `[Unreleased]` changelog sections (ingress, branching) into a tagged 0.2.0 at launch | Pre-public changelog sections vs README "implemented" claims | README and the pre-public changelog disagreed about what had shipped at the time of this review. |
| 3.8 | Record an ADR for the rank-station / `no_selection_policy` design | `adr/README.md` candidate list | The decision was made in build step 8.1; the rationale lives only in the PRD. |

---

## Verified sound (what the review confirmed, not just failed to break)

Recorded so future reviews don't re-litigate, and because several were explicit hunt
targets:

- **Effectful outbox discipline** — intent written before the effect, checkpoint before
  commit; every crash window between them lands in fail-closed escalation to `hold`
  rather than blind retry or double-billing (`executor.ts:558-600,778-875`).
- **Binding stamps include rework feedback** — the feedback string is hashed into the
  input set (`executor.ts:739-741`), so a rework attempt never falsely matches the
  pre-feedback checkpoint. This was a deliberate hunt target and it holds.
- **Fan-out idempotency** — `commitFanOut` + child routing + the FAN_OUT transition are
  individually idempotent, so the multi-statement sequence survives a crash at any point
  (`executor.ts:1637-1705`), though wrapping it in one transaction would make that
  obvious rather than provable.
- **The four rework guards** are independent, agree with the FSM (no double-counting —
  there's a test proving FSM/guard agreement, `rework.test.ts:209-239`), and the
  findings-hash is order-insensitive and computed over findings only, not the artifact.
- **Ingress signature verification** is timing-safe and signs the raw body on both the
  webhook and Slack paths; auth runs before any DB write or spawn.
- **`flow.yaml` validation** covers cycles (both `depends_on` and `next` topologies),
  back-edge legality, quorum bounds, prompt-placeholder scope, and overlapping
  `owned_paths`.
- **The liveness watchdog and consumption andon** trip conditions are correct (the
  reviewer initially flagged both; on verification each suspected hole was guarded by the
  dual condition `noProgress && noActiveWorkers` or by the documented soft-ceiling
  semantics).

## Decision

Pending triage. Proposed order: §1.2 and §1.3 are afternoon-sized code fixes; §1.1 and
§1.5 are doc fixes; §1.4 is a writing task gated on launch. §2 items each need an explicit
yes/no recorded — 2.1 (cascade strategy) and 2.5 (run-lock) before build step 9 starts,
the rest before "production" is in the README.

## Consequences

If §1 ships fixed, the launch surface is honest: the kernel's strong claims are real and
verified, and the known limitations (sequential executor, ingress ceilings) are documented
trade-offs rather than surprises. The §2 decisions are the ones with compounding cost —
journal schema (2.6) and cascade strategy (2.1) get an order of magnitude more expensive
to change after kaizen and the Tool-Bridge build against them.
