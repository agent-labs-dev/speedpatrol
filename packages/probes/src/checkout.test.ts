import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { Store } from '@speedpatrol/core';
import { expect, test, vi } from 'vitest';
import { checkout, removeCheckout } from './compare.js';

test('measured source copies live outside the repository and remain reusable', async () => {
  const scratch = join(homedir(), '.cache', 'agent-scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'speedpatrol-checkout-'));
  const repo = join(root, 'repo');
  let worktree: string | undefined;
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'source.ts'), 'export const measured = true;\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repo },
    );
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    const store = new Store(join(repo, '.speedpatrol'));
    const first = await checkout(repo, store, 'HEAD');
    worktree = first.dir;
    expect(relative(repo, first.dir).startsWith('..')).toBe(true);
    expect(await readFile(join(first.dir, 'source.ts'), 'utf8')).toContain('measured');
    expect(await checkout(repo, store, 'HEAD')).toEqual(first);
    expect(store.path('runs')).toBe(join(repo, '.speedpatrol', 'runs', 'runs'));
  } finally {
    vi.unstubAllEnvs();
    if (worktree) await removeCheckout(repo, worktree);
    await rm(root, { recursive: true, force: true });
  }
});
