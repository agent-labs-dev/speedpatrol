import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, Store } from '@speedpatrol/core';
import { expect, it, vi } from 'vitest';
import { measure } from './runner.js';

vi.mock('@speedpatrol/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@speedpatrol/core')>()),
  sourceInfo: async () => ({ sha: 'abc', dirty: false }),
  machineInfo: () => ({
    fingerprint: 'quiet-at-start',
    hostname: 'host',
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'cpu',
    cpus: 4,
    memoryGb: 8,
    node: '22',
    load: { start: 0 },
  }),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  loadavg: () => [8, 0, 0],
}));

vi.mock('./probes/index.js', () => ({
  createProbe: () => ({
    primary: 'wall_ms',
    metrics: { wall_ms: { unit: 'ms', better: 'lower' } },
    sample: async () => ({ wall_ms: 100 }),
  }),
}));

it('warns when the machine becomes overloaded during a comparison run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'end-load-review-'));
  try {
    const config = configSchema.parse({
      benchmarks: [{ id: 'bench', kind: 'command', run: 'true' }],
      defaults: { warmup: 0, iterations: 1 },
    });
    const lines: string[] = [];
    const run = await measure({
      loaded: { config, source: root, dir: root, benchmarks: config.benchmarks },
      store: new Store(root),
      purpose: 'compare',
      profile: false,
      log: (line) => lines.push(line),
    });
    expect(run.failed).toBeUndefined();
    expect(run.machine.load).toEqual({ start: 0, end: 8 });
    expect(lines.join('\n')).toContain('Machine load 8.00 on 4 cores at end');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
