import { interpolate } from '@speedpatrol/core';
import { runTimed, shellQuote, startBackground, waitUntil } from '../exec.js';
import type { ProbeFactory } from './types.js';

/** `am start -W` prints the launch times that Android itself measured. */
export function parseAmStart(output: string): { totalTime?: number; waitTime?: number } {
  const total = output.match(/TotalTime:\s*(\d+)/);
  const wait = output.match(/WaitTime:\s*(\d+)/);
  return { totalTime: total ? Number(total[1]) : undefined, waitTime: wait ? Number(wait[1]) : undefined };
}

/**
 * Android app open. A cold start stops the app first, so each launch creates
 * the process; `TotalTime` is the time to the first frame of the activity.
 */
export const androidProbe: ProbeFactory<'android'> = (benchmark, context) => {
  const adb = `adb${benchmark.device ? ` -s ${shellQuote(benchmark.device)}` : ''}`;
  const pkg = benchmark.activity.split('/')[0]!;
  const run = (command: string) => runTimed({ command, cwd: context.source, timeoutMs: context.timeoutMs });
  return {
    primary: 'total_time_ms',
    metrics: {
      total_time_ms: { unit: 'ms', better: 'lower' },
      wait_time_ms: { unit: 'ms', better: 'lower' },
    },
    async sample() {
      if (benchmark.cold) await run(`${adb} shell am force-stop ${shellQuote(pkg)}`);
      const result = await run(`${adb} shell am start -W -n ${shellQuote(benchmark.activity)}`);
      const { totalTime, waitTime } = parseAmStart(result.stdout);
      if (totalTime === undefined) throw new Error(`am start printed no TotalTime:\n${result.stdout}${result.stderr}`);
      return { total_time_ms: totalTime, ...(waitTime === undefined ? {} : { wait_time_ms: waitTime }) };
    },
  };
};

/**
 * iOS app open on a simulator. Without `readyOutput` the clock stops when
 * `simctl launch` returns (the process started). With it, the clock stops
 * when the app prints the marker, e.g. from its first screen's `onAppear`.
 */
export const iosProbe: ProbeFactory<'ios'> = (benchmark, context) => {
  const device = shellQuote(benchmark.device);
  const bundle = shellQuote(benchmark.bundleId);
  const ready = benchmark.readyOutput ? new RegExp(interpolate(benchmark.readyOutput, context.vars), 'm') : undefined;
  return {
    primary: 'launch_ms',
    metrics: { launch_ms: { unit: 'ms', better: 'lower' } },
    async sample() {
      await runTimed({ command: `xcrun simctl terminate ${device} ${bundle}`, cwd: context.source, timeoutMs: 30_000 });
      if (!ready) {
        const result = await runTimed({
          command: `xcrun simctl launch ${device} ${bundle}`,
          cwd: context.source,
          timeoutMs: context.timeoutMs,
        });
        if (result.code !== 0) throw new Error(`simctl launch failed: ${result.stderr.trim()}`);
        return { launch_ms: result.wallMs };
      }
      const started = performance.now();
      const process = startBackground(`xcrun simctl launch --console-pty ${device} ${bundle}`, context.source, {});
      try {
        await waitUntil(
          () => ready.test(process.output()),
          context.timeoutMs,
          `${benchmark.bundleId} to print the marker`,
          5,
        );
        return { launch_ms: performance.now() - started };
      } finally {
        await process.stop();
      }
    },
  };
};

/** A Maestro flow on iOS or Android, timed as one screen journey. */
export const maestroProbe: ProbeFactory<'maestro'> = (benchmark, context) => {
  const device = benchmark.device ? ` --device ${shellQuote(benchmark.device)}` : '';
  const command = `maestro${device} test ${shellQuote(interpolate(benchmark.flow, context.vars))}`;
  return {
    primary: 'flow_ms',
    metrics: { flow_ms: { unit: 'ms', better: 'lower' } },
    async sample() {
      const result = await runTimed({ command, cwd: context.source, timeoutMs: context.timeoutMs });
      if (result.code !== 0) throw new Error(`Maestro flow failed:\n${result.stdout.trim().slice(-800)}`);
      return { flow_ms: result.wallMs };
    },
  };
};
