import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkSchema } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { shellQuote } from './exec.js';
import { ptyProbe } from './probes/pty.js';

function stopped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
  } catch {
    return true;
  }
}

// How the app starts a child that outlives it: plainly, ignoring the hangup
// the terminal sends when it closes, and in a job of its own (another group).
const children = {
  plain: 'sleep 60 &',
  'ignoring SIGHUP': "(trap '' HUP; exec sleep 60) &",
  'in its own group': 'set -m; sleep 60 & set +m;',
};
const ends = {
  marker: { tail: 'printf SP_DONE; wait', error: undefined },
  timeout: { tail: 'wait', error: 'Timed out' },
  error: { tail: 'exit 3', error: 'Exited with code' },
};

describe.runIf(process.platform === 'linux')('pty process cleanup', () => {
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
        if (pid !== undefined && !stopped(pid)) process.kill(pid, 'SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
