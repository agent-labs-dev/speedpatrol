import { isAbsolute, resolve } from 'node:path';
import { interpolate, type MetricSpec, type ProfileArtifact } from '@speedpatrol/core';
import { runTimed, shellQuote } from '../exec.js';
import { withNodeProfile } from './node-profile.js';
import type { ProbeContext, ProbeFactory } from './types.js';

export function resolveCwd(cwd: string | undefined, context: ProbeContext): string {
  if (!cwd) return context.source;
  const dir = interpolate(cwd, context.vars);
  return isAbsolute(dir) ? dir : resolve(context.source, dir);
}

export function resolveEnv(env: Record<string, string>, context: ProbeContext): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, interpolate(value, context.vars)])),
    SPEEDPATROL_SOURCE: context.source,
  };
}

/** A command that runs to completion: a build, a CLI call, a test, a script. */
export const commandProbe: ProbeFactory<'command'> = (benchmark, context) => {
  const cwd = resolveCwd(benchmark.cwd, context);
  const env = resolveEnv(benchmark.env, context);
  const command = interpolate(benchmark.run, context.vars);
  const before = benchmark.before ? interpolate(benchmark.before, context.vars) : undefined;
  const metrics: Record<string, MetricSpec> = {
    wall_ms: { unit: 'ms', better: 'lower' },
    cpu_user_ms: { unit: 'ms', better: 'lower' },
    cpu_sys_ms: { unit: 'ms', better: 'lower' },
    max_rss_mb: { unit: 'mb', better: 'lower' },
  };
  const exec = async (extra: Record<string, string> = {}, run = command) => {
    if (before) await runTimed({ command: before, cwd, env, timeoutMs: context.timeoutMs });
    const result = await runTimed({ command: run, cwd, env: { ...env, ...extra }, timeoutMs: context.timeoutMs });
    if (result.timedOut || result.code !== 0) {
      const reason = result.timedOut ? `Timed out after ${context.timeoutMs} ms` : `Exit ${result.code}`;
      const evidence = await context.commandFailure?.(run, result);
      // Each stream has its own preview budget: stderr cannot displace stdout.
      const preview = `stdout:\n${(evidence?.stdout ?? result.stdout).slice(0, 2000)}\nstderr:\n${(evidence?.stderr ?? result.stderr).slice(0, 2000)}`;
      throw new Error(
        `${reason}: ${run}${evidence?.path ? `\nDiagnostics: ${evidence.path}` : ''}${evidence?.error ? `\nDiagnostics could not be saved: ${evidence.error}` : ''}\n${preview}`,
      );
    }
    return result;
  };
  return {
    primary: 'wall_ms',
    metrics,
    async sample() {
      const result = await exec();
      const out: Record<string, number> = { wall_ms: result.wallMs };
      if (result.cpuUserMs !== undefined) out.cpu_user_ms = result.cpuUserMs;
      if (result.cpuSysMs !== undefined) out.cpu_sys_ms = result.cpuSysMs;
      if (result.maxRssMb !== undefined) out.max_rss_mb = result.maxRssMb;
      return out;
    },
    profile: (file) => profileCommand(benchmark.profile, file, exec, command),
  };
};

export async function profileCommand(
  profile: { mode: string; command?: string },
  file: string,
  exec: (extra?: Record<string, string>, run?: string) => Promise<unknown>,
  command: string,
): Promise<ProfileArtifact | undefined> {
  if (profile.mode === 'off') return undefined;
  if (profile.mode === 'command') {
    if (!profile.command) throw new Error('profile.mode is command, but profile.command is not set');
    const out = `${file}.prof`;
    await exec(
      {},
      profile.command
        .replaceAll('{cmd}', command)
        .replaceAll('{quotedCmd}', shellQuote(command))
        .replaceAll('{out}', out),
    );
    return { path: out, kind: 'custom' };
  }
  const { artifact } = await withNodeProfile((extra) => exec(extra), file);
  return artifact;
}
