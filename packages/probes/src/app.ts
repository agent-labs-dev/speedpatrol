import { isAbsolute, resolve } from 'node:path';
import { type AppCommand, interpolate, MeasureError, redact } from '@speedpatrol/core';
import { type Background, runTimed, startBackground, urlAnswers, waitUntil } from './exec.js';

export type AppOptions = {
  setup: AppCommand[];
  teardown: AppCommand[];
  env: Record<string, string>;
  secrets: string[];
  /** The checkout the app runs from. Relative `cwd`s resolve against it. */
  source: string;
  log?: (line: string) => void;
};

/**
 * Brings the app up for a measurement and down after it. The user owns the
 * lifecycle: Speedpatrol never guesses how to start an app. Each command sees
 * `SPEEDPATROL_SOURCE`, so the same config can start the app from the main
 * checkout or from an experiment's worktree.
 */
export class AppSession {
  readonly vars: Record<string, string>;
  private readonly background: Background[] = [];

  constructor(private readonly options: AppOptions) {
    this.vars = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])),
      ...options.env,
      SPEEDPATROL_SOURCE: options.source,
    };
  }

  /** Values never to print: the configured secrets and every captured value. */
  get secretValues(): string[] {
    return this.options.secrets.map((name) => this.vars[name]).filter((value): value is string => !!value);
  }

  private cwd(command: AppCommand): string {
    const dir = command.cwd ? interpolate(command.cwd, this.vars) : '.';
    return isAbsolute(dir) ? dir : resolve(this.options.source, dir);
  }

  private say(line: string) {
    this.options.log?.(redact(line, this.secretValues));
  }

  async start(): Promise<void> {
    for (const command of this.options.setup) await this.runCommand(command, 'setup');
  }

  private capture(command: AppCommand, output: string) {
    for (const [name, pattern] of Object.entries(command.capture)) {
      const match = output.match(new RegExp(pattern, 'm'));
      if (match?.[1]) {
        this.vars[name] = match[1];
        this.options.secrets.push(name);
      }
    }
  }

  private async runCommand(command: AppCommand, phase: 'setup' | 'teardown') {
    const run = interpolate(command.run, this.vars);
    const env = Object.fromEntries(
      Object.entries({ ...this.options.env, ...command.env }).map(([key, value]) => [
        key,
        interpolate(value, this.vars),
      ]),
    );
    env.SPEEDPATROL_SOURCE = this.options.source;
    this.say(`${phase}: ${run}`);
    if (!command.background) {
      const result = await runTimed({ command: run, cwd: this.cwd(command), env, timeoutMs: command.timeoutMs });
      if (result.code !== 0 && phase === 'setup') {
        const tail = redact(
          `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n'),
          this.secretValues,
        );
        throw new MeasureError(`Setup command failed (exit ${result.code}): ${run}\n${tail}`);
      }
      this.capture(command, result.stdout + result.stderr);
      return;
    }
    const process = startBackground(run, this.cwd(command), env);
    this.background.push(process);
    const readyUrl = command.readyUrl ? interpolate(command.readyUrl, this.vars) : undefined;
    const readyWhen = command.readyWhen ? new RegExp(command.readyWhen, 'm') : undefined;
    try {
      await waitUntil(
        async () => {
          if (process.child.exitCode !== null) {
            const tail = process.output().trim().split('\n').slice(-20).join('\n');
            throw new MeasureError(
              `Background command exited (code ${process.child.exitCode}): ${run}\n${redact(tail, this.secretValues)}`,
            );
          }
          if (readyWhen && !readyWhen.test(process.output())) return false;
          if (readyUrl && !(await urlAnswers(readyUrl))) return false;
          return true;
        },
        command.timeoutMs,
        `${run} to be ready`,
        100,
      );
    } catch (error) {
      if (error instanceof MeasureError) throw error;
      throw new MeasureError((error as Error).message);
    }
    this.capture(command, process.output());
  }

  async stop(): Promise<void> {
    for (const command of this.options.teardown) {
      try {
        await this.runCommand(command, 'teardown');
      } catch (error) {
        this.say(`teardown failed: ${(error as Error).message}`);
      }
    }
    for (const process of this.background.reverse()) await process.stop();
    this.background.length = 0;
  }
}
