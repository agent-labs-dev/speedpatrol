import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join, relative } from 'node:path';
import {
  type Benchmark,
  type BenchmarkResult,
  hash,
  type LoadedConfig,
  loadWarning,
  MeasureError,
  type MetricSeries,
  type MetricSpec,
  machineInfo,
  newId,
  type Run,
  type RunPurpose,
  redact,
  type Sample,
  type Store,
  sourceInfo,
} from '@speedpatrol/core';
import { summarize } from '@speedpatrol/stats';
import { AppSession } from './app.js';
import { createProbe } from './probes/index.js';

export type MeasureOptions = {
  loaded: LoadedConfig;
  store: Store;
  /** The checkout to measure. Default: the configured source. */
  source?: string;
  purpose: RunPurpose;
  /** Only these benchmark ids (or tags). Default: all. */
  only?: string[];
  /** Overrides each benchmark's iteration count, e.g. a quick confirmation. */
  iterations?: number;
  profile?: boolean;
  log?: (line: string) => void;
  /** Called after each benchmark, so the dashboard can show progress. */
  onResult?: (result: BenchmarkResult) => void | Promise<void>;
};

/**
 * What a benchmark measures, without the settings that only change how long
 * or how often (iterations, warmup, timeout) or how it is labelled: tuning
 * those keeps two runs comparable.
 */
export function benchmarksHash(benchmarks: Benchmark[]): string {
  return hash(
    benchmarks.map(
      ({
        title: _t,
        description: _d,
        tags: _g,
        critical: _c,
        iterations: _i,
        warmup: _w,
        timeoutMs: _o,
        profile: _p,
        ...what
      }) => what,
    ),
  );
}

export function selectBenchmarks(benchmarks: Benchmark[], only?: string[]): Benchmark[] {
  if (!only?.length) return benchmarks;
  const selected = benchmarks.filter(
    (benchmark) => only.includes(benchmark.id) || benchmark.tags.some((tag) => only.includes(tag)),
  );
  const unknown = only.filter((name) => !benchmarks.some((b) => b.id === name || b.tags.includes(name)));
  if (unknown.length) throw new MeasureError(`Unknown benchmark or tag: ${unknown.join(', ')}`);
  return selected;
}

/** Turns samples into one series per metric, and picks the primary metric. */
export function toResult(
  benchmark: Benchmark,
  probe: { primary: string; metrics: Record<string, MetricSpec> },
  samples: Sample[],
  durationMs: number,
): BenchmarkResult {
  const metrics: Record<string, MetricSeries> = {};
  for (const [name, spec] of Object.entries(probe.metrics)) {
    const values = samples.flatMap((sample) => (sample.metrics[name] === undefined ? [] : [sample.metrics[name]!]));
    if (values.length) metrics[name] = { unit: spec.unit, better: spec.better, values, summary: summarize(values) };
  }
  // The declared primary, else the probe's, else the first metric that has values
  // (a page with no contentful paint has no LCP).
  const candidates = [benchmark.primary, probe.primary, 'load_ms', ...Object.keys(metrics)].filter(Boolean) as string[];
  const primary = candidates.find((name) => metrics[name]) ?? probe.primary;
  return {
    benchmark: benchmark.id,
    kind: benchmark.kind,
    primary,
    metrics,
    iterations: samples.length,
    errors: samples.flatMap((sample) => (sample.error ? [sample.error] : [])),
    durationMs,
    critical: benchmark.critical,
  };
}

/**
 * Brings the app up, runs every selected benchmark (warmup, timed
 * iterations, then one profiled iteration), brings the app down, and saves
 * the run. No model is involved: a run is the same code path every time.
 */
export async function measure(options: MeasureOptions): Promise<Run> {
  const { loaded, store } = options;
  const log = options.log ?? (() => {});
  const source = options.source ?? loaded.source;
  const benchmarks = selectBenchmarks(loaded.benchmarks, options.only);
  if (benchmarks.length === 0) throw new MeasureError('No benchmarks to run. Add some, or run `speedpatrol scout`.');
  const id = newId();
  const startedAt = new Date().toISOString();
  const app = new AppSession({
    setup: loaded.config.app.setup,
    teardown: loaded.config.app.teardown,
    env: loaded.config.app.env,
    secrets: [...loaded.config.app.secrets],
    source,
    log,
  });
  const run: Run = {
    id,
    purpose: options.purpose,
    startedAt,
    finishedAt: startedAt,
    source: { dir: source, ...(await sourceInfo(source)) },
    machine: machineInfo(),
    benchmarksHash: benchmarksHash(benchmarks),
    results: [],
  };
  const highLoad = loadWarning(run.machine);
  if (highLoad) log(highLoad);
  const defaults = loaded.config.defaults;
  try {
    await app.start();
    for (const benchmark of benchmarks) {
      const result = await measureOne(benchmark, {
        app,
        iterations: options.iterations ?? benchmark.iterations ?? defaults.iterations,
        warmup: options.iterations ? Math.min(1, defaults.warmup) : (benchmark.warmup ?? defaults.warmup),
        timeoutMs: benchmark.timeoutMs ?? defaults.timeoutMs,
        diagnosticDir: store.path('diagnostics', id),
        profileDir: options.profile === false ? undefined : store.path('profiles', id),
        source,
        log,
        storeRoot: store.root,
      });
      run.results.push(result);
      await options.onResult?.(result);
    }
  } catch (error) {
    run.failed = redact((error as Error).message, app.secretValues);
  } finally {
    await app.stop();
  }
  if (run.machine.load) {
    run.machine.load.end = loadavg()[0] ?? 0;
    // A run that started quiet can end overloaded; one warning per run is enough.
    const endLoad = loadWarning(run.machine);
    if (endLoad && !highLoad) log(endLoad);
  }
  run.finishedAt = new Date().toISOString();
  if (!run.failed) {
    const failedCritical = run.results.filter(
      (result) => result.critical && !result.metrics[result.primary]?.values.length,
    );
    if (failedCritical.length) {
      run.failed = failedCritical
        .map((result) => `Critical benchmark ${result.benchmark} failed: ${result.errors[0] ?? 'no primary samples'}`)
        .join('\n');
    } else if (run.results.every((result) => Object.keys(result.metrics).length === 0)) {
      run.failed = 'Every benchmark failed.';
    }
  }
  await store.saveRun(run);
  return run;
}

