import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Comparison, type LoadedConfig, type Run, type Store, tryGit } from '@speedpatrol/core';
import { abCompare, checkout, compareWithBaseline, measure, prepare, recordBaseline } from '@speedpatrol/probes';
import { comparisonMarkdown, formatValue } from '@speedpatrol/stats';

export function runTable(run: Run): string {
  const rows = run.results.map((result) => {
    const series = result.metrics[result.primary];
    const value = series
      ? `${formatValue(series.summary.median, series.unit)} ±${formatValue(series.summary.mad, series.unit)}`
      : 'failed';
    const p95 = series ? formatValue(series.summary.p95, series.unit) : '';
    return `  ${result.critical ? '★' : ' '} ${result.benchmark.padEnd(32)} ${result.primary.padEnd(22)} ${value.padEnd(24)} p95 ${p95}${result.errors.length ? `  (${result.errors.length} errors: ${result.errors[0]?.split('\n')[0]})` : ''}`;
  });
  return rows.join('\n');
}

export async function runCommand(options: {
  loaded: LoadedConfig;
  store: Store;
  only: string[];
  iterations?: number;
  log: (line: string) => void;
}): Promise<{ run: Run; comparison?: Comparison }> {
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
  const baseline = await recordBaseline(store, run);
  if (!baseline)
    log(
      run.source.dirty ? 'Uncommitted changes: this run is not recorded as a baseline.' : 'Not recorded as a baseline.',
    );
  const comparison = await compareWithBaseline(loaded, store, run);
  return { run, comparison };
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
  only: string[];
  rounds?: number;
  iterations?: number;
  markdown?: string;
  log: (line: string) => void;
}): Promise<Comparison> {
  const { loaded, store, log } = options;
  const baseRef = options.base ?? loaded.config.agents.patrol.pull;
  const base = await side(loaded, store, baseRef);
  const head = options.head ? await side(loaded, store, options.head) : { label: 'working tree', dir: loaded.source };
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
