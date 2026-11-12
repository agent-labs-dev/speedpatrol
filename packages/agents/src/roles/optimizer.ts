import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  type Benchmark,
  type Comparison,
  type Experiment,
  git,
  type LoadedConfig,
  newId,
  type Run,
  type Store,
  tryGit,
} from '@speedpatrol/core';
import { abCompare, checkout, prepare, runTimed } from '@speedpatrol/probes';
import { comparisonMarkdown, formatPct } from '@speedpatrol/stats';
import { runRole } from '../session.js';
import { readInstructions } from '../tools/benchmarks.js';
import { profileDiffText } from '../tools/measure.js';
import { repoTools } from '../tools/repo.js';
import { optionalStr, str, tool } from '../tools/schema.js';

const SYSTEM = `You are the optimizer of Speedpatrol, a team of agents that keeps an app fast.
You work in your own git worktree (the current directory), on a branch made for you. Your job: make one benchmark faster without making anything else slower, with a change a reviewer would merge.

How to work:
1. get_target shows the primary metric, latest numbers, CPU hotspots and remaining working time. Trace what the primary metric actually times, including its wait conditions; a CPU hotspot alone is not evidence that removing it can clear the improvement threshold.
2. Call set_hypothesis with one hypothesis (e.g. "loadOrders queries once per row; batch it") and why it can materially improve the primary metric. Prefer algorithmic and I/O fixes (N+1 queries, repeated work, oversized payloads, blocking calls, needless re-renders) over micro-tuning or speculative import rewrites.
3. Edit the code. Keep behaviour identical, keep the change small, and follow the repo's required checks. Measure a plausible candidate before optional broad validation; run the required checks before finishing a candidate for publication. Do not fix unrelated lint or test failures.
4. Call measure_change to A/B your worktree against the base. It prepares both sides and measures one round without profiling. Wait without editing files or running builds, tests or other CPU-heavy work during measurement.
5. When the primary metric improves without collateral regressions and the required checks pass, call finish promptly: Speedpatrol runs a separate full A/B verification after the session, outside your working-time limit. Do not spend the remaining budget remeasuring an unchanged candidate. For an unchanged or regressed result, revert it before trying a different hypothesis, and only start another A/B if the remaining time covers the last A/B duration plus edits, required checks and finish. Otherwise revert unsuccessful edits and call finish explaining that no candidate worked.

Call finish with a title and what changed. The title says what the code change does, for a reviewer who does not know the benchmark. Do not commit, push or open a PR: Speedpatrol verifies and publishes.

The measurement and the declared checks and path policy decide whether the change is kept: an improvement smaller than the threshold, any regression elsewhere, failed checks, or undeclared changes discards it.`;

function targetDescription(benchmark: Benchmark, run: Run | undefined): string {
  const result = run?.results.find((item) => item.benchmark === benchmark.id);
  const metrics = result
    ? Object.entries(result.metrics)
        .map(
          ([name, series]) =>
            `${name}: median ${series.summary.median.toFixed(2)} ${series.unit}, p95 ${series.summary.p95.toFixed(2)}`,
        )
        .join('\n')
    : 'not measured yet';
  return `# Target\n\n${JSON.stringify(benchmark, null, 2)}\n\n## Primary metric\n${result?.primary ?? benchmark.primary ?? 'Not measured yet.'}\n\n## Latest numbers\n${metrics}\n\n## Profile\n${profileDiffText(undefined, run, benchmark.id)}`;
}

/**
 * The first line, cut to 60 characters at a word boundary: one subject for the
 * commit and the PR. A capital first word is lowered, as commitlint's
 * subject-case wants; an identifier such as `HTTP` or `MyCache` is kept.
 */
export function subject(text: string): string {
  const line = text
    .split('\n')[0]!
    .trim()
    .replace(/^[A-Z][a-z]*\b/, (word) => word.toLowerCase());
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).trimEnd();
}

export type OptimizerResult = { experiment: Experiment; comparison?: Comparison };

/**
 * One experiment: a worktree, an optimizer session, then a verification that
 * is all code. The final A/B covers the target and every critical benchmark,
 * so a speed-up that slows a critical path is rejected.
 */
