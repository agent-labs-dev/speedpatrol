import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolResult } from './types.js';

type Options = {
  onCall?: (name: string, input: Record<string, unknown>, result: ToolResult, ms: number) => void;
  maxCalls?: number;
};

/** Runs one tool call under the step budget. `finish` is always allowed. */
export async function callTool(
  tools: Tool[],
  name: string,
  input: Record<string, unknown>,
  budget: { calls: number; max: number },
): Promise<ToolResult> {
  if (name !== 'finish') {
    if (budget.calls >= budget.max) return { text: 'The step budget is used. Call finish now.', isError: true };
    budget.calls++;
  }
  const tool = tools.find((item) => item.name === name);
  if (!tool) return { text: `Unknown tool ${name}`, isError: true };
  try {
    return await tool.run(input);
  } catch (error) {
    return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

/**
 * Serves a role's tools to a CLI agent over streamable HTTP. Stateless: each
 * request gets its own server and transport. The step budget lives out here,
 * so it holds across every session the CLI opens.
 */
export async function serveTools(
  tools: Tool[],
  options: Options = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const budget = { calls: 0, max: options.maxCalls ?? Number.POSITIVE_INFINITY };
  const running = new Map<string, Promise<ToolResult>>();
  const http = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    void handle(request, response, tools, options, budget, running).catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((done, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      done();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  tools: Tool[],
  options: Options,
  budget: { calls: number; max: number },
  running: Map<string, Promise<ToolResult>>,
): Promise<void> {
  const server = new Server({ name: 'speedpatrol', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const input = call.params.arguments ?? {};
    const started = Date.now();
    // A client that gave up on a slow call and calls again joins the first run:
    // the server never cancels a tool, so a second one would race it for the
    // same worktree and ports.
    const key = `${call.params.name}\0${JSON.stringify(input)}`;
    const joined = running.get(key);
    if (joined) {
      const result = await joined;
      return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError ?? false };
    }
    const pending = callTool(tools, call.params.name, input, budget);
    running.set(key, pending);
    const result = await pending.finally(() => running.delete(key));
    options.onCall?.(call.params.name, input, result, Date.now() - started);
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError ?? false };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}
