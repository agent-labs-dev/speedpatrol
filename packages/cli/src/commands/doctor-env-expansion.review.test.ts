import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@speedpatrol/core';
import { AppSession } from '@speedpatrol/probes';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('resolves a setup tool using the interpolated step environment used by AppSession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-env-expansion-'));
  try {
    const bin = join(root, 'bin');
    const configDir = join(root, '.speedpatrol');
    await mkdir(bin);
    await mkdir(configDir);
    await writeFile(join(bin, 'review-expansion-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(configDir, 'speedpatrol.yml'),
      JSON.stringify({
        app: {
          env: { REVIEW_TOOL_DIR: bin },
          setup: [{ run: 'review-expansion-tool', env: { PATH: '${REVIEW_TOOL_DIR}:/usr/bin:/bin' } }],
        },
        agents: {
          scout: { enabled: false },
          analyst: { enabled: false },
          optimizer: { enabled: false },
        },
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
    expect(lines.join('\n')).toContain(`review-expansion-tool: ${join(bin, 'review-expansion-tool')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
