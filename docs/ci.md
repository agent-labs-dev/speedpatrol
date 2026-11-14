# CI

## The Action

`agent-labs-dev/speedpatrol@v0` runs `speedpatrol compare --base origin/<base branch>` on a pull request and posts the table as one comment, which it updates on each push.

```yaml
# .github/workflows/speedpatrol.yml
name: Speedpatrol
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  compare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: agent-labs-dev/speedpatrol@v0
        with:
          fail-on-regression: true
```

| Input | Default | |
| --- | --- | --- |
| `base` | the PR's base branch | the ref to compare against |
| `benchmarks` | all | ids or tags, space separated |
| `rounds` | config | A/B rounds |
| `iterations` | config | iterations per round |
| `fail-on-regression` | `false` | fail the job when a primary metric regressed |
| `accept-label` | `speedpatrol: accept` | a PR label that accepts a regression as an intended cost; empty turns it off |
| `comment` | `true` | post the table on the PR |
| `working-directory` | `.` | the folder that holds `.speedpatrol/` |
| `package` | `speedpatrol@latest` | the npm package to run |
| `node-version` | `22` | |

The checkout needs the base branch: use `fetch-depth: 0`. A `web` or `electron` benchmark needs Chromium; the Action installs it when the config has one.

Some regressions are the cost of the change itself: a suite timed as a whole gets slower when a pull request adds tests. Add the `accept-label` label to that pull request and re-run the job. The table and its comment still show the regression, marked as accepted, and the job passes. The label is read when the job runs, so a re-run after labelling is enough; to re-run it automatically, list `labeled` with the default types: `types: [opened, synchronize, reopened, labeled]` (naming any types replaces the defaults).

The `accept-label` input and the label check are on `main`, and ship in the first release after 0.3.0, when the `v0` tag moves to it. Today `@v0` points at 0.3.0, whose Action has no `accept-label` input: GitHub warns that the input is unexpected and ignores it, the label changes nothing, and with `fail-on-regression: true` a labelled regression still fails the job. The check lives in the Action itself, so the `package` input cannot bring it to `@v0`. To use the label before that release, pin the Action to a commit on `main` instead of `@v0`.

To run the same comparison on your machine, use `speedpatrol compare --pr <number>`.

Exit codes: 0 no regression, 1 regression (with `fail-on-regression`), 2 config error, 4 could not measure (the app did not start, a critical benchmark had no primary samples, or every benchmark failed).

## Noise on shared runners

Hosted runners share their machines with other jobs. The A/B rounds and the confirmation keep false alarms rare, but a dedicated runner gives smaller intervals.

A hosted runner shares its CPU. Speedpatrol's defenses are the alternating rounds, outlier trimming, the double significance test and the thresholds; raise `rounds` to 3 or 4 on a hosted runner, or use a dedicated runner and `SPEEDPATROL_MACHINE` for tight intervals.
