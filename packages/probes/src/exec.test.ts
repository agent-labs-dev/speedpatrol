import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { activeGroupCount, killAllGroups, killTree, startBackground, waitUntil } from './exec.js';

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