export async function runOptimizer(options: {
  loaded: LoadedConfig;
  store: Store;
  benchmark: Benchmark;
  baseSha: string;
  baseRun?: Run;
  log: (line: string) => void;
}): Promise<OptimizerResult> {
  const { loaded, store, benchmark, log } = options;
  const config = loaded.config.agents.optimizer;
  const id = newId();
  const branch = `speedpatrol/speedup-${benchmark.id.replace(/[^a-z0-9-]+/g, '-')}-${id.slice(-4)}`;
  const worktree = store.path('worktrees', id);
  const now = () => new Date().toISOString();
  let experiment: Experiment = {
    id,
    target: {
      benchmark: benchmark.id,
      metric: options.baseRun?.results.find((r) => r.benchmark === benchmark.id)?.primary ?? '',
    },
    status: 'proposed',
    createdAt: now(),
    updatedAt: now(),
    branch,
    worktree,
    baseSha: options.baseSha,
  };
  const save = async (patch: Partial<Experiment>) => {
    experiment = { ...experiment, ...patch, updatedAt: now() };
    await store.saveExperiment(experiment);
  };
  if (
    config.checks.length === 0 ||
    config.allowedPaths.length === 0 ||
    benchmark.measures.length === 0 ||
    config.allowedPaths.some(
      (path) =>
        !benchmark.measures.includes(path) ||
        benchmark.protectedPaths.includes(path) ||
        path.startsWith('/') ||
        path.split('/').includes('..'),
    ) ||
    config.allowedPaths.includes(relative(loaded.source, `${loaded.dir}/speedpatrol.yml`))
  ) {
    await save({ status: 'rejected', reason: 'Optimizer checks and allowedPaths must be declared.' });
    return { experiment };
  }
  await save({});
  if (await tryGit(loaded.source, ['status', '--porcelain'])) {
    await save({ status: 'rejected', reason: 'The source checkout has uncommitted changes.' });
    return { experiment };
  }
  await git(loaded.source, ['worktree', 'add', '-b', branch, worktree, options.baseSha]);
  const base = await checkout(loaded.source, store, options.baseSha);
  const critical = loaded.benchmarks.filter((b) => b.critical && b.id !== benchmark.id).map((b) => b.id);
  const guard = [benchmark.id, ...critical];
  try {
    await prepare(loaded, worktree, log);
    const baselineTracked = new Set((await git(worktree, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean));
    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    const remaining = () =>
      `Working time remaining: ${Math.max(0, (deadline - Date.now()) / 60_000).toFixed(1)} minutes.`;
    const target = () =>
      `${targetDescription(benchmark, options.baseRun)}\n\n## Working budget\n${remaining()}\nSession limit: ${config.timeoutMinutes} minutes. Final A/B verification runs after finish.\n\n## Improvement requirements\n${JSON.stringify(loaded.config.thresholds)}\nOptimizer minimum improvement: ${(config.minImprovement * 100).toFixed(1)}%. The primary metric must also receive an improvement verdict.`;
    let hypothesis: string | undefined;
    const tools = [
      tool(
        'get_target',
        'The benchmark, primary metric, latest numbers, CPU hotspots, improvement requirements and remaining working time.',
        {},
        [],
        async () => ({ text: target() }),
      ),
      tool(
        'measure_change',
        'A/B measure your worktree against the base commit, for the target and the critical benchmarks. Returns duration and remaining working time. Keep the machine idle while it runs.',
        {},
        [],
        async () => {
          const started = Date.now();
          const { comparison } = await abCompare({
            loaded,
            store,
            base: { label: 'base', dir: base.dir },
            head: { label: 'experiment', dir: worktree },
            only: guard,
            rounds: 1,
            profile: false,
            log,
          });
          return {
            text: `${comparisonMarkdown(comparison)}\n\nA/B duration: ${((Date.now() - started) / 60_000).toFixed(1)} minutes. ${remaining()}\nFinish a promising candidate for full verification; revert unsuccessful edits before finishing without a candidate.`,
            summary: `Measured: ${comparison.verdict}.`,
          };
        },
        { exclusive: true },
      ),
      tool('git_diff', 'Your changes so far.', {}, [], async () => ({
        text: (await tryGit(worktree, ['diff', 'HEAD'])) || 'No changes yet.',
      })),
      tool(
        'set_hypothesis',
        'Record the hypothesis you are testing.',
        { hypothesis: { type: 'string', description: 'One or two sentences.' } },
        ['hypothesis'],
        async (input) => {
          hypothesis = optionalStr(input, 'hypothesis');
          await save({ hypothesis });
          return { text: 'Recorded.' };
        },
      ),
      ...repoTools(worktree),
      tool(
        'finish',
        'Finish with a title and the change.',
        {
          title: {
            type: 'string',
            description:
              'What the code change does, in the imperative and under 60 characters, e.g. "batch the order lookups in loadOrders". No metric names or numbers: Speedpatrol adds the measured speed-up.',
          },
          summary: { type: 'string', description: 'What you changed and why it is faster, for the reviewer.' },
        },
        ['title', 'summary'],
        async (input) => {
          const summary = str(input, 'summary');
          await save({ title: subject(str(input, 'title')), summary });
          return { text: summary, done: true, summary: 'Finished.' };
        },
      ),
    ];
    const outcome = await runRole({
      role: 'optimizer',
      use: config.use,
      system: `${SYSTEM}\n\n# App guide\n\n${await readInstructions(loaded)}`,
      prompt: `Make \`${benchmark.id}\` faster.\n\n${target()}`,
      tools,
      maxSteps: config.maxSteps,
      timeoutMinutes: config.timeoutMinutes,
      budgetUsd: config.budgetUsd,
      workdir: worktree,
      store,
      secrets: loaded.config.app.secrets.map((name) => process.env[name] ?? '').filter(Boolean),
      log,
    });
    if (outcome.stop !== 'done') {
      await save({ status: 'failed', reason: outcome.error });
      return { experiment };
    }
    if (!(await tryGit(worktree, ['status', '--porcelain']))) {
      await save({ status: 'rejected', reason: 'The optimizer made no change.' });
      return { experiment };
    }
    const status = await git(worktree, ['status', '--porcelain']);
    const untracked = status
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3));
    if (untracked.length > 0) {
      await save({ status: 'rejected', reason: `Untracked scratch files in experiment: ${untracked.join(', ')}` });
      return { experiment };
    }
    const changedTracked = new Set((await git(worktree, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean));
    const invalidPaths = [...changedTracked].filter((path) => !config.allowedPaths.includes(path));
    if (invalidPaths.length > 0) {
      await save({ status: 'rejected', reason: `Changed paths are outside allowedPaths: ${invalidPaths.join(', ')}` });
      return { experiment };
    }
    for (const command of config.checks) {
      try {
        const result = await runTimed({ command, cwd: worktree, timeoutMs: config.timeoutMinutes * 60_000 });
        if (result.timedOut || result.code !== 0) {
          throw new Error(
            result.timedOut ? `timed out after ${config.timeoutMinutes * 60_000}ms` : `exit ${result.code}`,
          );
        }
      } catch (error) {
        await save({ status: 'rejected', reason: `Optimizer check failed: ${command}: ${(error as Error).message}` });
        return { experiment };
      }
    }
    if ((await git(worktree, ['status', '--porcelain'])) !== status) {
      await save({ status: 'rejected', reason: 'Optimizer checks modified the experiment worktree.' });
      return { experiment };
    }
    const unexpected = [...baselineTracked].filter((path) => !changedTracked.has(path));
    if (unexpected.length > 0) {
      await save({
        status: 'rejected',
        reason: `Pre-existing tracked files changed or removed: ${unexpected.join(', ')}`,
      });
      return { experiment };
    }
    await git(worktree, ['add', '--update']);
    // Supply a fallback identity only when the repo has none. Git controls signing.
    const identity = (await tryGit(worktree, ['config', 'user.email']))
      ? []
      : ['-c', 'user.name=Speedpatrol', '-c', 'user.email=speedpatrol@users.noreply.github.com'];
    await git(worktree, [
      ...identity,
      'commit',
      '-q',
      '-m',
      `perf(${loaded.config.agents.optimizer.commitScope ?? benchmark.id}): ${subject(experiment.title ?? hypothesis ?? experiment.summary ?? 'speed up')}`,
      '-m',
      `${experiment.summary ?? ''}\n\nProposed by the Speedpatrol optimizer.`,
    ]);
    await save({ status: 'measuring', headSha: await git(worktree, ['rev-parse', 'HEAD']) });
    return await verify(loaded, store, experiment, base.dir, guard, save, log);
  } catch (error) {
    await save({ status: 'failed', reason: (error as Error).message });
    return { experiment };
  } finally {
    // A rejected or failed experiment leaves nothing behind; an improved one
    // keeps its branch for the PR.
    if (experiment.status !== 'improved' && existsSync(worktree)) {
      await tryGit(loaded.source, ['worktree', 'remove', '--force', worktree]);
      await tryGit(loaded.source, ['branch', '-D', branch]);
    }
  }
}

