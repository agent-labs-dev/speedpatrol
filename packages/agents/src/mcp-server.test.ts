import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { serveTools } from './mcp-server.js';

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe('serveTools', () => {
  it('drains an in-flight measurement before closing the session', async () => {
    let start!: () => void;
    let release!: () => void;
    let completed = false;
    const started = new Promise<void>((done) => {
      start = done;
    });
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const mcp = await serveTools([
      {
        name: 'measure_change',
        description: 'slow',
        inputSchema: { type: 'object', properties: {} },
        async run() {
          start();
          await pending;
          completed = true;
          return { text: 'done' };
        },
      },
    ]);
    const client = await connect(mcp.url);
    const call = client.callTool({ name: 'measure_change', arguments: {} }).catch(() => undefined);
    await started;
    const timer = setTimeout(release, 100);
    try {
      await mcp.close();
      expect(completed).toBe(true);
    } finally {
      release();
      clearTimeout(timer);
      await call;
      await client.close();
    }
  });

  it('joins a repeated call to a tool that is still running instead of starting it again', async () => {
    let runs = 0;
    const mcp = await serveTools([
      {
        name: 'measure_change',
        description: 'slow',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          runs++;
          await new Promise((done) => setTimeout(done, 200));
          return { text: `run ${runs}` };
        },
      },
    ]);
    try {
      const [a, b] = [await connect(mcp.url), await connect(mcp.url)];
      const results = await Promise.all([
        a.callTool({ name: 'measure_change', arguments: {} }),
        b.callTool({ name: 'measure_change', arguments: {} }),
      ]);
      expect(runs).toBe(1);
      expect(results.map((r) => (r.content as { text: string }[])[0]!.text)).toEqual(['run 1', 'run 1']);
      // Once it has finished, the next call runs the tool again.
      await a.callTool({ name: 'measure_change', arguments: {} });
      expect(runs).toBe(2);
      await Promise.all([a.close(), b.close()]);
    } finally {
      await mcp.close();
    }
  });

  it('runs two exclusive calls with different inputs one after the other', async () => {
    let active = 0;
    let overlapped = false;
    const mcp = await serveTools([
      {
        name: 'measure_commit',
        description: 'slow',
        inputSchema: { type: 'object', properties: { sha: { type: 'string' } } },
        exclusive: true,
        run: async () => {
          active++;
          if (active > 1) overlapped = true;
          await new Promise((done) => setTimeout(done, 100));
          active--;
          return { text: 'done' };
        },
      },
    ]);
    try {
      const client = await connect(mcp.url);
      await Promise.all([
        client.callTool({ name: 'measure_commit', arguments: { sha: 'a' } }),
        client.callTool({ name: 'measure_commit', arguments: { sha: 'b' } }),
      ]);
      expect(overlapped).toBe(false);
      await client.close();
    } finally {
      await mcp.close();
    }
  });
});
