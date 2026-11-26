import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runOptimizer } from './roles/optimizer.js';

let cache: string;
beforeAll(() => {
  cache = mkdtempSync(join(tmpdir(), 'speedpatrol-opt-policy-cache-'));
  vi.stubEnv('XDG_CACHE_HOME', cache);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
});

const fakeAgent = resolve(import.meta.dirname, 'testing/fake-agent.mjs');

function gitIn(dir: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

describe('optimizer enforced policy visibility (#75)', () => {
  it('exposes exact allowedPaths, checks, and protectedPaths before editing and blocks disallowed measurements early', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speedpatrol-opt-policy-'));
    const repo = join(root, 'repo');
    const profileDir = join(root, 'external-profile');
    const promptOut = join(root, 'initial-prompt.txt');
    const benchMarker = join(root, 'benchmark-ran.marker');
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'bench'), { recursive: true });
      mkdirSync(join(profileDir, '.speedpatrol'), { recursive: true });

      writeFileSync(join(repo, 'src/allowed.mjs'), 'export const value = 1;\n');
      writeFileSync(join(repo, 'src/disallowed.mjs'), 'export const other = 1;\n');
      writeFileSync(
        join(repo, 'bench/run.mjs'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(benchMarker)}, 'ran');\n`,
      );

      gitIn(repo, 'init', '-q', '-b', 'main');
      gitIn(repo, 'add', '-A');
      gitIn(repo, 'commit', '-q', '-m', 'initial');
      const baseSha = gitIn(repo, 'rev-parse', 'HEAD');

      // External operator profile (outside the candidate worktree, like Eng Computer).
      writeFileSync(
        join(profileDir, '.speedpatrol/speedpatrol.yml'),
        JSON.stringify({
          version: 1,
          project: { name: 'demo', source: repo },
          defaults: { iterations: 1, warmup: 0 },
          benchmarks: [
            {
              id: 'app.nav',
              kind: 'command',
              run: 'node bench/run.mjs',
              measures: ['src/allowed.mjs'],
              protectedPaths: ['bench/run.mjs'],
            },
          ],
          agents: {
            optimizer: {
              enabled: true,
              use: {
                runtime: 'cli',
                command: `cp {prompt} ${JSON.stringify(promptOut)} && node ${fakeAgent} {mcp}`,
              },
              timeoutMinutes: 5,
              checks: ['node -e "process.exit(0)"', 'test -f src/allowed.mjs'],
              allowedPaths: ['src/allowed.mjs'],
            },
          },
        }),
      );

      process.env.FAKE_AGENT_SCRIPT = JSON.stringify([
        { tool: 'get_target' },
        { tool: 'check_policy' },
        { edit: { file: 'src/disallowed.mjs', from: 'other = 1', to: 'other = 2' } },
        { tool: 'check_policy' },
        { tool: 'measure_change' },
        { tool: 'finish', input: { title: 'Edit disallowed hotspot', summary: 'Edited disallowed file.' } },
      ]);

      const loaded = await loadConfig(profileDir);
      const store = new Store(loaded.dir);
      const result = await runOptimizer({
        loaded,
        store,
        benchmark: loaded.benchmarks[0]!,
        baseSha,
        log: () => {},
      });

      // 1. Initial prompt exposes exact allowedPaths, required checks, and protectedPaths.
      const initialPrompt = readFileSync(promptOut, 'utf8');
      expect(initialPrompt).toContain('## Enforced policy');
      expect(initialPrompt).toContain('- src/allowed.mjs');
      expect(initialPrompt).toContain('- node -e "process.exit(0)"');
      expect(initialPrompt).toContain('- test -f src/allowed.mjs');
      expect(initialPrompt).toContain('- bench/run.mjs');

      const sessions = await store.sessions();
      expect(sessions).toHaveLength(1);
      const events = await store.events(sessions[0]!);
      const toolResults = (name: string) =>
        events
          .filter((event) => event.kind === 'tool-result' && event.tool === name)
          .map((event) => event.output ?? '');

      // 2. get_target exposes the exact enforced policy as well.
      const [targetOutput] = toolResults('get_target');
      expect(targetOutput).toContain('## Enforced policy');
      expect(targetOutput).toContain('- src/allowed.mjs');
      expect(targetOutput).toContain('- node -e "process.exit(0)"');
      expect(targetOutput).toContain('- bench/run.mjs');

      // 3. check_policy passes before editing and flags disallowed edits immediately.
      const policyChecks = toolResults('check_policy');
      expect(policyChecks[0]).toContain('Policy OK');
      expect(policyChecks[1]).toContain('Changed paths are outside allowedPaths: src/disallowed.mjs');
      expect(policyChecks[1]).toContain('Allowed paths: src/allowed.mjs');

      // 4. measure_change blocks before executing the benchmark when disallowed paths are modified.
      const [measureOutput] = toolResults('measure_change');
      expect(measureOutput).toContain('Refused to measure: Changed paths are outside allowedPaths: src/disallowed.mjs');
      expect(existsSync(benchMarker)).toBe(false);

      // 5. The final enforced guard still rejects the disallowed candidate.
      expect(result.experiment.status).toBe('rejected');
      expect(result.experiment.reason).toBe('Changed paths are outside allowedPaths: src/disallowed.mjs');
    } finally {
      delete process.env.FAKE_AGENT_SCRIPT;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
