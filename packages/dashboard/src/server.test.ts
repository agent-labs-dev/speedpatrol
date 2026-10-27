import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Run, Store, type Summary } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Dashboard, startDashboard } from './server.js';

const summary = (median: number): Summary => ({
  n: 3,
  min: median - 1,
  max: median + 1,
  mean: median,
  median,
  p75: median + 0.5,
  p90: median + 0.8,
  p95: median + 0.9,
  p99: median + 1,
  stddev: 1,
  mad: 1,
  cv: 1 / median,
});

function run(id: string, sha: string, median: number): Run {
  return {
    id,
    purpose: 'baseline',
    startedAt: `2026-10-0${id.slice(-1)}T00:00:00.000Z`,
    finishedAt: `2026-10-0${id.slice(-1)}T00:01:00.000Z`,
    source: { dir: '/app', sha, dirty: false, subject: `commit ${sha}` },
    machine: {
      fingerprint: 'm1',
      hostname: 'h',
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'cpu',
      cpus: 4,
      memoryGb: 8,
      node: '22.0.0',
    },
    benchmarksHash: 'h',
    results: [
      {
        benchmark: 'api.items',
        kind: 'http',
        primary: 'total_ms',
        metrics: {
          total_ms: { unit: 'ms', better: 'lower', values: [median], summary: summary(median) },
        },
        iterations: 3,
        errors: [],
        durationMs: 100,
        critical: true,
      },
    ],
  };
}

/** The raw request line, so a `..` reaches the server instead of being normalised by a URL parser. */
function get(base: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((done, fail) => {
    request({ hostname, port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    })
      .on('error', fail)
      .end();
  });
}

describe('dashboard server', () => {
  let dir: string;
  let dashboard: Dashboard;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speedpatrol-dashboard-'));
    const store = new Store(dir);
    for (const [index, median] of [10, 10.2, 14].entries()) {
      const item = run(`r${index + 1}`, `sha${index + 1}`, median);
      await store.saveRun(item);
      await store.addBaseline({
        sha: item.source.sha,
        runId: item.id,
        machine: 'm1',
        benchmarksHash: 'h',
        at: item.finishedAt,
      });
    }
    dashboard = await startDashboard({ configDir: dir, port: 0 });
  });

  afterAll(async () => {
    await dashboard.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the benchmark trend over baseline commits', async () => {
    const { status, body } = await get(dashboard.url, '/api/benchmarks');
    expect(status).toBe(200);
    const [row] = JSON.parse(body).benchmarks;
    expect(row.series.map((point: { sha: string }) => point.sha)).toEqual(['sha1', 'sha2', 'sha3']);
    expect(row.latest.median).toBe(14);
    expect(row.deltaPct).toBeCloseTo(14 / 10.2 - 1);
  });

  it('reports the latest baseline in the overview and 404s an unknown run', async () => {
    const overview = JSON.parse((await get(dashboard.url, '/api/overview')).body);
    expect(overview.latest.sha).toBe('sha3');
    expect((await get(dashboard.url, '/api/runs/nope')).status).toBe(404);
  });

  it('serves the UI at /', async () => {
    const { status, body } = await get(dashboard.url, '/');
    expect(status).toBe(200);
    expect(body).toContain('<!doctype html>');
  });

  it('rejects path traversal', async () => {
    for (const path of ['/../package.json', '/..%2F..%2Fpackage.json', '/api/runs/..%2F..%2Fbaselines']) {
      const { status, body } = await get(dashboard.url, path);
      expect(status, path).toBe(400);
      expect(body).not.toContain('"name"');
    }
  });
});
