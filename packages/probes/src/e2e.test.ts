import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abCompare, checkout, compareWithBaseline, recordBaseline } from './compare.js';
import { measure } from './runner.js';

const fixture = resolve(import.meta.dirname, '../../../examples/fixture-app');

function gitIn(dir: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
  });
}

/**
 * The whole measuring path against real processes and a real Chromium: the
 * fixture app's server, page, CLI and script, then a commit that makes
 * `work()` slower, which an A/B compare must flag on the benchmarks that call
 * it and on no other.
 */
describe('measure and compare the fixture app', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'speedpatrol-e2e-'));
    cpSync(fixture, repo, { recursive: true, filter: (path) => !path.includes('/.speedpatrol/runs') });
    writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'fixture');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('measures every probe kind and records a baseline', async () => {
    const loaded = await loadConfig(repo);
    const store = new Store(loaded.dir);
    const run = await measure({ loaded, store, purpose: 'baseline', iterations: 6 });
    expect(run.failed).toBeUndefined();
    const byId = Object.fromEntries(run.results.map((result) => [result.benchmark, result]));
    for (const result of run.results) expect(result.errors, result.benchmark).toEqual([]);
    expect(byId['api.items']!.metrics.total_ms!.values).toHaveLength(6);
    expect(byId['web.home']!.metrics).toHaveProperty('fcp_ms');
    expect(byId['web.home']!.metrics).toHaveProperty('step.open-settings_ms');
    expect(byId['web.home']!.primary).toBe('flow_ms');
    expect(byId['startup.server']!.metrics.ready_ms!.summary.median).toBeGreaterThan(0);
    expect(byId['cli.work']!.metrics).toHaveProperty('cpu_user_ms');
    expect(byId['script.work']!.metrics).toHaveProperty('work_ms');
    // The CLI's profile names the function that does the work.
    expect(byId['cli.work']!.profile?.hotspots?.map((spot) => spot.function)).toContain('work');
    const web = byId['web.home']!.profile;
    expect(web?.kind).toBe('cpuprofile');
    expect(await recordBaseline(store, run)).toMatchObject({ sha: run.source.sha });
  });

  it('flags a slower work() on the benchmarks that call it, and only those', async () => {
    const work = join(repo, 'work.js');
    writeFileSync(work, readFileSync(work, 'utf8').replace('ROUNDS = 20000', 'ROUNDS = 2000000'));
    gitIn(repo, 'commit', '-q', '-am', 'slower work');
    const loaded = await loadConfig(repo);
    const store = new Store(loaded.dir);
    const base = await checkout(repo, store, 'HEAD~1');
    const { comparison } = await abCompare({
      loaded,
      store,
      base: { label: 'main~1', dir: base.dir },
      head: { label: 'main', dir: repo },
      only: ['api.items', 'api.health', 'cli.work'],
      iterations: 10,
      rounds: 2,
    });
    const verdict = (benchmark: string) =>
      comparison.metrics.find((metric) => metric.benchmark === benchmark && metric.primary)?.verdict;
    expect(verdict('api.items')).toBe('regression');
    expect(verdict('cli.work')).toBe('regression');
    expect(verdict('api.health')).not.toBe('regression');
    expect(comparison.verdict).toBe('regression');

    // The baseline path finds the earlier commit's baseline on this machine.
    const run = await measure({ loaded, store, purpose: 'baseline', only: ['api.items'], iterations: 10 });
    const againstBaseline = await compareWithBaseline(loaded, store, run);
    expect(againstBaseline?.base.sha).not.toBe(run.source.sha);
    expect(againstBaseline?.metrics.find((metric) => metric.primary)?.verdict).toBe('regression');
  });
});
