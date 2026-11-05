import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { killTree, shellQuote, startBackground, waitUntil } from './exec.js';

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

it('stops a server group after its shell leader has exited', async () => {
  const script =
    "require('node:net').createServer(s => s.end()).listen(0, '127.0.0.1', function () { console.log(this.address().port); });";
  const background = startBackground(`${shellQuote(process.execPath)} -e ${shellQuote(script)} &`, process.cwd(), {});
  let port = 0;
  try {
    await waitUntil(
      () => {
        port = Number(background.output().trim());
        return background.child.exitCode === 0 && port > 0;
      },
      3000,
      'the shell to exit and the server to listen',
    );
    expect(await acceptsConnections(port)).toBe(true);
    await background.stop();
    await delay(100);
    expect(await acceptsConnections(port), 'stop() must release the server port even after the leader exits').toBe(
      false,
    );
  } finally {
    killTree(background.child, 'SIGKILL');
    if (port) await waitUntil(async () => !(await acceptsConnections(port)), 3000, 'the test server to stop');
  }
});
