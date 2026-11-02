import type { BenchmarkKind } from '../config/schema.js';
import type { MetricSeries } from './metrics.js';

/**
 * The machine a run measured on. Timings from two machines are not
 * comparable, so a comparison refuses runs with different fingerprints unless
 * it is told otherwise (ADR 0002).
 */
export type MachineInfo = {
  fingerprint: string;
  hostname: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpus: number;
  memoryGb: number;
  node: string;
};

/** The code a run measured. */
export type SourceInfo = {
  /** The checkout the app ran from. */
  dir: string;
  sha: string;
  branch?: string;
  /** Uncommitted changes were present: the run is not a baseline. */
  dirty: boolean;
  subject?: string;
};

export type ProfileArtifact = {
  /** Path relative to the runs folder. */
  path: string;
  kind: 'cpuprofile' | 'trace' | 'custom';
  /** The hottest functions, by self time. Written for humans and agents. */
  hotspots?: Hotspot[];
};

export type Hotspot = {
  function: string;
  location: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
};

export type BenchmarkResult = {
  benchmark: string;
  kind: BenchmarkKind;
  /** The metric the verdict leads with, e.g. `total_ms` for an API call. */
  primary: string;
  metrics: Record<string, MetricSeries>;
  iterations: number;
  errors: string[];
  durationMs: number;
  profile?: ProfileArtifact;
  critical: boolean;
};

export type RunPurpose = 'baseline' | 'compare' | 'experiment' | 'adhoc';

export type Run = {
  id: string;
  purpose: RunPurpose;
  startedAt: string;
  finishedAt: string;
  source: SourceInfo;
  machine: MachineInfo;
  /** Hash of the measured benchmark definitions. A change resets comparability. */
  benchmarksHash: string;
  results: BenchmarkResult[];
  /** The app did not come up, or every benchmark failed. */
  failed?: string;
};
