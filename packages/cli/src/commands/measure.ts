import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type Comparison,
  ConfigError,
  type LoadedConfig,
  type Run,
  type Store,
  type Thresholds,
  tryGit,
} from '@speedpatrol/core';
import { abCompare, checkout, compareWithBaseline, measure, prepare, recordBaseline } from '@speedpatrol/probes';
import { comparisonMarkdown, formatValue } from '@speedpatrol/stats';
import { fetchPullRequest } from './pr.js';

export function runTable(run: Run, thresholds: Thresholds): string {
  const rows = run.results.map((result) => {
    const series = result.metrics[result.primary];
    const value = series
      ? `${formatValue(series.summary.median, series.unit)} ±${formatValue(series.summary.mad, series.unit)} MAD`
      : 'failed';
    const p95 = series ? formatValue(series.summary.p95, series.unit) : '';
    const noisy = Object.entries(result.metrics)
      .filter(([, metric]) => metric.summary.cv > thresholds.maxCv)
      .map(([metric, series]) => `noisy: ${metric} cv ${(series.summary.cv * 100).toFixed(1)}%`)
      .join('  ');
    return `  ${result.critical ? '★' : ' '} ${result.benchmark.padEnd(36)} ${result.primary.padEnd(24)} ${value.padEnd(32)} p95 ${p95}${noisy ? `  ${noisy}` : ''}${result.errors.length ? `  (${result.errors.length} errors: ${result.errors[0]?.split('\n')[0]})` : ''}`;
  });
  return rows.join('\n');
}

export async function runCommand(options: {
  loaded: LoadedConfig;
  store: Store;
  only: string[];
  iterations?: number;
  forceBaseline?: boolean;
  log: (line: string) => void;
}): Promise<{ run: Run; comparison?: Comparison; baselineRefused?: string; comparisonSkipped?: string }> {
  const { loaded, store, log } = options;
  await prepare(loaded, loaded.source, log);
  const run = await measure({
    loaded,
    store,
    purpose: 'baseline',
    only: options.only,
    iterations: options.iterations,
    log,
  });
  if (run.failed) return { run };
  const baseline = await recordBaseline(store, run, {
    thresholds: loaded.config.thresholds,
    force: Boolean(options.forceBaseline),
  });
  const baselineRefused = 'refused' in baseline ? baseline.refused : undefined;
  if (baselineRefused) log(`Not recorded as a baseline: ${baselineRefused}`);
  // A run refused as a baseline, such as a dirty tree, is still compared with the last one.
  const compared = await compareWithBaseline(loaded, store, run);
  if ('skipped' in compared) {
    log(compared.skipped);
    return { run, baselineRefused, comparisonSkipped: compared.skipped };
  }
  return { run, comparison: compared.comparison, baselineRefused };
}

/** A directory is a checkout; anything else is a git ref, checked out on the side. */
async function side(loaded: LoadedConfig, store: Store, value: string): Promise<{ label: string; dir: string }> {
  const asPath = resolve(value);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) {
    const branch = await tryGit(asPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { label: branch && branch !== 'HEAD' ? branch : value, dir: asPath };
  }
  const tree = await checkout(loaded.source, store, value);
  return { label: value, dir: tree.dir };
}

export async function compareCommand(options: {
  loaded: LoadedConfig;
  store: Store;
  base?: string;
  head?: string;
  /** A pull request number or URL: its head is the head side, its base branch the default base. */
  pr?: string;
  only: string[];
  rounds?: number;
  iterations?: number;
  markdown?: string;
  log: (line: string) => void;
}): Promise<Comparison> {
  const { loaded, store, log } = options;
  if (options.pr !== undefined && options.head !== undefined) throw new ConfigError('Give --pr or --head, not both.');
  const pr =
    options.pr !== undefined
      ? await fetchPullRequest(loaded.source, options.pr, { fetchBase: options.base === undefined })
      : undefined;
  const base = await side(loaded, store, options.base ?? pr?.base ?? loaded.config.agents.patrol.pull);
  const head = pr
    ? { ...(await side(loaded, store, pr.head)), label: `#${pr.number}` }
    : options.head
      ? await side(loaded, store, options.head)
      : { label: 'working tree', dir: loaded.source };
  const { comparison } = await abCompare({
    loaded,
    store,
    base,
    head,
    only: options.only,
    rounds: options.rounds,
    iterations: options.iterations,
    log,
  });
  if (options.markdown) await writeFile(options.markdown, `${comparisonMarkdown(comparison)}\n`);
  return comparison;
}
