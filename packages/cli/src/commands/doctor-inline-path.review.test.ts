import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@speedpatrol/core';
import { AppSession } from '@speedpatrol/probes';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('does not report a working inline-PATH setup program as missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-inline-path-'));
  try {
    await mkdir(join(root, '.speedpatrol'));
    await mkdir(join(root, 'tools'));
    await writeFile(join(root, 'tools', 'review-inline-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(root, '.speedpatrol', 'speedpatrol.yml'),
      JSON.stringify({
        app: { setup: [{ run: 'PATH=./tools:$PATH review-inline-tool' }] },
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
    expect(lines.join('\n')).not.toContain('✗ review-inline-tool: missing');
    expect(ok, lines.join('\n')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
