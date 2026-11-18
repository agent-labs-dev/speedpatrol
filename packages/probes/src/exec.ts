import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

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
  /** Bytes discarded after the per-stream capture limit. */
  stdoutOmittedBytes?: number;
  stderrOmittedBytes?: number;
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
// Session ids, tracked like groups: `script` starts a terminal app in a
// session of its own, and the app's processes can leave its group (a job).
// Each maps to the groups the session has had.
const sessions = new Map<number, Set<number>>();

/** True while a non-zombie process of the group exists; drops the id once none does. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    // ESRCH: the group is gone. EPERM: the id now belongs to someone else.
    groups.delete(pgid);
    return false;
  }
  // kill(-pgid, 0) also succeeds while the only members left are zombies,
  // which stay until their parent or reaper waits for them: a container init
  // need not reap orphans at all. So the members' states decide.
  if (hasLiveMember(pgid)) return true;
  groups.delete(pgid);
  return false;
}

const live = (state: string | undefined) => state !== undefined && state[0] !== 'Z' && state[0] !== 'X';

type Process = { pid: number; state: string; pgrp: number; session: number };

/** Tasks the kernel has created since boot, from /proc/stat; undefined where it cannot be read. */
function forkCount(): string | undefined {
  try {
    return readFileSync('/proc/stat', 'utf8').match(/^processes (\d+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

/** Whether this /proc hides other users' processes or their stat files (the hidepid mount option). */
function procHides(): boolean {
  try {
    const mount = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .find((line) => line.split(' ')[4] === '/proc');
    const option = mount?.split(' - ')[1]?.match(/hidepid=(\w+)/)?.[1];
    return mount === undefined || (option !== undefined && option !== '0' && option !== 'off');
  } catch {
    return true;
  }
}

/** A task's state, pgrp and session from its stat file: "pid (comm) state ppid pgrp session ...". */
function readStat(path: string): { state: string; pgrp: string | undefined; session: string | undefined } {
  const stat = readFileSync(path, 'utf8');
  // comm can hold spaces and ")".
  const [state = '', , pgrp, session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { state, pgrp, session };
}

const exited = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

/** The state of a live thread of the process, if one is left; a thread that exits meanwhile is skipped. */
function liveThreadState(pid: string): string | undefined {
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const { state } = readStat(`/proc/${pid}/task/${tid}/stat`);
      if (live(state)) return state;
    } catch (error) {
      if (!exited(error)) throw error;
    }
  }
  return undefined;
}

/**
 * Every process on Linux, from /proc; undefined without /proc. A process whose main thread has
 * exited reads as a zombie while its other threads run, so its state is a live thread's.
 * `complete`: the reading saw every process: the kernel created no task (process or thread)
 * while it was read, as the fork count is the same before and after, /proc hides none, and each
 * stat file it could not read belonged to a process that had exited.
 */
function linuxProcesses(): { processes: Process[]; complete: boolean } | undefined {
  const forks = forkCount();
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  let complete = forks !== undefined && !procHides();
  const processes = pids.flatMap((pid) => {
    let row: ReturnType<typeof readStat>;
    try {
      row = readStat(`/proc/${pid}/stat`);
      if (!live(row.state)) row.state = liveThreadState(pid) ?? row.state;
    } catch (error) {
      // Exited since the listing; any other failure leaves the process unknown.
      if (!exited(error)) complete = false;
      return [];
    }
    return [{ pid: Number(pid), state: row.state, pgrp: Number(row.pgrp), session: Number(row.session) }];
  });
  return { processes, complete: complete && forks === forkCount() };
}

/**
 * Joins ps rows of "pid pgid state" with rows of "pid sid"; a process
 * without a session (it exited between the two listings) or a row of any
 * other shape is skipped.
 */
export function joinProcessRows(ps: string, sids: string): Process[] {
  const rows = (text: string, width: number) =>
    text.split('\n').flatMap((row) => {
      const fields = row.trim().split(/\s+/);
      return fields.length === width ? [fields] : [];
    });
  const id = (text: string) => (/^\d+$/.test(text) && Number(text) > 0 ? Number(text) : undefined);
  const session = new Map(rows(sids, 2).map(([pid, sid]) => [id(pid!), id(sid!)]));
  return rows(ps, 3).flatMap(([pid, pgrp, state]) => {
    const ids = { pid: id(pid!), pgrp: id(pgrp!), session: session.get(id(pid!)) };
    if (ids.pid === undefined || ids.pgrp === undefined || ids.session === undefined) return [];
    return [{ pid: ids.pid, pgrp: ids.pgrp, session: ids.session, state: state! }];
  });
}

// No macOS ps column or pgrep option gives the session: ps documents `sess`
// as the session ID but prints the kernel's eproc e_sess pointer, which xnu
// leaves zero, and pgrep has no -s. getsid(2) answers for any pid, and
// JavaScript for Automation, which every macOS ships, can bind it. (macOS
// perl is built without syscall.)
const GETSID_JXA = `ObjC.bindFunction('getsid', ['int', ['int']]);
function run(pids) {
  return pids.map((pid) => pid + ' ' + $.getsid(Number(pid))).join('\\n');
}`;

/** Every process on macOS, with its session; undefined when the table cannot be read. */
function macProcesses(): Process[] | undefined {
  try {
    // Bounded like a stop's own waits: these run synchronously, so a stalled one would block every deadline.
    const options = { encoding: 'utf8', timeout: 5000 } as const;
    const ps = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], options);
    const pids = ps.split('\n').flatMap((row) =>
      row
        .trim()
        .split(/\s+/, 1)
        .filter((pid) => /^\d+$/.test(pid)),
    );
    const sids = execFileSync('osascript', ['-l', 'JavaScript', '-e', GETSID_JXA, ...pids], options);
    return joinProcessRows(ps, sids);
  } catch {
    return undefined;
  }
}

/** Only ESRCH proves a group gone: EPERM means a process of it exists under other credentials. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Whether a member of the group is in any state but zombie (Z) or dead (X). */
function hasLiveMember(pgid: number): boolean {
  if (process.platform === 'linux') {
    // No /proc to read: the signal check is all there is.
    return linuxProcesses()?.processes.some((proc) => proc.pgrp === pgid && live(proc.state)) ?? true;
  }
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8' });
    return rows.split('\n').some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === pgid && live(state);
    });
  } catch {
    return true; // No ps to ask: the signal check is all there is.
  }
}

