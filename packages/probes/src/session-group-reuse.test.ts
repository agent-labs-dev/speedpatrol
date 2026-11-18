import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { activeGroupCount, shellQuote, startBackground, waitUntil } from './exec.js';

it.skipIf(process.platform === 'win32')('drops a session once its group id belongs to another session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-group-reuse-'));
  const pidFile = join(dir, 'group.pid');
  // The reported id names a live group of the shell's own session, not a session:
  // the reading shows that group in another session, as a reused id would be.
  const group = [
    'import os, signal',
    'os.setpgid(0, 0)',
    `open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))`,
    'os.write(3, (str(os.getpid()) + "\\n").encode())',
    'os.close(3)',
    'signal.pause()',
  ].join('\n');
  const app = startBackground(`python3 -c ${shellQuote(group)}; :`, process.cwd(), {}, { session: true });
  try {
    await waitUntil(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0, 5000, 'the group to start');
    await waitUntil(() => activeGroupCount() === 1, 5000, 'the session to be dropped');
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      /* Not started, or already gone. */
    }
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
