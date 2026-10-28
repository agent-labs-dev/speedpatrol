import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ensureLabels } from './publish.js';

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
