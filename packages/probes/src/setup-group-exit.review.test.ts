import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { expect, it } from 'vitest';
import { measure } from './runner.js';

it('rejects a benchmark after the entire background setup group is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speedpatrol-group-exit-'));
  try {
    mkdirSync(join(dir, '.speedpatrol'));
    writeFileSync(
      join(dir, '.speedpatrol/speedpatrol.yml'),
      `version: 1
project: { name: group-exit, source: . }
defaults: { iterations: 1, warmup: 0 }
app:
  setup:
    - run: >-
        echo $$ > setup.pgid;
        node -e 'console.log("READY"); setInterval(() => {}, 1000)' & wait
      background: true
      readyWhen: READY
      timeoutMs: 5000
benchmarks:
  - id: kill-setup
    kind: command
    run: kill -KILL -- -$(cat setup.pgid); sleep 0.1
`,
    );
    const loaded = await loadConfig(dir);
    const run = await measure({ loaded, store: new Store(loaded.dir), purpose: 'baseline', profile: false });
    expect(run.failed, 'a killed setup group must make the run ineligible as a baseline').toBeDefined();
    expect(run.failed).toContain('Background setup command exited during the run');
    expect(run.results).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