async function verify(
  loaded: LoadedConfig,
  store: Store,
  experiment: Experiment,
  baseDir: string,
  guard: string[],
  save: (patch: Partial<Experiment>) => Promise<void>,
  log: (line: string) => void,
): Promise<OptimizerResult> {
  const { comparison } = await abCompare({
    loaded,
    store,
    base: { label: 'base', dir: baseDir },
    head: { label: experiment.branch, dir: experiment.worktree },
    only: guard,
    log,
  });
  const primary = comparison.metrics.filter((metric) => metric.primary);
  const target = primary.find((metric) => metric.benchmark === experiment.target.benchmark);
  const collateral = primary
    .filter((metric) => metric.benchmark !== experiment.target.benchmark && metric.verdict === 'regression')
    .map((metric) => `${metric.benchmark} ${formatPct(metric.deltaPct)}`);
  const min = Math.max(loaded.config.agents.optimizer.minImprovement, loaded.config.thresholds.relative);
  const improved = target?.verdict === 'improvement' && -target.deltaPct >= min && collateral.length === 0;
  await save({
    status: improved ? 'improved' : 'rejected',
    comparisonId: comparison.id,
    deltaPct: target?.deltaPct,
    collateral,
    target: { benchmark: experiment.target.benchmark, metric: target?.metric ?? experiment.target.metric },
    reason: improved
      ? undefined
      : collateral.length
        ? `Slower elsewhere: ${collateral.join(', ')}`
        : `The target did not improve by ${(min * 100).toFixed(0)}% (${target ? `${target.verdict}, ${formatPct(target.deltaPct)}` : 'not measured'}).`,
  });
  return { experiment: (await store.getExperiment(experiment.id))!, comparison };
}
