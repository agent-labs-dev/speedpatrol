import type { Benchmark, MetricSpec, ProfileArtifact } from '@speedpatrol/core';

export type ProbeContext = {
  /** The checkout the app runs from. */
  source: string;
  /** Env, `app.env` and captured values, for `${NAME}`. */
  vars: Record<string, string>;
  timeoutMs: number;
  log: (line: string) => void;
};

/**
 * A probe measures one benchmark kind. `sample` runs one timed iteration and
 * returns every metric it read; it throws when the iteration failed. A
 * profile is taken in its own iteration, never a timed one, because a
 * profiler slows the code down.
 */
export interface Probe {
  readonly primary: string;
  readonly metrics: Record<string, MetricSpec>;
  open?(): Promise<void>;
  sample(): Promise<Record<string, number>>;
  /** Writes a profile to `file` (no extension) and returns what it wrote. */
  profile?(file: string): Promise<ProfileArtifact | undefined>;
  close?(): Promise<void>;
}

export type ProbeFactory<K extends Benchmark['kind']> = (
  benchmark: Extract<Benchmark, { kind: K }>,
  context: ProbeContext,
) => Probe;
