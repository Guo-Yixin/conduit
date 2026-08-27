# Diagrams

Mermaid diagrams of the flows through the Conduit kernel. Each diagram is drawn from the
*code*, not the SPEC's idealized version — sources are cited per diagram. Terms:
[`glossary.md`](./glossary.md).

---

## Rendering `flow.yaml`

Use `conduit explain` to inspect the compiled topology without starting a run:

```sh
conduit explain path/to/flow.yaml
```

The command loads the same fail-closed `flow.yaml` config as `conduit run`, then
prints a read-only topology explanation. It never opens the state DB, calls a
model, or starts workers.

In an interactive terminal, the rich view shows:

- a compact horizontal flow overview with boxed stations
- fan-out child lanes anchored under the split station
- fan-in continuation under `join survivors`
- in-box rework markers for backflow routes
- a station table with worker, route, and notes
- a backflow table when the flow declares reject routes

For scripts and pipes, disable rich output:

```sh
conduit explain path/to/flow.yaml --color never
```

`--color auto` is the default. `--color always` forces the rich layout, and
`NO_COLOR=1` suppresses ANSI color while keeping the rich structure when rich
output is otherwise selected.

---

## 1. The card status FSM

Every status move a card can make, exactly as the kernel transition table allows it
(`src/statemachine/transitions.ts` — every `(from, event)` pair not shown here is
rejected as illegal). Lane routing is the *other* axis; see §2.

```mermaid
stateDiagram-v2
    [*] --> waiting
    waiting --> ready: tick promotes<br/>(deps confirmed)
    ready --> claimed: CLAIM<br/>(atomic claim txn)
    claimed --> working: START_WORK
    working --> done_pending_ack: MARK_DONE<br/>(Summary Hook fires)
    working --> interrupted: WORKER_CRASH
    interrupted --> ready: REHYDRATE<br/>(lease reconcile — only exit)

    done_pending_ack --> waiting: INTEGRITY_PASS<br/>(advance lane, mid-flow)
    done_pending_ack --> complete: INTEGRITY_PASS<br/>(last station → done)
    done_pending_ack --> working: INTEGRITY_FAIL<br/>(executionAttempt+1, under cap)
    done_pending_ack --> scrapped: INTEGRITY_FAIL at cap<br/>(reason integrity)

    done_pending_ack --> waiting: QC_REJECT<br/>(validated back-edge,<br/>reworkCount+1, under cap)
    done_pending_ack --> scrapped: QC_REJECT at cap<br/>(cap_policy scrap)
    done_pending_ack --> complete: QC_REJECT at cap<br/>(cap_policy proceed_with_findings,<br/>last station)

    done_pending_ack --> awaiting_children: FAN_OUT
    awaiting_children --> ready: FAN_IN_MET<br/>(quorum satisfied)

    waiting --> held: NEEDS_JUDGMENT<br/>(pause in place, lane unchanged)
    waiting --> held: DEP_SCRAP<br/>(on_dep_scrap hold → lane = hold)
    waiting --> scrapped: DEP_SCRAP<br/>(on_dep_scrap scrap)

    complete --> [*]
    scrapped --> [*]
```

