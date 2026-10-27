import { thresholdsSchema } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { compareSamples, worstVerdict } from './compare.js';
import { quantile, summarize, trimOutliers } from './summary.js';
import { bootstrapDelta, mannWhitney, mulberry32 } from './tests.js';

const thresholds = thresholdsSchema.parse({});

/** Latency-like samples: a floor plus a skewed tail, seeded. */
function latencies(median: number, spread: number, n: number, seed: number): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: n }, () => median + spread * (random() + random() - 1) + spread * random() ** 4);
}

describe('summarize', () => {
  it('matches type-7 quantiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.5)).toBe(5.5);
    expect(quantile(sorted, 0.9)).toBeCloseTo(9.1);
    const summary = summarize([3, 1, 2]);
    expect(summary).toMatchObject({ n: 3, min: 1, max: 3, median: 2, mean: 2 });
    expect(summary.stddev).toBeCloseTo(1);
  });

  it('drops a GC-pause outlier but keeps the bulk', () => {
    const values = [10, 10.2, 9.9, 10.1, 10, 9.8, 10.3, 250];
    expect(trimOutliers(values)).not.toContain(250);
    expect(trimOutliers(values)).toHaveLength(7);
  });
});

describe('mannWhitney', () => {
  it('agrees with scipy (asymptotic, continuity correction)', () => {
    // scipy.stats.mannwhitneyu([1..5], [6..10], method='asymptotic') -> p = 0.01219
    expect(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).p).toBeCloseTo(0.01219, 4);
    expect(mannWhitney([1, 2, 3], [1, 2, 3]).p).toBe(1);
  });
});

describe('bootstrapDelta', () => {
  it('is deterministic for the same samples', () => {
    const base = latencies(100, 5, 20, 1);
    const head = latencies(120, 5, 20, 2);
    expect(bootstrapDelta(base, head)).toEqual(bootstrapDelta(base, head));
    const [lo, hi] = bootstrapDelta(base, head);
    expect(lo).toBeGreaterThan(0.1);
    expect(hi).toBeLessThan(0.3);
  });
});

describe('compareSamples', () => {
  const cases: { name: string; base: number[]; head: number[]; better?: 'lower' | 'higher'; verdict: string }[] = [
    { name: 'same distribution', base: latencies(100, 5, 20, 1), head: latencies(100, 5, 20, 2), verdict: 'unchanged' },
    { name: '20% slower', base: latencies(100, 5, 20, 1), head: latencies(120, 5, 20, 2), verdict: 'regression' },
    { name: '20% faster', base: latencies(100, 5, 20, 1), head: latencies(80, 5, 20, 2), verdict: 'improvement' },
    {
      name: '2% slower is below the threshold',
      base: latencies(100, 1, 30, 1),
      head: latencies(102, 1, 30, 2),
      verdict: 'unchanged',
    },
    {
      name: 'a large change hidden in noise',
      base: latencies(100, 80, 6, 1),
      head: latencies(115, 80, 6, 2),
      verdict: 'noisy',
    },
    {
      name: 'higher is better: throughput drop',
      base: latencies(500, 10, 20, 1),
      head: latencies(400, 10, 20, 2),
      better: 'higher',
      verdict: 'regression',
    },
    {
      name: 'sub-millisecond change is below the absolute threshold',
      base: latencies(2, 0.01, 20, 1),
      head: latencies(2.5, 0.01, 20, 2),
      verdict: 'unchanged',
    },
    { name: 'one side empty', base: [], head: [1, 2, 3], verdict: 'missing' },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(compareSamples(testCase.base, testCase.head, testCase.better ?? 'lower', thresholds).verdict).toBe(
        testCase.verdict,
      );
    });
  }
});

it('marks a real change that is smaller than a threshold', () => {
  const result = compareSamples(latencies(2, 0.01, 20, 1), latencies(2.5, 0.01, 20, 2), 'lower', thresholds);
  expect(result).toMatchObject({ verdict: 'unchanged', underThreshold: true });
  expect(
    compareSamples(latencies(100, 5, 20, 1), latencies(100, 5, 20, 2), 'lower', thresholds).underThreshold,
  ).toBeUndefined();
});

describe('worstVerdict', () => {
  it('lets one regression outweigh speed-ups', () => {
    expect(worstVerdict(['improvement', 'regression', 'unchanged'])).toBe('regression');
    expect(worstVerdict(['improvement', 'unchanged'])).toBe('improvement');
    expect(worstVerdict([])).toBe('missing');
  });
});
