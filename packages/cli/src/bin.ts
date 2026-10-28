#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycle, patrol, publish, runAnalyst, runOptimizer, runScout } from '@speedpatrol/agents';
import { ConfigError, EXIT, loadConfig, MeasureError, Store, sourceInfo } from '@speedpatrol/core';
import { startDashboard } from '@speedpatrol/dashboard';
import { comparisonMarkdown, formatPct } from '@speedpatrol/stats';
import { type Argv, intFlag, parseArgv, strFlag } from './argv.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { compareCommand, runCommand, runTable } from './commands/measure.js';
import { USAGE } from './usage.js';

declare const __SPEEDPATROL_VERSION__: string | undefined;

function version(): string {
  if (typeof __SPEEDPATROL_VERSION__ === 'string') return __SPEEDPATROL_VERSION__;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(join(here, '../../speedpatrol/package.json'), 'utf8')) as { version: string })
      .version;
  } catch {
    return '0.0.0-dev';
  }
}

const log = (line: string) => process.stderr.write(`${line}\n`);
const out = (line: string) => process.stdout.write(`${line}\n`);

async function load(cwd: string) {
  const loaded = await loadConfig(cwd);
  return { loaded, store: new Store(loaded.dir) };
}

async function main(argv: Argv): Promise<number> {
  const { command, positional, flags } = argv;
  const cwd = resolve(strFlag(flags, 'cwd') ?? process.cwd());
  if (flags.version) {
    out(version());
    return EXIT.ok;
  }
  if (flags.help || command === 'help') {
    out(USAGE);
    return EXIT.ok;
  }
  switch (command) {
    case 'init':
      await init(cwd, strFlag(flags, 'agent'), log);
      return EXIT.ok;
    case 'doctor':
      return (await doctor(cwd, out)) ? EXIT.ok : EXIT.config;
    case 'run': {
      const { loaded, store } = await load(cwd);
      const { run, comparison } = await runCommand({
        loaded,
        store,
        only: positional,
        iterations: intFlag(flags, 'iterations'),
        log,
      });
      if (flags.json) out(JSON.stringify({ run, comparison }, null, 2));
      else {
        out(
          `Run ${run.id} at ${run.source.sha.slice(0, 10)}${run.source.dirty ? ' (dirty)' : ''} on ${run.machine.fingerprint}`,
        );
        out(runTable(run));
        if (comparison) out(`\n${comparisonMarkdown(comparison)}`);
      }
      if (run.failed) {
        log(`Could not measure: ${run.failed}`);
        return EXIT.infra;
      }
      return flags['fail-on-regression'] && comparison?.verdict === 'regression' ? EXIT.regression : EXIT.ok;
    }
    case 'compare': {
      const { loaded, store } = await load(cwd);
      const comparison = await compareCommand({
        loaded,
        store,
        base: strFlag(flags, 'base'),
        head: strFlag(flags, 'head'),
        only: positional,
        rounds: intFlag(flags, 'rounds'),
        iterations: intFlag(flags, 'iterations'),
        markdown: strFlag(flags, 'markdown'),
        log,
      });
      out(
        flags.json ? JSON.stringify(comparison, null, 2) : comparisonMarkdown(comparison, { all: Boolean(flags.all) }),
      );
      return comparison.verdict === 'regression' ? EXIT.regression : EXIT.ok;
    }
    case 'scout': {
      const { loaded, store } = await load(cwd);
      const outcome = await runScout({ loaded, store, log, focus: strFlag(flags, 'focus') });
      out(outcome.summary ?? outcome.stop);
      return outcome.stop === 'error' ? EXIT.infra : EXIT.ok;
    }
    case 'analyze': {
      const { loaded, store } = await load(cwd);
      const targets = (await store.listRegressions()).filter((r) =>
        positional.length ? positional.includes(r.id) : r.status === 'open' || (r.status === 'filed' && !r.analysis),
      );
      if (targets.length === 0) out('No regression to analyze.');
      for (const regression of targets) {
        const result = await runAnalyst({ loaded, store, regression, log });
        out(`${regression.id}: ${result.regression.title}`);
      }
      return EXIT.ok;
    }
    case 'optimize': {
      const { loaded, store } = await load(cwd);
      const id = positional[0];
      const benchmark = id
        ? loaded.benchmarks.find((b) => b.id === id)
        : (loaded.benchmarks.find((b) => b.critical) ?? loaded.benchmarks[0]);
      if (!benchmark) throw new ConfigError(id ? `Unknown benchmark ${id}` : 'No benchmarks.');
      const { sha } = await sourceInfo(loaded.source);
      const state = await store.patrolState();
      const baseRun = state.lastRunId ? await store.getRun(state.lastRunId) : undefined;
      const { experiment } = await runOptimizer({ loaded, store, benchmark, baseSha: sha, baseRun, log });
      out(
        `${experiment.id}: ${experiment.status}${experiment.deltaPct !== undefined ? ` (${formatPct(experiment.deltaPct)})` : ''}${experiment.reason ? ` - ${experiment.reason}` : ''}`,
      );
      if (experiment.status === 'improved')
        out(`Branch ${experiment.branch} in ${experiment.worktree}. Run \`speedpatrol publish\` to open the PR.`);
      return EXIT.ok;
    }
    case 'publish': {
      const { loaded, store } = await load(cwd);
      const result = await publish(loaded, store, { dryRun: Boolean(flags['dry-run']) || undefined, log: out });
      for (const url of [...result.issues, ...result.pullRequests]) out(url);
      for (const error of result.errors) log(error);
      if (result.dryRun && !flags['dry-run']) log('agents.github.enabled is false: this was a dry run.');
      return result.errors.length ? EXIT.infra : EXIT.ok;
    }
    case 'dashboard': {
      const { loaded } = await load(cwd);
      const server = await startDashboard({ configDir: loaded.dir, port: intFlag(flags, 'port') });
      out(`Speedpatrol dashboard: ${server.url}`);
      await new Promise<void>((done) => process.once('SIGINT', () => done()));
      await server.close();
      return EXIT.ok;
    }
    case 'baselines': {
      const { store } = await load(cwd);
      for (const entry of await store.baselines()) {
        out(`${entry.at}  ${entry.sha.slice(0, 10)}  ${entry.machine}  ${entry.runId}  ${entry.subject ?? ''}`);
      }
      return EXIT.ok;
    }
    case 'regressions': {
      const { store } = await load(cwd);
      if (positional[0] === 'dismiss') {
        const regression = await store.getRegression(positional[1] ?? '');
        if (!regression) throw new ConfigError(`Unknown regression ${positional[1]}`);
        const reason = strFlag(flags, 'reason');
        if (!reason) throw new ConfigError('Give a --reason.');
        await store.saveRegression({ ...regression, status: 'dismissed', reason, updatedAt: new Date().toISOString() });
        out(`Dismissed ${regression.id}.`);
        return EXIT.ok;
      }
      for (const r of await store.listRegressions()) {
        out(
          `${r.id}  ${r.status.padEnd(9)}  ${formatPct(r.deltaPct).padStart(7)}  ${r.title}${r.issueUrl ? `  ${r.issueUrl}` : ''}`,
        );
      }
      return EXIT.ok;
    }
    default: {
      const { loaded, store } = await load(cwd);
      if (flags.once) {
        const result = await cycle({
          loaded,
          store,
          force: Boolean(flags.force),
          optimize: flags.optimize !== false,
          log,
        });
        out(
          result.skipped
            ? `No new commit on ${loaded.config.agents.patrol.pull}.`
            : `Measured ${result.sha.slice(0, 10)}: ${result.comparison?.verdict ?? 'first baseline'}; ${result.confirmed.length} confirmed regression(s).`,
        );
        return EXIT.ok;
      }
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      await patrol({
        loaded,
        store,
        force: Boolean(flags.force),
        optimize: flags.optimize !== false,
        log,
        signal: controller.signal,
      });
      return EXIT.ok;
    }
  }
}

try {
  process.exitCode = await main(parseArgv(process.argv.slice(2)));
} catch (error) {
  log(`speedpatrol: ${(error as Error).message}`);
  process.exitCode =
    error instanceof ConfigError ? EXIT.config : error instanceof MeasureError ? EXIT.infra : EXIT.config;
}
