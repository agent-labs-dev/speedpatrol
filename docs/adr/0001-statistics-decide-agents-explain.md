# ADR 0001 — Statistics decide, agents explain

**Status:** Accepted
**Date:** 2026-10-27

## Context

A performance tool that cries wolf is turned off within a week, and one that a persuasive model can talk out of a real regression is worse. Benchmarks are noisy: the same code measured twice differs, and a model reading two numbers will find a story for any difference.

## Decision

Only code decides a verdict. A metric is a `regression` or an `improvement` when a Mann-Whitney U test is significant at `alpha`, a seeded bootstrap interval of the median change excludes zero, and the change clears both the relative and the absolute threshold. A suspected regression on `main` is recorded only after a second, independent A/B measurement reproduces it. An optimizer's change is kept only when a code-run A/B shows the target improved past `minImprovement` with no regression on a critical path.

The agents never set or clear a verdict. The analyst explains a regression that statistics settled; the optimizer proposes a change that statistics judge. A human can dismiss a regression (`speedpatrol regressions dismiss`, or closing its issue).

## Consequences

A verdict is reproducible from the stored samples, on any machine, by anyone. The agents can be swapped, can be wrong, or can be off, and the verdicts do not change. The cost is a second measurement per suspected regression.
