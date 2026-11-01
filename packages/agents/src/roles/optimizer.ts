import { existsSync } from 'node:fs';
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
import { abCompare, checkout, prepare } from '@speedpatrol/probes';
import { comparisonMarkdown, formatPct } from '@speedpatrol/stats';
import { runRole } from '../session.js';
import { readInstructions } from '../tools/benchmarks.js';
import { profileDiffText } from '../tools/measure.js';
import { repoTools } from '../tools/repo.js';
import { optionalStr, str, tool } from '../tools/schema.js';

const SYSTEM = `You are the optimizer of Speedpatrol, a team of agents that keeps an app fast.
You work in your own git worktree (the current directory), on a branch made for you. Your job: make one benchmark faster without making anything else slower, with a change a reviewer would merge.

How to work:
1. get_target shows the benchmark, its latest numbers and its CPU hotspots. Read the code on that path.
2. Form one hypothesis (e.g. "loadOrders queries once per row; batch it"). Prefer algorithmic and I/O fixes (N+1 queries, repeated work, missing caching or memoization, oversized payloads, blocking calls, needless re-renders) over micro-tuning.
3. Edit the code. Keep behaviour identical, keep the change small, follow the repo's style, and run the repo's own tests for the code you touched.
4. Call measure_change to A/B your worktree against the base. Iterate while it helps.
5. Call finish with a title and what changed. The title says what the code change does, for a reviewer who does not know the benchmark. Do not commit, push or open a PR: Speedpatrol verifies and publishes.

Only the measurement decides whether the change is kept: an improvement smaller than the threshold, or any regression elsewhere, discards it.`;

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
  return `# Target\n\n${JSON.stringify(benchmark, null, 2)}\n\n## Latest numbers\n${metrics}\n\n## Profile\n${profileDiffText(undefined, run, benchmark.id)}`;
}

/** The first line, cut to 60 characters at a word boundary: one subject for the commit and the PR. */
export function subject(text: string): string {
  const line = text.split('\n')[0]!.trim();
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
  await save({});
  await git(loaded.source, ['worktree', 'add', '-b', branch, worktree, options.baseSha]);
  const base = await checkout(loaded.source, store, options.baseSha);
  const critical = loaded.benchmarks.filter((b) => b.critical && b.id !== benchmark.id).map((b) => b.id);
  const guard = [benchmark.id, ...critical];
  try {
    await prepare(loaded, worktree, log);
    let hypothesis: string | undefined;
    const tools = [
      tool('get_target', 'The benchmark to speed up, its latest numbers and its CPU hotspots.', {}, [], async () => ({
        text: targetDescription(benchmark, options.baseRun),
      })),
      tool(
        'measure_change',
        'A/B measure your worktree against the base commit, for the target and the critical benchmarks. Takes a minute or more.',
        {},
        [],
        async () => {
          await prepare(loaded, worktree, log);
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
          return { text: comparisonMarkdown(comparison), summary: `Measured: ${comparison.verdict}.` };
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
              'What the code change does, in the imperative and under 60 characters, e.g. "Batch the order lookups in loadOrders". No metric names or numbers: Speedpatrol adds the measured speed-up.',
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
      prompt: `Make \`${benchmark.id}\` faster.\n\n${targetDescription(benchmark, options.baseRun)}`,
      tools,
      maxSteps: config.maxSteps,
      timeoutMinutes: config.timeoutMinutes,
      budgetUsd: config.budgetUsd,
      workdir: worktree,
      store,
      secrets: loaded.config.app.secrets.map((name) => process.env[name] ?? '').filter(Boolean),
      log,
    });
    if (outcome.stop === 'error') {
      await save({ status: 'failed', reason: outcome.error });
      return { experiment };
    }
    if (!(await tryGit(worktree, ['status', '--porcelain']))) {
      await save({ status: 'rejected', reason: 'The optimizer made no change.' });
      return { experiment };
    }
    await git(worktree, ['add', '-A']);
    // The repo's own identity when it has one; a machine with none (a fresh
    // CI runner or VM) still gets its experiment committed.
    const identity = (await tryGit(worktree, ['config', 'user.email']))
      ? []
      : ['-c', 'user.name=Speedpatrol', '-c', 'user.email=speedpatrol@users.noreply.github.com'];
    await git(worktree, [
      ...identity,
      '-c',
      'commit.gpgsign=false',
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
  await prepare(loaded, experiment.worktree, log);
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
  const min = loaded.config.agents.optimizer.minImprovement;
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
