import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Overridable so a machine without GNU time can still exercise this path.
const GNU_TIME = process.env.SPEEDPATROL_GNU_TIME ?? '/usr/bin/time';
// Process group ids, tracked apart from their leaders: a dev server's
// grandchild can outlive the bash leader and keep its port bound.
const groups = new Set<number>();

/** True while a process of the group is alive; drops the id once it is gone. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    // ESRCH: the group is gone. EPERM: the id now belongs to someone else.
    groups.delete(pgid);
    return false;
  }
}

export function registerGroup(child: ChildProcess): void {
  const pgid = child.pid;
  if (pgid === undefined || groups.has(pgid)) return;
  groups.add(pgid);
  child.once('exit', () => groupAlive(pgid));
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    groups.delete(pgid);
  }
}

export function killAllGroups(signal: NodeJS.Signals): void {
  for (const pgid of groups) signalGroup(pgid, signal);
}

export function activeGroupCount(): number {
  for (const pgid of groups) groupAlive(pgid);
  return groups.size;
}

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
  if (child.pid === undefined) return;
  // A tracked group can outlive its leader, so it is signalled by id regardless.
  if (groups.has(child.pid)) {
    signalGroup(child.pid, signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* The child can exit between the group and child kill attempts. */
    }
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
  // GNU time writes to a file: Node's stdio pipes are sockets, and Linux
  // refuses to open() a socket through /dev/fd (ENXIO).
  const rssFile = gnuTime ? join(tmpdir(), `speedpatrol-rss-${randomBytes(6).toString('hex')}`) : undefined;
  const script = `${rssFile ? `${GNU_TIME} -f '__SP_RSS %M' -o ${shellQuote(rssFile)} ` : ''}bash -c ${shellQuote(exec.command)}; __sp=$?; times >&3; exit $__sp`;
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn('bash', ['-c', script], {
      cwd: exec.cwd,
      env: { ...process.env, ...exec.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    registerGroup(child);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const meta = collect(child.stdio[3] as Readable);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, exec.timeoutMs);
    // A failed spawn (e.g. a cwd an experiment's cleanup already removed)
    // is a failed sample, not an unhandled 'error' that kills the patrol.
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rssFile) rmSync(rssFile, { force: true });
      resolve({ code: null, stdout: '', stderr: error.message, wallMs: performance.now() - started, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const wallMs = performance.now() - started;
      clearTimeout(timer);
      const metaText = meta.text();
      let rssText = '';
      if (rssFile) {
        try {
          rssText = readFileSync(rssFile, 'utf8');
        } catch {
          /* killed before time wrote it */
        }
        rmSync(rssFile, { force: true });
      }
      const rss = rssText.match(/__SP_RSS (\d+)/);
      const times = parseTimes(metaText);
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
  registerGroup(child);
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 1024 * 1024) output = output.slice(-512 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (error) => append(Buffer.from(`${error.message}\n`)));
  return {
    child,
    output: () => output,
    async stop() {
      // The group can outlive its leader (a server backgrounded by the shell), so wait for both.
      const pgid = child.pid;
      const running = () =>
        (child.exitCode === null && child.signalCode === null) || (pgid !== undefined && groupAlive(pgid));
      const settle = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (running() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      };
      if (!running()) return;
      killTree(child, 'SIGTERM');
      await settle(5000);
      if (!running()) return;
      killTree(child, 'SIGKILL');
      await settle(5000);
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
