---
missionId: ~
---

# Skill Ingest — zero-dialect `SKILL.md` consumption + `worker.uses:`

**Author:** Josh Owens  **Date:** 2026-07-02  **Status:** Done

> Scope note: this is **Phase 1 of the Skill Library**
> ([`../drafts/skill-library.md`](../drafts/skill-library.md)), split out per the 2026-07-02
> requirements-critic review. It is deliberately **local and network-free**: parse standard Claude
> Code `SKILL.md` bundles from a directory next to the flow, let stations adopt them via
> `worker.uses:`, and keep the binding stamp honest. Fetching/vendoring, the lockfile, `conduit
> skills audit`, and `skill-eval` integration are later phases and remain in the parent draft.

## 0. The one non-negotiable — Zero-dialect

**A Conduit skill IS a Claude Code skill.** Conduit shall not add, require, or redefine any
`SKILL.md` frontmatter field, and shall not require any file inside the bundle that Anthropic's spec
does not define. All Conduit-specific configuration lives in `flow.yaml`. (Inherited verbatim from
the parent PRD §0; release-blocking here too.)

## 1. Context

Prompts are referenced per-station (`worker.prompt_file` + `prompt_version`, resolved at load in
`src/flow/load.ts`) with no reuse — `fixtures/flows/aiteam.flow.yaml` repeats the same
`prompt_file`/`output_schema` across seven stations. Meanwhile a large ecosystem of authored Claude
Code skills already exists. This phase makes a flow able to consume one — from local disk — and
de-duplicates prompt authorship, while proving the zero-dialect guarantee against a real corpus.

Trust posture for this phase: **local skills are the author's own files**, same trust level as
`prompt_file` today. The hostile-import surface only opens when fetching arrives (Phase 3), which is
why `audit` (Phase 2) ships before it.

## 2. Design decisions (resolved 2026-07-02)

These were the open forks the critic flagged; they are decided and are **requirements**, not
suggestions:

1. **Schema home:** the skill reference is a **list under the worker block** —
   `worker.uses: [stop-slop, house-style]` — resolved in declared order. It does **not** collide
   with the existing channel-level `uses:` (`src/flow/load.ts` channel schema), which is untouched.
2. **Composition:** a station may declare both `worker.uses:` and a local prompt
   (`prompt_file`/inline). The injected instruction content is: skill contents in `uses:` order,
   **then** the station's local prompt last, as the station-local override layer. All other
   `StationConfig` fields (`output_schema`, `model`, …) come only from the station — a skill
   populates instruction content, nothing else (shallow, one-level, station-wins).
3. **`references/` loading:** **eager-concat with a size cap.** A transform station has no tools, so
   progressive disclosure is impossible; all files under the bundle's `references/` are concatenated
   after the body (lexicographic filename order, each preceded by a `--- references/<name> ---`
   delimiter line). Total injected skill content per station (bodies + references, all skills) is
   capped at **64 KiB** by default, overridable via `defaults.skill_content_max_bytes`. Exceeding
   the cap is a **load-time validation error** naming the skill and per-file sizes.
4. **`description` is catalog metadata, not prompt content.** Matching Claude Code semantics
   (description is the discovery trigger), only the **body + references** are injected. `name` is
   used for lookup; `description` is surfaced by tooling (`conduit explain`, future `skills list`),
   never injected. This also keeps it out of the Phase 2 audit's injection surface.

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| 100% **load** compatibility | Valid Claude Code skills in the compat corpus that parse + inject their instruction content | 100% |
| Zero dialect | Frontmatter fields or in-bundle files Conduit requires beyond the Claude Code spec | 0 |
| Consume all, execute none | Bundled scripts/tool-grants/hooks executed or honored | 0 |
| DRY | A prompt reused across N stations authored in more than one place | 1 place |
| Replay-safe | Skill content edits that fail to invalidate dependent checkpoints | 0 |

"100% compatibility" is deliberately scoped to **loading**: execution-oriented skill features
(scripts, `allowed-tools`, hooks, `` !`command` ``) are inert in data-only mode and their limits are
documented and surfaced, per the parent PRD.

## 4. Scope

### In Scope

- **Verbatim `SKILL.md` bundle parsing.** Frontmatter + body + `references/`. Unknown and
  execution-oriented frontmatter fields are read and preserved, never honored, never required.
- **Local skill resolution.** Skills live in a directory of bundles: `<skills_dir>/<name>/SKILL.md`,
  where `skills_dir` defaults to `skills/` next to `flow.yaml` and is overridable via
  `defaults.skills_dir`. Lookup is by directory name; if frontmatter `name` is present and
  mismatches the directory name, that is a load-time validation error.
- **`worker.uses:` + composition** per §2.1–§2.2, resolved at load into the same fully-resolved
  `StationConfig` the kernel already consumes. **The kernel is unchanged** — the loader gains a
  merge step, exactly like today's `prompt_file` resolution.
- **Binding-stamp correctness.** For a `uses:` station, the stamp's `prompt_template_version` input
  becomes `hash(declared prompt_version ?? '', sha256(skill_1 injected content), …, in uses: order)`
  — the content hash **combines with** (does not replace) `prompt_version`. Editing a skill file
  changes the stamp and cascades checkpoint invalidation via the existing `cascadeInvalidation`
  machinery; an unchanged skill preserves skip-on-resume.
- **Load-time validation & path safety.** Malformed frontmatter, missing bundle, `references/`
  entries escaping the bundle directory (path traversal or symlink, symlink-resolved), and cap
  violations are load errors — "config is validated, not trusted" extends to skill bundles.
