import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { activeGroupCount, killAllGroups, waitUntil } from './exec.js';
import { measure } from './runner.js';

// The app under test: answers /health, writes its pid, and fails to start when the port is taken.
const SERVER = `const fs = require('node:fs');
require('node:http')
  .createServer((_, res) => res.end('ok'))
  .listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync('server.pid', String(process.pid)));
`;

let dir: string;
let busy: Server;
let busyPort: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'speedpatrol-busy-'));
  mkdirSync(join(dir, '.speedpatrol'));
  writeFileSync(join(dir, 'server.cjs'), SERVER);
  busy = createServer((_, res) => res.end('someone else'));
  await new Promise<void>((done) => busy.listen(0, '127.0.0.1', done));
  busyPort = (busy.address() as AddressInfo).port;
});

afterEach(async () => {
  killAllGroups('SIGKILL');
  await waitUntil(() => activeGroupCount() === 0, 5000, 'test processes to stop');
});

afterAll(async () => {
  await new Promise((done) => busy.close(done));
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

async function run(config: string) {
  writeFileSync(
    join(dir, '.speedpatrol/speedpatrol.yml'),
    `version: 1
project: { name: busy, source: . }
defaults: { iterations: 1, warmup: 0 }
${config}`,
  );
  const loaded = await loadConfig(dir);
  return measure({ loaded, store: new Store(loaded.dir), purpose: 'baseline', profile: false });
}

it('fails before setup when the ready URL already answers', async () => {
  const measured = await run(`app:
  setup:
    - run: PORT=${busyPort} exec node server.cjs
      background: true
      readyUrl: http://127.0.0.1:${busyPort}/health
benchmarks:
  - id: api
    kind: http
    request: { url: "http://127.0.0.1:${busyPort}/health" }
`);
  expect(measured.failed).toContain(`http://127.0.0.1:${busyPort}/health already answers before`);
  expect(measured.results).toEqual([]);
});

it('fails the run when a background setup process exits after it was ready', async () => {
  const port = await freePort();
  const measured = await run(`app:
  setup:
    - run: PORT=${port} exec node server.cjs
      background: true
      readyUrl: http://127.0.0.1:${port}/health
benchmarks:
  - id: crash
    kind: command
    # Kills the app, then waits until it is reaped, so the check after the benchmark sees it gone.
    run: pid=$(cat server.pid); kill -9 $pid; while kill -0 $pid 2>/dev/null; do sleep 0.01; done
`);
  expect(measured.failed).toMatch(
    /Background setup command exited during the run \(SIGKILL\): PORT=\d+ exec node server\.cjs/,
  );
  expect(measured.results).toEqual([]);
});

it('does not time a startup whose ready URL another process already answers', async () => {
  const measured = await run(`benchmarks:
  - id: startup
    kind: startup
    run: exec node server.cjs
    env: { PORT: "${busyPort}" }
    ready: { url: "http://127.0.0.1:${busyPort}/health" }
`);
  const [result] = measured.results;
  expect(result?.metrics).toEqual({});
  expect(result?.errors[0]).toContain(`http://127.0.0.1:${busyPort}/health already answers before`);
});
