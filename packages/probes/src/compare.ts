import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type BaselineEntry,
  type Comparison,
  git,
  type LoadedConfig,
  loadWarning,
  MeasureError,
  type Run,
  type Store,
  type Thresholds,
  tryGit,
} from '@speedpatrol/core';
import { compareRuns } from '@speedpatrol/stats';
import { AppSession } from './app.js';
import { type MeasureOptions, measure } from './runner.js';

/** Runs `app.prepare` in a checkout: install, build. Not timed. */
export async function prepare(loaded: LoadedConfig, source: string, log: (line: string) => void): Promise<void> {
  if (loaded.config.app.prepare.length === 0) return;
  const session = new AppSession({
    setup: loaded.config.app.prepare,
    teardown: [],
    env: loaded.config.app.env,
    secrets: [...loaded.config.app.secrets],
    source,
    log,
  });
  try {
    await session.start();
  } finally {
    await session.stop();
  }
}

/**
 * Records a clean, complete, quiet run as the baseline of its commit. `force`
 * overrides machine load and a noisy metric, never a failed, dirty or
 * unknown commit.
 */
export async function recordBaseline(
  store: Store,
  run: Run,
  options: { thresholds: Thresholds; force: boolean },
): Promise<{ entry: BaselineEntry } | { refused: string }> {
  const fatal: string[] = [];
  if (run.failed) fatal.push(`Run failed: ${run.failed}`);
  if (run.source.dirty) fatal.push('Source is dirty.');
  if (run.source.sha === 'unknown') fatal.push('Source SHA is unknown.');
  if (fatal.length) return { refused: fatal.join(' ') };
  const overridable: string[] = [];
  const highLoad = loadWarning(run.machine);
  if (highLoad) overridable.push(highLoad);
  const { maxCv } = options.thresholds;
  for (const result of run.results) {
    // Only the primary metric gates: secondaries such as cpu_sys_ms are jittery at small values and would block
    // every baseline. The run table still flags each noisy metric.
    const series = result.metrics[result.primary];
    if (!series || series.summary.cv <= maxCv) continue;
    overridable.push(
      `Benchmark ${result.benchmark}, metric ${result.primary}, cv ${(series.summary.cv * 100).toFixed(1)}%, above maxCv ${(maxCv * 100).toFixed(1)}%.`,
    );
  }
  if (!options.force && overridable.length) return { refused: overridable.join(' ') };
  const entry: BaselineEntry = {
    sha: run.source.sha,
    runId: run.id,
    machine: run.machine.fingerprint,
    benchmarksHash: run.benchmarksHash,
    branch: run.source.branch,
    subject: run.source.subject,
    at: run.finishedAt,
  };
  await store.addBaseline(entry);
  return { entry };
}

/**
 * Compares a run with the newest baseline of another commit on the same
 * machine. Returns a reason when there is no such baseline yet or its run is
 * missing, so callers can explain why comparison did not happen.
 */
export async function compareWithBaseline(
  loaded: LoadedConfig,
  store: Store,
  run: Run,
  against?: string,
): Promise<{ comparison: Comparison } | { skipped: string }> {
  const entry = against
    ? await store.baselineFor(against, run.machine.fingerprint)
    : await store.latestBaseline(run.machine.fingerprint, run.source.sha);
  if (!entry) {
    if (against) return { skipped: `No baseline for ${against} on this machine.` };
    const recorded = (await store.baselines()).some((baseline) => baseline.runId === run.id);
    const none = `No baseline from another commit on machine ${run.machine.fingerprint} yet`;
    return { skipped: recorded ? `${none}: this run becomes the first.` : `${none}.` };
  }
  const baseRun = await store.getRun(entry.runId);
  if (!baseRun) return { skipped: `Baseline run ${entry.runId} is missing from the store.` };
  const comparison = compareRuns([baseRun], [run], {
    mode: 'baseline',
    thresholds: loaded.config.thresholds,
    baseLabel: entry.branch ?? 'baseline',
    headLabel: run.source.branch ?? run.source.sha.slice(0, 8),
    benchmarks: run.results.map((result) => result.benchmark),
  });
  await store.saveComparison(comparison);
  return { comparison };
}

/**
 * A detached worktree of `ref`, so a ref can be measured next to the working
 * checkout. Speedpatrol keeps them under runs/checkouts and reuses one per sha.
 */
export async function checkout(repo: string, store: Store, ref: string): Promise<{ dir: string; sha: string }> {
  const sha = await tryGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!sha) throw new MeasureError(`Unknown git ref: ${ref}`);
  const dir = store.path('checkouts', sha.slice(0, 12));
  if (!existsSync(dir)) {
    await mkdir(store.path('checkouts'), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', '--force', dir, sha]);
  }
  return { dir, sha };
}

export async function removeCheckout(repo: string, dir: string): Promise<void> {
  await tryGit(repo, ['worktree', 'remove', '--force', dir]);
  await rm(dir, { recursive: true, force: true });
}

export type Side = { label: string; dir: string };

export type AbOptions = Omit<MeasureOptions, 'source' | 'purpose'> & {
  base: Side;
  head: Side;
  rounds?: number;
};

/**
 * An A/B comparison of two checkouts on this machine. The sides alternate
 * (A B, B A, A B...), so a drift of the machine during the comparison, a
 * thermal throttle or a noisy neighbour, falls on both sides equally rather
 * than on whichever side ran second. Each side is prepared once.
 */
export async function abCompare(options: AbOptions): Promise<{ comparison: Comparison; runs: Run[] }> {
  const { loaded, store } = options;
  const log = options.log ?? (() => {});
  const rounds = options.rounds ?? loaded.config.defaults.rounds;
  const base = { ...options.base, dir: resolve(options.base.dir) };
  const head = { ...options.head, dir: resolve(options.head.dir) };
  for (const side of [base, head]) {
    log(`prepare ${side.label} (${side.dir})`);
    await prepare(loaded, side.dir, log);
  }
  const baseRuns: Run[] = [];
  const headRuns: Run[] = [];
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [base, head] : [head, base];
    for (const side of order) {
      log(`round ${round + 1}/${rounds}: ${side.label}`);
      const run = await measure({
        ...options,
        source: side.dir,
        purpose: 'compare',
        profile: options.profile !== false && round === 0,
      });
      if (run.failed) throw new MeasureError(`${side.label}: ${run.failed}`);
      (side === base ? baseRuns : headRuns).push(run);
    }
  }
  const comparison = compareRuns(baseRuns, headRuns, {
    mode: 'ab',
    thresholds: loaded.config.thresholds,
    baseLabel: base.label,
    headLabel: head.label,
  });
  await store.saveComparison(comparison);
  return { comparison, runs: [...baseRuns, ...headRuns] };
}

export function profilePath(store: Store, relativePath: string): string {
  return join(store.root, relativePath);
}
