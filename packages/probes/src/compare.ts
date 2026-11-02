import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type BaselineEntry,
  type Comparison,
  git,
  type LoadedConfig,
  MeasureError,
  type Run,
  type Store,
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

/** Records a clean, complete run as the baseline of its commit. */
export async function recordBaseline(store: Store, run: Run): Promise<BaselineEntry | undefined> {
  if (run.failed || run.source.dirty || run.source.sha === 'unknown') return undefined;
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
  return entry;
}

/**
 * Compares a run with the newest baseline of another commit on the same
 * machine. Returns undefined when there is no such baseline yet: the first
 * run of a project only creates one.
 */
export async function compareWithBaseline(
  loaded: LoadedConfig,
  store: Store,
  run: Run,
  against?: string,
): Promise<Comparison | undefined> {
  const entry = against
    ? await store.baselineFor(against, run.machine.fingerprint)
    : await store.latestBaseline(run.machine.fingerprint, run.source.sha);
  if (!entry) return undefined;
  const baseRun = await store.getRun(entry.runId);
  if (!baseRun) return undefined;
  const comparison = compareRuns([baseRun], [run], {
    mode: 'baseline',
    thresholds: loaded.config.thresholds,
    baseLabel: entry.branch ?? 'baseline',
    headLabel: run.source.branch ?? run.source.sha.slice(0, 8),
    benchmarks: run.results.map((result) => result.benchmark),
  });
  await store.saveComparison(comparison);
  return comparison;
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
      const run = await measure({ ...options, source: side.dir, purpose: 'compare', profile: round === 0 });
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
