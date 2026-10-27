import type { Better, Summary, Unit } from './metrics.js';

/**
 * The verdict of one metric. Only statistics decide it (ADR 0001): a model
 * may explain a regression, but never makes or clears one.
 *
 * - `regression` / `improvement`: significant, and larger than both thresholds.
 * - `unchanged`: the difference is within the thresholds, or not significant
 *   while the samples are steady.
 * - `noisy`: not significant, and too variable to say that nothing changed.
 * - `missing`: one side has no samples.
 */
export type Verdict = 'regression' | 'improvement' | 'unchanged' | 'noisy' | 'missing';

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
  /** Mann-Whitney U, two-sided. */
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
  /** The run ids on each side. An A/B comparison pools several rounds. */
  base: { runs: string[]; sha: string; label: string };
  head: { runs: string[]; sha: string; label: string; dirty?: boolean };
  metrics: MetricComparison[];
  /** The worst verdict over the primary metrics. */
  verdict: Verdict;
  warnings: string[];
};
