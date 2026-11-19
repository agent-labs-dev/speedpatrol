import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkSchema } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { activeGroupCount, killAllGroups, shellQuote, startBackground, waitUntil } from './exec.js';
import { ptyCommand, ptyProbe } from './probes/pty.js';

/** Whether the process is gone or a zombie. */
function stopped(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
    }
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state === '' || /^[ZX]/.test(state);
  } catch {
    return true;
  }
}

// How the app starts a child that outlives it: plainly, ignoring the hangup
// the terminal sends when it closes, in a job of its own (another group), and
// in a job of its own that ignores the hangup.
const children = {
  plain: 'sleep 60 &',
  'ignoring SIGHUP': "(trap '' HUP; exec sleep 60) &",
  'in its own group': 'set -m; sleep 60 & set +m;',
  'in its own group ignoring SIGHUP': "set -m; (trap '' HUP; exec sleep 60) & set +m;",
};
const ends = {
  marker: { tail: 'printf SP_DONE; wait', error: undefined },
  timeout: { tail: 'wait', error: 'Timed out' },
  error: { tail: 'exit 3', error: 'Exited with code' },
};

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('pty process cleanup', () => {
  it.each(Object.keys(children).flatMap((child) => Object.keys(ends).map((end) => [child, end])))(
    'stops a child started %s after the %s',
    async (child, end) => {
      const dir = await mkdtemp(join(tmpdir(), 'pty-cleanup-'));
      const pidFile = join(dir, 'child.pid');
      const { tail, error } = ends[end as keyof typeof ends];
      let pid: number | undefined;
      try {
        const benchmark = benchmarkSchema.parse({
          id: 'tui',
          kind: 'pty',
          run: `${children[child as keyof typeof children]} echo $! > ${shellQuote(pidFile)}; ${tail}`,
          marker: 'SP_DONE',
        });
        if (benchmark.kind !== 'pty') throw new Error('Expected pty');
        const sample = ptyProbe(benchmark, {
          source: process.cwd(),
          vars: {},
          timeoutMs: 1000,
          log: () => {},
        }).sample();
        if (error) await expect(sample).rejects.toThrow(error);
        else await expect(sample).resolves.toHaveProperty('marker_ms');
        pid = Number((await readFile(pidFile, 'utf8')).trim());
        // The sample resolves only after cleanup, so the child is already gone (a zombie at most).
        expect(stopped(pid)).toBe(true);
      } finally {
        // A failed assertion above still leaves the child to clean up, if the app started it.
        pid ??= Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || undefined;
        if (pid !== undefined && !stopped(pid)) process.kill(pid, 'SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('tracks the session for shutdown until its last process stops', async () => {
    // The leader exits at once, so its group empties; the job lives on in a group of its own.
    const command = ptyCommand('set -m; (trap \'\' HUP; exec sleep 60) & echo "job $!"', 80, 24);
    const app = startBackground(command, process.cwd(), {}, { input: true, session: true });
    let pid: number | undefined;
    try {
      await waitUntil(() => /job \d+/.test(app.output()), 5000, 'the job pid');
      pid = Number(app.output().match(/job (\d+)/)![1]);
      await waitUntil(() => app.child.exitCode !== null, 5000, 'the session leader to exit');
      expect(stopped(pid)).toBe(false);
      expect(app.running()).toBe(true);
      expect(activeGroupCount()).toBeGreaterThan(0);
      killAllGroups('SIGKILL');
      await waitUntil(() => activeGroupCount() === 0, 5000, 'the session to empty');
      expect(stopped(pid)).toBe(true);
    } finally {
      if (pid !== undefined && !stopped(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
