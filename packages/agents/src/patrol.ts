import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  type Comparison,
  type LoadedConfig,
  loadConfig,
  MeasureError,
  newId,
  type Regression,
  type Run,
  type Store,
  tryGit,
} from '@speedpatrol/core';
import { abCompare, checkout, compareWithBaseline, measure, prepare, recordBaseline } from '@speedpatrol/probes';
import { compareSamples } from '@speedpatrol/stats';
import { publish, syncGithub } from './publish.js';
import { runAnalyst } from './roles/analyst.js';
import { runOptimizer } from './roles/optimizer.js';
import { runScout } from './roles/scout.js';

export type CycleOptions = {
  /** The primary config; its `runs/` holds all data. */
  loaded: LoadedConfig;
  store: Store;
  force?: boolean;
  log: (line: string) => void;
};

export type CycleResult = {
  sha: string;
  skipped: boolean;
  run?: Run;
  comparison?: Comparison;
  confirmed: Regression[];
  fixed: Regression[];
};

/** The regressions that a second A/B measurement confirms (ADR 0001). */
async function confirm(
  loaded: LoadedConfig,
  store: Store,
  comparison: Comparison,
  dir: string,
  log: (line: string) => void,
): Promise<{ confirmation?: Comparison; benchmarks: string[] }> {
  const suspects = [
    ...new Set(comparison.metrics.filter((m) => m.primary && m.verdict === 'regression').map((m) => m.benchmark)),
  ];
  if (suspects.length === 0) return { benchmarks: [] };
  log(`confirming ${suspects.length} suspected regression(s) with an A/B run: ${suspects.join(', ')}`);
  const base = await checkout(loaded.source, store, comparison.base.sha);
  await prepare(loaded, base.dir, log);
  const { comparison: confirmation } = await abCompare({
    loaded,
    store,
    base: { label: comparison.base.sha.slice(0, 8), dir: base.dir },
    head: { label: comparison.head.sha.slice(0, 8), dir },
    only: suspects,
    log,
  });
  const benchmarks = suspects.filter((id) =>
    confirmation.metrics.some((m) => m.benchmark === id && m.primary && m.verdict === 'regression'),
  );
  return { confirmation, benchmarks };
}

async function markFixed(store: Store, run: Run, loaded: LoadedConfig): Promise<Regression[]> {
  const fixed: Regression[] = [];
  for (const regression of await store.listRegressions()) {
    if (regression.status !== 'open' && regression.status !== 'filed') continue;
    const good = await store.baselineFor(regression.goodSha, run.machine.fingerprint);
    const goodRun = good ? await store.getRun(good.runId) : undefined;
    const before = goodRun?.results.find((r) => r.benchmark === regression.benchmark)?.metrics[regression.metric];
    const now = run.results.find((r) => r.benchmark === regression.benchmark)?.metrics[regression.metric];
    if (!before || !now) continue;
    const { verdict } = compareSamples(before.values, now.values, now.better, loaded.config.thresholds);
    if (verdict === 'regression' || verdict === 'noisy') continue;
    const updated: Regression = {
      ...regression,
      status: 'fixed',
      reason: `Back within the thresholds at ${run.source.sha.slice(0, 10)}.`,
      updatedAt: new Date().toISOString(),
    };
    await store.saveRegression(updated);
    fixed.push(updated);
  }
  return fixed;
}

/**
 * Measures the patrolled ref (default origin/main) in its own detached
 * worktree, records the baseline, compares it with the previous baseline,
 * and confirms each suspected regression before recording it.
 */
export async function measureMain(options: CycleOptions): Promise<CycleResult> {
  const { store, log } = options;
  const patrol = options.loaded.config.agents.patrol;
  const remote = patrol.pull.includes('/') ? patrol.pull.split('/')[0]! : undefined;
  if (remote) await tryGit(options.loaded.source, ['fetch', '--quiet', remote]);
  const sha = await tryGit(options.loaded.source, ['rev-parse', '--verify', `${patrol.pull}^{commit}`]);
  if (!sha) throw new MeasureError(`Cannot resolve ${patrol.pull} in ${options.loaded.source}.`);
  const state = await store.patrolState();
  if (state.lastSha === sha && !options.force) {
    log(`${patrol.pull} is still ${sha.slice(0, 10)}, measured before: skipping the measurement.`);
    return { sha, skipped: true, confirmed: [], fixed: [] };
  }
  const tree = await checkout(options.loaded.source, store, sha);
  // The benchmarks and the setup come from the measured commit, so a change to
  // them lands with the code that needs it. The data stays in the primary store.
  const loaded = existsSync(`${tree.dir}/.speedpatrol/speedpatrol.yml`)
    ? { ...(await loadConfig(tree.dir)), dir: options.loaded.dir }
    : { ...options.loaded, source: tree.dir };
  log(`measuring ${patrol.pull} at ${sha.slice(0, 10)}`);
  await prepare(loaded, tree.dir, log);
  const run = await measure({ loaded, store, source: tree.dir, purpose: 'baseline', log });
  if (run.failed) throw new MeasureError(`The run failed: ${run.failed}`);
  await recordBaseline(store, run);
  const comparison = await compareWithBaseline(loaded, store, run);
  const confirmed: Regression[] = [];
  if (comparison) {
    log(`against ${comparison.base.sha.slice(0, 10)}: ${comparison.verdict}`);
    const { confirmation, benchmarks } = await confirm(loaded, store, comparison, tree.dir, log);
    const open = await store.listRegressions();
    for (const id of benchmarks) {
      const metric = confirmation!.metrics.find((m) => m.benchmark === id && m.primary)!;
      const fingerprint = `${id}:${metric.metric}`;
      if (open.some((r) => r.fingerprint === fingerprint && (r.status === 'open' || r.status === 'filed'))) continue;
      const now = new Date().toISOString();
      const regression: Regression = {
        id: newId(),
        fingerprint,
        benchmark: id,
        metric: metric.metric,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        goodSha: comparison.base.sha,
        badSha: sha,
        comparisonId: confirmation!.id,
        deltaPct: metric.deltaPct,
        title: `${id} ${metric.metric} ${(metric.deltaPct * 100).toFixed(1)}% slower`,
      };
      await store.saveRegression(regression);
      confirmed.push(regression);
    }
  } else {
    log('first baseline on this machine: nothing to compare yet.');
  }
  const fixed = await markFixed(store, run, loaded);
  await store.savePatrolState({
    ...state,
    lastSha: sha,
    lastRunId: run.id,
    lastCycleAt: new Date().toISOString(),
    cycles: state.cycles + 1,
  });
  return { sha, skipped: false, run, comparison, confirmed, fixed };
}

