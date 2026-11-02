import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AgentStatus,
  type BaselineEntry,
  type BenchmarkKind,
  type BenchmarkResult,
  type Better,
  type Comparison,
  type Hotspot,
  loadConfigDir,
  type Run,
  Store,
  type Summary,
  type Unit,
  type Verdict,
} from '@speedpatrol/core';
import { type DefinedBenchmark, isOpen, type ProjectSummary, projectSummary } from './summary.js';

/** The roles the header always shows, in this order, whether or not they ever ran. */
const ROLES = ['scout', 'analyst', 'optimizer', 'runner', 'patrol'] as const;

export type AgentView = {
  role: string;
  /** `stopped`: the status says it is working, but its process is gone. `never`: no status was written. */
  state: AgentStatus['state'] | 'stopped' | 'never';
  detail: string;
  sessionId?: string;
  updatedAt?: string;
};

type Point = {
  runId: string;
  sha: string;
  subject?: string;
  at: string;
  median: number;
  min: number;
  p75: number;
  p95: number;
  n: number;
};

export type BenchmarkRow = {
  id: string;
  kind: BenchmarkKind;
  critical: boolean;
  primary: string;
  unit: Unit;
  better: Better;
  latest?: Point;
  /** Latest primary median against the previous baseline's. */
  deltaPct?: number;
  /** The statistical verdict of that step, when a comparison of the two commits exists. */
  verdict?: Verdict;
  /** The open or filed regression of this benchmark. */
  regression?: { id: string; status: string; deltaPct: number; metric: string; badSha: string };
  /** Errors in the newest baseline result. */
  errors: number;
  /**
   * What needs a look first: an open regression, errors, no baseline at all,
   * or a benchmark that the newest baseline did not measure.
   */
  problem?: 'regression' | 'errors' | 'unmeasured' | 'stale';
  series: Point[];
};

const PROBLEM_ORDER = ['regression', 'errors', 'unmeasured', 'stale', undefined];

