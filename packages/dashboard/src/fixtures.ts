import type { BenchmarkResult, Comparison, Experiment, Regression, Run, Summary } from '@speedpatrol/core';

/** Small, generic records for the tests. `scripts/fixture.mjs` writes the large demo tree. */

const summary = (median: number): Summary => ({
  n: 3,
  min: median - 1,
  max: median + 1,
  mean: median,
  median,
  p75: median + 0.5,
  p90: median + 0.8,
  p95: median + 0.9,
  p99: median + 1,
  stddev: 1,
  mad: 1,
  cv: 1 / median,
});

export function result(benchmark: string, median: number, extra: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    benchmark,
    kind: 'http',
    primary: 'total_ms',
    metrics: { total_ms: { unit: 'ms', better: 'lower', values: [median], summary: summary(median) } },
    iterations: 3,
    errors: [],
    durationMs: 100,
    critical: false,
    ...extra,
  };
}

/** A run on day `day` of October 2026. */
export function run(id: string, day: number, results: BenchmarkResult[], extra: Partial<Run> = {}): Run {
  const at = `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id,
    purpose: 'baseline',
    startedAt: at,
    finishedAt: at.replace('T00:00', 'T00:01'),
    source: { dir: '/app', sha: `sha-${id}`, dirty: false, subject: `commit ${id}` },
    machine: {
      fingerprint: 'm1',
      hostname: 'runner',
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'cpu',
      cpus: 4,
      memoryGb: 8,
      node: '22.0.0',
    },
    benchmarksHash: 'h',
    results,
    ...extra,
  };
}

export function comparison(id: string, base: Run, head: Run, verdict: Comparison['verdict']): Comparison {
  return {
    id,
    createdAt: head.finishedAt,
    mode: 'baseline',
    base: { runs: [base.id], sha: base.source.sha, label: base.source.sha },
    head: { runs: [head.id], sha: head.source.sha, label: head.source.sha },
    metrics: [],
    verdict,
    warnings: [],
  };
}

export function regression(id: string, extra: Partial<Regression> = {}): Regression {
  return {
    id,
    fingerprint: 'api.items/total_ms',
    benchmark: 'api.items',
    metric: 'total_ms',
    status: 'open',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    goodSha: 'sha-a',
    badSha: 'sha-b',
    comparisonId: 'c1',
    deltaPct: 0.3,
    title: 'api.items got 30% slower',
    ...extra,
  };
}

export function experiment(id: string, extra: Partial<Experiment> = {}): Experiment {
  return {
    id,
    target: { benchmark: 'api.items', metric: 'total_ms' },
    status: 'measuring',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    branch: `speedpatrol/${id}`,
    worktree: `/tmp/${id}`,
    baseSha: 'sha-a',
    ...extra,
  };
}
