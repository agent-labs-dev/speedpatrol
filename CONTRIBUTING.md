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
