# Contributing to Conduit

Thanks for helping improve Conduit. Bug reports, focused feature proposals,
documentation fixes, and tests are welcome.

## Development setup

Conduit uses [Bun](https://bun.sh/) and TypeScript.

```bash
git clone https://github.com/theaiteam-dev/conduit
cd conduit
bun install
bun test src/ --pass-with-no-tests
bun run typecheck
```

Copy `.env.example` to `.env` only when a test or example needs a real model
gateway. Never commit credentials, runtime databases, journals, or generated
flow artifacts.

## Making a change

1. Open an issue for substantial behavior or design changes.
2. Keep pull requests focused and explain the user-visible effect.
3. Add or update tests for behavioral changes.
4. Run `bun test src/ --pass-with-no-tests` and `bun run typecheck`.
5. Run `bun run test:blackbox` when changing CLI, ingress, persistence, or
   process-boundary behavior.
6. Update documentation and `CHANGELOG.md` when behavior changes.

By contributing, you agree that your contribution may be distributed under the
MIT License.