export type SessionView = {
  id: string;
  role?: string;
  /** The summary of the start event: what the session set out to do. */
  goal?: string;
  startedAt?: string;
  lastAt?: string;
  durationMs?: number;
  events: number;
  toolCalls: number;
  errors: number;
  costUsd?: number;
  last?: string;
  /** `stopped`: no finish event, and no live agent owns the session any more. */
  state: 'running' | 'stopped' | 'done' | 'failed' | 'empty';
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function point(run: Run, summary: Summary): Point {
  return {
    runId: run.id,
    sha: run.source.sha,
    subject: run.source.subject,
    at: run.startedAt,
    median: summary.median,
    min: summary.min,
    p75: summary.p75,
    p95: summary.p95,
    n: summary.n,
  };
}

const newestFirst = <T extends { createdAt: string }>(items: T[]): T[] =>
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * Reads `.speedpatrol/runs/` on every request. The tree is small JSON and the
 * dashboard is a local, single-user page, so a cache would only add staleness.
 */
export class DashboardData {
  readonly store: Store;

  constructor(readonly configDir: string) {
    this.store = new Store(configDir);
  }

  async projectName(): Promise<string> {
    const file = join(this.configDir, 'speedpatrol.yml');
    if (!existsSync(file)) return 'speedpatrol';
    // Only the name is wanted, so a regex over the `project:` block rather than a full config load.
    const text = await readFile(file, 'utf8');
    const block = text.match(/^project:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
    const name = block.match(/^[ \t]+name:\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/m)?.[1];
    return name ?? 'app';
  }

  async agents(): Promise<AgentView[]> {
    const statuses = await this.store.statuses();
    const byRole = new Map(statuses.map((status) => [status.role as string, status]));
    const roles = [...ROLES, ...statuses.map((status) => status.role).filter((role) => !ROLES.includes(role as never))];
    return roles.map((role) => {
      const status = byRole.get(role);
      if (!status) return { role, state: 'never', detail: '' };
      const working = status.state === 'running' || status.state === 'idle';
      return {
        role,
        state: working && !pidAlive(status.pid) ? 'stopped' : status.state,
        detail: status.detail,
        sessionId: status.sessionId,
        updatedAt: status.updatedAt,
      };
    });
  }

  /**
   * The baseline runs of one machine, oldest first, one per commit (a
   * re-measured commit's newest run wins). Timings from different machines
   * are not comparable, so the machine of the newest baseline is the one shown.
   */
  async baselineRuns(): Promise<{ machine?: string; runs: Run[] }> {
    const entries = await this.store.baselines();
    const machine = entries.at(-1)?.machine;
    if (!machine) return { runs: [] };
    const bySha = new Map<string, BaselineEntry>();
    for (const entry of entries) if (entry.machine === machine) bySha.set(entry.sha, entry);
    const ordered = [...bySha.values()].sort((a, b) => a.at.localeCompare(b.at));
    const runs = await Promise.all(ordered.map((entry) => this.store.getRun(entry.runId)));
    return { machine, runs: runs.filter((run): run is Run => run !== undefined && !run.failed) };
  }

  /** The benchmarks of the config, or the error that stops the load. */
  async config(): Promise<{ benchmarks: DefinedBenchmark[] } | { error: string }> {
    try {
      const { benchmarks } = await loadConfigDir(this.configDir);
      return { benchmarks: benchmarks.map(({ id, critical, kind }) => ({ id, critical, kind })) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async summary(): Promise<ProjectSummary> {
    const [name, config, agents, runs, baselines, comparisons, regressions, experiments] = await Promise.all([
      this.projectName(),
      this.config(),
      this.agents(),
      this.store.listRuns(),
      this.baselineRuns(),
      this.store.listComparisons(),
      this.store.listRegressions(),
      this.store.listExperiments(),
    ]);
    return projectSummary({
      name,
      config,
      runs,
      baselines: baselines.runs,
      comparisons,
      regressions,
      experiments,
      stoppedAgents: agents.filter((agent) => agent.state === 'stopped').map((agent) => agent.role),
    });
  }

  async agentsAndPatrol() {
    const [agents, patrol] = await Promise.all([this.agents(), this.store.patrolState()]);
    return { agents, patrol };
  }

  /** The comparison of exactly these two commits, newest first. */
  private stepComparison(comparisons: Comparison[], base?: Run, head?: Run): Comparison | undefined {
    if (!base || !head) return undefined;
    return newestFirst(comparisons).find(
      (comparison) => comparison.base.sha === base.source.sha && comparison.head.sha === head.source.sha,
    );
  }

  async benchmarks(): Promise<{ machine?: string; benchmarks: BenchmarkRow[] }> {
    const [{ machine, runs }, comparisons, regressions, config] = await Promise.all([
      this.baselineRuns(),
      this.store.listComparisons(),
      this.store.listRegressions(),
      this.config(),
    ]);
    const latestRun = runs.at(-1);
    const step = this.stepComparison(comparisons, runs.at(-2), latestRun);
    const rows = new Map<string, BenchmarkRow>();
    for (const run of runs) {
      for (const result of run.results) {
        const series = result.metrics[result.primary];
        const row = rows.get(result.benchmark) ?? {
          id: result.benchmark,
          kind: result.kind,
          critical: result.critical,
          primary: result.primary,
          unit: series?.unit ?? 'ms',
          better: series?.better ?? 'lower',
          errors: 0,
          series: [],
        };
        // The newest run's definition wins: the primary metric or criticality may have changed.
        Object.assign(row, { kind: result.kind, critical: result.critical, errors: result.errors.length });
        if (series && result.primary === row.primary) row.series.push(point(run, series.summary));
        if (series && result.primary !== row.primary) {
          Object.assign(row, { primary: result.primary, unit: series.unit, better: series.better });
          row.series = [point(run, series.summary)];
        }
        rows.set(result.benchmark, row);
      }
    }
    // A benchmark of the config with no baseline yet is a row too, so that it cannot hide.
    for (const defined of 'benchmarks' in config ? config.benchmarks : []) {
      if (rows.has(defined.id)) continue;
      rows.set(defined.id, {
        id: defined.id,
        kind: defined.kind,
        critical: defined.critical,
        primary: '',
        unit: 'ms',
        better: 'lower',
        errors: 0,
        series: [],
      });
    }
    const open = newestFirst(regressions.filter(isOpen));
    for (const row of rows.values()) {
      const latest = row.series.at(-1);
      const previous = row.series.at(-2);
      const inLatest = latestRun?.results.some((result) => result.benchmark === row.id) ?? false;
      row.latest = latest?.runId === latestRun?.id ? latest : undefined;
      if (row.latest && previous) row.deltaPct = row.latest.median / previous.median - 1;
      row.verdict = step?.metrics.find(
        (metric) => metric.benchmark === row.id && metric.metric === row.primary,
      )?.verdict;
      if (!inLatest) row.errors = 0;
      const regression = open.find((item) => item.benchmark === row.id);
      if (regression) {
        row.regression = {
          id: regression.id,
          status: regression.status,
          deltaPct: regression.deltaPct,
          metric: regression.metric,
          badSha: regression.badSha,
        };
      }
      row.problem = regression
        ? 'regression'
        : row.errors
          ? 'errors'
          : !row.series.length
            ? 'unmeasured'
            : !inLatest
              ? 'stale'
              : undefined;
    }
    const benchmarks = [...rows.values()].sort(
      (a, b) =>
        PROBLEM_ORDER.indexOf(a.problem) - PROBLEM_ORDER.indexOf(b.problem) ||
        Number(b.critical) - Number(a.critical) ||
        a.id.localeCompare(b.id),
    );
    return { machine, benchmarks };
  }

  async benchmark(id: string) {
    const [{ runs }, allRuns, regressions, experiments] = await Promise.all([
      this.baselineRuns(),
      this.store.listRuns(),
      this.store.listRegressions(),
      this.store.listExperiments(),
    ]);
    const results = runs.flatMap((run) => {
      const result = run.results.find((item) => item.benchmark === id);
      return result ? [{ run, result }] : [];
    });
    const last = results.at(-1);
    if (!last) return undefined;

    const metrics = new Map<string, { name: string; unit: Unit; better: Better; primary: boolean; series: Point[] }>();
    for (const { run, result } of results) {
      for (const [name, series] of Object.entries(result.metrics)) {
        const entry = metrics.get(name) ?? {
          name,
          unit: series.unit,
          better: series.better,
          primary: false,
          series: [],
        };
        entry.series.push(point(run, series.summary));
        metrics.set(name, entry);
      }
    }
    const primary = metrics.get(last.result.primary);
    if (primary) primary.primary = true;

    // The newest run of any purpose whose result for this benchmark carries hotspots.
    const profiled = allRuns
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .flatMap((run) => {
        const result = run.results.find((item) => item.benchmark === id);
        return result?.profile?.hotspots?.length ? [{ run, result }] : [];
      })[0];

    return {
      id,
      kind: last.result.kind,
      critical: last.result.critical,
      primary: last.result.primary,
      iterations: last.result.iterations,
      errors: last.result.errors,
      metrics: [...metrics.values()].sort((a, b) => Number(b.primary) - Number(a.primary)),
      hotspots: profiled ? hotspotsOf(profiled.run, profiled.result) : null,
      regressions: newestFirst(regressions.filter((item) => item.benchmark === id)),
      experiments: newestFirst(experiments.filter((item) => item.target.benchmark === id)),
    };
  }

  async runs() {
    const [runs, comparisons] = await Promise.all([this.store.listRuns(), this.store.listComparisons()]);
    // The oldest baseline of each machine has no earlier one to compare with.
    const first = new Map<string, string>();
    for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (run.purpose === 'baseline' && !run.failed && !first.has(run.machine.fingerprint)) {
        first.set(run.machine.fingerprint, run.id);
      }
    }
    const byHead = new Map<string, Comparison>();
    for (const comparison of newestFirst(comparisons).reverse()) {
      for (const runId of comparison.head.runs) byHead.set(runId, comparison);
    }
    return runs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => {
        const comparison = byHead.get(run.id);
        return {
          id: run.id,
          purpose: run.purpose,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          sha: run.source.sha,
          subject: run.source.subject,
          branch: run.source.branch,
          dirty: run.source.dirty,
          machine: run.machine.fingerprint,
          benchmarks: run.results.length,
          errors: run.results.filter((result) => result.errors.length).length,
          failed: run.failed,
          first: first.get(run.machine.fingerprint) === run.id,
          comparison: comparison
            ? { id: comparison.id, verdict: comparison.verdict, mode: comparison.mode }
            : undefined,
        };
      });
  }

  async comparisons() {
    const comparisons = newestFirst(await this.store.listComparisons());
    return comparisons.map((comparison) => {
      const verdicts: Partial<Record<Verdict, number>> = {};
      for (const metric of comparison.metrics) verdicts[metric.verdict] = (verdicts[metric.verdict] ?? 0) + 1;
      return {
        id: comparison.id,
        createdAt: comparison.createdAt,
        mode: comparison.mode,
        base: comparison.base,
        head: comparison.head,
        verdict: comparison.verdict,
        verdicts,
        warnings: comparison.warnings,
      };
    });
  }

  async regressions() {
    return newestFirst(await this.store.listRegressions());
  }

  async experiments() {
    return newestFirst(await this.store.listExperiments());
  }

  async sessions(): Promise<SessionView[]> {
    const [ids, agents] = await Promise.all([this.store.sessions(), this.agents()]);
    const live = new Set(agents.filter((agent) => agent.state === 'running').map((agent) => agent.sessionId));
    const views = await Promise.all(ids.map(async (id) => sessionView(id, await this.store.events(id))));
    for (const view of views) if (view.state === 'running' && !live.has(view.id)) view.state = 'stopped';
    return views.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }
}

function hotspotsOf(
  run: Run,
  result: BenchmarkResult,
): { runId: string; sha: string; at: string; hotspots: Hotspot[] } {
  return {
    runId: run.id,
    sha: run.source.sha,
    at: run.startedAt,
    hotspots: [...(result.profile?.hotspots ?? [])].sort((a, b) => b.selfMs - a.selfMs),
  };
}

function sessionView(id: string, events: AgentEvent[]): SessionView {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return { id, events: 0, toolCalls: 0, errors: 0, state: 'empty' };
  const cost = events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  return {
    id,
    role: first.role,
    goal: events.find((event) => event.kind === 'start')?.summary,
    startedAt: first.at,
    lastAt: last.at,
    durationMs: Date.parse(last.at) - Date.parse(first.at),
    events: events.length,
    toolCalls: events.filter((event) => event.kind === 'tool-call').length,
    errors: events.filter((event) => event.kind === 'error').length,
    ...(cost ? { costUsd: cost } : {}),
    last: last.summary,
    state: last.kind === 'error' ? 'failed' : last.kind === 'finish' ? 'done' : 'running',
  };
}
