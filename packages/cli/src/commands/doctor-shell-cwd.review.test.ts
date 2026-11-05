import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { doctor } from './doctor.js';

it('checks the successful directory after a cd guarded by an exit fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-shell-cwd-'));
  try {
    await mkdir(join(root, '.speedpatrol'));
    await mkdir(join(root, 'tools'));
    await writeFile(join(root, 'tools', 'review-tool'), '#!/bin/sh\nprintf tool-ran\n', { mode: 0o755 });
    const command = 'cd tools || exit 1; ./review-tool';
    const result = await promisify(execFile)('bash', ['-c', command], { cwd: root });
    expect(result.stdout).toBe('tool-ran');
    await writeFile(
      join(root, '.speedpatrol', 'speedpatrol.yml'),
      JSON.stringify({
        app: { setup: [{ run: command }] },
        agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
      }),
    );
    const lines: string[] = [];
    const ok = await doctor(root, (line) => lines.push(line));
    expect(lines.join('\n')).not.toContain('✗ ./review-tool: missing');
    expect(ok, lines.join('\n')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
