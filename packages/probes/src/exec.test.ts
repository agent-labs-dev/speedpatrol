import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeGroupCount, killAllGroups, killTree, runTimed, shellQuote, startBackground, waitUntil } from './exec.js';

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
    expect(() => process.kill(grandchild, 0)).toThrow();
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
