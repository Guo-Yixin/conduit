---
name: repo-triage
description: Triage incoming repository issues by severity and category. Use when asked to triage, categorize, or prioritize a batch of issues.
allowed-tools: Bash(scripts/triage.sh:*)
---

# Repo Triage

Categorize each issue into one of `bug`, `feature`, `question`, or `chore`, and assign a severity
of `p0`–`p3` based on user impact and blast radius.

## Helper script

`scripts/triage.sh` prints a starter checklist for a triage pass. It is bundled for a Claude Code
agent's own use in a tool-enabled session — a data-only consumer (such as a Conduit `transform`
station) reads this bundle for its frontmatter and body text only and never executes anything under
`scripts/`.

## Severity rubric

- `p0` — data loss, security, or a hard crash affecting all users.
- `p1` — a major feature broken for a large fraction of users, no workaround.
- `p2` — a real bug with a workaround, or a moderate-impact feature gap.
- `p3` — cosmetic, edge-case, or a "nice to have" request.
