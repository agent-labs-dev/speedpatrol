import { expect, it } from 'vitest';
import { shellQuote, startBackground, waitUntil } from './exec.js';

it.skipIf(process.platform !== 'linux')('stops a session whose main thread exited while a thread runs', async () => {
  // The session leader's main thread exits, so /proc/<pid>/stat reads Z, while a worker thread keeps the process alive.
  const script = [
    'import ctypes, os, threading, time',
    'if os.fork(): os._exit(0)',
    'os.setsid()',
    'os.write(3, (str(os.getpid()) + "\\n").encode())',
    'os.close(3)',
    'threading.Thread(target=lambda: time.sleep(600)).start()',
    'print(os.getpid(), flush=True)',
    'ctypes.CDLL(None).pthread_exit(None)',
  ].join('\n');
  const app = startBackground(`exec python3 -c ${shellQuote(script)}`, process.cwd(), {}, { session: true });
  await waitUntil(() => app.child.exitCode !== null && /^\d+\s*$/.test(app.output()), 5000, 'the session');
  const pid = Number(app.output().trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await waitUntil(() => alive(), 5000, 'the worker thread');
    await app.stop();
    await waitUntil(() => !alive(), 5000, 'the process to end');
  } finally {
    if (alive()) process.kill(pid, 'SIGKILL');
  }
  expect(alive()).toBe(false);
});