- **The compat corpus** as a first-class deliverable: checked-in fixtures under `fixtures/skills/`
  covering at minimum — (a) minimal frontmatter+body; (b) a bundle with `references/`; (c) a bundle
  with `scripts/` + `allowed-tools` (proves inert-and-surfaced); (d) a bundle with `` !`command` ``
  blocks (proves not evaluated); (e) unicode/formatting oddities; (f) one real published Claude Code
  skill vendored verbatim; (g) a negative fixture exceeding the size cap; (h) a negative fixture
  with a `references/` symlink escape.

### Out of Scope (this phase)

- **Network anything** — no fetch, no sources, no lockfile, no vendoring (Phase 3).
- **`conduit skills audit`** — the hostile-first gate (Phase 2). In this phase, execution surface in
  a bundle produces a structured **load-time warning** (surfaced, never silent); the
  `pass`/`flag`/`deny` verdict machinery is Phase 2.
- **`skill-eval` integration** (Phase 4), agentic-skill Law grants, registry/discovery UX, authoring
  tooling.

## 5. Requirements

### Functional

1. Conduit **shall** parse any valid Claude Code `SKILL.md` bundle and inject its instruction
   content (body, then `references/` per §2.3) without requiring any Conduit-specific frontmatter
   field or in-bundle file. `description` **shall not** be injected (§2.4).
2. A station **shall** reference skills via `worker.uses:` (a list); the loader **shall** resolve
   them from `skills_dir` in declared order and compose with the local prompt per §2.2, producing
   the same fully-resolved `StationConfig` shape the kernel consumes today.
3. The channel-level `uses:` keyword **shall** be unaffected; a flow using both **shall** load
   without ambiguity.
4. The binding stamp for a `uses:` station **shall** incorporate the SHA-256 of each injected
   skill's content combined with the declared `prompt_version` (§4, stamp bullet). ACs: (a) editing
   a skill body or reference file → dependent stations' checkpoints invalidate and cascade on
   resume; (b) no edit → skip-on-resume preserved; (c) a station not using the skill is unaffected.
5. Total injected skill content per station **shall** be capped (default 64 KiB,
   `defaults.skill_content_max_bytes`); violations are load-time errors naming skill and sizes.
6. Bundles **shall** be validated at load: well-formed frontmatter; directory/frontmatter `name`
   agreement; `references/` confined to the bundle directory after symlink resolution. Violations
   are load errors.
7. Execution surface in a bundle (`scripts/`, `allowed-tools`, `hooks`, `` !`command` `` blocks)
   **shall not** be executed, honored, or evaluated; its presence **shall** produce a structured
   load-time warning identifying the skill and the inert surface.
8. `uses:` on a non-LLM (`deterministic`) station **shall** be a load-time validation error — skills
   are instruction content; a station with no prompt has nowhere to put them.

### Non-Functional

1. **Zero-dialect (release-blocking):** any change requiring a Conduit-specific `SKILL.md` field, or
   failing to load an otherwise-valid Claude Code skill in the compat corpus, blocks release.
2. **Deterministic:** identical bundle bytes → identical injected content → identical stamps, across
   machines and runs (no timestamps, no locale-dependent ordering).
3. **Kernel untouched:** all changes live in the loader (`src/flow/load.ts`) and stamp-input
   computation; the executor's dispatch/claim/FSM paths are unchanged.

### Edge Cases

- Two skills in `uses:` whose bodies conflict → later content (and finally the local prompt) is the
  override layer by position; no merging logic, no error — composition is by concatenation order.
- A skill directory without `SKILL.md` → load error (missing bundle), not silent skip.
- Empty `references/` or none → body-only injection, no delimiter emitted.
- Duplicate skill name in `uses:` list → load-time validation error (no double-injection).
- `skills_dir` missing but no station declares `uses:` → not an error (feature dormant).

## 6. Solution Approach

The loader (`src/flow/load.ts`) gains a resolution step beside the existing `prompt_file` handling:
resolve each `worker.uses:` entry to `<skills_dir>/<name>/SKILL.md`, parse frontmatter, strip it,
concatenate body + capped `references/`, validate path safety, and prepend the result to the
station's local prompt in the resolved `StationConfig`. The stamp-input computation
(`src/controller/executor.ts` / `src/checkpoint/checkpoint.ts`, which today read
`stationConfig.prompt_version`) reads the combined `prompt_version` + skill-content hashes instead
for `uses:` stations. Everything downstream — claim, dispatch, transform worker, checkpoint
skip/cascade — is unchanged and unaware skills exist.

## 7. Risks

| Risk | Mitigation |
|------|-----------|
| Zero-dialect drift (we "just add one field") | NFR-1 release-blocking; compat corpus incl. a verbatim real skill |
| Eager-concat context bloat degrades transform quality | 64 KiB default cap, per-file size reporting, overridable knob |
| Stamp wiring subtly wrong → stale checkpoint replay | FR-4's three ACs are the contract; reuse existing cascade tests as the template |
| Local-only phase misread as the trust story | §1 trust-posture note; audit (Phase 2) ships before any fetching (Phase 3) |

## 8. Dependencies

- `src/flow/load.ts` prompt resolution seam (shipped).
- Binding stamp + `cascadeInvalidation` (shipped, [SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)).
- Parent PRD: [`../drafts/skill-library.md`](../drafts/skill-library.md) (Phases 2–4).
