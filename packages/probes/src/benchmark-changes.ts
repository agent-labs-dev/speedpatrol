import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Benchmark, type LoadedConfig, loadConfig } from '@speedpatrol/core';
import { benchmarksHash, selectBenchmarks } from './runner.js';

const HARNESS_PATH_RE =
  /(?:^|\/)(?:bench(?:marks?|es)?|perf|tests?|__tests__|\.speedpatrol)(?:\/|$)|(?:bench|perf|speedpatrol|harness|probe)/i;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_OPERATOR = /^(?:&&|\|\||[;|&()<>]|2?>&?1?)$/;
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function insideRepo(root: string, candidate: string): string | undefined {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Splits a shell command line into unquoted tokens, stopping before `#` comments. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i]!;
      } else if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]!;
      inToken = true;
      continue;
    }
    if (ch === '#' && !inToken) {
      const nl = command.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function collectFilesUnder(root: string, relPath: string): Promise<string[]> {
  const abs = resolve(root, relPath);
  const safe = insideRepo(root, abs);
  if (!safe) return [];
  const stat = await lstat(abs).catch(() => undefined);
  if (!stat) return [];
  if (stat.isFile()) return [safe];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const rel = insideRepo(root, full);
        if (rel) out.push(rel);
      }
    }
  }
  return out;
}

function matchesMeasured(relPath: string, measures: readonly string[]): boolean {
  const normalized = toPosix(relPath).replace(/^\.\//, '');
  return measures.some((entry) => {
    const clean = toPosix(entry).replace(/^\.\//, '').replace(/\/+$/, '');
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

async function scriptCandidates(benchmark: Benchmark, baseDir: string, headDir: string): Promise<string[]> {
  // Startup benchmarks launch the app itself; only command/custom benchmarks run harness scripts.
  if (benchmark.kind !== 'command' && benchmark.kind !== 'custom') return [];
  const commands = [benchmark.run, ...(benchmark.kind === 'command' && benchmark.before ? [benchmark.before] : [])];
  const baseCwd = benchmark.cwd ? resolve(baseDir, benchmark.cwd) : baseDir;
  const headCwd = benchmark.cwd ? resolve(headDir, benchmark.cwd) : headDir;
  const found = new Set<string>();
  for (const cmd of commands) {
    for (const token of shellTokens(cmd)) {
      if (!token || token.startsWith('-') || ASSIGNMENT.test(token) || SHELL_OPERATOR.test(token)) continue;
      if (/[$`*?[\]{}]/.test(token)) continue;
      const baseAbs = resolve(baseCwd, token);
      const headAbs = resolve(headCwd, token);
      const rel = insideRepo(baseDir, baseAbs) ?? insideRepo(headDir, headAbs);
      if (!rel || !HARNESS_PATH_RE.test(rel)) continue;
      if (matchesMeasured(rel, benchmark.measures)) continue;
      if ((await isRegularFile(join(baseDir, rel))) || (await isRegularFile(join(headDir, rel)))) {
        found.add(rel);
      }
    }
  }
  return [...found];
}

async function fileDiffers(baseDir: string, headDir: string, relPath: string): Promise<boolean> {
  const [baseBytes, headBytes] = await Promise.all([
    readFile(join(baseDir, relPath)).catch(() => undefined),
    readFile(join(headDir, relPath)).catch(() => undefined),
  ]);
  if (baseBytes === undefined && headBytes === undefined) return false;
  if (baseBytes === undefined || headBytes === undefined) return true;
  return !baseBytes.equals(headBytes);
}

async function configBenchmarksById(dir: string): Promise<Map<string, Benchmark> | undefined> {
  try {
    const loaded = await loadConfig(dir);
    return new Map(loaded.benchmarks.map((item) => [item.id, item]));
  } catch {
    return undefined;
  }
}

/**
 * Detects selected benchmarks whose config definition, `protectedPaths`, or
 * harness script files changed between `baseDir` and `headDir`. Such benchmarks
 * do not measure like-for-like work across the two sides and must be reported
 * as `not_comparable` rather than a regression.
 */
export async function changedBenchmarks(
  loaded: LoadedConfig,
  baseDir: string,
  headDir: string,
  only?: string[],
): Promise<Map<string, string>> {
  const selected = selectBenchmarks(loaded.benchmarks, only);
  const reasons = new Map<string, string>();
  const [baseConfig, headConfig] = await Promise.all([configBenchmarksById(baseDir), configBenchmarksById(headDir)]);

  for (const benchmark of selected) {
    const changedFiles = new Set<string>();

    const tracked = new Set<string>();
    for (const protectedPath of benchmark.protectedPaths) {
      for (const file of await collectFilesUnder(baseDir, protectedPath)) tracked.add(file);
      for (const file of await collectFilesUnder(headDir, protectedPath)) tracked.add(file);
    }
    for (const script of await scriptCandidates(benchmark, baseDir, headDir)) {
      tracked.add(script);
    }

    for (const relPath of tracked) {
      if (await fileDiffers(baseDir, headDir, relPath)) changedFiles.add(relPath);
    }

    const baseDef = baseConfig?.get(benchmark.id);
    const headDef = headConfig?.get(benchmark.id);
    const defChanged = Boolean(baseDef && headDef && benchmarksHash([baseDef]) !== benchmarksHash([headDef]));

    if (changedFiles.size > 0 || defChanged) {
      const parts: string[] = [];
      if (changedFiles.size > 0) {
        parts.push(`benchmark file changed between base and head: ${[...changedFiles].sort().join(', ')}`);
      }
      if (defChanged) {
        parts.push('benchmark definition changed between base and head');
      }
      reasons.set(benchmark.id, parts.join('; '));
    }
  }

  return reasons;
}