Two distinctions worth internalizing (they're in the FSM comments):

- **`held` (status) vs `hold` (lane).** `NEEDS_JUDGMENT` freezes a card *in place* —
  status becomes `held`, lane unchanged. `DEP_SCRAP` with `on_dep_scrap: hold` *moves*
  the card to the `hold` terminal lane.
- **Two counters, never mixed.** `INTEGRITY_FAIL` charges `executionAttempt` (guard #2);
  `QC_REJECT` charges `reworkCount` (guard #1). A QC rework never burns an execution
  attempt, and vice versa.

---

## 2. Lane routing — the generic line

How a card moves *between* lanes: intake, the stations declared in `flow.yaml`, and the
kernel terminals. (SPEC §3; routing context injected per-flow.)

```mermaid
flowchart LR
    intake([intake]) --> S1[station 1<br/>worker]
    S1 --> S2[station 2<br/>worker + check]
    S2 -- check passes --> S3[station 3<br/>worker]
    S2 -. "QC_REJECT<br/>(bounded back-edge)" .-> S1
    S3 --> done([done])
    S2 -- rework_cap hit,<br/>cap_policy scrap --> scrap([scrap])
    S2 -- NEEDS_JUDGMENT /<br/>dep scrapped --> hold([hold])

    style done fill:#d4edda,stroke:#28a745
    style scrap fill:#f8d7da,stroke:#dc3545
    style hold fill:#fff3cd,stroke:#ffc107
```

---

## 3. The quality loop and its four guards

The engine of the system: work → check → bounded rework (SPEC §6,
`src/quality/rework.ts`, `src/controller/gate-rework.ts`). Each guard is independent;
any one of them ends the loop.

```mermaid
flowchart TD
    W[worker produces artifact] --> IH{integrity check<br/>deterministic Summary Hook}
    IH -- fail --> G2{"guard 2:<br/>executionAttempt + 1<br/>< max_execution_attempts?"}
    G2 -- yes --> W
    G2 -- "no" --> SCRAP([scrap: integrity])
    IH -- pass --> QC{quality check<br/>LLM critic, separate prompt/model}
    QC -- approve --> NEXT([advance to next lane])
    QC -- reject --> G3{"guard 3:<br/>findings_hash changed<br/>since last attempt?"}
    G3 -- "no (same findings = no progress)" --> SCRAP2([scrap: no_progress])
    G3 -- yes --> G1{"guard 1:<br/>reworkCount < rework_cap?"}
    G1 -- yes --> BE[route down back-edge<br/>with findings as feedback]
    BE --> W
    G1 -- "no" --> CP{cap_policy}
    CP -- scrap --> SCRAP3([scrap: rework_cap])
    CP -- proceed_with_findings --> NEXT
    G4[/"guard 4 (ambient): budgets at card, wave, and run scope<br/>+ liveness watchdog — can halt or scrap-subtree at any point"/]

    style SCRAP fill:#f8d7da,stroke:#dc3545
    style SCRAP2 fill:#f8d7da,stroke:#dc3545
    style SCRAP3 fill:#f8d7da,stroke:#dc3545
    style NEXT fill:#d4edda,stroke:#28a745
    style G4 fill:#fff3cd,stroke:#ffc107
```

Note the asymmetry: integrity failures re-run the *same* work (the worker botched
execution); QC rejections route down the back-edge with feedback (the work was executed
fine but judged insufficient).

---

## 4. Effectful station — the outbox discipline

Why a publish or a billed call is never blind-retried (SPEC §5,
`src/checkpoint/checkpoint.ts`, wired in `src/controller/executor.ts`). The two crash
windows are the whole point of the design.

```mermaid
sequenceDiagram
    participant E as executor
    participant DB as state DB<br/>(outbox + checkpoints)
    participant X as external system<br/>(model gateway / publish target)

    E->>DB: writePendingIntent(idempotency_key)
    Note over E,DB: ── crash window A ──<br/>pending intent, no effect yet
    E->>X: fire the effect (billed call / publish)
    X-->>E: result
    E->>DB: writeCheckpoint(output, binding_stamp)
    Note over E,DB: ── crash window B ──<br/>effect happened, intent still pending
    E->>DB: commitIntent(idempotency_key)
    E->>DB: FSM transition (advance card)

    rect rgb(255, 243, 205)
    Note over E,X: On resume — reconcileOnResume:<br/>window A (pending, no checkpoint) → escalate to hold:<br/>did the effect land? A human decides — never re-fire blind.<br/>window B (committed or checkpoint present) → skip the call,<br/>reuse the checkpoint. Exactly-once, fail-closed.
    end
```

---

## 5. Checkpoint skip-on-resume

What decides whether a completed station re-runs after a crash (SPEC §5).

```mermaid
flowchart TD
    R[resume: card arrives at station] --> C{checkpoint exists<br/>for this station?}
    C -- no --> RUN[execute the station]
    C -- yes --> S{"binding stamp matches?<br/>hash(model_id, prompt_template_version,<br/>input_artifact_hashes ⊕ feedback, flow_version)"}
    S -- match --> SKIP([skip — reuse checkpoint output])
    S -- mismatch --> RUN
    RUN --> WC[write new checkpoint]
    WC --> N["downstream stations re-hash their inputs at dispatch —<br/>a changed upstream output mismatches their stamps too<br/>(the cascade is implicit via input hashing)"]

    style SKIP fill:#d4edda,stroke:#28a745
```

---

## 6. Ingress — event lifecycle

From HTTP delivery to a spawned run (docs/ingress-listener.md, `src/ingress/`,
`src/persistence/db.ts`). The invariant is **accept-before-spawn**: once a 2xx is
returned, the event is durable and will be driven to a run or surfaced — the sender is
never asked to retry. The 2xx is returned when the run is **launched**,
not when it finishes; the child's exit is handled after the response.

```mermaid
flowchart TD
    RX[HTTP request arrives] --> AUTH{auth verifies?<br/>HMAC over raw body,<br/>timing-safe compare}
    AUTH -- no --> REJ([reject — logged to ingress_log,<br/>nothing persisted])
    AUTH -- yes --> EID[derive event_id<br/>configured source, or smart defaults,<br/>or degraded raw-body content hash]
    EID --> DUP{event_id<br/>already seen?}
    DUP -- yes --> DEDUP([dedup — no-op, logged])
    DUP -- no --> ACC[acceptIngressEvent<br/>spawn_state=accepted, attempts=0<br/>single atomic INSERT]
    ACC --> SP{launch run<br/>attempts+1 first}
    SP -- launched --> SPN([spawn_state=spawned<br/>202 ack — run still executing])
    SP -- launch failed --> FAIL[spawn_state=failed]
    SPN --> EXIT{child exits}
    EXIT -- code 0 --> DONE([run finished — row stays spawned,<br/>run slot released])
    EXIT -- non-zero --> FAIL
    FAIL --> CAP{attempts < cap?}
    CAP -- yes --> RD[re-drive on next boot or sweep] --> SP
    CAP -- no --> ALERT([at-cap: surfaced for<br/>manual intervention])

    style SPN fill:#d4edda,stroke:#28a745
    style DONE fill:#d4edda,stroke:#28a745
    style REJ fill:#f8d7da,stroke:#dc3545
    style ALERT fill:#fff3cd,stroke:#ffc107
```

---

## 7. Example: `tiktok-shoppable-ideas` (linear, gated)

The dogfood flow (`examples/tiktok-shoppable-ideas/flow.yaml`): deterministic fetch →
one transform → one gate, reject loops back with feedback.

```mermaid
flowchart LR
    intake([intake]) --> F["fetch_context<br/>deterministic: duckdb -readonly<br/>request.json → context.json"]
    F --> I["ideate<br/>transform: gemini-flash-lite<br/>context.json + feedback → idea.json"]
    I --> V{"verify (gate, taste)<br/>critic: gpt-4o<br/>grounded + non-repeat?"}
    V -- approve --> done([done])
    V -. "reject → feedback<br/>rework_cap: 2<br/>progress_signal: findings_hash" .-> I
    V -- cap hit --> scrap([scrap])

    style done fill:#d4edda,stroke:#28a745
    style scrap fill:#f8d7da,stroke:#dc3545
```

Maker/inspector separation in miniature: the maker is a cheap fast model, the critic a
stronger one, different prompt — the check is the quality engine, not the worker.

---

## 8. Example: `branching` (fan-out → quorum fan-in → rank → HITL)

The Studio-style flow (`examples/branching/flow.yaml`): one brief becomes three variant
children; at least 2 must survive; a rank critic short-lists; a human picks in Slack.

```mermaid
flowchart TD
    intake([intake]) --> B["brief<br/>transform, fan_out: 3<br/>plan.json"]
    B -- FAN_OUT<br/>parent awaits children --> C1 & C2 & C3

    subgraph children [child cards — child_entry: draft, child_terminal: done]
      C1["draft₁ → publish₁"]
      C2["draft₂ → publish₂"]
      C3["draft₃ → publish₃"]
    end

    C1 --> A
    C2 --> A
    C3 --> A
    A{"assemble<br/>fan_in: quorum, k: 2<br/>(≥2 of 3 children non-scrap)"}
    A -- quorum met<br/>FAN_IN_MET --> RK["rank (taste)<br/>critic short-lists survivors"]
    A -- quorum impossible --> scrap([scrap])
    RK --> H{{"HITL: post short-list to #studio-hitl<br/>card held, hold_timeout: 30s"}}
    H -- human selects --> D[deliver] --> done([done])
    H -- "timeout, on_timeout: scrap<br/>(no_selection_policy: scrap)" --> scrap

    style done fill:#d4edda,stroke:#28a745
    style scrap fill:#f8d7da,stroke:#dc3545
    style H fill:#fff3cd,stroke:#ffc107
```

---

## 9. The tick — who decides what runs

The control loop that keeps LLMs out of orchestration (SPEC §8,
`src/controller/tick.ts`, `src/controller/executor.ts`). Deterministic flow,
non-deterministic labor.

```mermaid
flowchart TD
    T[tick: read state DB] --> AND{consumption andon tripped?<br/>wall-clock or token budget}
    AND -- yes, no active workers --> HALT([halt run — alert with overshoot])
    AND -- no --> LV{liveness watchdog:<br/>no lane change for N min<br/>AND no active worker?}
    LV -- yes --> HALT2([halt — stalled/deadlocked])
    LV -- no --> PLAN["compute action plan:<br/>promote waiting→ready where deps met,<br/>find dispatchable cards"]
    PLAN --> CLAIM{"atomic claim (single SQLite txn):<br/>status=ready AND lane is work station<br/>AND under WIP cap AND slot free"}
    CLAIM -- claimed --> EXEC[execute station<br/>worker runs, FSM routes the result]
    EXEC --> T
    CLAIM -- nothing dispatchable --> T

    style HALT fill:#f8d7da,stroke:#dc3545
    style HALT2 fill:#f8d7da,stroke:#dc3545
```

The two halt paths are deliberately different mechanisms: the andon catches a *busy*
runaway (spending without shipping); the watchdog catches a *silent* stall (nothing
spending, nothing moving). One cannot substitute for the other.