export function registerGroup(child: ChildProcess): void {
  const pgid = child.pid;
  if (pgid === undefined || groups.has(pgid)) return;
  groups.add(pgid);
  child.once('exit', () => groupAlive(pgid));
}

/** Returns false where the group is gone or group signals are unsupported (Windows). */
function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    groups.delete(pgid);
    return false;
  }
}

/**
 * The process groups of a session that still have a live member, from a
 * reading of every process; undefined while that is unknown, and empty for a
 * session already dropped. A reading alone cannot prove a session empty: a
 * process of it can fork and exit while the processes are read, and the
 * reading misses its child. The child starts in its parent's group, though,
 * and a group signal check is atomic. So an empty reading drops the id only
 * once each group the session has had is gone: a signal check finds it gone
 * (ESRCH), or a /proc reading shows its id in another session, which a group
 * only gets once it has emptied, as a group lies within one session. A row of
 * the session itself proves nothing about the rest of its group: a zombie can
 * have forked an unlisted child before it exited. A group that still exists keeps the
 * session tracked, unknown, until a later reading shows a live member or the
 * group goes, or a reading is complete. A complete /proc reading proves the
 * session has no live process even while zombies hold its groups: the kernel
 * created no task during it, so every process alive when it ends existed
 * throughout it and was read, and one live at the end was live, and in the
 * session (a session can only be left), when read. Zombies cannot fork, so no
 * process can join the session after it. macOS has no fork count to bracket
 * its reading with. Otherwise POSIX has no session-wide check, so a child that
 * moves to a new group during the reading is missed. A signal check proves a group
 * exists, not that it is still the session's, so only groups a reading shows
 * are returned to be signalled.
 */
function sessionGroups(sid: number): number[] | undefined {
  const seen = sessions.get(sid);
  // Dropped once proven empty: the id may since belong to another session.
  if (seen === undefined) return [];
  // Every process: /proc where it exists (Linux), else on macOS ps and getsid(2).
  const proc = linuxProcesses();
  const table = proc?.processes ?? (process.platform === 'darwin' ? macProcesses() : undefined);
  if (table === undefined) return undefined;
  const pgids = [...new Set(table.filter((p) => p.session === sid && live(p.state)).map((p) => p.pgrp))];
  for (const pgid of pgids) seen.add(pgid);
  if (pgids.length > 0) return pgids;
  if (proc?.complete) seen.clear();
  // Checked after the reading, so a child forked during it is still in a group checked here.
  for (const pgid of seen) {
    // Only /proc gives a group and a session from one record: macOS reads them apart, so a pid
    // reused between the two pairs one process's group with another's session.
    const elsewhere = proc !== undefined && table.some((p) => p.pgrp === pgid && p.session !== sid);
    if (groupGone(pgid) || elsewhere) seen.delete(pgid);
  }
  if (seen.size > 0) return undefined;
  sessions.delete(sid);
  return [];
}

/**
 * A session has no kill(2) of its own, so each of its groups is signalled: a
 * group signal reaches every member at once, and a group id stays taken while
 * the group has a member, unlike a bare pid. Groups in `sent` are skipped, then added.
 */
