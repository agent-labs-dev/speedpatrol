import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { expect, it } from 'vitest';
import { activeGroupCount, runTimed } from './exec.js';
import { measure } from './runner.js';

it.each([
  { warmup: 0, mode: 'exit' },
  { warmup: 1, mode: 'exit' },
  { warmup: 0, mode: 'timeout' },
  { warmup: 0, mode: 'overflow' },
  { warmup: 2, mode: 'recover' },
  { warmup: 0, mode: 'write-failure' },
])(
  'retains redacted command failure evidence through measure and Store (warmup=$warmup, mode=$mode)',
  async ({ warmup, mode }) => {
    const repo = mkdtempSync(join(tmpdir(), 'speedpatrol-diagnostics-'));
    try {
      mkdirSync(join(repo, '.speedpatrol'));
      writeFileSync(
        join(repo, 'fail.cjs'),
        `${mode === 'recover' ? `const fs = require('node:fs'); if (fs.existsSync('once')) process.exit(0); fs.writeFileSync('once', 'done');` : ''}
console.log('PROFILE Horde60 rebuild 9.993ms synthetic-private-token');
console.error('budget failure\\n' + Array.from({length: 8}, (_, i) => 'trace frame ' + i).join('\\n'));
${mode === 'overflow' ? `process.stdout.write('x'.repeat(4 * 1024 * 1024 - Buffer.byteLength('PROFILE Horde60 rebuild 9.993ms synthetic-private-token\\n') - 6) + 'synthetic-private-token');` : ''}
${mode === 'timeout' ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 1;'}`,
      );
      writeFileSync(
        join(repo, '.speedpatrol/speedpatrol.yml'),
        `version: 1
project: { name: diagnostics, source: . }
defaults: { iterations: 1, warmup: ${warmup} }
app:
  env: { TOKEN: synthetic-private-token }
  secrets: [TOKEN]
benchmarks:
  - id: command.failure
    kind: command
    critical: true
    run: node fail.cjs
    timeoutMs: 1000
    profile: { enabled: false }
`,
      );
      const loaded = await loadConfig(repo);
      const store = new Store(loaded.dir);
      if (mode === 'write-failure') {
        mkdirSync(store.root, { recursive: true });
        writeFileSync(join(store.root, 'diagnostics'), 'blocked');
      }
      const logs: string[] = [];
      const run = await measure({ loaded, store, purpose: 'adhoc', profile: false, log: (line) => logs.push(line) });
      const saved = await store.getRun(run.id);
      const diagnostics = saved?.results[0]?.diagnostics;
      if (mode === 'write-failure') {
        expect(saved?.failed).toContain('Exit 1: node fail.cjs');
        expect(saved?.failed).toContain('Diagnostics could not be saved:');
        expect(saved?.failed).toContain('PROFILE Horde60 rebuild 9.993ms [redacted]');
        expect(diagnostics).toBeUndefined();
        return;
      }
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics![0]!;
      expect(diagnostic.phase).toBe(warmup ? 'warmup' : 'sample');
      expect(diagnostic.iteration).toBe(1);
      const text = readFileSync(join(store.root, diagnostic.path), 'utf8');
      expect(text).toContain('PROFILE Horde60 rebuild 9.993ms [redacted]');
      expect(text).toContain('budget failure');
      expect(text).toContain('trace frame 7');
      expect(text).toContain('stdout');
      expect(text).toContain('stderr');
      const evidence = JSON.parse(text);
      expect(evidence.timedOut).toBe(mode === 'timeout');
      expect(evidence.stdout.omittedBytes > 0).toBe(mode === 'overflow');
      if (mode === 'overflow') expect(evidence.stdout.text.endsWith('[redacted]')).toBe(true);
      expect(JSON.stringify(saved) + logs.join('') + text).not.toContain('synthetic-private-token');
      expect(logs.join('\n')).toContain(diagnostic.path);
      if (mode === 'recover') expect(saved?.failed).toBeUndefined();
      else expect(saved?.failed).toContain('Critical benchmark command.failure failed');
      expect(activeGroupCount()).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

it('bounds each pipe by bytes, drains excess output, and reports truncation', async () => {
  const limit = 4 * 1024 * 1024;
  const result = await runTimed({
    command: `node -e "process.stdout.write('x'.repeat(${limit + 100})); process.stderr.write('y'.repeat(${limit + 200})); process.exitCode = 1"`,
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  expect(result.code).toBe(1);
  expect(Buffer.byteLength(result.stdout)).toBe(limit);
  expect(Buffer.byteLength(result.stderr)).toBe(limit);
  expect(result.stdoutOmittedBytes).toBe(100);
  expect(result.stderrOmittedBytes).toBe(200);
  expect(activeGroupCount()).toBe(0);
});
