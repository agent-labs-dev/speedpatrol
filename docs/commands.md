# Commands

| Command | What it does |
| --- | --- |
| `speedpatrol` | The patrol: measure each new commit on `origin/main`, confirm and explain regressions, try speed-ups, publish |
| `speedpatrol init` | Create `.speedpatrol/` with a config for this repo. `--agent claude \| codex \| opencode` |
| `speedpatrol run [ids\|tags...]` | Measure this checkout, record the baseline, and compare with the previous baseline |
| `speedpatrol compare [ids\|tags...]` | Do an A/B measurement of two checkouts on this machine |
| `speedpatrol scout` | The scout finds critical paths and writes benchmarks. `--focus "<text>"` |
| `speedpatrol analyze [id]` | The analyst explains the open regressions |
| `speedpatrol optimize [benchmark]` | The optimizer tries a speed-up in a worktree. Then an A/B run verifies it |
| `speedpatrol publish` | Open issues for regressions and PRs for verified speed-ups. `--dry-run` |
| `speedpatrol dashboard` | Serve the [dashboard](dashboard.md). `--port N` (default 4321) |
| `speedpatrol baselines` | List the recorded baselines |
| `speedpatrol regressions` | List the regressions. `regressions dismiss <id> --reason "..."` |
| `speedpatrol doctor` | Check the config, git, Chromium, and the agent CLIs |

`speedpatrol --help` shows each option. Exit codes: 0 ok, 1 regression, 2 config error, 4 could not measure.

## The patrol

```bash
npx speedpatrol
```

- Every 30 minutes, the patrol fetches `origin/main`. It measures only a commit that it did not measure before. On the same commit, it still finishes the open work: analysis, experiments, and publish.
- The patrol measures `main` in a detached worktree under `.speedpatrol/runs/checkouts/`. So it never changes the checkout where you work.
- When there are no benchmarks yet, the first cycle runs the scout.
- `npx speedpatrol --once` runs one cycle.
- `--force` measures the same commit again.
- `--no-optimize` skips the optimizer for that run. Then `speedpatrol optimize` can run as a separate step.

[How it works](how-it-works.md#the-patrol-cycle) tells each step of the cycle.

## Two ways to compare

**Against the baseline.** `speedpatrol run` measures this checkout. When the tree is clean, it records the run as the baseline of its commit. Then it compares the run with the newest baseline of a different commit on this machine. Each patrol cycle does this for `main`, so the baselines make a history that the dashboard shows as a chart.

**A/B, for a change.** `speedpatrol compare` measures two checkouts on the same machine, in alternating rounds (A B, B A, ...). If the machine changes during the comparison, the change affects the two sides equally. Use it for a branch, a PR, or a speed-up that you try in a worktree:

```bash
speedpatrol compare                           # this working tree (with uncommitted changes) vs origin/main
speedpatrol compare --head ../my-worktree     # a worktree vs origin/main
speedpatrol compare --base v1.4.0 --head main # two refs
speedpatrol compare api.orders web.inbox      # only some benchmarks (ids or tags)
```

`compare` prints a table. It exits with code 1 when a primary metric regressed:

```
🔴 regression: `working tree` (a41c09d2) against `origin/main` (3f9a1c2e)

| Verdict        | Benchmark   | Metric   | Base (median) | Head (median) | Change | 95% CI           | p      |
| 🔴 regression  | api.orders  | total_ms | 41.2 ms       | 57.9 ms       | +40.5% | +35.1% to +46.0% | <0.001 |
| ⚪ unchanged   | web.inbox   | lcp_ms   | 812.0 ms      | 806.5 ms      | -0.7%  | -2.9% to +1.4%   | 0.512  |
```