function signalSession(sid: number, signal: NodeJS.Signals, sent?: Set<number>): void {
  const pgids = sessionGroups(sid);
  for (const pgid of pgids ?? []) {
    if (sent?.has(pgid)) continue;
    sent?.add(pgid);
    try {
      process.kill(-pgid, signal);
    } catch {
      /* The group emptied since the listing. */
    }
  }
}

export function killAllGroups(signal: NodeJS.Signals): void {
  for (const pgid of groups) signalGroup(pgid, signal);
  for (const sid of sessions.keys()) signalSession(sid, signal);
}

export function activeGroupCount(): number {
  for (const pgid of groups) groupAlive(pgid);
  for (const sid of sessions.keys()) sessionGroups(sid);
  return groups.size + sessions.size;
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
  if (groups.has(child.pid) && signalGroup(child.pid, signal)) return;
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

/** Drain both pipes, retaining at most 4 MiB per stream, regardless of chunk size. */
function collect(stream: Readable | null, limit = 4 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let retained = 0;
  let omitted = 0;
  stream?.on('data', (chunk: Buffer) => {
    const size = Math.min(chunk.length, limit - retained);
    if (size) chunks.push(Buffer.from(chunk.subarray(0, size)));
    retained += size;
    omitted += chunk.length - size;
  });
  return { text: () => new StringDecoder('utf8').write(Buffer.concat(chunks)), omitted: () => omitted };
}

/** The package manager launching Speedpatrol is not necessarily the app's. */
function commandEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  return { ...env, ...overrides };
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
      env: commandEnv(exec.env),
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
        stdoutOmittedBytes: stdout.omitted(),
        stderrOmittedBytes: stderr.omitted(),
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
  /** True while the leader or any process of its group is alive. */
  running(): boolean;
  stop(): Promise<void>;
};

/**
 * Starts a long-running command in its own process group. `input` gives it a
 * writable stdin. `session` is for a command that starts a session of its
 * own (as `script` does): it writes that session's id and a newline to fd 3,
 * and `stop` ends every process of the session too.
 */
export function startBackground(
  command: string,
  cwd: string,
  env: Record<string, string>,
  options: { input?: boolean; session?: boolean } = {},
): Background {
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: commandEnv(env),
    detached: true,
    stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe', options.session ? 'pipe' : 'ignore'],
  });
  registerGroup(child);
  let sid: number | undefined;
  // Settles once the id arrives, or once the pipe closes because the command ended without one.
  const reported = new Promise<void>((settle) => {
    const report = child.stdio[3] as Readable | null;
    if (!report) return settle();
    let text = '';
    report.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.includes('\n')) return;
      sid = Number(text.split('\n')[0]);
      sessions.set(sid, new Set([sid]));
      report.destroy();
      settle();
    });
    report.on('close', () => settle());
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 1024 * 1024) output = output.slice(-512 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (error) => append(Buffer.from(`${error.message}\n`)));
  // The group can outlive its leader (a server backgrounded by the shell), so check both. A session
  // still tracked after its reading may hold a live process the reading could not confirm.
  const pgid = child.pid;
  const running = () =>
    (child.exitCode === null && child.signalCode === null) ||
    (pgid !== undefined && groupAlive(pgid)) ||
    (sid !== undefined && (sessionGroups(sid)?.length ?? 1) > 0);
  // A stop's session signal also reaches each group a later reading shows: one that no reading
  // showed when it was sent (it failed, or a fork raced it) gets it once one does.
  let current: NodeJS.Signals | undefined;
  const sent = new Set<number>();
  const signalPending = () => {
    if (current && sid !== undefined) signalSession(sid, current, sent);
  };
  const signal = (name: NodeJS.Signals) => {
    current = name;
    sent.clear();
    signalPending();
    killTree(child, name);
  };
  return {
    child,
    output: () => output,
    running,
    async stop() {
      const settle = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (running() && Date.now() < deadline) {
          signalPending();
          await new Promise((done) => setTimeout(done, 25));
        }
      };
      // The session id is the first thing the command writes. A command stalled
      // before writing it gets the same bound as the stop, then its group is stopped.
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([reported, new Promise((done) => (bound = setTimeout(done, 5000)))]);
      clearTimeout(bound);
      if (!running()) return;
      signal('SIGTERM');
      await settle(5000);
      if (!running()) return;
      signal('SIGKILL');
      await settle(5000);
      if (sid === undefined) return;
      // A last reading confirms the session is empty. One that finds a live group (after readings
      // that could not show it) gets the SIGKILL they could not send, and the stop still fails.
      const left = sessionGroups(sid);
      if (left?.length === 0) return;
      if (left) signalSession(sid, 'SIGKILL');
      throw new Error(
        left
          ? 'The terminal app was still running after SIGKILL'
          : 'Could not confirm from the process table that the terminal app stopped',
      );
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
