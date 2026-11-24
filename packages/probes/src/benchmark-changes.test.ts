import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { comparisonMarkdown, signTestRounds } from '@speedpatrol/stats';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { changedBenchmarks } from './benchmark-changes.js';
import { abCompare, checkout } from './compare.js';

let cache: string;
beforeAll(() => {
  cache = mkdtempSync(join(tmpdir(), 'speedpatrol-bench-changes-cache-'));
  vi.stubEnv('XDG_CACHE_HOME', cache);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
});

function gitIn(dir: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
  });
}

describe('changed benchmark detection in abCompare (#73)', () => {
  it('reports not_comparable instead of regression when a PR adds work to a benchmark script', {
    timeout: 60_000,
  }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'speedpatrol-issue73-'));
    try {
      mkdirSync(join(repo, '.speedpatrol'), { recursive: true });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
      writeFileSync(
        join(repo, '.speedpatrol/speedpatrol.yml'),
        [
          'version: 1',
          'project:',
          '  name: demo',
          '  source: .',
          'defaults:',
          '  iterations: 5',
          '  warmup: 1',
          'benchmarks:',
          '  - id: plan.bench',
          '    kind: command',
          '    critical: true',
          '    run: node tests/bench.mjs',
          '  - id: core.fast',
          '    kind: command',
          '    measures: [src/work.mjs]',
          '    run: node src/work.mjs',
          '',
        ].join('\n'),
      );
      writeFileSync(join(repo, 'tests/bench.mjs'), 'const end = Date.now() + 5; while (Date.now() < end) {}\n');
      writeFileSync(join(repo, 'src/work.mjs'), 'const end = Date.now() + 5; while (Date.now() < end) {}\n');
      gitIn(repo, 'init', '-q', '-b', 'main');
      gitIn(repo, 'add', '-A');
      gitIn(repo, 'commit', '-q', '-m', 'base');

      // PR adds a new scenario to tests/bench.mjs (much longer wall time), leaving src/work.mjs unchanged.
      writeFileSync(join(repo, 'tests/bench.mjs'), 'const end = Date.now() + 45; while (Date.now() < end) {}\n');
      gitIn(repo, 'commit', '-q', '-am', 'add benchmark scenario');

      const loaded = await loadConfig(repo);
      const store = new Store(loaded.dir);
      const base = await checkout(repo, store, 'HEAD~1');

      const changed = await changedBenchmarks(loaded, base.dir, repo);
      expect(changed.get('plan.bench')).toContain('tests/bench.mjs');
      expect(changed.has('core.fast')).toBe(false);

      const { comparison } = await abCompare({
        loaded,
        store,
        base: { label: 'main', dir: base.dir },
        head: { label: 'pr', dir: repo },
        only: ['plan.bench'],
        iterations: 4,
        rounds: signTestRounds(loaded.config.thresholds.alpha),
        profile: false,
      });

      const primary = comparison.metrics.find((m) => m.benchmark === 'plan.bench' && m.primary);
      expect(primary?.verdict).toBe('not_comparable');
      expect(comparison.verdict).toBe('not_comparable');
      expect(comparison.warnings.some((w) => w.includes('plan.bench') && w.includes('tests/bench.mjs'))).toBe(true);
      expect(comparisonMarkdown(comparison)).toContain('not comparable');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still flags a real regression in an unchanged benchmark alongside an edited benchmark', {
    timeout: 60_000,
  }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'speedpatrol-issue73-mixed-'));
    try {
      mkdirSync(join(repo, '.speedpatrol'), { recursive: true });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
      writeFileSync(
        join(repo, '.speedpatrol/speedpatrol.yml'),
        [
          'version: 1',
          'project:',
          '  name: demo',
          '  source: .',
          'defaults:',
          '  iterations: 4',
          '  warmup: 1',
          'benchmarks:',
          '  - id: plan.bench',
          '    kind: command',
          '    protectedPaths: [tests/custom-driver.mjs]',
          '    run: node tests/custom-driver.mjs',
          '  - id: core.work',
          '    kind: command',
          '    measures: [src/work.mjs]',
          '    run: node src/work.mjs',
          '',
        ].join('\n'),
      );
      writeFileSync(join(repo, 'tests/custom-driver.mjs'), 'const end = Date.now() + 5; while (Date.now() < end) {}\n');
      writeFileSync(join(repo, 'src/work.mjs'), 'const end = Date.now() + 5; while (Date.now() < end) {}\n');
      gitIn(repo, 'init', '-q', '-b', 'main');
      gitIn(repo, 'add', '-A');
      gitIn(repo, 'commit', '-q', '-m', 'base');

      // Both files become slower: custom-driver.mjs is protected (not comparable), src/work.mjs is a real regression.
      writeFileSync(
        join(repo, 'tests/custom-driver.mjs'),
        'const end = Date.now() + 45; while (Date.now() < end) {}\n',
      );
      writeFileSync(join(repo, 'src/work.mjs'), 'const end = Date.now() + 45; while (Date.now() < end) {}\n');
      gitIn(repo, 'commit', '-q', '-am', 'edit harness and slow down work');

      const loaded = await loadConfig(repo);
      const store = new Store(loaded.dir);
      const base = await checkout(repo, store, 'HEAD~1');

      const { comparison } = await abCompare({
        loaded,
        store,
        base: { label: 'main', dir: base.dir },
        head: { label: 'pr', dir: repo },
        iterations: 4,
        rounds: signTestRounds(loaded.config.thresholds.alpha, 1),
        profile: false,
      });

      const byBench = (id: string) => comparison.metrics.find((m) => m.benchmark === id && m.primary)?.verdict;
      expect(byBench('plan.bench')).toBe('not_comparable');
      expect(byBench('core.work')).toBe('regression');
      expect(comparison.verdict).toBe('regression');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
