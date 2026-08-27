---
name: changelog-entry
description: Draft a changelog entry from the current diff. Use when asked to write a changelog line, release note, or "what changed" summary.
---

# Changelog Entry

Write one changelog line per user-visible change, in the imperative mood ("Add", "Fix", "Remove"),
past-tense project style is not used here.

## Reference the last commit subject

A tool-enabled Claude Code session can pull the latest commit subject inline before drafting:

    Last commit subject: !`git log -1 --pretty=%s`

That `` !`command` `` form is Claude Code's inline bash-execution syntax. A data-only bundle
consumer (such as a Conduit `transform` station, which has no tools and no loop) must treat the
line above as inert prompt text — read verbatim, never shelled out to, never evaluated.

## Format

- One bullet per change.
- Group under `### Added`, `### Fixed`, `### Changed`, `### Removed` as needed.
- Omit empty groups.
