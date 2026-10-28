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
});
