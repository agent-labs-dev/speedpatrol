# Glossary

- **Benchmark**: one critical path and how to measure it (`kind`, target, iterations). Defined in `speedpatrol.yml` or `benchmarks.json`.
- **Probe**: the code that measures one benchmark kind.
- **Sample**: the metrics of one timed iteration.
- **Primary metric**: the metric that decides a benchmark's verdict.
- **Run**: every benchmark measured once against one checkout on one machine.
- **Baseline**: the run recorded for a clean commit on a machine.
- **Comparison**: the verdicts of every metric between two sides. `baseline` mode compares two runs; `ab` mode pools alternating rounds.
- **Verdict**: `regression`, `improvement`, `unchanged`, `noisy` or `missing`, decided by statistics only.
- **Regression**: a confirmed slowdown on the patrolled branch, with its analysis.
- **Experiment**: an optimizer's attempt at a speed-up, verified by an A/B comparison.
- **Patrol**: the loop that measures each new commit of the patrolled branch.
