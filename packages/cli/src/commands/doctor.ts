import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Benchmark, interpolate, loadConfig, type SpeedpatrolConfig } from '@speedpatrol/core';

const exec = promisify(execFile);

async function version(command: string, args = ['--version']): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout: 15_000 });
    return (stdout || stderr).trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * A program word from a command line, and whether Speedpatrol can check it.
 * `cd` lists the directories an earlier `cd` in the same line moved into, in order.
 */
type ProgramWord = { word: string; checked: boolean; cd?: string[] };

/** A segment and the operator that follows it: `&&`, `||`, `|`, or `;` (also a newline or the end). */
type Segment = { text: string; next: '&&' | '||' | '|' | ';' };

/** Splits a shell command line on `&&`, `||`, `;`, `|` and newlines outside quotes. */
function commandSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if ((char === '&' || char === '|') && command[i + 1] === char) {
      segments.push({ text: command.slice(start, i), next: char === '&' ? '&&' : '||' });
      start = i + 2;
      i++;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n') {
      segments.push({ text: command.slice(start, i), next: char === '|' ? '|' : ';' });
      start = i + 1;
    }
  }
  segments.push({ text: command.slice(start), next: ';' });
  return segments.map((segment) => ({ ...segment, text: segment.text.trim() })).filter((segment) => segment.text);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Expansion, redirection, quoting and `{cmd}` templates: the word on disk is not the word in the config. */
