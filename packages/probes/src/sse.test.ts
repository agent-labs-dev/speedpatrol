import { once } from 'node:events';
import { createServer } from 'node:http';
import { benchmarkSchema } from '@speedpatrol/core';
import { expect, it } from 'vitest';
import { httpProbe } from './probes/http.js';
import { EventFrames, timeEventStream } from './probes/sse.js';

it('frames SSE independently of chunks, line endings, comments and empty data', () => {
  const seen: string[] = [];
  const frames = new EventFrames((name) => seen.push(name));
  for (const char of ': keepalive\r\n\r\nevent: token\rdata: é\r\nevent: token\r\n\r\ndata\n\nevent: incomplete\ndata: lost')
    frames.push(char);
  expect(seen).toEqual(['token', 'message']);
});

it('times actual streamed events and cancels an open connection at completion', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write(': heartbeat\n\n');
    const first = setTimeout(() => response.write('event: token\ndata: hello\n\n'), 20);
    const second = setTimeout(() => response.write('event: tool\ndata: {}\n\nevent: done\ndata: {}\n\n'), 40);
    response.on('close', () => {
      clearTimeout(first);
      clearTimeout(second);
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const benchmark = benchmarkSchema.parse({
      id: 'turn',
      kind: 'http',
      request: { url: `http://127.0.0.1:${address.port}` },
      stream: { events: { ttft_ms: 'token', tool_ms: 'tool' }, endEvent: 'done' },
    });
    if (benchmark.kind !== 'http') throw new Error('Expected HTTP');
    const probe = httpProbe(benchmark, { source: '.', vars: {}, timeoutMs: 1000, log: () => {} });
    const result = await probe.sample();
    expect(result.ttfb_ms).toBeLessThan(result.first_event_ms!);
    expect(result.first_event_ms).toBe(result.ttft_ms);
    expect(result.tool_ms).toBeGreaterThan(result.ttft_ms!);
    expect(result.total_ms).toBeGreaterThanOrEqual(result.tool_ms!);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects absent events and does not treat EOF as dispatch', async () => {
  const response = new Response('event: token\ndata: unfinished', { headers: { 'Content-Type': 'text/event-stream' } });
  await expect(timeEventStream(response, performance.now(), { events: { ttft_ms: 'token' } })).rejects.toThrow(
    'without a complete',
  );
  const complete = new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  await expect(timeEventStream(complete, performance.now(), { events: { tool_ms: 'tool' } })).rejects.toThrow(
    'configured event: tool',
  );
});

it('rejects reserved metrics and non-SSE responses', async () => {
  expect(() =>
    benchmarkSchema.parse({
      id: 'bad',
      kind: 'http',
      request: { url: 'http://localhost' },
      stream: { events: { total_ms: 'token' } },
    }),
  ).toThrow();
  await expect(timeEventStream(new Response('html'), performance.now(), { events: {} })).rejects.toThrow(
    'Content-Type',
  );
});
