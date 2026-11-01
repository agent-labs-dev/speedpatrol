import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Experiment } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { ensureLabels, experimentTitle } from './publish.js';
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
