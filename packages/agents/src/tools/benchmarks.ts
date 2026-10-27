import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BENCHMARK_KINDS,
  BENCHMARKS_FILE,
  type Benchmark,
  type LoadedConfig,
  parseBenchmark,
  readScoutedBenchmarks,
  redact,
  type Store,
} from '@speedpatrol/core';
import { AppSession, createProbe } from '@speedpatrol/probes';
import { formatValue, summarize } from '@speedpatrol/stats';
import type { Tool } from '../types.js';
import { str, tool } from './schema.js';

const BENCHMARK_HELP = `A benchmark is a JSON object. Common fields: id (lowercase, e.g. "api.list-orders"), title, description, critical (true for the paths users feel most), tags, iterations, primary.
Kinds (${BENCHMARK_KINDS.join(', ')}):
- http: {"kind":"http","request":{"url":"\${BASE_URL}/api/orders","method":"GET","headers":{}},"expectStatus":200,"concurrency":1}
- web: {"kind":"web","url":"...","steps":[{"name":"open-settings","click":"#settings","waitFor":"h1.settings"}],"setup":[...sign-in steps, not timed]}
- startup: {"kind":"startup","run":"node dist/server.js","env":{"PORT":"4999"},"ready":{"url":"http://127.0.0.1:4999/health"}}
- command: {"kind":"command","run":"npm run build"}
- electron: {"kind":"electron","run":"npx electron . --remote-debugging-port=9333","cdpPort":9333,"readySelector":"#app"}
- android: {"kind":"android","activity":"com.example/.MainActivity"}; ios: {"kind":"ios","bundleId":"com.example.app"}
- maestro: {"kind":"maestro","flow":".maestro/open-settings.yaml"}
- custom: {"kind":"custom","run":"node bench/render.js","metrics":{"render_ms":{"unit":"ms","better":"lower"}}} (prints {"metrics":{...}} as its last line)
Use \${NAME} for env vars and values captured by app.setup; never write a secret value.`;

async function writeScouted(dir: string, benchmarks: Benchmark[]): Promise<void> {
  await writeFile(join(dir, BENCHMARKS_FILE), `${JSON.stringify({ benchmarks }, null, 2)}\n`);
}

/**
 * The scout's tools: see the benchmarks, try one against the running app,
 * and save it. A benchmark is saved only after a trial run worked, so the
 * scout cannot commit a path that does not measure.
 */
