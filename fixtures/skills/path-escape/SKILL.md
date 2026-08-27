---
name: path-escape
description: Negative fixture — a references/ entry that is a symlink resolving outside the bundle directory. Used to prove the loader's path-safety check rejects symlink escapes at load time.
---

# Path Escape

This bundle exists solely to trip the path-safety check described in the Skill Ingest PRD §5 FR-6:
`references/` entries must be confined to the bundle directory after symlink resolution.
`references/escaped-note.md` in this bundle is a real, git-tracked symlink whose target resolves
outside `fixtures/skills/path-escape/`. Loading a station that declares
`worker.uses: [path-escape]` **shall** fail with a load-time validation error identifying the
escaping path — it must never be silently followed or skipped.
