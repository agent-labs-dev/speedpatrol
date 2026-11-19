# Speedpatrol

A performance team of agents: it measures an app's critical paths on each commit, keeps a baseline, finds regressions
with statistics, explains them and proposes speed-ups it measured itself. A pnpm workspace of `packages/*` and `examples/*`, each
package a deep module. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code and use the terms in
[GLOSSARY.md](GLOSSARY.md); [docs/adr/](docs/adr/) records settled decisions.

## Commands

- `pnpm install --frozen-lockfile`, then `pnpm gate`: biome, build, knip and the tests.
- `pnpm gate:changed`: the same, linting only files changed against `origin/main` and running the tests of every changed package and its dependents (all tests for a change outside `packages/` other than documentation and workflows).
- The probe and agent tests drive a real Chromium: `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright@1.65.1 install chromium`.
- Tests need `pnpm build` first (packages resolve each other through `dist/`); both gates build.
- Release: raise `version` in `packages/speedpatrol/package.json` in a PR; see `CONTRIBUTING.md`.

## Invariants

- A verdict is code, never a model's call (ADR 0001): statistics in `packages/stats` decide, and a change there comes
  with a row in its table test.
- Tests run real processes against `examples/fixture-app`; no test calls a real model (`vitest.config.ts` blanks keys).

## Standards

- `repo-standards`: the RS-* requirements every cjber and agent-labs-dev repo meets; its `audit.py` checks this repo.
