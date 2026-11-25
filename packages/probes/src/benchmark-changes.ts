import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Benchmark, type LoadedConfig, loadConfig } from '@speedpatrol/core';
import { benchmarksHash, selectBenchmarks } from './runner.js';

const HARNESS_PATH_RE =
  /(?:^|\/)(?:bench(?:marks?|es)?|perf|tests?|__tests__|\.speedpatrol)(?:\/|$)|(?:bench|perf|speedpatrol|harness|probe)/i;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_OPERATOR = /^(?:&&|\|\||[;|&()<>]|2?>&?1?)$/;
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

type ShellItem = { kind: 'word'; value: string } | { kind: 'sep' } | { kind: 'lparen' } | { kind: 'rparen' };

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function insideRepo(root: string, candidate: string): string | undefined {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Splits a shell command line into unquoted words and command/subshell separators, skipping `#` comments. */
function shellItems(command: string): ShellItem[] {
  const items: ShellItem[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  const flush = () => {
    if (!inToken) return;
    items.push({ kind: 'word', value: current });
    current = '';
    inToken = false;
  };
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
      flush();
      items.push({ kind: 'sep' });
      i = nl;
      continue;
    }
    if (ch === '\n') {
      flush();
      items.push({ kind: 'sep' });
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '(') {
      flush();
      items.push({ kind: 'lparen' });
      continue;
    }
    if (ch === ')') {
      flush();
      items.push({ kind: 'rparen' });
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      items.push({ kind: 'sep' });
      continue;
    }
    current += ch;
    inToken = true;
  }
  flush();
  return items;
}

function cdTarget(words: string[]): string | undefined {
  let endOfFlags = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (!endOfFlags && word === '--') {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && /^-[LP]+$/.test(word)) continue;
    if (word === '-' || /[$`*?[\]{}]/.test(word)) return undefined;
    return word;
  }
  return undefined;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function collectFilesUnder(
  root: string,
  relPath: string,
  ignoredAbsDirs: ReadonlySet<string>,
): Promise<string[]> {
  const abs = resolve(root, relPath);
  if (ignoredAbsDirs.has(abs)) return [];
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
      if (ignoredAbsDirs.has(full)) continue;
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
  const initialBaseCwd = benchmark.cwd ? resolve(baseDir, benchmark.cwd) : baseDir;
  const initialHeadCwd = benchmark.cwd ? resolve(headDir, benchmark.cwd) : headDir;
  const found = new Set<string>();
  for (const cmd of commands) {
    let curBaseCwd = initialBaseCwd;
    let curHeadCwd = initialHeadCwd;
    const subshellStack: Array<[string, string]> = [];
    const dirStack: Array<[string, string]> = [];
    let segment: string[] = [];

    const processSegment = async (words: string[]) => {
      if (words.length === 0) return;
      let start = 0;
      while (start < words.length && ASSIGNMENT.test(words[start]!)) start++;
      const cmdWords = words.slice(start);
      if (cmdWords.length === 0) return;

      const head = cmdWords[0]!;
      if (head === 'cd' || head === 'pushd') {
        const target = cdTarget(cmdWords);
        if (target) {
          if (head === 'pushd') dirStack.push([curBaseCwd, curHeadCwd]);
          curBaseCwd = resolve(curBaseCwd, target);
          curHeadCwd = resolve(curHeadCwd, target);
        }
        return;
      }
      if (head === 'popd') {
        const prev = dirStack.pop();
        if (prev) [curBaseCwd, curHeadCwd] = prev;
        return;
      }

      for (const token of cmdWords) {
        if (!token || token.startsWith('-') || ASSIGNMENT.test(token) || SHELL_OPERATOR.test(token)) continue;
        if (/[$`*?[\]{}]/.test(token)) continue;
        const baseAbs = resolve(curBaseCwd, token);
        const headAbs = resolve(curHeadCwd, token);
        const rel = insideRepo(baseDir, baseAbs) ?? insideRepo(headDir, headAbs);
        if (!rel || !HARNESS_PATH_RE.test(rel)) continue;
        if (matchesMeasured(rel, benchmark.measures)) continue;
        if ((await isRegularFile(join(baseDir, rel))) || (await isRegularFile(join(headDir, rel)))) {
          found.add(rel);
        }
      }
    };

    for (const item of shellItems(cmd)) {
      if (item.kind === 'word') {
        segment.push(item.value);
      } else if (item.kind === 'sep') {
        await processSegment(segment);
        segment = [];
      } else if (item.kind === 'lparen') {
        await processSegment(segment);
        segment = [];
        subshellStack.push([curBaseCwd, curHeadCwd]);
      } else if (item.kind === 'rparen') {
        await processSegment(segment);
        segment = [];
        const saved = subshellStack.pop();
        if (saved) [curBaseCwd, curHeadCwd] = saved;
      }
    }
    await processSegment(segment);
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

function ignoredStoreDirs(
  root: string,
  loaded: LoadedConfig,
  headDir: string,
  excludeDirs: readonly string[],
): Set<string> {
  const ignored = new Set<string>([resolve(root, '.speedpatrol', 'runs')]);
  const relConfigDir = insideRepo(headDir, loaded.dir);
  if (relConfigDir) ignored.add(resolve(root, relConfigDir, 'runs'));
  for (const dir of excludeDirs) {
    const abs = resolve(dir);
    ignored.add(abs);
    const relFromHead = insideRepo(headDir, abs);
    if (relFromHead) ignored.add(resolve(root, relFromHead));
  }
  return ignored;
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
  excludeDirs: readonly string[] = [],
): Promise<Map<string, string>> {
  const selected = selectBenchmarks(loaded.benchmarks, only);
  const reasons = new Map<string, string>();
  const [baseConfig, headConfig] = await Promise.all([configBenchmarksById(baseDir), configBenchmarksById(headDir)]);
  const ignoredBaseDirs = ignoredStoreDirs(baseDir, loaded, headDir, excludeDirs);
  const ignoredHeadDirs = ignoredStoreDirs(headDir, loaded, headDir, excludeDirs);

  for (const benchmark of selected) {
    const changedFiles = new Set<string>();

    const tracked = new Set<string>();
    for (const protectedPath of benchmark.protectedPaths) {
      for (const file of await collectFilesUnder(baseDir, protectedPath, ignoredBaseDirs)) tracked.add(file);
      for (const file of await collectFilesUnder(headDir, protectedPath, ignoredHeadDirs)) tracked.add(file);
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
