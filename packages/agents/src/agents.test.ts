import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const say = () => {};
  const script = (steps: unknown[]) => {
    process.env.FAKE_AGENT_SCRIPT = JSON.stringify(steps);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'speedpatrol-agents-'));
    cpSync(fixture, repo, { recursive: true, filter: (path) => !path.includes('/.speedpatrol/runs') });
    writeFileSync(join(repo, '.gitignore'), '.speedpatrol/runs/\n');
    const configFile = join(repo, '.speedpatrol/speedpatrol.yml');
    const config = readFileSync(configFile, 'utf8')
      .replace(/agents:[\s\S]*$/, '')
      .concat(
        `agents:\n  scout: { use: ${AGENT} }\n  analyst: { use: ${AGENT} }\n  optimizer: { use: ${AGENT}, enabled: false, timeoutMinutes: 5 }\n  patrol: { pull: main }\n`,
      )
      // Only the fast benchmarks: this test is about the agents, not the probes.
      .replace(/ {2}- id: web\.home[\s\S]*?(?= {2}- id: startup)/, '')
      .replace(/ {2}- id: startup\.server[\s\S]*?(?= {2}- id: cli)/, '')
      .replace('PORT: "4390"', 'PORT: "4490"');
    writeFileSync(configFile, config);
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'fixture');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.FAKE_AGENT_SCRIPT;
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
    const first = await cycle({ loaded, store, log: say });
    expect(first.comparison).toBeUndefined();
    expect((await cycle({ loaded, store, log: say })).skipped).toBe(true);

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
    const second = await cycle({ loaded, store, log: say });
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

  it('the optimizer change is kept only when the A/B run shows the speed-up', async () => {
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
          file: 'server.js',
          from: "import { work } from './work.js';",
          to: "import { work } from './work.js'; // fast",
        },
      },
      { tool: 'finish', input: { title: 'Add a comment to the server', summary: 'Added a comment.' } },
    ]);
    const placebo = await runOptimizer({ loaded, store, benchmark, baseSha: head, log: say });
    expect(placebo.experiment.status, placebo.experiment.reason).toBe('rejected');

    script([
      { tool: 'get_target' },
      { tool: 'set_hypothesis', input: { hypothesis: 'work() does 20x more rounds than it needs.' } },
      { edit: { file: 'work.js', from: 'ROUNDS = 2000000', to: 'ROUNDS = 20000' } },
      { tool: 'finish', input: { title: 'Restore the work rounds to 20000', summary: 'Restored ROUNDS to 20000.' } },
    ]);
    const real = await runOptimizer({ loaded, store, benchmark, baseSha: head, log: say });
    expect(real.experiment.status, real.experiment.reason).toBe('improved');
    expect(real.experiment.deltaPct).toBeLessThan(-0.05);
    expect(gitIn(real.experiment.worktree, 'log', '-1', '--format=%s')).toBe(
      'perf(api.items): restore the work rounds to 20000',
    );
  });
});
