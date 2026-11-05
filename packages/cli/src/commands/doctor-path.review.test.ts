import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('checks each step with its own PATH even when the program and cwd repeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-path-review-'));
  try {
    const goodPath = join(root, 'good-bin');
    const badPath = join(root, 'bad-bin');
    const configDir = join(root, '.speedpatrol');
    for (const dir of [goodPath, badPath, configDir]) await mkdir(dir);
    for (const dir of [goodPath, badPath]) await symlink('/bin/bash', join(dir, 'bash'));
    await writeFile(join(goodPath, 'review-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(configDir, 'speedpatrol.yml'),
      JSON.stringify({
        app: {
          setup: [{ run: 'review-tool', env: { PATH: goodPath } }],
          teardown: [{ run: 'review-tool', env: { PATH: badPath } }],
        },
        agents: { scout: { enabled: false }, analyst: { enabled: false } },
      }),
    );
    const lines: string[] = [];
    const ok = await doctor(root, (line) => lines.push(line));
    expect(ok, lines.join('\n')).toBe(false);
    expect(lines.join('\n')).toContain('review-tool: missing (used by app.teardown[0])');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
