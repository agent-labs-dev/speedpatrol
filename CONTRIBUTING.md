# Contributing

```bash
pnpm install
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright@1.64.1 install chromium   # the probe and agent tests use a real browser
pnpm build
pnpm test
pnpm check
pnpm knip
```

- Commits and PR titles follow Conventional Commits.
- A verdict is code (ADR 0001): a change to `packages/stats` comes with a row in its table test.
- Tests run real processes against `examples/fixture-app`; no test may call a real model (`vitest.config.ts` blanks the keys).

## Releases

A maintainer runs the **Release** workflow in GitHub Actions and selects `patch`, `minor`, or `major`. The workflow tests the repo, bumps `packages/speedpatrol/package.json`, publishes `speedpatrol` to npm with provenance, and pushes a tag and a GitHub release. On the release tag, the `package` input of `action.yml` defaults to the new version. The workflow also moves the major tag, for example `v0`, to the release, so workflows that use `agent-labs-dev/speedpatrol@v0` get it with no edit. The internal `@speedpatrol/*` packages are private. The bundle includes them.
