---
name: minimal-notes
description: Take structured notes during a working session and summarize them at the end. Use when asked to "take notes", "jot this down", "keep track of decisions", or "summarize what we covered".
---

# Minimal Notes

Keep a running list of notes during the session and produce a short summary when asked.

## Workflow

1. As decisions, action items, or open questions come up, append a one-line note under the
   appropriate heading (`## Decisions`, `## Action Items`, `## Open Questions`).
2. Keep each note terse — a single sentence, not a paragraph.
3. When asked to summarize, collapse the running notes into a short recap grouped by heading,
   dropping anything that was later superseded.

## Format

```
## Decisions
- Use SQLite for local persistence.

## Action Items
- [ ] Wire up the migration script.

## Open Questions
- Do we need a background compaction job?
```

This bundle intentionally has no `references/` directory — it is the minimal-frontmatter case.