/** Picks optimizer targets: critical first, then the least-tried benchmarks. */
async function pickTargets(loaded: LoadedConfig, store: Store, count: number) {
  const experiments = await store.listExperiments();
  const tries = (id: string) => experiments.filter((e) => e.target.benchmark === id).length;
  const open = new Set(experiments.filter((e) => e.status === 'improved').map((e) => e.target.benchmark));
  return loaded.benchmarks
    .filter((b) => !open.has(b.id) && !['android', 'ios', 'maestro'].includes(b.kind))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || tries(a.id) - tries(b.id))
    .slice(0, count);
}

/**
 * One patrol cycle: scout when there is nothing to measure, measure main,
 * explain each confirmed regression, try speed-ups, sync GitHub, publish.
 */
export async function cycle(options: CycleOptions): Promise<CycleResult> {
  const { loaded, store, log } = options;
  const agents = loaded.config.agents;
  if (loaded.benchmarks.length === 0 && agents.scout.enabled) {
    await store.setStatus({
      role: 'patrol',
      state: 'running',
      detail: 'No benchmarks: the scout looks for critical paths.',
    });
    await runScout({ loaded, store, log });
    options = { ...options, loaded: await loadConfig(loaded.dir) };
  }
  await store.setStatus({ role: 'runner', state: 'running', detail: `Measuring ${agents.patrol.pull}` });
  let result: CycleResult;
  try {
    result = await measureMain(options);
    await store.setStatus({
      role: 'runner',
      state: 'done',
      detail: result.skipped
        ? 'No new commit.'
        : `Measured ${result.sha.slice(0, 10)}: ${result.comparison?.verdict ?? 'first baseline'}`,
    });
  } catch (error) {
    await store.setStatus({ role: 'runner', state: 'failed', detail: (error as Error).message.split('\n')[0]! });
    throw error;
  }
  if (agents.analyst.enabled) {
    for (const regression of result.confirmed) await runAnalyst({ loaded, store, regression, log });
  } else {
    // Without an analyst the regression is still filed, with the numbers alone.
    for (const regression of result.confirmed) await store.saveRegression({ ...regression, status: 'filed' });
  }
  if (agents.optimizer.enabled && !result.skipped && result.run) {
    for (const benchmark of await pickTargets(options.loaded, store, agents.optimizer.maxPerCycle)) {
      const { experiment } = await runOptimizer({
        loaded: options.loaded,
        store,
        benchmark,
        baseSha: result.sha,
        baseRun: result.run,
        log,
      });
      log(
        `experiment ${experiment.id} on ${benchmark.id}: ${experiment.status}${experiment.reason ? ` (${experiment.reason})` : ''}`,
      );
    }
  }
  await syncGithub(loaded, store);
  if (agents.github.enabled) {
    const published = await publish(loaded, store, { log });
    for (const url of [...published.issues, ...published.pullRequests]) log(`published ${url}`);
    for (const error of published.errors) log(`publish failed: ${error}`);
  }
  return result;
}

async function acquireLock(store: Store): Promise<() => Promise<void>> {
  const file = store.path('patrol.lock');
  if (existsSync(file)) {
    const pid = Number(await readFile(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      /* a stale lock */
    }
    if (alive) throw new MeasureError(`Another patrol runs (pid ${pid}).`);
  }
  await writeFile(file, String(process.pid));
  return () => rm(file, { force: true });
}

/** Runs cycles until stopped: every `intervalMinutes`, or `cycles` times. */
export async function patrol(options: CycleOptions & { once?: boolean; signal?: AbortSignal }): Promise<void> {
  const { store, log } = options;
  const { intervalMinutes, cycles } = options.loaded.config.agents.patrol;
  await mkdir(store.root, { recursive: true });
  const release = await acquireLock(store);
  try {
    for (let count = 1; ; count++) {
      await store.setStatus({ role: 'patrol', state: 'running', detail: `Cycle ${count}` });
      try {
        const loaded = await loadConfig(options.loaded.dir);
        await cycle({ ...options, loaded, force: options.force && count === 1 });
      } catch (error) {
        log(`cycle failed: ${(error as Error).message}`);
        if (options.once) throw error;
      }
      if (options.once || (cycles && count >= cycles) || options.signal?.aborted) break;
      await store.setStatus({ role: 'patrol', state: 'idle', detail: `Next check in ${intervalMinutes} min` });
      await new Promise<void>((done) => {
        const timer = setTimeout(done, intervalMinutes * 60_000);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          done();
        });
      });
      if (options.signal?.aborted) break;
    }
  } finally {
    await store.setStatus({ role: 'patrol', state: 'idle', detail: 'Stopped.' });
    await release();
  }
}
