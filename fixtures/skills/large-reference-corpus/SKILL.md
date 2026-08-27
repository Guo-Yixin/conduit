---
name: large-reference-corpus
description: Negative fixture — combined body and references content exceeds the default 64 KiB skill_content_max_bytes cap. Used to prove the loader rejects oversized skill content at load time.
---

# Large Reference Corpus

This bundle exists solely to trip the size cap described in the Skill Ingest PRD §2.3: total
injected skill content (body + all `references/` files, concatenated) is capped at 64 KiB by
default (`defaults.skill_content_max_bytes`). Both files under `references/` are filler content
sized so that body + references together exceed that cap. Loading a station that declares
`worker.uses: [large-reference-corpus]` **shall** fail with a load-time validation error naming
this skill and the per-file sizes — it must never silently truncate or inject partial content.
