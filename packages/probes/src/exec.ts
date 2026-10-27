import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';

export type Exec = {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  /** User and system CPU of the command and its children, from bash `times`. */
  cpuUserMs?: number;
  cpuSysMs?: number;
  /** Peak RSS in MB, when GNU time is installed. */
  maxRssMb?: number;
  timedOut: boolean;
};

const GNU_TIME = '/usr/bin/time';

function parseTimes(text: string): { user: number; sys: number } | undefined {
  // bash `times`: the second line is the children's "user sys", e.g. "0m1.250s 0m0.031s".
  const line = text.trim().split('\n').at(-1);
  const match = line?.match(/^(\d+)m([\d.]+)s\s+(\d+)m([\d.]+)s$/);
  if (!match) return undefined;
  const ms = (minutes: string, seconds: string) => (Number(minutes) * 60 + Number(seconds)) * 1000;
  return { user: ms(match[1]!, match[2]!), sys: ms(match[3]!, match[4]!) };
}

/** Kills the whole process group: a dev server's children must not outlive it. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function collect(stream: Readable | null, limit = 4 * 1024 * 1024): { text: () => string } {
  let text = '';
  stream?.on('data', (chunk: Buffer) => {
    if (text.length < limit) text += chunk.toString();
  });
  return { text: () => text };
}

/**
 * Runs one command under bash and times it. The wall clock starts right
 * before the spawn, so it includes the shell's own start (a few ms, the same
 * on both sides of a comparison).
 */
export function runTimed(exec: Exec): Promise<ExecResult> {
  const gnuTime = process.platform === 'linux' && existsSync(GNU_TIME);
  const script = `${gnuTime ? `${GNU_TIME} -f '__SP_RSS %M' -o /dev/fd/3 ` : ''}bash -c ${shellQuote(exec.command)}; __sp=$?; times >&3; exit $__sp`;
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn('bash', ['-c', script], {
      cwd: exec.cwd,
      env: { ...process.env, ...exec.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const meta = collect(child.stdio[3] as Readable);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, exec.timeoutMs);
    child.on('close', (code) => {
      const wallMs = performance.now() - started;
      clearTimeout(timer);
      const metaText = meta.text();
      const rss = metaText.match(/__SP_RSS (\d+)/);
      const times = parseTimes(metaText.replace(/__SP_RSS \d+\n?/, ''));
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        wallMs,
        cpuUserMs: times?.user,
        cpuSysMs: times?.sys,
        maxRssMb: rss ? Number(rss[1]) / 1024 : undefined,
        timedOut,
      });
    });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type Background = {
  child: ChildProcess;
  output: () => string;
  stop(): Promise<void>;
};

/** Starts a long-running command in its own process group. */
export function startBackground(command: string, cwd: string, env: Record<string, string>): Background {
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 1024 * 1024) output = output.slice(-512 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      killTree(child, 'SIGTERM');
      const timeout = new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 5000).unref());
      if ((await Promise.race([exited, timeout])) === 'timeout') {
        killTree(child, 'SIGKILL');
        await exited;
      }
    },
  };
}

/** Resolves when `test` passes, polling; rejects after `timeoutMs`. */
export async function waitUntil(
  test: () => Promise<boolean> | boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 25,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

export async function urlAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
