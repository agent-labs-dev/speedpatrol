import type { Summary } from '@speedpatrol/core';

/** Linear interpolation between the closest ranks (type 7, as in R and NumPy). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  return low + (sorted[upper]! - low) * (position - lower);
}

export function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

export function summarize(values: readonly number[]): Summary {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, median: 0, p75: 0, p90: 0, p95: 0, p99: 0, stddev: 0, mad: 0, cv: 0 };
  }
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const mid = quantile(sorted, 0.5);
  // 1.4826 makes the MAD estimate stddev for normal data.
  const mad = 1.4826 * median(sorted.map((value) => Math.abs(value - mid)));
  return {
    n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean,
    median: mid,
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    stddev,
    mad,
    cv: mean === 0 ? 0 : stddev / Math.abs(mean),
  };
}

/**
 * Drops samples far outside the bulk (beyond 3 scaled MADs from the median),
 * which are almost always a GC pause or a scheduler hiccup on the runner, not
 * the code under test. It keeps at least half of the samples.
 */
export function trimOutliers(values: readonly number[]): number[] {
  if (values.length < 6) return [...values];
  const { median: mid, mad } = summarize(values);
  if (mad === 0) return [...values];
  const kept = values.filter((value) => Math.abs(value - mid) <= 3 * mad);
  return kept.length >= values.length / 2 ? kept : [...values];
}
