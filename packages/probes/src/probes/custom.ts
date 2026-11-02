import { interpolate } from '@speedpatrol/core';
import { runTimed } from '../exec.js';
import { profileCommand, resolveCwd, resolveEnv } from './command.js';
import type { ProbeFactory } from './types.js';

/** The last stdout line that is `{"metrics": {...}}` or `{"metrics": [{name, value}]}`. */
export function parseMetricsLine(stdout: string): Record<string, number> | undefined {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { metrics?: unknown };
      if (!parsed.metrics || typeof parsed.metrics !== 'object') continue;
      // Also the list form, [{"name": "boot_ms", "value": 812}], that perf
      // harnesses such as nebula-desktop's `e2e --json perf` print.
      if (Array.isArray(parsed.metrics)) {
        return Object.fromEntries(
          parsed.metrics
            .filter(
              (item): item is { name: string; value: number } =>
                typeof item?.name === 'string' && typeof item?.value === 'number',
            )
            .map((item) => [item.name, item.value]),
        );
      }
      return Object.fromEntries(
        Object.entries(parsed.metrics as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
    } catch {
      /* not a metrics line */
    }
  }
  return undefined;
}

/** A command that measures itself and prints its metrics as JSON. */
export const customProbe: ProbeFactory<'custom'> = (benchmark, context) => {
  const cwd = resolveCwd(benchmark.cwd, context);
  const env = resolveEnv(benchmark.env, context);
  const command = interpolate(benchmark.run, context.vars);
  const declared = Object.keys(benchmark.metrics);
  const exec = async (extra: Record<string, string> = {}, run = command) => {
    const result = await runTimed({ command: run, cwd, env: { ...env, ...extra }, timeoutMs: context.timeoutMs });
    if (result.code !== 0) throw new Error(`Exit ${result.code}: ${command}\n${result.stderr.trim().slice(-500)}`);
    return result;
  };
  return {
    primary: declared[0]!,
    metrics: benchmark.metrics,
    async sample() {
      const result = await exec();
      const metrics = parseMetricsLine(result.stdout);
      if (!metrics) throw new Error(`No {"metrics": {...}} line in the output of: ${command}`);
      const missing = declared.filter((name) => metrics[name] === undefined);
      if (missing.length === declared.length)
        throw new Error(`The output has none of the declared metrics: ${declared.join(', ')}`);
      return Object.fromEntries(
        declared.filter((name) => metrics[name] !== undefined).map((name) => [name, metrics[name]!]),
      );
    },
    profile: (file) => profileCommand(benchmark.profile, file, exec, command),
  };
};
