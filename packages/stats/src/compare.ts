import {
  type BenchmarkResult,
  type Better,
  type Comparison,
  type ComparisonMode,
  type MetricComparison,
  newId,
  type Run,
  type Thresholds,
  type Verdict,
} from '@speedpatrol/core';
import { summarize, trimOutliers } from './summary.js';
import { bootstrapDelta, mannWhitney } from './tests.js';

export type MetricVerdict = Pick<
  MetricComparison,
  'deltaPct' | 'deltaAbs' | 'ci' | 'pValue' | 'verdict' | 'underThreshold'
>;

/**
 * The verdict of one metric (ADR 0001). A change counts only when it is
 * significant twice over (the rank test and the bootstrap interval both
 * exclude no change) and larger than both thresholds. A small but real change
 * stays `unchanged`; a large change that the samples cannot separate from
 * noise is `noisy`, which asks for more iterations rather than a decision.
 */
export function compareSamples(
  base: readonly number[],
  head: readonly number[],
  better: Better,
  thresholds: Thresholds,
): MetricVerdict {
  if (base.length === 0 || head.length === 0) {
    return { deltaPct: 0, deltaAbs: 0, ci: [0, 0], pValue: 1, verdict: 'missing' };
  }
  const b = trimOutliers(base);
  const h = trimOutliers(head);
  const bs = summarize(b);
  const hs = summarize(h);
  const deltaAbs = hs.median - bs.median;
  const deltaPct = bs.median === 0 ? (hs.median === 0 ? 0 : Math.sign(deltaAbs)) : hs.median / bs.median - 1;
  const ci = bootstrapDelta(b, h);
  const { p } = mannWhitney(b, h);
  const excludesZero = ci[0] > 0 || ci[1] < 0;
  const significant = p < thresholds.alpha && excludesZero;
  const large = Math.abs(deltaPct) >= thresholds.relative && Math.abs(deltaAbs) >= thresholds.absolute;
  let verdict: Verdict;
  if (significant && large) {
    const worse = better === 'lower' ? deltaAbs > 0 : deltaAbs < 0;
    verdict = worse ? 'regression' : 'improvement';
  } else if (!significant && Math.max(bs.cv, hs.cv) > thresholds.maxCv && large) {
    verdict = 'noisy';
  } else {
    verdict = 'unchanged';
  }
  return { deltaPct, deltaAbs, ci, pValue: p, verdict, ...(significant && !large ? { underThreshold: true } : {}) };
}

const SEVERITY: Record<Verdict, number> = { regression: 4, noisy: 3, improvement: 2, unchanged: 1, missing: 0 };

/** The worst verdict wins: one regression outweighs any number of speed-ups. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'missing';
  return verdicts.reduce((worst, verdict) => (SEVERITY[verdict] > SEVERITY[worst] ? verdict : worst));
}

/** Pools the samples of the same benchmark over several runs (A/B rounds). */
export function poolResults(runs: readonly Run[]): Map<string, BenchmarkResult> {
  const pooled = new Map<string, BenchmarkResult>();
  for (const run of runs) {
    for (const result of run.results) {
      const existing = pooled.get(result.benchmark);
      if (!existing) {
        pooled.set(result.benchmark, structuredClone(result));
        continue;
      }
      for (const [name, series] of Object.entries(result.metrics)) {
        const target = existing.metrics[name];
        if (target) {
          target.values.push(...series.values);
          target.summary = summarize(target.values);
        } else {
          existing.metrics[name] = structuredClone(series);
        }
      }
      existing.iterations += result.iterations;
      existing.errors.push(...result.errors);
    }
  }
  return pooled;
}

export type CompareOptions = {
  mode: ComparisonMode;
  thresholds: Thresholds;
  baseLabel: string;
  headLabel: string;
  /** Only these benchmarks. Default: all that either side measured. */
  benchmarks?: string[];
};

export function compareRuns(baseRuns: readonly Run[], headRuns: readonly Run[], options: CompareOptions): Comparison {
  const base = poolResults(baseRuns);
  const head = poolResults(headRuns);
  const warnings: string[] = [];
  const machines = new Set([...baseRuns, ...headRuns].map((run) => run.machine.fingerprint));
  if (machines.size > 1) warnings.push('The runs come from different machines: timings may not be comparable.');
  const hashes = new Set([...baseRuns, ...headRuns].map((run) => run.benchmarksHash));
  if (hashes.size > 1) warnings.push('The benchmark definitions changed between the runs.');
  const headRun = headRuns[0];
  if (headRun?.source.dirty) warnings.push('The head checkout had uncommitted changes.');

  const ids = options.benchmarks ?? [...new Set([...base.keys(), ...head.keys()])];
  const metrics: MetricComparison[] = [];
  for (const id of ids) {
    const b = base.get(id);
    const h = head.get(id);
    const reference = h ?? b;
    if (!reference) continue;
    const names = new Set([...Object.keys(b?.metrics ?? {}), ...Object.keys(h?.metrics ?? {})]);
    for (const name of names) {
      const bm = b?.metrics[name];
      const hm = h?.metrics[name];
      const spec = (hm ?? bm)!;
      const result = compareSamples(bm?.values ?? [], hm?.values ?? [], spec.better, options.thresholds);
      metrics.push({
        benchmark: id,
        metric: name,
        unit: spec.unit,
        better: spec.better,
        primary: name === reference.primary,
        critical: reference.critical,
        base: bm ? summarize(bm.values) : undefined,
        head: hm ? summarize(hm.values) : undefined,
        ...result,
      });
    }
  }
  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    base: { runs: baseRuns.map((run) => run.id), sha: baseRuns[0]?.source.sha ?? '', label: options.baseLabel },
    head: {
      runs: headRuns.map((run) => run.id),
      sha: headRun?.source.sha ?? '',
      label: options.headLabel,
      dirty: headRun?.source.dirty,
    },
    metrics,
    verdict: worstVerdict(metrics.filter((metric) => metric.primary).map((metric) => metric.verdict)),
    warnings,
  };
}
