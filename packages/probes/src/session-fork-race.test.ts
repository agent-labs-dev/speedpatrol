import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { activeGroupCount, shellQuote, startBackground, waitUntil } from './exec.js';
import { ptyCommand } from './probes/pty.js';

const race = vi.hoisted(() => ({ afterSnapshot: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      const snapshot = fs.readdirSync(...args);
      if (args[0] === '/proc') race.afterSnapshot?.();
      return snapshot;
    },
  };
});

it.skipIf(process.platform !== 'linux')('keeps tracking a session when both readings race with a fork', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-fork-race-'));
  const pidFile = join(dir, 'worker.pid');
  // Each USR1 replaces the worker with its child, in the same session and group.
  // Publish the new pid only once the old process has exited.
  const worker = [
    'import os, signal, time',
    `path = ${JSON.stringify(pidFile)}`,
    'signal.signal(signal.SIGHUP, signal.SIG_IGN)',
    'def publish():',
    '    with open(path + ".tmp", "w") as f: f.write(str(os.getpid()))',
    '    os.replace(path + ".tmp", path)',
    'def replace(signum, frame):',
    '    parent = os.getpid()',
    '    if os.fork(): os._exit(0)',
    '    while os.getppid() == parent: time.sleep(0.001)',
    '    publish()',
    'signal.signal(signal.SIGUSR1, replace)',
    'if os.fork(): os._exit(0)',
    'publish()',
    'while True: signal.pause()',
  ].join('\n');
  const app = startBackground(
    ptyCommand(`exec python3 -c ${shellQuote(worker)}`, 80, 24),
    process.cwd(),
    {},
    {
      input: true,
      session: true,
    },
  );
  try {
    await waitUntil(
      () => app.child.exitCode !== null && Number(readFileSync(pidFile, 'utf8')) > 0,
      5000,
      'the wrapper to exit and the worker to start',
    );
    expect(activeGroupCount()).toBe(1);
    let snapshots = 0;
    race.afterSnapshot = () => {
      snapshots++;
      if (snapshots > 2) return;
      // The listing is real. Force exactly the race under review: the listed
      // parent exits and its unlisted child survives before stat files are read.
      execFileSync(
        'python3',
        [
          '-c',
          [
            'import os, signal, time',
            `path = ${JSON.stringify(pidFile)}`,
            'old = int(open(path).read())',
            'os.kill(old, signal.SIGUSR1)',
            'while int(open(path).read()) == old: time.sleep(0.001)',
          ].join('\n'),
        ],
        { timeout: 3000 },
      );
    };
    const count = activeGroupCount();
    race.afterSnapshot = undefined;
    expect(snapshots).toBeGreaterThan(0);
    const survivor = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(survivor, 0)).not.toThrow();
    expect(count, 'a live worker in the remembered session must remain tracked for shutdown').toBeGreaterThan(0);
  } finally {
    race.afterSnapshot = undefined;
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      /* The worker may already have exited. */
    }
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
