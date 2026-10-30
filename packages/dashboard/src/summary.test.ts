import { describe, expect, it } from 'vitest';
import { comparison, experiment, regression, result, run } from './fixtures.js';
import { projectSummary, type SummaryInput } from './summary.js';

const ITEMS = { id: 'api.items', critical: true, kind: 'http' as const };
const HOME = { id: 'web.home', critical: false, kind: 'web' as const };

function summarize(input: Partial<SummaryInput>) {
  return projectSummary({
    name: 'app',
    config: { benchmarks: [ITEMS] },
    runs: [],
    baselines: [],
    comparisons: [],
    regressions: [],
    experiments: [],
    stoppedAgents: [],
    ...input,
  });
}

describe('projectSummary', () => {
  it('sends a project with no benchmarks to the scout', () => {
    const summary = summarize({ config: { benchmarks: [] } });
    expect(summary.verdict).toMatchObject({ tone: 'info', text: 'Not measured yet' });
    expect(summary.next?.command).toBe('npx speedpatrol scout');
    expect(summary.attention).toEqual([]);
  });

  it('sends a project with benchmarks but no baseline to a run', () => {
    expect(summarize({}).next?.command).toBe('npx speedpatrol run');
  });

  it('does not call one baseline "no regressions": nothing was compared yet', () => {
    const first = run('a', 1, [result('api.items', 10)]);
    const summary = summarize({ runs: [first], baselines: [first] });
    expect(summary.verdict).toMatchObject({ tone: 'info', text: 'First baseline recorded' });
    expect(summary.next).toBeUndefined();
    expect(summary.benchmarks).toMatchObject({ defined: 1, measured: 1, unmeasured: [] });
  });

  it('passes when the baselines were compared and nothing waits', () => {
    const a = run('a', 1, [result('api.items', 10)]);
    const b = run('b', 2, [result('api.items', 10)]);
    const summary = summarize({ runs: [a, b], baselines: [a, b], comparisons: [comparison('c1', a, b, 'unchanged')] });
    expect(summary.verdict).toMatchObject({ tone: 'pass', text: 'No open regressions' });
    expect(summary.lastRun?.comparison).toEqual({ id: 'c1', verdict: 'unchanged' });
  });

  it('shows a failed baseline as the last run, not the older one that worked', () => {
    const good = run('a', 1, [result('api.items', 10)]);
    const failed = run('b', 2, [], { failed: 'The app did not come up.' });
    // The baselines that the store reports leave the failed run out.
    const summary = summarize({ runs: [good, failed], baselines: [good] });
    expect(summary.lastRun).toMatchObject({ id: 'b', failed: 'The app did not come up.' });
    expect(summary.verdict).toMatchObject({ tone: 'fail', text: 'Last run failed' });
    expect(summary.attention[0]).toMatchObject({ tone: 'fail', title: 'The last run failed' });
    expect(summary.runs.failed).toBe(1);
  });

  it('does not let an A/B run of an experiment stand for the main line', () => {
    const base = run('a', 1, [result('api.items', 10)]);
    const ab = run('b', 2, [result('api.items', 8)], { purpose: 'experiment' });
    expect(summarize({ runs: [base, ab], baselines: [base] }).lastRun?.id).toBe('a');
  });

  it('counts open and filed regressions, and gives each the next step that fits it', () => {
    const a = run('a', 1, [result('api.items', 10), result('web.home', 5)]);
    const summary = summarize({
      config: { benchmarks: [ITEMS, HOME] },
      runs: [a],
      baselines: [a],
      regressions: [
        regression('r1'),
        regression('r2', { status: 'open', analysis: 'Why.', benchmark: 'web.home' }),
        regression('r3', { status: 'filed', analysis: 'Why.', issueUrl: 'https://example.com/issues/1' }),
        regression('r4', { status: 'fixed' }),
        regression('r5', { status: 'dismissed' }),
      ],
    });
    expect(summary.regressions).toEqual({
      open: 3,
      total: 5,
      byStatus: { open: 2, filed: 1, fixed: 1, dismissed: 1 },
    });
    expect(summary.benchmarks.regressed).toBe(2);
    expect(summary.verdict).toMatchObject({ tone: 'fail', text: '3 open regressions' });
    const commands = summary.attention.map((item) => item.command);
    expect(commands).toEqual(['npx speedpatrol analyze r1', 'npx speedpatrol publish', undefined]);
  });

  it('warns about a defined benchmark that the newest baseline does not measure', () => {
    const a = run('a', 1, [result('api.items', 10)]);
    const b = run('b', 2, [result('api.items', 10)]);
    const summary = summarize({
      config: { benchmarks: [ITEMS, HOME] },
      runs: [a, b],
      baselines: [a, b],
      comparisons: [comparison('c1', a, b, 'unchanged')],
    });
    expect(summary.benchmarks).toMatchObject({ defined: 2, measured: 1, unmeasured: ['web.home'] });
    expect(summary.verdict.tone).toBe('warn');
    expect(summary.attention).toEqual([
      expect.objectContaining({ tone: 'warn', title: '1 benchmark has no baseline', command: 'npx speedpatrol run' }),
    ]);
  });

  it('lists a verified speed-up as waiting to be published', () => {
    const a = run('a', 1, [result('api.items', 10)]);
    const summary = summarize({
      runs: [a],
      baselines: [a],
      experiments: [
        experiment('e1', { status: 'improved', summary: 'Cache it.' }),
        experiment('e2', { status: 'measuring' }),
        experiment('e3', { status: 'published' }),
        experiment('e4', { status: 'failed' }),
      ],
    });
    expect(summary.experiments).toEqual({ active: 1, waiting: 1, published: 1, rejected: 1, total: 4 });
    expect(summary.attention).toEqual([
      expect.objectContaining({ detail: 'Cache it.', href: '#/experiments/e1', command: 'npx speedpatrol publish' }),
    ]);
  });

  it('reports a config that does not load, and still counts the measured benchmarks', () => {
    const a = run('a', 1, [result('api.items', 10, { critical: true })]);
    const summary = summarize({ config: { error: 'bad yaml' }, runs: [a], baselines: [a] });
    expect(summary.verdict).toMatchObject({ tone: 'fail', text: 'Config error' });
    expect(summary.configError).toBe('bad yaml');
    expect(summary.benchmarks).toMatchObject({ measured: 1, critical: 1 });
    expect(summary.benchmarks.defined).toBeUndefined();
  });

  it('warns about an agent whose process is gone', () => {
    const a = run('a', 1, [result('api.items', 10)]);
    const summary = summarize({ runs: [a], baselines: [a], stoppedAgents: ['optimizer'] });
    expect(summary.attention).toEqual([expect.objectContaining({ tone: 'warn', title: 'The optimizer stopped' })]);
  });
});
