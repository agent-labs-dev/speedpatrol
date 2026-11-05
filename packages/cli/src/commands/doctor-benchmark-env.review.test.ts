import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { measure } from '@speedpatrol/probes';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('checks a benchmark using its runtime environment rather than the app command environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-benchmark-env-'));
  try {
    await mkdir(join(root, '.speedpatrol'));
    await writeFile(
      join(root, '.speedpatrol', 'speedpatrol.yml'),
      JSON.stringify({
        app: { env: { PATH: '/speedpatrol-review-no-such-directory' } },
        benchmarks: [{ id: 'node-command', kind: 'command', run: 'node -e "process.exit(0)"' }],
        defaults: { warmup: 0, iterations: 1 },
        agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
      }),
    );
    const loaded = await loadConfig(root);
    const run = await measure({ loaded, store: new Store(loaded.dir), purpose: 'baseline', profile: false });
    expect(run.failed).toBeUndefined();
    expect(run.results[0]?.errors).toEqual([]);
    const lines: string[] = [];
    const ok = await doctor(root, (line) => lines.push(line));
    expect(ok, lines.join('\n')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
