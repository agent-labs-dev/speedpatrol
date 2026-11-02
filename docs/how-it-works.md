# How it works

## The measurement protocol

A **run** measures a set of benchmarks against one checkout on one machine:

1. `app.prepare` runs once in the checkout (install, build). It is never timed.
2. `app.setup` brings the app up. A background command waits for `readyWhen` (a regex on its output) or `readyUrl` (a URL that answers). `capture` reads values from the output, e.g. a port, for `${NAME}` in later commands and benchmarks. Every command gets `SPEEDPATROL_SOURCE`, the checkout it runs from, so the same config starts the app from `main`, from a PR, or from an experiment's worktree.
3. For each benchmark: `warmup` iterations that are thrown away, then `iterations` timed ones, then one profiled iteration that is not timed.
4. `app.teardown` runs, and every background process group is stopped.

The run is saved under `.speedpatrol/runs/runs/<id>.json` with the machine fingerprint, the commit, and every sample. A run of a clean commit is recorded as that commit's **baseline**.

An iteration that fails is recorded with its error and has no metrics. Three failures in a row with no success stop the benchmark: it is broken, not slow.

## The statistics

For each metric, Speedpatrol compares the samples of two sides (ADR 0001):

- Outliers beyond three scaled MADs from the median are dropped (a GC pause or a scheduler hiccup on the runner), keeping at least half of the samples.
- The **change** is the relative change of the median.
- A **Mann-Whitney U** test (two-sided, tie and continuity corrected) asks whether the two sides differ. It is rank-based, so it assumes nothing about the shape of the distribution: latencies are skewed.
- A seeded **bootstrap** (2000 resamples) gives a 95% interval of the change of the median. The seed makes the same samples give the same interval on every machine.

| Verdict | When |
| --- | --- |
| `regression` / `improvement` | p < `alpha` **and** the interval excludes 0 **and** the change clears `relative` **and** `absolute` |
| `noisy` | Not significant, the change is large, and the samples vary more than `maxCv`: measure more |
| `unchanged` | Anything else |
| `missing` | One side has no samples |

A comparison's verdict is the worst verdict of its benchmarks' primary metrics. Secondary metrics are reported and charted, but do not decide.

With the defaults (`alpha: 0.01`), each side needs about 8 samples before a difference can be significant at all; the default is 15.

## Baselines and machines

Timings belong to the machine that measured them (ADR 0002). A run carries a fingerprint of the CPU model, the core count, the memory, the OS and the Node major. A comparison with a baseline uses only baselines with the same fingerprint, and a comparison of runs from different machines carries a warning. Set `SPEEDPATROL_MACHINE` to share one fingerprint across a fleet of identical runners.

For the same reason, `runs/` is never committed. The definitions that produce the data are: `speedpatrol.yml`, `instructions.md` and `benchmarks.json`.

## A/B comparisons

Two checkouts measured one after the other can differ because the machine changed between them (another process, the CPU's temperature, a cache). An A/B comparison alternates the sides in rounds — A B, then B A, then A B — and pools the samples of each side (ADR 0004). `defaults.rounds` sets the count (2 by default).

## The patrol cycle

1. **Scout** when there are no benchmarks.
2. **Measure** `agents.patrol.pull` (default `origin/main`) when it moved since the last cycle, in a detached worktree; record the baseline. The benchmarks and the setup are read from that commit, so a benchmark change lands with the code it needs.
3. **Compare** with the newest baseline of another commit on this machine.
4. **Confirm** every benchmark whose primary metric regressed with an A/B comparison of the last good commit and this one. Only a regression that the second measurement reproduces is recorded. One open regression per benchmark and metric.
5. **Fixed**: an open regression whose metric is back within the thresholds of its good baseline is closed.
6. **Explain** each new regression with the analyst. With the analyst off, the regression is filed with the numbers alone.
7. **Speed up** with the optimizer, if it is on: `maxPerCycle` targets, critical benchmarks first, then the least-tried ones.
8. **Sync** GitHub (a closed issue dismisses or fixes its regression) and **publish**.

## The optimizer's verification

The optimizer edits code in a new worktree on the branch `speedpatrol/speedup-<benchmark>-<id>`. It can measure its own change while it works. When it finishes, Speedpatrol commits the change and runs the verification, which is all code: an A/B comparison of the base commit and the worktree, on the target and every critical benchmark, with the full iterations and rounds. The experiment is `improved` only when the target's primary metric improved by at least `minImprovement` and no other benchmark's primary metric regressed. Otherwise the worktree and the branch are deleted.
