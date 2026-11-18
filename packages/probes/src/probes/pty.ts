import { StringDecoder } from 'node:string_decoder';
import { inputEchoesMarker, interpolate, type MetricSpec } from '@speedpatrol/core';
import { runTimed, shellQuote, startBackground } from '../exec.js';
import { resolveCwd, resolveEnv } from './command.js';
import type { ProbeFactory } from './types.js';

/** Finds an exact marker in a stream of text chunks, including a marker split across chunks. */
export class MarkerScan {
  private tail = '';

  constructor(private readonly marker: string) {}

  /** Returns the text after the marker once it appears, else undefined. */
  push(text: string): string | undefined {
    const seen = this.tail + text;
    const at = seen.indexOf(this.marker);
    if (at !== -1) return seen.slice(at + this.marker.length);
    this.tail = seen.slice(Math.max(0, seen.length - this.marker.length + 1));
    return undefined;
  }
}

/**
 * Wraps a command so it runs on a pseudo-terminal of the given size. `script`
 * (util-linux on Linux, BSD on macOS) owns the terminal, so Speedpatrol needs
 * no native module.
 */
export function ptyCommand(command: string, cols: number, rows: number, platform = process.platform): string {
  const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; exec bash -c ${shellQuote(command)}`;
  if (platform === 'linux') return `exec script -qfec ${shellQuote(inner)} /dev/null`;
  if (platform === 'darwin') return `exec script -qF /dev/null bash -c ${shellQuote(inner)}`;
  throw new Error(`The pty probe runs on Linux and macOS, not ${platform}`);
}

/**
 * A terminal app, timed to an explicit marker. The app writes `marker` when
 * the measured output (a reply, a screen) is visible, and the clock stops at
 * its first appearance in the terminal output. The clock starts at the spawn,
 * or, with `ready`, when the app writes that marker; `input` is typed then.
 * Speedpatrol never guesses from what the screen shows: the app decides.
 */
export const ptyProbe: ProbeFactory<'pty'> = (benchmark, context) => {
  const cwd = resolveCwd(benchmark.cwd, context);
  const env = { TERM: 'xterm-256color', ...resolveEnv(benchmark.env, context) };
  const command = ptyCommand(interpolate(benchmark.run, context.vars), benchmark.cols, benchmark.rows);
  const before = benchmark.before ? interpolate(benchmark.before, context.vars) : undefined;
  const input = benchmark.input === undefined ? undefined : interpolate(benchmark.input, context.vars);
  // The schema checked the input as written; a `${NAME}` value can still bring the marker in.
  const echoed = inputEchoesMarker(input, benchmark.marker);
  const metrics: Record<string, MetricSpec> = { marker_ms: { unit: 'ms', better: 'lower' } };
  if (benchmark.ready) metrics.ready_ms = { unit: 'ms', better: 'lower' };

  return {
    primary: 'marker_ms',
    metrics,
    async sample() {
      if (echoed) throw new Error('The terminal echo of input contains the marker, so the echo would stop the clock');
      if (before) {
        const prepared = await runTimed({ command: before, cwd, env, timeoutMs: context.timeoutMs });
        if (prepared.timedOut || prepared.code !== 0) {
          throw new Error(`before command ${prepared.timedOut ? 'timed out' : `exited with code ${prepared.code}`}`);
        }
      }
      const started = performance.now();
      const app = startBackground(command, cwd, env, { input: true });
      // A write after the app exited must fail the sample through 'exit', not crash Speedpatrol.
      app.child.stdin?.on('error', () => undefined);
      const decoder = new StringDecoder('utf8');
      const readyScan = benchmark.ready ? new MarkerScan(benchmark.ready) : undefined;
      const markerScan = new MarkerScan(benchmark.marker);
      let clock: number | undefined;
      let readyMs: number | undefined;
      const startClock = (at: number) => {
        clock = at;
        if (input) app.child.stdin?.write(input);
      };
      try {
        return await new Promise<Record<string, number>>((resolve, reject) => {
          const which = () => (clock === undefined ? 'ready marker' : 'marker');
          const timer = setTimeout(
            () => done(new Error(`Timed out after ${context.timeoutMs} ms waiting for the ${which()}`)),
            context.timeoutMs,
          );
          const done = (error?: Error, result?: Record<string, number>) => {
            clearTimeout(timer);
            app.child.stdout?.off('data', onData);
            app.child.off('exit', onExit);
            if (error) reject(error);
            else resolve(result!);
          };
          const onData = (chunk: Buffer) => {
            const at = performance.now();
            let text: string | undefined = decoder.write(chunk);
            if (clock === undefined) {
              text = readyScan!.push(text);
              if (text === undefined) return;
              readyMs = at - started;
              startClock(at);
            }
            if (markerScan.push(text) === undefined) return;
            done(undefined, { marker_ms: at - clock!, ...(readyMs === undefined ? {} : { ready_ms: readyMs }) });
          };
          const onExit = (code: number | null) =>
            done(new Error(`Exited with code ${code} before writing the ${which()}`));
          app.child.stdout?.on('data', onData);
          app.child.on('exit', onExit);
          if (!readyScan) startClock(started);
        });
      } finally {
        await app.stop();
      }
    },
  };
};
