import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeGroupCount,
  killAllGroups,
  killTree,
  parseProcessRows,
  psProcesses,
  runTimed,
  shellQuote,
  startBackground,
  waitUntil,
} from './exec.js';

/** Whether the process is gone or a zombie: a killed orphan stays a zombie until its reaper waits for it. */
function stopped(pid: number): boolean {
  const signalable = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalable()) return true;
  let state: string;
  try {
    if (process.platform === 'linux') {
      // "pid (comm) state ...": comm can hold spaces and ")".
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2);
    } else {
      state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    }
  } catch {
    return !signalable(); // Reaped since the first check.
  }
  return state.startsWith('Z') || state.startsWith('X');
}

describe('process group cleanup', () => {
  let child: ReturnType<typeof startBackground> | undefined;

  afterEach(async () => {
    if (!child) return;
    killTree(child.child, 'SIGKILL');
    if (child.child.exitCode === null && child.child.signalCode === null) await once(child.child, 'exit');
    child = undefined;
  });

  it('kills a detached background child and tolerates repeated cleanup', async () => {
    child = startBackground(`${process.execPath} -e "setInterval(() => {}, 1000)"`, process.cwd(), {});
    const pid = child.child.pid;
    expect(pid).toBeDefined();
    killAllGroups('SIGTERM');
    await once(child.child, 'exit');
    expect(() => killAllGroups('SIGTERM')).not.toThrow();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('still tracks and kills a group whose leader exited first', async () => {
    const survivor = `${process.execPath} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`;
    child = startBackground(`${survivor} & echo $!`, process.cwd(), {});
    const leader = child;
    await waitUntil(() => leader.child.exitCode !== null && leader.output().trim() !== '', 2000, 'the leader to exit');
    const grandchild = Number(child.output().trim());
    expect(activeGroupCount()).toBeGreaterThan(0);
    killAllGroups('SIGTERM');
    killAllGroups('SIGKILL');
    await waitUntil(() => activeGroupCount() === 0, 2000, 'the group to die');
    expect(stopped(grandchild)).toBe(true);
  });

  // A zombie stays in its group until its parent waits for it. Here the
  // parent moves to its own group and never waits, as a container init that
  // does not reap orphans would, so only a zombie is left in the setup group.
  it.skipIf(process.platform !== 'linux')('treats a group of only zombies as stopped', async () => {
    const script = [
      'import os, time',
      'group = os.getpgid(0)',
      'os.setpgid(0, 0)',
      'pid = os.fork()',
      'if pid == 0:',
      '    os.setpgid(0, group)',
      '    os._exit(0)',
      'os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)',
      'print(os.getpid(), flush=True)',
      'time.sleep(60)',
    ].join('\n');
    child = startBackground(`python3 -c ${shellQuote(script)} & wait`, process.cwd(), {});
    const background = child;
    await waitUntil(() => background.output().trim() !== '', 5000, 'the zombie to exist');
    const parent = Number(background.output().trim());
    try {
      process.kill(-background.child.pid!, 'SIGKILL');
      await waitUntil(() => !background.running(), 2000, 'the zombie-only group to read as stopped');
    } finally {
      process.kill(parent, 'SIGKILL');
    }
  });
});

describe('package-manager launcher environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['timed', 'background'])('%s commands do not inherit the launcher user agent', async (mode) => {
    vi.stubEnv('npm_config_user_agent', 'npm/12.2.1');
    vi.stubEnv('SPEEDPATROL_TEST_INHERITED', 'kept');
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(
      'if (process.env.npm_config_user_agent) process.exit(1); console.log(process.env.SPEEDPATROL_TEST_INHERITED);',
    )}`;
    if (mode === 'timed') {
      const result = await runTimed({ command, cwd: process.cwd(), timeoutMs: 5000 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('kept');
    } else {
      const child = startBackground(command, process.cwd(), {});
      try {
        const [code] = await once(child.child, 'close');
        expect(code).toBe(0);
        expect(child.output().trim()).toBe('kept');
      } finally {
        await child.stop();
      }
    }
    expect(process.env.npm_config_user_agent).toBe('npm/12.2.1');
  });

  it.each(['timed', 'background'])('%s commands preserve an explicitly configured user agent', async (mode) => {
    vi.stubEnv('npm_config_user_agent', 'npm/12.2.1');
    const command = `${shellQuote(process.execPath)} -e ${shellQuote('console.log(process.env.npm_config_user_agent)')}`;
    const env = { npm_config_user_agent: 'explicit-test-agent' };
    if (mode === 'timed') {
      const result = await runTimed({ command, cwd: process.cwd(), env, timeoutMs: 5000 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('explicit-test-agent');
    } else {
      const child = startBackground(command, process.cwd(), env);
      try {
        const [code] = await once(child.child, 'close');
        expect(code).toBe(0);
        expect(child.output().trim()).toBe('explicit-test-agent');
      } finally {
        await child.stop();
      }
    }
  });
});

describe('process table from ps and getsid', () => {
  it('parses "pid pgid sid state" rows and skips any other shape', () => {
    expect(
      parseProcessRows('  412   400   390 S+\n9 9 9 Ss\n\nPID PGID SID STAT\n7 7 -1 S\n5 5 5\n6 6 6 R extra\n'),
    ).toEqual([
      { pid: 412, pgrp: 400, session: 390, state: 'S+' },
      { pid: 9, pgrp: 9, session: 9, state: 'Ss' },
    ]);
  });

  // The ps and getsid path serves macOS. Linux has a getsid syscall too, so
  // the same script runs here and must agree with the session ids in /proc.
  const linuxGetsid = { x64: 124, arm64: 156 }[arch()];
  it.runIf(process.platform === 'linux' && linuxGetsid !== undefined)('agrees with /proc on Linux', () => {
    const fromPs = psProcesses(linuxGetsid);
    expect(fromPs?.some((p) => p.pid === process.pid)).toBe(true);
    for (const p of fromPs!) {
      let stat: string;
      try {
        stat = readFileSync(`/proc/${p.pid}/stat`, 'utf8');
      } catch {
        continue; // Exited since the listing.
      }
      const [, , pgrp, session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      expect({ pid: p.pid, pgrp: p.pgrp, session: p.session }).toEqual({
        pid: p.pid,
        pgrp: Number(pgrp),
        session: Number(session),
      });
    }
  });

  it.runIf(process.platform === 'darwin')('lists this process with its session on macOS', () => {
    const self = psProcesses()?.find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.session).toBeGreaterThan(0);
  });
});
