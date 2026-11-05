import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@speedpatrol/core';
import { AppSession } from '@speedpatrol/probes';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('detects a missing executable in a shell conditional', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-compound-review-'));
  try {
    await mkdir(join(root, '.speedpatrol'));
    await writeFile(
      join(root, '.speedpatrol', 'speedpatrol.yml'),
      JSON.stringify({
        app: { setup: [{ run: 'if true; then speedpatrol_review_missing_tool; fi' }] },
        agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
      }),
    );
    const loaded = await loadConfig(root);
    const session = new AppSession({ ...loaded.config.app, source: root });
    try {
      await expect(session.start()).rejects.toThrow(/speedpatrol_review_missing_tool/);
    } finally {
      await session.stop();
    }
    const lines: string[] = [];
    expect(await doctor(root, (line) => lines.push(line)), lines.join('\n')).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
