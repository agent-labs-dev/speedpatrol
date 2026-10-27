/**
 * Which way is good for a metric. A latency is better when it is lower; a
 * throughput is better when it is higher. The verdict of a comparison reads
 * this, so a metric without a direction cannot be compared.
 */
export type Better = 'lower' | 'higher';

export type Unit = 'ms' | 'bytes' | 'kb' | 'mb' | 'count' | 'score' | 'rps' | 'percent';

/** Order statistics of one metric over the samples of one run. */
export type Summary = {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  stddev: number;
  /** Median absolute deviation, scaled to be comparable with stddev. */
  mad: number;
  /** Coefficient of variation (stddev / mean). How noisy the metric is. */
  cv: number;
};

/** All samples of one metric in one run, and their summary. */
export type MetricSeries = {
  unit: Unit;
  better: Better;
  values: number[];
  summary: Summary;
};

/** One measured iteration: every metric the probe read, by name. */
export type Sample = {
  iteration: number;
  metrics: Record<string, number>;
  /** Set when the iteration failed. A failed iteration has no metrics. */
  error?: string;
};

/** What a probe declares about each metric it reports. */
export type MetricSpec = { unit: Unit; better: Better };