export function benchmarkTools(
  loaded: LoadedConfig,
  store: Store,
  log: (line: string) => void,
): { tools: Tool[]; dispose(): Promise<void> } {
  let app: AppSession | undefined;
  const tried = new Map<string, string>();
  const ensureApp = async () => {
    if (app) return app;
    app = new AppSession({
      setup: loaded.config.app.setup,
      teardown: loaded.config.app.teardown,
      env: loaded.config.app.env,
      secrets: [...loaded.config.app.secrets],
      source: loaded.source,
      log,
    });
    await app.start();
    return app;
  };
  const tools: Tool[] = [
    tool('benchmark_help', 'How to write a benchmark: the fields of each kind, with examples.', {}, [], async () => ({
      text: BENCHMARK_HELP,
    })),
    tool(
      'list_benchmarks',
      'The benchmarks that exist now, with their latest median on this machine.',
      {},
      [],
      async () => {
        const runs = await store.listRuns();
        const latest = new Map<string, string>();
        for (const run of runs) {
          for (const result of run.results) {
            const series = result.metrics[result.primary];
            if (series)
              latest.set(result.benchmark, `${result.primary} ${formatValue(series.summary.median, series.unit)}`);
          }
        }
        const scouted = new Set((await readScoutedBenchmarks(loaded.dir)).map((b) => b.id));
        const all = [...loaded.config.benchmarks, ...(await readScoutedBenchmarks(loaded.dir))];
        if (all.length === 0) return { text: 'No benchmarks yet.' };
        return {
          text: all
            .map(
              (b) =>
                `${b.id} [${b.kind}${b.critical ? ', critical' : ''}${scouted.has(b.id) ? ', scouted' : ', config'}] ${b.title ?? ''} -> ${latest.get(b.id) ?? 'not measured'}`,
            )
            .join('\n'),
        };
      },
    ),
    tool(
      'try_benchmark',
      'Run a benchmark 3 times against the running app (started on first use) and show what it measured. Do this before save_benchmark.',
      { benchmark: { type: 'object', description: 'The benchmark JSON. See benchmark_help.' } },
      ['benchmark'],
      async (input) => {
        const parsed = parseBenchmark(input.benchmark);
        if (!parsed.ok) return { text: parsed.error, isError: true };
        const session = await ensureApp();
        const probe = createProbe(parsed.benchmark, {
          source: loaded.source,
          vars: session.vars,
          timeoutMs: 60_000,
          log,
        });
        const samples: Record<string, number>[] = [];
        const errors: string[] = [];
        try {
          await probe.open?.();
          for (let i = 0; i < 3; i++) {
            try {
              samples.push(await probe.sample());
            } catch (error) {
              errors.push((error as Error).message);
            }
          }
        } finally {
          await probe.close?.();
        }
        const clean = (text: string) => redact(text, session.secretValues);
        if (samples.length === 0) return { text: clean(`Every trial failed:\n${errors.join('\n')}`), isError: true };
        tried.set(parsed.benchmark.id, JSON.stringify(parsed.benchmark));
        const lines = Object.entries(probe.metrics).flatMap(([name, spec]) => {
          const values = samples.flatMap((sample) => (sample[name] === undefined ? [] : [sample[name]!]));
          if (!values.length) return [];
          const summary = summarize(values);
          return [`${name}: median ${formatValue(summary.median, spec.unit)} (cv ${(summary.cv * 100).toFixed(1)}%)`];
        });
        return {
          text: clean(`${parsed.benchmark.id} works. ${errors.length} of 3 trials failed.\n${lines.join('\n')}`),
          summary: `Tried ${parsed.benchmark.id}.`,
        };
      },
    ),
    tool(
      'save_benchmark',
      'Save a benchmark that try_benchmark ran successfully. Replaces a scouted benchmark with the same id.',
      { benchmark: { type: 'object', description: 'The same JSON that you tried.' } },
      ['benchmark'],
      async (input) => {
        const parsed = parseBenchmark(input.benchmark);
        if (!parsed.ok) return { text: parsed.error, isError: true };
        const benchmark = parsed.benchmark;
        if (tried.get(benchmark.id) !== JSON.stringify(benchmark)) {
          return { text: `Run try_benchmark with exactly this benchmark first.`, isError: true };
        }
        if (loaded.config.benchmarks.some((b) => b.id === benchmark.id)) {
          return { text: `${benchmark.id} is defined in speedpatrol.yml; pick another id.`, isError: true };
        }
        const existing = await readScoutedBenchmarks(loaded.dir);
        await writeScouted(loaded.dir, [...existing.filter((b) => b.id !== benchmark.id), benchmark]);
        return { text: `Saved ${benchmark.id} to ${BENCHMARKS_FILE}.`, summary: `Saved ${benchmark.id}.` };
      },
    ),
    tool(
      'remove_benchmark',
      'Remove a scouted benchmark that no longer measures a real path (the route or screen is gone).',
      { id: { type: 'string', description: 'The benchmark id.' }, reason: { type: 'string', description: 'Why.' } },
      ['id', 'reason'],
      async (input) => {
        const id = str(input, 'id');
        if (!existsSync(join(loaded.dir, BENCHMARKS_FILE))) return { text: 'No scouted benchmarks.', isError: true };
        const existing = await readScoutedBenchmarks(loaded.dir);
        if (!existing.some((b) => b.id === id)) return { text: `${id} is not a scouted benchmark.`, isError: true };
        await writeScouted(
          loaded.dir,
          existing.filter((b) => b.id !== id),
        );
        return { text: `Removed ${id}: ${str(input, 'reason')}` };
      },
    ),
  ];
  return {
    tools,
    async dispose() {
      await app?.stop();
    },
  };
}

export async function readInstructions(loaded: LoadedConfig): Promise<string> {
  const file = join(loaded.dir, loaded.config.app.instructions);
  return existsSync(file) ? readFile(file, 'utf8') : '(No app guide. Read the README.)';
}
