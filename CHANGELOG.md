# Changelog

## [Unreleased]

### Fixed

- A run fails, with exit code 4, when a background setup command's `readyUrl` already answers before the command starts, or when a background setup process exits during the run, instead of measuring whatever else serves that port. A `startup` benchmark whose ready URL already answers fails its sample instead of timing the other process (#62).
- The end-to-end regression test runs enough A/B rounds to keep its verdict when one round disagrees, keeps its cache under the temp directory, and stops the fixture app's processes when a test fails (#61).

## [0.4.0] - 2026-11-16

### Added

- The Action takes an `accept-label` input, default `speedpatrol: accept`. A pull request with that label passes when its only verdict is an intended regression, and the table marks the regression as accepted (#51).

### Changed

- A/B comparisons use one trimmed median per paired round, an exact paired sign test and a paired bootstrap, so repeated iterations in one machine state no longer count as independent evidence. The default is now eight rounds, the fewest that can reach the default alpha of 0.01 (#55).
- Runtime dependencies: Playwright 1.65.1 (reinstall Chromium with `npx -y playwright@1.65.1 install chromium`), zod 4, yaml 2.9 and the MCP SDK 1.32.
- CI pins runner images, cancels superseded pull request runs, validates workflows, and scans repository history for secrets.

### Fixed

- Profile failure logs redact captured credentials and configured secrets, as measurement errors already did (#43).
- App commands no longer inherit `npm_config_user_agent` from the launcher, so a Bun command run under `npx speedpatrol` identifies itself correctly (#44).
- Optimizer commits follow the repository's Git signing configuration instead of forcing unsigned commits (#47).
- Displayed base and head medians come from the same outlier-trimmed samples as the reported change, so they agree (#49).
- The optimizer rejects candidates that change tracked files during preparation, leave scratch files, or touch paths outside the measured boundary, and re-checks them in a fresh checkout of the committed candidate (#50).
- A comment that a fork's read-only token cannot post no longer fails the job: the table stays in the job summary with a warning. `init` no longer invents an app type without a `package.json` (#52).
- The npm package ships the README (#53).
