# CI

## The Action

`agent-labs-dev/speedpatrol@v0` runs `speedpatrol compare --base origin/<base branch>` on a pull request and posts the table as one comment, which it updates on each push.

| Input | Default | |
| --- | --- | --- |
| `base` | the PR's base branch | the ref to compare against |
| `benchmarks` | all | ids or tags, space separated |
| `rounds` | config | A/B rounds |
| `iterations` | config | iterations per round |
| `fail-on-regression` | `false` | fail the job when a primary metric regressed |
| `comment` | `true` | post the table on the PR |
| `working-directory` | `.` | the folder that holds `.speedpatrol/` |
| `package` | `speedpatrol@latest` | the npm package to run |
| `node-version` | `22` | |

The checkout needs the base branch: use `fetch-depth: 0`. A `web` or `electron` benchmark needs Chromium; the Action installs it when the config has one.

Exit codes: 0 no regression, 1 regression (with `fail-on-regression`), 2 config error, 4 could not measure (the app did not start).

## Noise on shared runners

A hosted runner shares its CPU. Speedpatrol's defenses are the alternating rounds, outlier trimming, the double significance test and the thresholds; raise `rounds` to 3 or 4 on a hosted runner, or use a dedicated runner and `SPEEDPATROL_MACHINE` for tight intervals.
