import { commitsBetween, type LoadedConfig, type Regression, type Store } from '@speedpatrol/core';
import { formatPct, formatValue } from '@speedpatrol/stats';
import { runRole } from '../session.js';
import { readInstructions } from '../tools/benchmarks.js';
import { measureCommitTool, profileDiffText } from '../tools/measure.js';
import { gitTools, repoTools } from '../tools/repo.js';
import { finishTool, str, tool } from '../tools/schema.js';

const SYSTEM = `You are the analyst of Speedpatrol, a team of agents that keeps an app fast.
Speedpatrol measured a regression and confirmed it with a second, independent A/B measurement. The verdict is settled by statistics: you cannot clear it, and you must not argue that it is noise.

Your job: explain it so an engineer can fix it in minutes.
1. Read the regression and the commits in the range (git_log). Look at the diffs that touch the code on this path (git_show).
2. Read the profile diff: which functions gained self time.
3. When the range has several commits and the cause is not clear, bisect with measure_commit (the middle commit against the good one), and narrow down.
4. Call write_analysis with a title, the suspect commits and an explanation: what got slower, by how much, which code and why, and a concrete fix.
5. Call finish.`;

export async function runAnalyst(options: {
  loaded: LoadedConfig;
  store: Store;
  regression: Regression;
  log: (line: string) => void;
}) {
  const { loaded, store, log } = options;
  let regression = options.regression;
  const analyst = loaded.config.agents.analyst;
  const comparison = await store.getComparison(regression.comparisonId);
  const metric = comparison?.metrics.find(
    (m) => m.benchmark === regression.benchmark && m.metric === regression.metric,
  );
  const baseRun = comparison ? await store.getRun(comparison.base.runs[0] ?? '') : undefined;
  const headRun = comparison ? await store.getRun(comparison.head.runs[0] ?? '') : undefined;
  const commits = await commitsBetween(loaded.source, regression.goodSha, regression.badSha);
  const facts = [
    `Benchmark: ${regression.benchmark}, metric ${regression.metric}`,
    metric
      ? `Median ${formatValue(metric.base?.median, metric.unit)} -> ${formatValue(metric.head?.median, metric.unit)} (${formatPct(metric.deltaPct)}, 95% CI ${formatPct(metric.ci[0])} to ${formatPct(metric.ci[1])}, p=${metric.pValue.toExponential(2)})`
      : `Change: ${formatPct(regression.deltaPct)}`,
    `Last good commit: ${regression.goodSha}`,
    `First bad commit measured: ${regression.badSha}`,
    `Commits in the range (${commits.length}):`,
    ...commits.map((commit) => `- ${commit.sha.slice(0, 10)} ${commit.subject} (${commit.author})`),
  ].join('\n');

  const writeAnalysis = tool(
    'write_analysis',
    'Write the explanation of the regression. It becomes the GitHub issue.',
    {
      title: {
        type: 'string',
        description: 'A short issue title, e.g. "GET /api/orders 38% slower since the N+1 in loadOrders"',
      },
      analysis: { type: 'string', description: 'Markdown: what, how much, which code, why, and the fix.' },
      suspects: {
        type: 'array',
        description: 'Suspect commits, most likely first.',
        items: {
          type: 'object',
          properties: { sha: { type: 'string' }, reason: { type: 'string' } },
          required: ['sha', 'reason'],
        },
      },
    },
    ['title', 'analysis'],
    async (input) => {
      const suspects = ((input.suspects as { sha: string; reason: string }[] | undefined) ?? []).map((suspect) => ({
        sha: suspect.sha,
        reason: suspect.reason,
        subject: commits.find((commit) => commit.sha.startsWith(suspect.sha))?.subject ?? '',
      }));
      regression = {
        ...regression,
        title: str(input, 'title'),
        analysis: str(input, 'analysis'),
        suspects,
        status: regression.status === 'open' ? 'filed' : regression.status,
        updatedAt: new Date().toISOString(),
      };
      await store.saveRegression(regression);
      return { text: 'Saved. Call finish.', summary: `Analysis: ${regression.title}` };
    },
  );
  const profileDiff = tool(
    'profile_diff',
    'The CPU profile of this benchmark before and after: which functions gained self time.',
    {},
    [],
    async () => ({
      text: profileDiffText(baseRun, headRun, regression.benchmark),
    }),
  );
  const outcome = await runRole({
    role: 'analyst',
    use: analyst.use,
    system: `${SYSTEM}\n\n# App guide\n\n${await readInstructions(loaded)}`,
    prompt: `# The regression\n\n${facts}`,
    tools: [
      writeAnalysis,
      profileDiff,
      measureCommitTool(loaded, store, log),
      ...gitTools(loaded.source),
      ...repoTools(loaded.source),
      finishTool('Finish after write_analysis.'),
    ],
    maxSteps: analyst.maxSteps,
    timeoutMinutes: analyst.timeoutMinutes,
    budgetUsd: analyst.budgetUsd,
    workdir: loaded.source,
    store,
    secrets: loaded.config.app.secrets.map((name) => process.env[name] ?? '').filter(Boolean),
    log,
  });
  return { outcome, regression };
}