const EXPANSION = /[$`()<>{}"'\\]/;

/**
 * Takes the program word of each segment and skips leading `NAME=value`
 * assignments. A word that a shell would expand (`$VAR`, a subshell), or
 * that follows a `PATH=` assignment, cannot be looked up without running it,
 * so it is reported as not checked.
 */
export function programWords(command: string): ProgramWord[] {
  const words: ProgramWord[] = [];
  const cd: string[] = [];
  // After `cd ~`, `cd -` or `cd $DIR` the directory is known only at run time, so a path word cannot be checked.
  let cdUnknown = false;
  let previous: Segment['next'] = ';';
  for (const segment of commandSegments(command)) {
    const before = previous;
    previous = segment.next;
    const parts = segment.text.split(/\s+/);
    const at = parts.findIndex((part) => !ASSIGNMENT.test(part));
    const word = parts[at];
    if (!word) continue;
    // A leading `PATH=...` changes where the shell looks the word up.
    const inlinePath = parts.slice(0, at).some((part) => part.startsWith('PATH='));
    words.push({
      word,
      checked: !EXPANSION.test(word) && !inlinePath && !(cdUnknown && word.includes('/')),
      ...(cd.length ? { cd: [...cd] } : {}),
    });
    // A piped `cd` runs in a subshell and leaves the directory as it was.
    if (word !== 'cd' || segment.next === '|' || before === '|') continue;
    const target = parts[at + 1];
    // After `cd dir || ...` the directory depends on whether the cd succeeded,
    // and after `... && cd dir` or `... || cd dir` on whether the cd ran at all.
    if (segment.next === '||' || before === '&&' || before === '||') cdUnknown = true;
    else if (target && parts.length === at + 2 && !EXPANSION.test(target) && !/^[-~]/.test(target)) cd.push(target);
    else cdUnknown = true;
  }
  return words;
}

type Step = {
  run: string;
  cwd?: string;
  env: Record<string, string>;
  /** How the doctor names the step that runs it. */
  usedBy: string;
};

function stepCommands(config: SpeedpatrolConfig, benchmarks: Benchmark[]): Step[] {
  const steps: Step[] = [];
  for (const [phase, commands] of [
    ['prepare', config.app.prepare],
    ['setup', config.app.setup],
    ['teardown', config.app.teardown],
  ] as const) {
    commands.forEach((command, index) => {
      steps.push({ run: command.run, cwd: command.cwd, env: command.env, usedBy: `app.${phase}[${index}]` });
    });
  }
  for (const benchmark of benchmarks) {
    const usedBy = `benchmark ${benchmark.id}`;
    if (benchmark.kind === 'command' || benchmark.kind === 'startup' || benchmark.kind === 'custom') {
      steps.push({ run: benchmark.run, cwd: benchmark.cwd, env: benchmark.env, usedBy });
      if (benchmark.kind !== 'custom' && benchmark.before) {
        steps.push({ run: benchmark.before, cwd: benchmark.cwd, env: benchmark.env, usedBy });
      }
      if (benchmark.profile.command) {
        steps.push({ run: benchmark.profile.command, cwd: benchmark.cwd, env: benchmark.env, usedBy });
      }
    }
    if (benchmark.kind === 'electron' && benchmark.run) {
      steps.push({ run: benchmark.run, cwd: benchmark.cwd, env: benchmark.env, usedBy });
    }
  }
  return steps;
}

/** Resolves a program word without running it: `bash` runs `command -v` on the positional argument. */
async function locate(word: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!existsSync(cwd)) return undefined;
  try {
    const { stdout } = await exec('bash', ['-c', 'command -v -- "$1"', '_', word], { cwd, env, timeout: 15_000 });
    return stdout.trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Checks what Speedpatrol needs and reports each item. Returns false if one required item fails. */
export async function doctor(cwd: string, log: (line: string) => void): Promise<boolean> {
  let ok = true;
  const check = (label: string, value: string | undefined, required: boolean) => {
    log(
      `${value ? '✓' : required ? '✗' : '-'} ${label}${value ? `: ${value}` : required ? ': missing' : ': not found (optional)'}`,
    );
    if (!value && required) ok = false;
  };
  check('node >= 22', Number(process.versions.node.split('.')[0]) >= 22 ? process.versions.node : undefined, true);
  check('git', await version('git'), true);
  try {
    const loaded = await loadConfig(cwd);
    check('config', `${loaded.benchmarks.length} benchmarks in ${loaded.dir}`, true);
    const seen = new Set<string>();
    for (const step of stepCommands(loaded.config, loaded.benchmarks)) {
      const dir = step.cwd ? (isAbsolute(step.cwd) ? step.cwd : resolve(loaded.source, step.cwd)) : loaded.source;
      // The same variables and interpolation as AppSession and the probes use at run time.
      const vars = {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])),
        ...loaded.config.app.env,
        SPEEDPATROL_SOURCE: loaded.source,
      };
      const stepEnv = Object.fromEntries(
        Object.entries({ ...loaded.config.app.env, ...step.env }).map(([key, value]) => [
          key,
          interpolate(value, vars),
        ]),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, ...stepEnv, SPEEDPATROL_SOURCE: loaded.source };
      // A `${NAME}` left in PATH comes from a setup capture, known only at run time.
      const runtimePath = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(env.PATH ?? '');
      for (const { word, checked, cd = [] } of programWords(step.run)) {
        const wordDir = resolve(dir, ...cd);
        const key = `${wordDir}\0${env.PATH ?? ''}\0${word}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // A `${NAME}` cwd comes from a setup capture, known only at run time.
        if (!checked || step.cwd?.includes('$')) {
          log(`- ${word}: not checked, shell expansion`);
          continue;
        }
        if (runtimePath) {
          log(`- ${word}: not checked, PATH set at run time`);
          continue;
        }
        const path = await locate(word, wordDir, env);
        if (path) log(`✓ ${word}: ${path}`);
        else {
          log(`✗ ${word}: missing (used by ${step.usedBy})`);
          ok = false;
        }
      }
    }
    const kinds = new Set(loaded.benchmarks.map((b) => b.kind));
    if (kinds.has('web') || kinds.has('electron')) {
      const { chromium } = await import('playwright');
      check(
        'chromium for playwright',
        existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined,
        true,
      );
    } else {
      log('- chromium for playwright: skipped, no web or electron benchmark');
    }
    if (kinds.has('android')) check('adb', await version('adb', ['version']), true);
    if (kinds.has('ios')) check('xcrun simctl', await version('xcrun', ['simctl', 'help']), true);
    if (kinds.has('maestro')) check('maestro', await version('maestro'), true);
    const agents = loaded.config.agents;
    for (const [role, settings] of Object.entries({
      scout: agents.scout,
      analyst: agents.analyst,
      optimizer: agents.optimizer,
    })) {
      if (!settings.enabled) continue;
      const use = settings.use;
      if (use.runtime === 'cli') {
        const program = use.command
          ?.trim()
          .split(/\s+/)
          .find((word) => !/^[A-Za-z_]+=/.test(word));
        check(`${role} agent (${program})`, program ? await version(program) : undefined, true);
      } else {
        check(`${role} model ${use.via}:${use.model}`, 'API key read at run time', true);
      }
    }
    if (agents.github.enabled) check('gh', await version('gh'), true);
  } catch (error) {
    check('config', undefined, true);
    log(`  ${(error as Error).message}`);
  }
  return ok;
}
