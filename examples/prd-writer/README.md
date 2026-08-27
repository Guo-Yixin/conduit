# Example: prd-writer

Harness-maker + adversarial-critic pattern (the same `kind: harness` shape as
[`../research-flow.yaml`](../research-flow.yaml)), applied to a real
PRD-drafting workload instead of a one-line research question: draft a
product PRD from a brief, gate it behind a distinct adversarial critic role
before the card advances.

```
draft-prd ──(gate: adversarial-prd-critic)──→ done
    ▲                       │
    └──────(reject, rework_cap: 2)───┘
```

| Station | kind | does |
|---|---|---|
| `draft-prd` | harness (`claude-headless`, `claude-sonnet-5`) | reads `brief.md` + a sibling prior-art PRD, writes the PRD draft and a one-paragraph `result.json` summary |
| `draft-prd`'s gate | check (gate, `claude-haiku-4-5`) | a distinct adversarial critic role verifies structure/scope/honesty against an objective checklist; reject → rework (capped at 2) |

## Origin

This flow was originally built and run in the `arcane-flows` repo, where its first real run
doubled as smoke evidence for `conduit`'s harness-adapter work (engine-config adapter
registration; `claude-headless` subscription auth). It's been moved here as a standalone
Conduit example: unlike `research-flow.yaml`'s intentionally tiny, cheap Phase-1
exit-criterion case, `prd-writer` shows the same `kind: harness` maker+critic shape scaled to a
real, multi-page drafting task (a much larger token budget, and `sonnet` instead of `haiku` for
the maker).

## Files

| File | Role |
|---|---|
| `flow.yaml` | the flow definition (one `harness` station + inline adversarial gate) |
| `brief.md` | the PRD brief fed to the maker — what to draft, and what NOT to duplicate |
| `prompts/prd-writer.md` | the maker's prompt — draft the PRD, then write `result.json` |
| `prompts/prd-critic.md` | the gate critic's prompt — an objective pass/reject checklist |
| `result.example.json` | the `result.json` from a real run (see below) |

## Run it

```
conduit run examples/prd-writer/flow.yaml --input <your-seed>.json
```

`draft-prd` needs two inputs on disk before it can run: `brief.md` (committed) and a sibling
**prior-art PRD** at `reference-prd.md` — both `brief.md` and the two prompts point at it as the
existing spec whose structure/voice the new draft must match and whose scope it must NOT
duplicate. That prior-art PRD is a real product document from the source project and isn't
committed here (same idea as `tiktok-parallel-ideas`' uncommitted DuckDB fixture — bring your own
data). Point `reference-prd.md` at a PRD of your own (or trim `brief.md` and the two prompts down
to drop the reference) to run this for real. Until then, `result.example.json` below is the
evidence of what a real run produces.

## What the sample output shows

`result.example.json` is the `result.json` from a real `claude-headless` run: the maker drafted a
full PRD for a second product-creation flow, sibling to an existing "v1" flow that only adds
variants to existing products. It stayed decision-complete on architecture, scope boundaries
versus v1, and safety defaults (e.g. draft-not-active on create), while leaving several genuinely
open questions in the PRD's own §10 rather than inventing resolutions — exactly what
`prompts/prd-critic.md`'s checklist item 4 ("no invented decisions") gates on. The critic's full
checklist (house structure present, no scope duplication, product-vs-variant draft-status handled
correctly, no invented decisions, measurable goals) is what `flow.yaml`'s gate enforces before the
card advances to `done`.

## Notes

- Same idiom as `research-flow.yaml`: **one** adapter (`claude-headless`) plays both the maker and
  the critic — "adversarial" is the critic's distinct role/prompt/model, not a second adapter.
- The critic runs the cheap/fast `claude-haiku-4-5-20251001` against the maker's stronger, slower
  `claude-sonnet-5` — a deliberately asymmetric maker/critic pair.
- `max_tokens: 2500000` is sized for real multi-page PRD drafting on top of `claude-headless`'s own
  large fixed per-invocation overhead (see `research-flow.yaml`'s comment for why headless
  invocations need much bigger budgets than a bare chat call), across up to 3 maker + 3 critic real
  invocations (`rework_cap: 2` = 1 initial attempt + 2 reworks).
