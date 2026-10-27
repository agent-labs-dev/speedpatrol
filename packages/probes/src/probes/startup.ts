import { interpolate } from '@speedpatrol/core';
import { runTimed, startBackground, urlAnswers, waitUntil } from '../exec.js';
import { resolveCwd, resolveEnv } from './command.js';
import { withNodeProfile } from './node-profile.js';
import type { ProbeFactory } from './types.js';

/**
 * Cold start of a long-running process: a server, a worker, a desktop app.
 * The clock runs from the spawn until the process prints `ready.output` or
 * answers on `ready.url`. Then the process is stopped.
 */
export const startupProbe: ProbeFactory<'startup'> = (benchmark, context) => {
  const cwd = resolveCwd(benchmark.cwd, context);
  const env = resolveEnv(benchmark.env, context);
  const command = interpolate(benchmark.run, context.vars);
  const readyOutput = benchmark.ready.output ? new RegExp(benchmark.ready.output, 'm') : undefined;
  const readyUrl = benchmark.ready.url ? interpolate(benchmark.ready.url, context.vars) : undefined;

  const launch = async (extra: Record<string, string> = {}) => {
    if (benchmark.before) {
      await runTimed({ command: interpolate(benchmark.before, context.vars), cwd, env, timeoutMs: context.timeoutMs });
    }
    const started = performance.now();
    const process = startBackground(command, cwd, { ...env, ...extra });
    try {
      await waitUntil(
        async () => {
          if (process.child.exitCode !== null) {
            throw new Error(`Exited with code ${process.child.exitCode} before it was ready: ${command}`);
          }
          if (readyOutput && !readyOutput.test(process.output())) return false;
          if (readyUrl && !(await urlAnswers(readyUrl))) return false;
          return true;
        },
        context.timeoutMs,
        `${command} to be ready`,
        readyUrl ? 10 : 2,
      );
      return performance.now() - started;
    } finally {
      await process.stop();
    }
  };

  return {
    primary: 'ready_ms',
    metrics: { ready_ms: { unit: 'ms', better: 'lower' } },
    async sample() {
      return { ready_ms: await launch() };
    },
    async profile(file) {
      if (benchmark.profile.mode === 'off' || benchmark.profile.mode === 'command') return undefined;
      return (await withNodeProfile((extra) => launch(extra), file)).artifact;
    },
  };
};
