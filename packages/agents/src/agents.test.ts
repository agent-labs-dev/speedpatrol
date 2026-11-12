import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, Store } from '@speedpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cycle } from './patrol.js';
import { publish } from './publish.js';
import { runOptimizer } from './roles/optimizer.js';
import { runScout } from './roles/scout.js';

const fixture = resolve(import.meta.dirname, '../../../examples/fixture-app');
const fakeAgent = resolve(import.meta.dirname, 'testing/fake-agent.mjs');

function gitIn(dir: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

const AGENT = `{ runtime: cli, command: "node ${fakeAgent} {mcp}" }`;

/**
 * The agent layer end to end, with a scripted CLI agent in place of a model:
 * every role reaches Speedpatrol only through its MCP tools, as claude or
 * codex would. The scout adds a benchmark; a patrol records a baseline, then
 * catches, confirms and files a slower commit; the optimizer's change is
 * verified by an A/B run, not by the agent's word.
 */
describe('agents over MCP', () => {
  let repo: string;
  let signingDir: string;
  const say = () => {};
  const script = (steps: unknown[]) => {
    process.env.FAKE_AGENT_SCRIPT = JSON.stringify(steps);
  };

  beforeAll(async () => {
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not get a TCP port');
    await new Promise<void>((done) => socket.close(() => done()));
    repo = mkdtempSync(join(tmpdir(), 'speedpatrol-agents-'));
    cpSync(fixture, repo, { recursive: true, filter: (path) => !path.includes('/.speedpatrol/runs') });
    writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
    const configFile = join(repo, '.speedpatrol/speedpatrol.yml');
    const config = readFileSync(configFile, 'utf8')
      .replace(/agents:[\s\S]*$/, '')
      .concat(
        `agents:\n  scout: { use: ${AGENT} }\n  analyst: { use: ${AGENT} }\n  optimizer: { use: ${AGENT}, enabled: false, timeoutMinutes: 5, checks: ['true'], allowedPaths: ['work.js'] }\n  patrol: { pull: main }\n`,
      )
      // Only the fast benchmarks: this test is about the agents, not the probes.
      .replace(/ {2}- id: web\.home[\s\S]*?(?= {2}- id: startup)/, '')
      .replace(/ {2}- id: startup\.server[\s\S]*?(?= {2}- id: cli)/, '')
      .replace('PORT: "4390"', `PORT: "${address.port}"`);
    writeFileSync(configFile, config);
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.name', 'Speedpatrol test');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'commit.gpgsign', 'false');
    signingDir = mkdtempSync(join(tmpdir(), 'speedpatrol-signing-'));
    const key = join(signingDir, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    writeFileSync(join(signingDir, 'allowed_signers'), `t@t ${readFileSync(`${key}.pub`, 'utf8')}`);
    gitIn(repo, 'config', 'gpg.format', 'ssh');
    gitIn(repo, 'config', 'gpg.ssh.allowedSignersFile', join(signingDir, 'allowed_signers'));
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'fixture');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(signingDir, { recursive: true, force: true });
    delete process.env.FAKE_AGENT_SCRIPT;
  });

  it('fails a CLI session that exits cleanly without finishing', async () => {
    script([]);
    const loaded = await loadConfig(repo);
    const outcome = await runScout({ loaded, store: new Store(loaded.dir), log: say });
    expect(outcome).toMatchObject({ stop: 'error', finished: false });
  });

  it('records a timed-out session as failed, with an error event', async () => {
    const loaded = await loadConfig(repo);
    loaded.config.agents.scout.use = {
      runtime: 'cli',
      agent: undefined,
      command: 'node -e "setTimeout(() => {}, 60000)"',
    };
    loaded.config.agents.scout.timeoutMinutes = 0.005;
    const store = new Store(loaded.dir);
    const outcome = await runScout({ loaded, store, log: say });
    expect(outcome).toMatchObject({ stop: 'timeout', finished: false });
    const statuses = JSON.parse(readFileSync(store.path('agents.json'), 'utf8'));
    expect(statuses.scout.state).toBe('failed');
    expect((await store.events(outcome.sessionId)).at(-1)?.kind).toBe('error');
  });

  it('the scout saves a benchmark only after trying it', async () => {
    const benchmark = { id: 'api.settings', kind: 'http', request: { url: 'http://127.0.0.1:${PORT}/settings' } };
    script([
      { tool: 'list_benchmarks' },
      { tool: 'save_benchmark', input: { benchmark }, mustSucceed: false },
      { tool: 'try_benchmark', input: { benchmark } },
      { tool: 'save_benchmark', input: { benchmark } },
      { tool: 'finish', input: { summary: 'Added api.settings.' } },
    ]);
    const loaded = await loadConfig(repo);
    const store = new Store(loaded.dir);
    const outcome = await runScout({ loaded, store, log: say });
    expect(outcome.stop).toBe('done');
    expect(outcome.finished).toBe(true);
    expect(outcome.costUsd).toBeCloseTo(0.0123);
    const saved = JSON.parse(readFileSync(join(loaded.dir, 'benchmarks.json'), 'utf8'));
    expect(saved.benchmarks.map((b: { id: string }) => b.id)).toEqual(['api.settings']);
    const events = await store.events(outcome.sessionId);
    const saves = events.filter((event) => event.kind === 'tool-result' && event.tool === 'save_benchmark');
    expect(saves[0]?.output).toContain('Run try_benchmark with exactly this benchmark first.');
    expect(saves[1]?.output).toContain('Saved api.settings');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'scouted benchmarks');
  });

  it('a patrol baselines main, then confirms, explains and files a regression', async () => {
    const loaded = await loadConfig(repo);
    const store = new Store(loaded.dir);
    // Forced: the baseline gate's load and noise reasons depend on the host, not on this fixture.
    const first = await cycle({ loaded, store, forceBaseline: true, log: say });
    expect(first.comparison).toBeUndefined();
    expect((await cycle({ loaded, store, forceBaseline: true, log: say })).skipped).toBe(true);

    const work = join(repo, 'work.js');
    writeFileSync(work, readFileSync(work, 'utf8').replace('ROUNDS = 20000', 'ROUNDS = 2000000'));
    gitIn(repo, 'commit', '-q', '-am', 'make work slower');
    const bad = gitIn(repo, 'rev-parse', 'HEAD');
    script([
      { tool: 'git_log', input: { range: `${first.sha}..${bad}` } },
      { tool: 'profile_diff' },
      {
        tool: 'write_analysis',
        input: {
          title: 'api.items slower since work() runs 100x more rounds',
          analysis: 'ROUNDS went from 20000 to 2000000 in work.js.',
          suspects: [{ sha: bad, reason: 'changes ROUNDS' }],
        },
      },
      { tool: 'finish', input: { summary: 'Explained.' } },
    ]);
    const second = await cycle({ loaded, store, forceBaseline: true, log: say });
    expect(second.comparison?.verdict).toBe('regression');
    const confirmed = second.confirmed.map((r) => r.benchmark).sort();
    expect(confirmed).toContain('api.items');
    expect(confirmed).not.toContain('api.health');
    const items = (await store.listRegressions()).find((r) => r.benchmark === 'api.items')!;
    expect(items).toMatchObject({ status: 'filed', title: 'api.items slower since work() runs 100x more rounds' });
    expect(items.suspects?.[0]).toMatchObject({ subject: 'make work slower' });

    const lines: string[] = [];
    const published = await publish(loaded, store, { dryRun: true, log: (line) => lines.push(line) });
    expect(published.dryRun).toBe(true);
    expect(lines.join('\n')).toContain('ROUNDS went from 20000 to 2000000');
  });

  it('the optimizer rejects a change that does not speed up the benchmark', async () => {
    const loaded = await loadConfig(repo);
    const store = new Store(loaded.dir);
    const benchmark = loaded.benchmarks.find((b) => b.id === 'api.items')!;
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    // The agent claims a speed-up but changes nothing that matters: rejected.
    script([
      { tool: 'get_target' },
      { tool: 'set_hypothesis', input: { hypothesis: 'A comment makes it faster.' } },
      {
        edit: {
          file: 'work.js',
          from: 'ROUNDS = 2000000',
          to: 'ROUNDS = 2000000 // fast',
        },
      },
      { tool: 'finish', input: { title: 'Add a comment to the server', summary: 'Added a comment.' } },
    ]);
    const placebo = await runOptimizer({ loaded, store, benchmark, baseSha: head, log: say });
    expect(placebo.experiment.status, placebo.experiment.reason).toBe('rejected');
  });

  it.each([
    ['a failed declared check', ['false'], 'Optimizer check failed', undefined],
    ['an untracked scratch file', ['true'], 'Untracked scratch files', { file: 'scratch.tmp', text: 'scratch' }],
    [
      'a staged scratch file',
      ['true'],
      'Changed paths are outside allowedPaths',
      { file: 'scratch.tmp', text: 'scratch', stage: true },
    ],
  ])('rejects %s before acceptance', async (_label, checks, reason, write) => {
    const loaded = await loadConfig(repo);
    loaded.config.agents.optimizer.checks = checks;
    const store = new Store(loaded.dir);
    const benchmark = loaded.benchmarks.find((item) => item.id === 'api.items')!;
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    script([
      { tool: 'get_target' },
      ...(write ? [{ write }] : []),
      { edit: { file: 'work.js', from: 'ROUNDS = 2000000', to: 'ROUNDS = 20000' } },
      { tool: 'finish', input: { title: 'Change work rounds', summary: 'Change work rounds.' } },
    ]);
    const result = await runOptimizer({ loaded, store, benchmark, baseSha: head, log: say });
    expect(result.experiment.status).toBe('rejected');
    expect(result.experiment.reason).toContain(reason);
  });

  it('checks both paths of a staged rename', async () => {
    const loaded = await loadConfig(repo);
    loaded.config.agents.optimizer.allowedPaths = ['renamed.js'];
    const benchmark = loaded.benchmarks.find((item) => item.id === 'api.items')!;
    benchmark.measures = ['renamed.js'];
    script([
      { move: { from: 'work.js', to: 'renamed.js' } },
      { tool: 'finish', input: { title: 'Rename work', summary: 'Rename work.' } },
    ]);
    const result = await runOptimizer({
      loaded,
      store: new Store(loaded.dir),
      benchmark,
      baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
      log: say,
    });
    expect(result.experiment.status).toBe('rejected');
    expect(result.experiment.reason).toContain('Changed paths are outside allowedPaths: work.js');
  });

  it.each(['', ' && git add work.js'])('rejects tracked preparation edits%s', async (stage) => {
    const loaded = await loadConfig(repo);
    loaded.config.app.prepare = [
      {
        run: `printf '\\n// generated by prepare\\n' >> work.js${stage}`,
        env: {},
        capture: {},
        background: false,
        timeoutMs: 10_000,
      },
    ];
    script([{ tool: 'finish', input: { title: 'No optimizer change', summary: 'No optimizer change.' } }]);
    const result = await runOptimizer({
      loaded,
      store: new Store(loaded.dir),
      benchmark: loaded.benchmarks.find((item) => item.id === 'api.items')!,
      baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
      log: say,
    });
    expect(result.experiment.status).toBe('rejected');
    expect(result.experiment.reason).toContain('Preparation modified tracked files');
  });

  it('rejects benchmark-only paths protected from optimizer changes', async () => {
    const loaded = await loadConfig(repo);
    const benchmark = loaded.benchmarks.find((item) => item.id === 'api.items')!;
    benchmark.protectedPaths = ['work.js'];
    const result = await runOptimizer({
      loaded,
      store: new Store(loaded.dir),
      benchmark,
      baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
      log: say,
    });
    expect(result.experiment.status).toBe('rejected');
    expect(result.experiment.reason).toContain('checks and allowedPaths');
  });

  it.each([
    { signing: false, missingKey: true },
    { signing: true, missingKey: false },
    { signing: true, missingKey: true },
  ])('optimizer honors commit.gpgsign=$signing with missingKey=$missingKey', async ({ signing, missingKey }) => {
    gitIn(repo, 'config', 'commit.gpgsign', String(signing));
    gitIn(repo, 'config', 'user.signingkey', join(signingDir, missingKey ? 'missing' : 'key'));
    try {
      const loaded = await loadConfig(repo);
      const store = new Store(loaded.dir);
      const benchmark = loaded.benchmarks.find((b) => b.id === 'api.items')!;
      const head = gitIn(repo, 'rev-parse', 'HEAD');
      script([
        { tool: 'get_target' },
        { tool: 'set_hypothesis', input: { hypothesis: 'work() does 20x more rounds than it needs.' } },
        { edit: { file: 'work.js', from: 'ROUNDS = 2000000', to: 'ROUNDS = 20000' } },
        { tool: 'finish', input: { title: 'Restore the work rounds to 20000', summary: 'Restored ROUNDS to 20000.' } },
      ]);
      const real = await runOptimizer({ loaded, store, benchmark, baseSha: head, log: say });
      if (signing && missingKey) {
        expect(real.experiment.status, real.experiment.reason).toBe('failed');
        expect(real.experiment.reason).toContain(join(signingDir, 'missing'));
        expect(real.experiment.headSha).toBeUndefined();
        expect(real.experiment.comparisonId).toBeUndefined();
        expect(existsSync(real.experiment.worktree)).toBe(false);
        return;
      }
      expect(real.experiment.status, real.experiment.reason).toBe('improved');
      expect(real.experiment.deltaPct).toBeLessThan(-0.05);
      expect(gitIn(real.experiment.worktree, 'log', '-1', '--format=%s')).toBe(
        'perf(api.items): restore the work rounds to 20000',
      );
      expect(gitIn(real.experiment.worktree, 'log', '-1', '--format=%G?')).toBe(signing ? 'G' : 'N');
      if (signing) gitIn(real.experiment.worktree, 'verify-commit', 'HEAD');
    } finally {
      gitIn(repo, 'config', 'commit.gpgsign', 'false');
    }
  });

  it.each(['optimize', '--once'])('exits 4 when %s cannot complete the optimizer session', async (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'speedpatrol-cli-timeout-'));
    const configDir = join(dir, '.speedpatrol');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, 'speedpatrol.yml'),
      readFileSync(join(repo, '.speedpatrol/speedpatrol.yml'), 'utf8')
        .replace('source: .', `source: ${JSON.stringify(repo)}`)
        .replace(
          / {2}optimizer:.*\n/,
          `  optimizer: { use: { runtime: cli, command: 'node -e "setTimeout(() => {}, 60000)"' }, enabled: true, timeoutMinutes: 0.005, checks: ['true'], allowedPaths: ['work.js'] }\n`,
        ),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, '../../cli/dist/bin.js'), command, '--force', '--force-baseline'],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 25_000,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(4);
      const experiment = (await new Store(configDir).listExperiments()).at(-1)!;
      expect(experiment.status).toBe('failed');
      expect(experiment.headSha).toBeUndefined();
      expect(experiment.comparisonId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
