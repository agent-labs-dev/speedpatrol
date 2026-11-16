import { interpolate } from '@speedpatrol/core';
import { quantile } from '@speedpatrol/stats';
import { timeEventStream } from './sse.js';
import type { ProbeFactory } from './types.js';

async function once(
  url: string,
  init: RequestInit,
  expectStatus: number,
  timeoutMs: number,
  stream?: { events: Record<string, string>; endEvent?: string },
): Promise<Record<string, number>> {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const ttfb = performance.now() - started;
  if (response.status !== expectStatus) {
    await response.body?.cancel();
    throw new Error(`${init.method} ${url}: status ${response.status}, expected ${expectStatus}`);
  }
  if (stream) return { ...(await timeEventStream(response, started, stream)), ttfb_ms: ttfb };
  const body = await response.arrayBuffer();
  return { ttfb_ms: ttfb, total_ms: performance.now() - started, bytes: body.byteLength };
}

/**
 * An API endpoint. Node's fetch keeps connections alive, so after the warmup
 * the samples measure the server, not the TCP and TLS handshakes.
 */
export const httpProbe: ProbeFactory<'http'> = (benchmark, context) => {
  const url = interpolate(benchmark.request.url, context.vars);
  const headers = Object.fromEntries(
    Object.entries(benchmark.request.headers).map(([key, value]) => [key, interpolate(value, context.vars)]),
  );
  const init: RequestInit = {
    method: benchmark.request.method,
    headers,
    body: benchmark.request.body === undefined ? undefined : interpolate(benchmark.request.body, context.vars),
  };
  const concurrent = benchmark.concurrency > 1;
  return {
    primary: 'total_ms',
    metrics: {
      total_ms: { unit: 'ms', better: 'lower' },
      ttfb_ms: { unit: 'ms', better: 'lower' },
      bytes: { unit: 'bytes', better: 'lower' },
      ...(benchmark.stream
        ? Object.fromEntries(
            ['first_event_ms', ...Object.keys(benchmark.stream.events)].map((name) => [
              name,
              { unit: 'ms' as const, better: 'lower' as const },
            ]),
          )
        : {}),
      ...(concurrent
        ? { p95_ms: { unit: 'ms', better: 'lower' } as const, rps: { unit: 'rps', better: 'higher' } as const }
        : {}),
    },
    async sample(): Promise<Record<string, number>> {
      if (!concurrent) {
        return once(url, init, benchmark.expectStatus, context.timeoutMs, benchmark.stream);
      }
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: benchmark.concurrency }, () =>
          once(url, init, benchmark.expectStatus, context.timeoutMs, benchmark.stream),
        ),
      );
      const wall = performance.now() - started;
      const totals = results.map((result) => result.total_ms!).sort((a, b) => a - b);
      const ttfbs = results.map((result) => result.ttfb_ms!).sort((a, b) => a - b);
      const streamed = benchmark.stream
        ? Object.fromEntries(
            ['first_event_ms', ...Object.keys(benchmark.stream.events)].map((name) => [
              name,
              quantile(
                results.map((result) => result[name]!).sort((a, b) => a - b),
                0.5,
              ),
            ]),
          )
        : {};
      return {
        ...streamed,
        total_ms: quantile(totals, 0.5),
        p95_ms: quantile(totals, 0.95),
        ttfb_ms: quantile(ttfbs, 0.5),
        bytes: results[0]!.bytes!,
        rps: (benchmark.concurrency * 1000) / wall,
      };
    },
  };
};
