import type { Better, Summary, Unit } from './metrics.js';

/**
 * The verdict of one metric. Only statistics decide it (ADR 0001): a model
 * may explain a regression, but never makes or clears one.
 *
 * - `regression` / `improvement`: significant, and larger than both thresholds.
 * - `unchanged`: the difference is within the thresholds, or not significant
 *   while the samples are steady.
 * - `noisy`: a large change that is not significant, because the samples are
 *   too variable or too few for the test to reach alpha.
 * - `not_comparable`: the benchmark definition or its harness/script files
 *   changed between base and head, so whole-run timings are not like for like.
 * - `missing`: one side has no samples.
 */
export type Verdict = 'regression' | 'improvement' | 'unchanged' | 'noisy' | 'not_comparable' | 'missing';

export type MetricComparison = {
  benchmark: string;
  metric: string;
  unit: Unit;
  better: Better;
  primary: boolean;
  critical: boolean;
  base?: Summary;
  head?: Summary;
  /** head median / base median - 1. Positive is slower for a `lower` metric. */
  deltaPct: number;
  deltaAbs: number;
  /** Bootstrap confidence interval of `deltaPct`. */
  ci: [number, number];
  /** Two-sided Mann-Whitney U for baselines, exact paired sign test for A/B rounds. */
  pValue: number;
  verdict: Verdict;
  /** Set on an `unchanged` metric whose change was significant but smaller than a threshold. */
  underThreshold?: boolean;
};

export type ComparisonMode = 'baseline' | 'ab';

export type Comparison = {
  id: string;
  createdAt: string;
  mode: ComparisonMode;
  /** The run ids on each side. A/B inference uses one median per paired round. */
  base: { runs: string[]; sha: string; label: string };
  head: { runs: string[]; sha: string; label: string; dirty?: boolean };
  metrics: MetricComparison[];
  /** The worst verdict over the primary metrics. */
  verdict: Verdict;
  warnings: string[];
};
