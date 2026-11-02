import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ZodError } from 'zod';
import { ConfigError } from '../errors.js';
import { type Benchmark, benchmarkSchema, configSchema, type SpeedpatrolConfig } from './schema.js';

export const CONFIG_DIR = '.speedpatrol';
export const CONFIG_FILE = 'speedpatrol.yml';
/** The benchmarks the scout writes. Committed, next to the config. */
export const BENCHMARKS_FILE = 'benchmarks.json';

export type LoadedConfig = {
  config: SpeedpatrolConfig;
  /** The `.speedpatrol` folder. */
  dir: string;
  /** The repository the benchmarks measure. */
  source: string;
  /** Inline benchmarks plus the scout's, in that order. */
  benchmarks: Benchmark[];
};

function describe(error: ZodError, file: string): string {
  return error.issues.map((issue) => `${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

/** Finds `.speedpatrol/speedpatrol.yml` from `cwd` upwards. */
export function findConfigDir(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_DIR, CONFIG_FILE))) return join(dir, CONFIG_DIR);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const dir = findConfigDir(cwd);
  if (!dir) throw new ConfigError(`No ${CONFIG_DIR}/${CONFIG_FILE} here or above. Run \`speedpatrol init\`.`);
  return loadConfigDir(dir);
}

/** Loads the config of a known `.speedpatrol` folder, without a search. */
export async function loadConfigDir(dir: string): Promise<LoadedConfig> {
  const file = join(dir, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = parse(await readFile(file, 'utf8')) ?? {};
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(describe(parsed.error, file));
  const config = parsed.data;
  const scouted = await readScoutedBenchmarks(dir);
  const benchmarks = [...config.benchmarks, ...scouted];
  const seen = new Set<string>();
  for (const benchmark of benchmarks) {
    if (seen.has(benchmark.id)) throw new ConfigError(`Benchmark id "${benchmark.id}" is defined twice.`);
    seen.add(benchmark.id);
  }
  return { config, dir, source: resolve(dirname(dir), config.project.source), benchmarks };
}

export async function readScoutedBenchmarks(dir: string): Promise<Benchmark[]> {
  const file = join(dir, BENCHMARKS_FILE);
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  const list = (raw as { benchmarks?: unknown }).benchmarks;
  if (!Array.isArray(list)) throw new ConfigError(`${file}: expected {"benchmarks": [...]}`);
  return list.map((item, index) => {
    const parsed = benchmarkSchema.safeParse(item);
    if (!parsed.success) throw new ConfigError(describe(parsed.error, `${file}#benchmarks[${index}]`));
    return parsed.data;
  });
}

export function parseBenchmark(input: unknown): { ok: true; benchmark: Benchmark } | { ok: false; error: string } {
  const parsed = benchmarkSchema.safeParse(input);
  if (parsed.success) return { ok: true, benchmark: parsed.data };
  return { ok: false, error: describe(parsed.error, 'benchmark') };
}
