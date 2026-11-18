import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { activeGroupCount, shellQuote, startBackground, waitUntil } from './exec.js';

it.skipIf(process.platform !== 'linux')('stops a session whose only process is already a zombie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-zombie-cleanup-'));
  // The supervisor is outside both tracked groups and keeps the exited session
  // leader as a zombie until cleanup. This does not depend on the host reaper.
  const script = [
    'import os, signal',
    'if os.fork(): os._exit(0)',
    'os.setsid()',
    'worker = os.fork()',
    'if worker == 0:',
    '    os.setsid()',
    '    os.write(3, (str(os.getpid()) + "\\n").encode())',
    '    os.close(3)',
    '    os._exit(0)',
    'os.close(3)',
    'os.waitid(os.P_PID, worker, os.WEXITED | os.WNOWAIT)',
    'def cleanup(signum, frame):',
    '    os.waitpid(worker, 0)',
    '    os._exit(0)',
    'signal.signal(signal.SIGUSR1, cleanup)',
    'print(os.getpid(), flush=True)',
    'while True: signal.pause()',
  ].join('\n');
  const app = startBackground(`exec python3 -c ${shellQuote(script)}`, dir, {}, { session: true });
  let supervisor: number | undefined;
  try {
    await waitUntil(() => app.child.exitCode !== null && /^\d+\s*$/.test(app.output()), 5000, 'the zombie session');
    supervisor = Number(app.output().trim());
    await expect(app.stop(), 'a session with no live process must stop successfully').resolves.toBeUndefined();
    expect(activeGroupCount(), 'the zombie-only session is retired').toBe(0);
  } finally {
    supervisor ??= Number(app.output().trim()) || undefined;
    if (supervisor !== undefined) process.kill(supervisor, 'SIGUSR1');
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
