import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each([false, true])(
  'the real Action preserves exit 4 and stages warmup evidence (copy failure=%s)',
  (copyFailure) => {
    const repo = mkdtempSync(join(tmpdir(), 'speedpatrol-action-'));
    try {
      const action = parse(readFileSync(resolve(import.meta.dirname, '../../../action.yml'), 'utf8')) as {
        runs: { steps: { id?: string; name?: string; run?: string; if?: string; with?: Record<string, string> }[] };
      };
      const script = action.runs.steps.find((step) => step.id === 'compare')!.run!;
      const upload = action.runs.steps.find((step) => step.name === 'Retain command failure diagnostics');
      expect(upload?.if).toContain('always()');
      expect(upload?.with?.path).toBe('${{ steps.compare.outputs.evidence }}');
      mkdirSync(join(repo, '.speedpatrol/runs/diagnostics/historical'), { recursive: true });
      writeFileSync(join(repo, '.speedpatrol/runs/diagnostics/historical/old.json'), 'not this invocation');
      writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\nrunner/\n');
      const traceback = ['budget failure', ...Array.from({ length: 8 }, (_, i) => `trace frame ${i}`)].join('\n');
      writeFileSync(
        join(repo, 'fail.cjs'),
        `console.log('PROFILE Horde60 rebuild 9.993ms synthetic-secret');
console.error(${JSON.stringify(traceback)});
process.exitCode = 1;`,
      );
      writeFileSync(
        join(repo, '.speedpatrol/speedpatrol.yml'),
        `version: 1
project: { name: action-diagnostics, source: . }
defaults: { iterations: 1, warmup: 1, rounds: 1 }
app:
  env: { TOKEN: synthetic-secret }
  secrets: [TOKEN]
benchmarks:
  - id: command.failure
    kind: command
    critical: true
    run: node fail.cjs
    profile: { enabled: false }
`,
      );
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      git('add', '.');
      git(
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      );
      git('remote', 'add', 'origin', repo);
      const runner = join(repo, 'runner');
      mkdirSync(runner);
      const cli = resolve(import.meta.dirname, '../../cli/dist/bin.js');
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const bin = join(runner, 'speedpatrol');
      writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
      if (copyFailure) writeFileSync(join(runner, 'cp'), '#!/bin/sh\nexit 69\n', { mode: 0o700 });
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${runner}:${process.env.PATH}`,
          RUNNER_TEMP: runner,
          GITHUB_OUTPUT: join(runner, 'output'),
          GITHUB_STEP_SUMMARY: join(runner, 'summary'),
          SPEEDPATROL_BIN: bin,
          BASE: 'HEAD',
          BASE_REF: '',
          BENCHMARKS: '',
          ROUNDS: '1',
          ITERATIONS: '1',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(4);
      expect(result.stderr).toContain('Every warmup failed');
      if (copyFailure) {
        expect(result.stdout).toContain('could not stage failure diagnostics');
        return;
      }
      const output = readFileSync(join(runner, 'output'), 'utf8');
      const evidence = output
        .split('\n')
        .find((line) => line.startsWith('evidence='))!
        .slice('evidence='.length);
      const ids = readdirSync(join(evidence, 'diagnostics'));
      expect(ids).toHaveLength(1);
      expect(ids).not.toContain('historical');
      const run = JSON.parse(readFileSync(join(evidence, 'runs', `${ids[0]}.json`), 'utf8'));
      const diagnostic = run.results[0].diagnostics[0];
      expect(diagnostic.phase).toBe('warmup');
      const artifact = readFileSync(join(evidence, diagnostic.path), 'utf8');
      expect(artifact).toContain('PROFILE Horde60 rebuild 9.993ms [redacted]');
      expect(artifact).toContain('trace frame 7');
      expect(artifact).not.toContain('synthetic-secret');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
