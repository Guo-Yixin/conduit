# Changelog

All notable public changes to Conduit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows [Semantic Versioning](https://semver.org/).

Development notes from before the fresh public repository are preserved in the
[pre-public changelog](./docs/history/pre-public-changelog.md). They are
historical context, not public releases or public repository history.

## [Unreleased]

## [1.0.0] - 2026-08-27

### Added

- Released the deterministic Conduit kernel with explicit station transitions,
  quality gates, bounded rework, terminal outcomes, and durable journal state.
- Added deterministic, transformation, and harness-delegated stations with
  typed inputs and outputs, provider-independent OpenAI-compatible model calls,
  and per-call usage attribution.
- Added binding-stamped checkpoints, crash-safe resume, an idempotent outbox for
  side effects, and shared-database isolation across concurrent runs.
- Added deterministic fan-out/fan-in, bounded worker concurrency, ingress
  listeners, and durable Slack human-in-the-loop decisions.
- Added a non-root, multi-architecture Docker distribution for Linux amd64 and
  arm64, published at `ghcr.io/theaiteam-dev/conduit-engine`.
- Prepared the fresh open-source repository, community policies, public
  documentation, and repository metadata for the initial public release.
- Added a locally verified, model-free README quickstart and a decision guide
  comparing Conduit with Temporal, n8n, and LangGraph.

[Unreleased]: https://github.com/theaiteam-dev/conduit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/theaiteam-dev/conduit/releases/tag/v1.0.0
