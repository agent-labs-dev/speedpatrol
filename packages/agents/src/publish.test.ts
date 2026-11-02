import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Comparison, Experiment, MetricComparison } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { ensureLabels, experimentBody, experimentTitle } from './publish.js';
import { subject } from './roles/optimizer.js';

const exec = promisify(execFile);

/** Stands in for `gh`: records each call, then fails like gh does when told to. */
function fakeGh(stderr?: string) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (!stderr) return;
    await exec(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`]);
  };
  return { calls, run };
}

describe('ensureLabels', () => {
  it('creates each label with the Speedpatrol colour and description', async () => {
    const gh = fakeGh();
    await ensureLabels(gh.run, ['speedpatrol']);
    expect(gh.calls).toEqual([
      ['label', 'create', 'speedpatrol', '--color', '5319e7', '--description', 'Filed by Speedpatrol'],
    ]);
  });

  it('leaves a label that already exists alone', async () => {
    const gh = fakeGh(
      'label with name "speedpatrol" already exists; use `--force` to update its color and description\n',
    );
    await expect(ensureLabels(gh.run, ['speedpatrol', 'perf'])).resolves.toBeUndefined();
    expect(gh.calls).toHaveLength(2);
  });

  it('surfaces any other failure', async () => {
    const gh = fakeGh('HTTP 403: Resource not accessible by integration\n');
    await expect(ensureLabels(gh.run, ['speedpatrol'])).rejects.toThrow(/403/);
  });
});

describe('experimentTitle', () => {
  const experiment = {
    target: { benchmark: 'mobile.navigate', metric: 'flow_ms' },
    deltaPct: -0.114,
  } as Experiment;

  it('names the change and the speed-up, not the metric', () => {
    expect(experimentTitle({ ...experiment, title: 'fetch the user before the router loads' }, 'mobile')).toBe(
      'perf(mobile): fetch the user before the router loads (11% faster)',
    );
  });

  it('says smaller when the metric is a size', () => {
    expect(experimentTitle({ ...experiment, title: 'drop the unused locale data' }, 'web', 'kb')).toBe(
      'perf(web): drop the unused locale data (11% smaller)',
    );
  });

  it('falls back to the benchmark when the optimizer gave no title', () => {
    expect(experimentTitle(experiment, 'mobile.navigate')).toBe(
      'perf(mobile.navigate): speed up mobile.navigate (11% faster)',
    );
  });
});

describe('subject', () => {
  it('keeps a short title as it is', () => {
    expect(subject('  batch the order lookups\nmore text')).toBe('batch the order lookups');
  });

  it('lowers a capital first word, but not an identifier', () => {
    expect(subject('Batch the order lookups')).toBe('batch the order lookups');
    expect(subject('HTTP responses stream')).toBe('HTTP responses stream');
    expect(subject('MyCache skips the disk')).toBe('MyCache skips the disk');
  });

  it('cuts a long title at a word boundary, within 60 characters', () => {
    const long = 'fetch the user from the entry before the router and load the syntax highlighter on first use';
    const cut = subject(long);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(cut)).toBe(true);
    expect(long[cut.length]).toBe(' ');
  });
});

describe('experimentBody', () => {
  const experiment = {
    target: { benchmark: 'mobile.navigate', metric: 'flow_ms' },
    deltaPct: -0.114,
    baseSha: '0cee930aa2b1',
  } as Experiment;
  const metric = (name: string, primary: boolean, base: number, head: number, verdict: string) =>
    ({
      benchmark: 'mobile.navigate',
      metric: name,
      unit: 'ms',
      primary,
      base: { median: base },
      head: { median: head },
      deltaPct: head / base - 1,
      ci: [0, 0],
      pValue: 0,
      verdict,
    }) as MetricComparison;
  const compare = (metrics: MetricComparison[]) =>
    ({
      verdict: 'improvement',
      base: { label: 'base', sha: '0cee930aa2b1', runs: [] },
      head: { label: 'head', sha: '5f21766d0000', runs: [] },
      metrics,
      warnings: [],
    }) as unknown as Comparison;
  const tradeOffs = (body: string) => body.split('## Trade-offs')[1]?.split('\n## ')[0];
  const target = metric('flow_ms', true, 2000, 1772, 'improvement');

  it('lists each secondary metric that got slower', () => {
    const comparison = compare([
      target,
      metric('tbt_ms', false, 57.5, 123.5, 'regression'),
      metric('fcp_ms', false, 1010, 804, 'improvement'),
    ]);
    const section = tradeOffs(experimentBody(experiment, comparison, target));
    expect(section).toContain('`mobile.navigate` total blocking time (`tbt_ms`): **+114.8%** (57.5 ms to 123.5 ms)');
    expect(section).not.toContain('fcp_ms');
  });

  it('has no trade-offs section when no secondary metric got slower', () => {
    expect(tradeOffs(experimentBody(experiment, compare([target]), target))).toBeUndefined();
  });
});
