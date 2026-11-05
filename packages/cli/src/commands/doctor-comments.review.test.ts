import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@speedpatrol/core';
import { AppSession } from '@speedpatrol/probes';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('accepts shell comments in a working multiline setup command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-comments-'));
  try {
    await mkdir(join(root, '.speedpatrol'));
    await writeFile(
      join(root, '.speedpatrol', 'speedpatrol.yml'),
      JSON.stringify({
        app: { setup: [{ run: '# Build the app\nnode -e "process.exit(0)"' }] },
        agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
      }),
    );
    const loaded = await loadConfig(root);
    const session = new AppSession({ ...loaded.config.app, source: root });
    try {
      await session.start();
    } finally {
      await session.stop();
    }
    const lines: string[] = [];
    const ok = await doctor(root, (line) => lines.push(line));
    expect(ok, lines.join('\n')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
