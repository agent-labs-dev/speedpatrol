import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Experiment, git, type LoadedConfig, type Regression, type Store } from '@speedpatrol/core';
import { comparisonMarkdown, formatPct } from '@speedpatrol/stats';

const exec = promisify(execFile);

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

const FOOTER =
  '\n\n---\n_Opened by [Speedpatrol](https://github.com/agent-labs-dev/speedpatrol). Close it to dismiss; Speedpatrol will not reopen the same regression._';

async function regressionBody(store: Store, regression: Regression): Promise<string> {
  const comparison = await store.getComparison(regression.comparisonId);
  const suspects = (regression.suspects ?? [])
    .map((s) => `- ${s.sha.slice(0, 10)} ${s.subject}: ${s.reason}`)
    .join('\n');
  return [
    `\`${regression.benchmark}\` (${regression.metric}) is **${formatPct(regression.deltaPct)}** slower between ${regression.goodSha.slice(0, 10)} and ${regression.badSha.slice(0, 10)}. A second, independent A/B measurement confirmed it.`,
    regression.analysis ? `## Analysis\n\n${regression.analysis}` : '',
    suspects ? `## Suspect commits\n\n${suspects}` : '',
    comparison ? `## Measurement\n\n${comparisonMarkdown(comparison)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function experimentBody(store: Store, experiment: Experiment): Promise<string> {
  const comparison = experiment.comparisonId ? await store.getComparison(experiment.comparisonId) : undefined;
  return [
    `Makes \`${experiment.target.benchmark}\` **${formatPct(experiment.deltaPct ?? 0)}** (${experiment.target.metric}), measured A/B against ${experiment.baseSha.slice(0, 10)} on the same machine. No critical benchmark got slower.`,
    experiment.hypothesis ? `## Hypothesis\n\n${experiment.hypothesis}` : '',
    experiment.summary ? `## Change\n\n${experiment.summary}` : '',
    comparison ? `## Measurement\n\n${comparisonMarkdown(comparison, { all: false })}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type PublishResult = { issues: string[]; pullRequests: string[]; errors: string[]; dryRun: boolean };

/**
 * Opens an issue for each analysed regression and a PR for each verified
 * speed-up. A dry run prints the bodies instead. GitHub state wins: a closed
 * issue dismisses its regression (synced by `syncGithub`).
 */
export async function publish(
  loaded: LoadedConfig,
  store: Store,
  options: { dryRun?: boolean; log: (line: string) => void },
): Promise<PublishResult> {
  const github = loaded.config.agents.github;
  const dryRun = options.dryRun ?? !github.enabled;
  const result: PublishResult = { issues: [], pullRequests: [], errors: [], dryRun };
  const repoArgs = github.repo ? ['--repo', github.repo] : [];
  const labels = github.labels.flatMap((label) => ['--label', label]);
  for (const regression of await store.listRegressions()) {
    if (regression.status !== 'filed' || regression.issueUrl) continue;
    const body = (await regressionBody(store, regression)) + FOOTER;
    if (dryRun) {
      options.log(`[dry run] issue: ${regression.title}\n${body}\n`);
      continue;
    }
    try {
      const url = await gh(loaded.source, [
        'issue',
        'create',
        ...repoArgs,
        '--title',
        regression.title,
        '--body',
        body,
        ...labels,
      ]);
      await store.saveRegression({ ...regression, issueUrl: url, updatedAt: new Date().toISOString() });
      result.issues.push(url);
    } catch (error) {
      result.errors.push(`issue ${regression.id}: ${(error as Error).message}`);
    }
  }
  for (const experiment of await store.listExperiments()) {
    if (experiment.status !== 'improved' || experiment.prUrl) continue;
    const scope = loaded.config.agents.optimizer.commitScope ?? experiment.target.benchmark;
    const title = `perf(${scope}): ${formatPct(experiment.deltaPct ?? 0)} ${experiment.target.metric}`;
    const body = (await experimentBody(store, experiment)) + FOOTER;
    if (dryRun) {
      options.log(`[dry run] PR from ${experiment.branch}: ${title}\n${body}\n`);
      continue;
    }
    try {
      await git(experiment.worktree, ['push', '-u', 'origin', experiment.branch]);
      const url = await gh(experiment.worktree, [
        'pr',
        'create',
        ...repoArgs,
        '--head',
        experiment.branch,
        '--title',
        title,
        '--body',
        body,
        ...(github.pullRequests === 'draft' ? ['--draft'] : []),
        ...labels,
      ]);
      await store.saveExperiment({
        ...experiment,
        status: 'published',
        prUrl: url,
        updatedAt: new Date().toISOString(),
      });
      result.pullRequests.push(url);
    } catch (error) {
      result.errors.push(`PR ${experiment.id}: ${(error as Error).message}`);
    }
  }
  return result;
}

/** A closed issue dismisses (not planned) or fixes (completed) its regression. */
export async function syncGithub(loaded: LoadedConfig, store: Store): Promise<void> {
  if (!loaded.config.agents.github.enabled) return;
  for (const regression of await store.listRegressions()) {
    if (!regression.issueUrl || regression.status === 'dismissed' || regression.status === 'fixed') continue;
    try {
      const out = await gh(loaded.source, ['issue', 'view', regression.issueUrl, '--json', 'state,stateReason']);
      const { state, stateReason } = JSON.parse(out) as { state: string; stateReason?: string };
      if (state !== 'CLOSED') continue;
      const status = stateReason === 'NOT_PLANNED' ? 'dismissed' : 'fixed';
      await store.saveRegression({
        ...regression,
        status,
        reason: `Closed on GitHub (${stateReason ?? 'closed'}).`,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* offline or no access: try again next cycle */
    }
  }
}
