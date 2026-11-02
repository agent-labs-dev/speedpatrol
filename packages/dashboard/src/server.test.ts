import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comparison, regression, result, run } from './fixtures.js';
import { type Dashboard, startDashboard } from './server.js';

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

const getJson = async (base: string, path: string) => JSON.parse((await get(base, path)).body);

const BENCHMARKS = [
  { id: 'api.items', kind: 'http', critical: true, request: { url: 'http://localhost:3000/items' } },
  { id: 'web.home', kind: 'web', url: 'http://localhost:3000/' },
  { id: 'web.checkout', kind: 'web', url: 'http://localhost:3000/checkout' },
];

describe('dashboard server', () => {
  let dir: string;
  let dashboard: Dashboard;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speedpatrol-dashboard-'));
    await writeFile(join(dir, 'speedpatrol.yml'), 'version: 1\nproject:\n  name: demo\n');
    await writeFile(join(dir, 'benchmarks.json'), JSON.stringify({ benchmarks: BENCHMARKS }));
    const store = new Store(dir);
    const baselines = [10, 10.2, 14].map((median, index) =>
      run(`r${index + 1}`, index + 1, [result('api.items', median, { critical: true }), result('web.home', 5)]),
    );
    for (const item of baselines) {
      await store.saveRun(item);
      await store.addBaseline({
        sha: item.source.sha,
        runId: item.id,
        machine: 'm1',
        benchmarksHash: 'h',
        at: item.finishedAt,
      });
    }
    // A later baseline whose app did not come up: the store keeps it out of the trend.
    await store.saveRun(run('r4', 4, [], { failed: 'The app did not come up.' }));
    await store.saveComparison(comparison('c1', baselines[1]!, baselines[2]!, 'regression'));
    await store.saveRegression(regression('reg1', { comparisonId: 'c1' }));
    // A session with no finish event, and no live agent that owns it.
    await store.appendEvent({
      at: '2026-10-03T00:00:00.000Z',
      sessionId: 's1',
      role: 'optimizer',
      kind: 'start',
      summary: 'Try a speed-up',
    });
    await store.appendEvent({
      at: '2026-10-03T00:00:09.000Z',
      sessionId: 's1',
      role: 'optimizer',
      kind: 'tool-call',
      summary: 'Edit',
      tool: 'edit_file',
    });
    dashboard = await startDashboard({ configDir: dir, port: 0 });
  });

  afterAll(async () => {
    await dashboard.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves one summary with the failed last run, the open regression, and the coverage', async () => {
    const summary = await getJson(dashboard.url, '/api/summary');
    expect(summary.name).toBe('demo');
    expect(summary.lastRun).toMatchObject({ id: 'r4', failed: 'The app did not come up.' });
    expect(summary.verdict.tone).toBe('fail');
    expect(summary.regressions.open).toBe(1);
    expect(summary.benchmarks).toMatchObject({ defined: 3, measured: 2, unmeasured: ['web.checkout'] });
    expect(summary.attention.map((item: { title: string }) => item.title)).toEqual([
      'The last run failed',
      'api.items got 30% slower',
      '1 benchmark has no baseline',
    ]);
  });

  it('serves the benchmark trend, problems first, with a row for each defined benchmark', async () => {
    const { benchmarks } = await getJson(dashboard.url, '/api/benchmarks');
    expect(benchmarks.map((row: { id: string; problem?: string }) => [row.id, row.problem ?? null])).toEqual([
      ['api.items', 'regression'],
      ['web.checkout', 'unmeasured'],
      ['web.home', null],
    ]);
    const [items] = benchmarks;
    expect(items.series.map((point: { sha: string }) => point.sha)).toEqual(['sha-r1', 'sha-r2', 'sha-r3']);
    expect(items.latest.median).toBe(14);
    expect(items.deltaPct).toBeCloseTo(14 / 10.2 - 1);
    expect(items.regression).toMatchObject({ id: 'reg1', status: 'open' });
  });

  it('marks each run with its comparison, and the oldest baseline as the first', async () => {
    const runs = await getJson(dashboard.url, '/api/runs');
    const byId = Object.fromEntries(runs.map((item: { id: string }) => [item.id, item]));
    expect(runs[0].id).toBe('r4');
    expect(byId.r4.failed).toBe('The app did not come up.');
    expect(byId.r3.comparison).toEqual({ id: 'c1', verdict: 'regression', mode: 'baseline' });
    expect(byId.r1.first).toBe(true);
    expect(byId.r2.first).toBe(false);
  });

  it('shows a session with no finish and no live agent as stopped, not running', async () => {
    const [session] = await getJson(dashboard.url, '/api/sessions');
    expect(session).toMatchObject({
      id: 's1',
      state: 'stopped',
      goal: 'Try a speed-up',
      toolCalls: 1,
      durationMs: 9000,
    });
    const events = await getJson(dashboard.url, '/api/sessions/s1/events');
    expect(events).toHaveLength(2);
  });

  it('reports a config that does not load in the summary, and still serves the data', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'speedpatrol-dashboard-'));
    await writeFile(join(broken, 'speedpatrol.yml'), 'version: 7\n');
    const other = await startDashboard({ configDir: broken, port: 0 });
    try {
      const summary = await getJson(other.url, '/api/summary');
      expect(summary.verdict.text).toBe('Config error');
      expect(summary.configError).toContain('speedpatrol.yml');
      expect((await get(other.url, '/api/benchmarks')).status).toBe(200);
    } finally {
      await other.close();
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('404s an unknown run and an unknown route', async () => {
    expect((await get(dashboard.url, '/api/runs/nope')).status).toBe(404);
    expect((await get(dashboard.url, '/api/overview')).status).toBe(404);
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
