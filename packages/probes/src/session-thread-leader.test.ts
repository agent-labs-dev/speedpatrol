import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { shellQuote, startBackground, waitUntil } from './exec.js';

/** The states of the process's threads, leader first; empty once it is gone. */
function threadStates(pid: number): string[] {
  try {
    const tids = readdirSync(`/proc/${pid}/task`).sort((a, b) => (Number(a) === pid ? -1 : Number(b) === pid ? 1 : 0));
    return tids.flatMap((tid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        return [stat.slice(stat.lastIndexOf(')') + 2)[0]!];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const liveThread = (pid: number) => threadStates(pid).some((state) => state !== 'Z' && state !== 'X');

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
  try {
    await waitUntil(() => threadStates(pid)[0] === 'Z' && liveThread(pid), 5000, 'the main thread to exit');
    await app.stop();
    // A killed orphan can stay a zombie where init does not reap, so only its threads' states count.
    await waitUntil(() => !liveThread(pid), 5000, 'the process to end');
  } finally {
    if (liveThread(pid)) process.kill(pid, 'SIGKILL');
  }
  expect(liveThread(pid)).toBe(false);
});
