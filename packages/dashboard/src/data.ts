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
  type Run,
  Store,
  type Summary,
  type Unit,
  type Verdict,
} from '@speedpatrol/core';

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
  series: Point[];
};

export type SessionView = {
  id: string;
  role?: string;
  startedAt?: string;
  lastAt?: string;
  events: number;
  last?: string;
  state: 'running' | 'done' | 'failed' | 'empty';
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

  async overview() {
    const [project, agents, runs, baselines, regressions, experiments, comparisons, patrol] = await Promise.all([
      this.projectName(),
      this.agents(),
      this.store.listRuns(),
      this.baselineRuns(),
      this.store.listRegressions(),
      this.store.listExperiments(),
      this.store.listComparisons(),
      this.store.patrolState(),
    ]);
    const latest = baselines.runs.at(-1) ?? runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
    return {
      project: { name: project },
      latest: latest
        ? {
            runId: latest.id,
            purpose: latest.purpose,
            sha: latest.source.sha,
            subject: latest.source.subject,
            branch: latest.source.branch,
            startedAt: latest.startedAt,
            machine: latest.machine,
            benchmarks: latest.results.length,
          }
        : null,
      counts: {
        runs: runs.length,
        baselines: baselines.runs.length,
        comparisons: comparisons.length,
        openRegressions: regressions.filter((item) => item.status === 'open' || item.status === 'filed').length,
        improvedExperiments: experiments.filter((item) => item.status === 'improved' || item.status === 'published')
          .length,
      },
      agents,
      patrol,
    };
  }

  /** The comparison of exactly these two commits, newest first. */
  private stepComparison(comparisons: Comparison[], base?: Run, head?: Run): Comparison | undefined {
    if (!base || !head) return undefined;
    return newestFirst(comparisons).find(
      (comparison) => comparison.base.sha === base.source.sha && comparison.head.sha === head.source.sha,
    );
  }

  async benchmarks(): Promise<{ machine?: string; benchmarks: BenchmarkRow[] }> {
    const [{ machine, runs }, comparisons] = await Promise.all([this.baselineRuns(), this.store.listComparisons()]);
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
          series: [],
        };
        // The newest run's definition wins: the primary metric or criticality may have changed.
        Object.assign(row, { kind: result.kind, critical: result.critical });
        if (series && result.primary === row.primary) row.series.push(point(run, series.summary));
        if (series && result.primary !== row.primary) {
          Object.assign(row, { primary: result.primary, unit: series.unit, better: series.better });
          row.series = [point(run, series.summary)];
        }
        rows.set(result.benchmark, row);
      }
    }
    for (const row of rows.values()) {
      const latest = row.series.at(-1);
      const previous = row.series.at(-2);
      row.latest = latest?.runId === latestRun?.id ? latest : undefined;
      if (row.latest && previous) row.deltaPct = row.latest.median / previous.median - 1;
      row.verdict = step?.metrics.find(
        (metric) => metric.benchmark === row.id && metric.metric === row.primary,
      )?.verdict;
    }
    const benchmarks = [...rows.values()].sort(
      (a, b) => Number(b.critical) - Number(a.critical) || a.id.localeCompare(b.id),
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
    const runs = await this.store.listRuns();
    return runs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => ({
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
        failed: run.failed,
      }));
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
    const ids = await this.store.sessions();
    const views = await Promise.all(ids.map(async (id) => sessionView(id, await this.store.events(id))));
    return views.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }

  /** The newest events across the most recent sessions, newest first. */
  async activity(limit: number): Promise<AgentEvent[]> {
    const sessions = (await this.sessions()).slice(0, 10);
    const events = (await Promise.all(sessions.map((session) => this.store.events(session.id)))).flat();
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
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
  if (!first || !last) return { id, events: 0, state: 'empty' };
  return {
    id,
    role: first.role,
    startedAt: first.at,
    lastAt: last.at,
    events: events.length,
    last: last.summary,
    state: last.kind === 'error' ? 'failed' : last.kind === 'finish' ? 'done' : 'running',
  };
}
