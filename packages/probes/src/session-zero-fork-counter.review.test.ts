import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { activeGroupCount, shellQuote, startBackground, waitUntil } from './exec.js';

const race = vi.hoisted(() => ({
  afterSnapshot: undefined as (() => void) | undefined,
  counter: 0n,
  // Once the assertions are made, the count advances again (offset by the stuck value, so it
  // passes the count read before the spawn), so the stop can prove a zombie-only session empty
  // even where no init reaps orphans.
  advancing: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    // gVisor exposes /proc/stat but reports an unsupported fork counter as zero; a counter can
    // also be stuck at another value. Either way it never advances.
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      return args[0] === '/proc/stat' && typeof result === 'string'
        ? result.replace(
            /^processes (\d+)$/m,
            (_, real: string) => `processes ${race.counter + (race.advancing ? BigInt(real) : 0n)}`,
          )
        : result;
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      const snapshot = fs.readdirSync(...args);
      if (args[0] === '/proc') race.afterSnapshot?.();
      return snapshot;
    },
  };
});

it.skipIf(process.platform !== 'linux').each([0n, 123456n])(
  'retains a fork-raced session when proc stat exposes a fork counter stuck at %s',
  async (counter) => {
    race.counter = counter;
    race.advancing = false;
    const dir = mkdtempSync(join(tmpdir(), 'session-zombie-fork-'));
    const pidFile = join(dir, 'worker.pid');
    // The supervisor remains outside the reported session and deliberately does
    // not wait for its child, making the zombie independent of the host's init.
    const script = [
      'import os, signal, time',
      `path = ${JSON.stringify(pidFile)}`,
      'if os.fork():',
      '    os.close(3)',
      '    while True: signal.pause()',
      'os.setsid()',
      'os.write(3, (str(os.getpid()) + "\\n").encode())',
      'os.close(3)',
      'def publish():',
      '    with open(path + ".tmp", "w") as f: f.write(str(os.getpid()))',
      '    os.replace(path + ".tmp", path)',
      'def replace(signum, frame):',
      '    parent = os.getpid()',
      '    if os.fork(): os._exit(0)',
      '    while os.getppid() == parent: time.sleep(0.001)',
      '    publish()',
      'signal.signal(signal.SIGUSR1, replace)',
      'publish()',
      'while True: signal.pause()',
    ].join('\n');
    const app = startBackground(`exec python3 -c ${shellQuote(script)}`, process.cwd(), {}, { session: true });
    try {
      await waitUntil(
        () => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0,
        5000,
        'the session worker',
      );
      const before = activeGroupCount();
      expect(before).toBe(2);
      let snapshots = 0;
      race.afterSnapshot = () => {
        // The first reading checks the supervisor's group; the second reads
        // the session. Fork only after the session's pid listing is captured.
        if (++snapshots !== 2) return;
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
      const after = activeGroupCount();
      race.afterSnapshot = undefined;
      expect(snapshots).toBe(2);
      const survivor = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(survivor, 0)).not.toThrow();
      expect(after, 'the surviving session must remain tracked alongside the supervisor group').toBe(before);
    } finally {
      race.afterSnapshot = undefined;
      race.advancing = true;
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        /* The worker may already have exited. */
      }
      try {
        await app.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
