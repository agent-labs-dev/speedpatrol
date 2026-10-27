import type { Comparison, MetricComparison, Unit, Verdict } from '@speedpatrol/core';

export function formatValue(value: number | undefined, unit: Unit): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  switch (unit) {
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
    case 'bytes':
      return value >= 1024 * 1024
        ? `${(value / 1024 / 1024).toFixed(2)} MB`
        : value >= 1024
          ? `${(value / 1024).toFixed(1)} KB`
          : `${Math.round(value)} B`;
    case 'kb':
      return `${value.toFixed(1)} KB`;
    case 'mb':
      return `${value.toFixed(1)} MB`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'rps':
      return `${value.toFixed(1)}/s`;
    case 'score':
      return value.toFixed(3);
    case 'count':
      return String(Math.round(value));
  }
}

export function formatPct(delta: number): string {
  if (!Number.isFinite(delta)) return '-';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(1)}%`;
}

export const VERDICT_ICON: Record<Verdict, string> = {
  regression: '🔴',
  improvement: '🟢',
  unchanged: '⚪',
  noisy: '🟡',
  missing: '⚫',
};

function row(metric: MetricComparison): string {
  const verdict = metric.underThreshold ? `${metric.verdict} (under threshold)` : metric.verdict;
  return `| ${VERDICT_ICON[metric.verdict]} ${verdict} | \`${metric.benchmark}\` | ${metric.metric} | ${formatValue(
    metric.base?.median,
    metric.unit,
  )} | ${formatValue(metric.head?.median, metric.unit)} | ${formatPct(metric.deltaPct)} | ${formatPct(
    metric.ci[0],
  )} to ${formatPct(metric.ci[1])} | ${metric.pValue < 0.001 ? '<0.001' : metric.pValue.toFixed(3)} |`;
}

/** The comparison as a Markdown table, for a PR comment, an issue or a terminal. */
export function comparisonMarkdown(comparison: Comparison, options: { all?: boolean } = {}): string {
  const shown = comparison.metrics.filter(
    (metric) => options.all || metric.primary || metric.verdict === 'regression' || metric.verdict === 'improvement',
  );
  const lines = [
    `**${VERDICT_ICON[comparison.verdict]} ${comparison.verdict}**: \`${comparison.head.label}\` (${comparison.head.sha.slice(
      0,
      8,
    )}) against \`${comparison.base.label}\` (${comparison.base.sha.slice(0, 8)})`,
    '',
    '| Verdict | Benchmark | Metric | Base (median) | Head (median) | Change | 95% CI | p |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...shown.map(row),
  ];
  for (const warning of comparison.warnings) lines.push('', `> ⚠️ ${warning}`);
  return lines.join('\n');
}