type OneOptions = {
  app: AppSession;
  iterations: number;
  warmup: number;
  timeoutMs: number;
  profileDir?: string;
  diagnosticDir: string;
  source: string;
  storeRoot: string;
  log: (line: string) => void;
};

async function measureOne(benchmark: Benchmark, options: OneOptions): Promise<BenchmarkResult> {
  const { app, log } = options;
  const diagnostics: NonNullable<BenchmarkResult['diagnostics']> = [];
  let phase: 'warmup' | 'sample' | 'profile' = 'warmup';
  let iteration = 1;
  const probe = createProbe(benchmark, {
    source: options.source,
    vars: app.vars,
    timeoutMs: options.timeoutMs,
    log,
    async commandFailure(command, output) {
      const path = join(options.diagnosticDir, `${randomUUID()}.json`);
      const stream = (text: string, omittedBytes = 0) => {
        text = redact(text, app.secretValues);
        // A capture boundary can split a secret. Remove any exact secret prefix at that boundary too.
        if (omittedBytes) {
          for (const secret of app.secretValues) {
            if (secret.length < 4) continue;
            for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
              if (text.endsWith(secret.slice(0, size))) {
                text = `${text.slice(0, -size)}[redacted]`;
                break;
              }
            }
          }
        }
        return { text, omittedBytes };
      };
      const evidence = {
        command: redact(command, app.secretValues),
        code: output.code,
        timedOut: output.timedOut,
        stdout: stream(output.stdout, output.stdoutOmittedBytes),
        stderr: stream(output.stderr, output.stderrOmittedBytes),
      };
      try {
        await mkdir(options.diagnosticDir, { recursive: true });
        await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
        const relativePath = relative(options.storeRoot, path);
        diagnostics.push({ path: relativePath, phase, iteration });
        log(`${benchmark.id}: ${phase} ${iteration} diagnostics: ${relativePath}`);
        return { path: relativePath, stdout: evidence.stdout.text, stderr: evidence.stderr.text };
      } catch (error) {
        return {
          stdout: evidence.stdout.text,
          stderr: evidence.stderr.text,
          error: redact((error as Error).message, app.secretValues),
        };
      }
    },
  });
  const started = performance.now();
  const samples: Sample[] = [];
  let profile: BenchmarkResult['profile'];
  log(`${benchmark.id}: ${options.warmup} warmup + ${options.iterations} iterations`);
  try {
    await probe.open?.();
    // A warmup that fails every time means the benchmark is broken, not slow:
    // stop here with the error instead of timing out iteration after iteration.
    let warmupError: string | undefined;
    let warmed = options.warmup === 0;
    for (let i = 0; i < options.warmup; i++) {
      iteration = i + 1;
      try {
        await probe.sample();
        warmed = true;
      } catch (error) {
        warmupError = (error as Error).message;
        log(`${benchmark.id}: warmup ${i + 1} failed: ${redact(warmupError, app.secretValues).split('\n')[0]}`);
      }
    }
    if (!warmed) throw new Error(`Every warmup failed: ${warmupError}`);
    phase = 'sample';
    let failures = 0;
    for (let i = 0; i < options.iterations; i++) {
      iteration = i + 1;
      try {
        samples.push({ iteration: i, metrics: await probe.sample() });
      } catch (error) {
        failures++;
        samples.push({ iteration: i, metrics: {}, error: redact((error as Error).message, app.secretValues) });
        log(`${benchmark.id}: iteration ${i + 1} failed: ${samples.at(-1)!.error!.split('\n')[0]}`);
        // Three failures in a row and no success: the benchmark is broken, not slow.
        if (failures >= 3 && samples.every((sample) => sample.error)) break;
      }
    }
    if (options.profileDir && benchmark.profile.enabled && probe.profile && samples.some((s) => !s.error)) {
      phase = 'profile';
      iteration = 1;
      await mkdir(options.profileDir, { recursive: true });
      try {
        const artifact = await probe.profile(join(options.profileDir, benchmark.id));
        if (artifact) profile = { ...artifact, path: relative(options.storeRoot, artifact.path) };
        else if (benchmark.profile.mode === 'auto') {
          log(
            `${benchmark.id}: automatic profiling produced no Node CPU profile; for other runtimes set profile.mode to command and provide profile.command.`,
          );
        }
      } catch (error) {
        log(`${benchmark.id}: profile failed: ${redact((error as Error).message, app.secretValues)}`);
      }
    }
  } catch (error) {
    samples.push({ iteration: samples.length, metrics: {}, error: redact((error as Error).message, app.secretValues) });
  } finally {
    await probe.close?.().catch(() => undefined);
  }
  const result = toResult(benchmark, probe, samples, performance.now() - started);
  if (profile) result.profile = profile;
  if (diagnostics.length) result.diagnostics = diagnostics;
  const primary = result.metrics[result.primary];
  log(
    primary
      ? `${benchmark.id}: ${result.primary} median ${primary.summary.median.toFixed(2)} (${result.errors.length} errors)`
      : `${benchmark.id}: failed: ${result.errors[0] ?? 'no samples'}`,
  );
  return result;
}
