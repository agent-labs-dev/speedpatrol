import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT, loadConfig, Store } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBaseline } from './compare.js';
import { measure } from './runner.js';

describe('a failed critical benchmark alongside a measured speed-up', () => {
  let repo: string;
  const cli = resolve(import.meta.dirname, '../../cli/dist/bin.js');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: repo,
        stdio: 'pipe',
      },
    );

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'speedpatrol-critical-'));
    mkdirSync(join(repo, '.speedpatrol'));
    writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
    writeFileSync(
      join(repo, '.speedpatrol/speedpatrol.yml'),
      `version: 1
project: { name: critical-failure, source: . }
defaults: { iterations: 6, warmup: 0, rounds: 1 }
benchmarks:
  - id: critical.path
    kind: command
    critical: true
    run: node critical.cjs
    profile: { enabled: false }
  - id: faster.path
    kind: custom
    run: node faster.cjs
    metrics: { elapsed_ms: { unit: ms, better: lower } }
    profile: { enabled: false }
`,
    );
    writeFileSync(join(repo, 'critical.cjs'), 'process.exit(0);\n');
    writeFileSync(join(repo, 'faster.cjs'), 'console.log(JSON.stringify({metrics: {elapsed_ms: 100}}));\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'critical.cjs'), 'console.error("critical endpoint failed"); process.exit(1);\n');
    writeFileSync(join(repo, 'faster.cjs'), 'console.log(JSON.stringify({metrics: {elapsed_ms: 80}}));\n');
    git('commit', '-qam', 'broken critical path and faster secondary path');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it.each([0, 1])(
    'fails and refuses a baseline when a critical benchmark has no samples (warmup=%i)',
    async (warmup) => {
      const loaded = await loadConfig(repo);
      loaded.config.defaults.warmup = warmup;
      const store = new Store(loaded.dir);
      const run = await measure({ loaded, store, purpose: 'baseline', profile: false });
      expect(run.results.find((result) => result.benchmark === 'faster.path')?.metrics.elapsed_ms?.values).toHaveLength(
        6,
      );
      expect(run.failed).toContain('critical.path');
      expect(run.failed).toContain('critical endpoint failed');
      expect((await store.getRun(run.id))?.failed).toBe(run.failed);
      expect(await recordBaseline(store, run, { thresholds: loaded.config.thresholds, force: true })).toEqual({
        refused: `Run failed: ${run.failed}`,
      });
    },
  );

  it('still allows a non-critical benchmark to fail beside a successful measurement', async () => {
    const loaded = await loadConfig(repo);
    loaded.benchmarks[0]!.critical = false;
    const run = await measure({ loaded, store: new Store(loaded.dir), purpose: 'adhoc', profile: false });
    expect(run.results[0]?.errors.length).toBeGreaterThan(0);
    expect(run.failed).toBeUndefined();
  });

  it('compare exits 4 and names the failed head benchmark instead of reporting an improvement', () => {
    const result = spawnSync(
      process.execPath,
      [cli, 'compare', '--base', 'HEAD~1', '--rounds', '1', '--iterations', '6'],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(EXIT.infra);
    expect(result.stderr).toContain('working tree: Critical benchmark critical.path failed');
    expect(result.stderr).toContain('critical endpoint failed');
    expect(result.stdout).not.toContain('improvement');
    expect(result.stdout).not.toContain('0.0%');
  });
});
