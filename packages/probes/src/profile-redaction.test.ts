import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { expect, it } from 'vitest';
import { measure } from './runner.js';

it('redacts configured and captured secrets from a failed profile without losing measured samples', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'speedpatrol-profile-redaction-'));
  try {
    mkdirSync(join(repo, '.speedpatrol'));
    writeFileSync(join(repo, 'capture.cjs'), "console.log('token=synthetic-captured-token');\n");
    writeFileSync(
      join(repo, 'profile.cjs'),
      "console.error('profile denied: ' + process.env.TOKEN + '\\ncredential=' + process.env.KEY); process.exit(1);\n",
    );
    writeFileSync(
      join(repo, '.speedpatrol/speedpatrol.yml'),
      `version: 1
project: { name: profile-redaction, source: . }
defaults: { iterations: 1, warmup: 0 }
app:
  env: { PRIVATE_KEY: synthetic-configured-key }
  secrets: [PRIVATE_KEY]
  setup:
    - run: node capture.cjs
      capture: { TOKEN: 'token=(.+)' }
benchmarks:
  - id: command.profile
    kind: command
    run: node -e 'process.exit(0)'
    env: { TOKEN: '\${TOKEN}', KEY: '\${PRIVATE_KEY}' }
    profile: { enabled: true, mode: command, command: 'node profile.cjs' }
`,
    );
    const loaded = await loadConfig(repo);
    const logs: string[] = [];
    const run = await measure({
      loaded,
      store: new Store(loaded.dir),
      purpose: 'adhoc',
      log: (line) => logs.push(line),
    });
    const failure = logs.find((line) => line.includes('profile failed:'));
    expect(failure).toContain('profile denied: [redacted]');
    expect(failure).toContain('credential=[redacted]');
    expect(logs.join('\n')).not.toContain('synthetic-captured-token');
    expect(logs.join('\n')).not.toContain('synthetic-configured-key');
    expect(run.failed).toBeUndefined();
    expect(run.results[0]?.metrics.wall_ms?.values).toHaveLength(1);
    expect(run.results[0]?.profile).toBeUndefined();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
