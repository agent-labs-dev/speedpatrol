import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent, AgentStatus, Experiment, Regression } from './types/agents.js';
import type { Comparison } from './types/compare.js';
import type { Run } from './types/run.js';

/**
 * One baseline per measured commit and machine. The index is append-only:
 * a re-measured commit adds an entry, and the newest entry wins.
 */
export type BaselineEntry = {
  sha: string;
  runId: string;
  machine: string;
  benchmarksHash: string;
  branch?: string;
  subject?: string;
  at: string;
};

export type PatrolState = {
  lastSha?: string;
  lastRunId?: string;
  lastCycleAt?: string;
  cycles: number;
};

/**
 * All Speedpatrol data is plain JSON under `.speedpatrol/runs/` (ADR 0002), so
 * the dashboard, a human and an agent can all read it. Writes go through a
 * temp file and a rename, so a reader never sees half a file.
 */
export class Store {
  readonly root: string;

  constructor(configDir: string) {
    this.root = join(configDir, 'runs');
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private async write(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  }

  private async read<T>(file: string): Promise<T | undefined> {
    if (!existsSync(file)) return undefined;
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }

  private async list<T>(folder: string): Promise<T[]> {
    const dir = this.path(folder);
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    const items: (T | undefined)[] = await Promise.all(names.map((name) => this.read<T>(join(dir, name))));
    return items.filter((item): item is T => item !== undefined);
  }

  saveRun(run: Run): Promise<void> {
    return this.write(this.path('runs', `${run.id}.json`), run);
  }
  getRun(id: string): Promise<Run | undefined> {
    return this.read(this.path('runs', `${id}.json`));
  }
  listRuns(): Promise<Run[]> {
    return this.list('runs');
  }

  saveComparison(comparison: Comparison): Promise<void> {
    return this.write(this.path('comparisons', `${comparison.id}.json`), comparison);
  }
  getComparison(id: string): Promise<Comparison | undefined> {
    return this.read(this.path('comparisons', `${id}.json`));
  }
  listComparisons(): Promise<Comparison[]> {
    return this.list('comparisons');
  }

  saveRegression(regression: Regression): Promise<void> {
    return this.write(this.path('regressions', `${regression.id}.json`), regression);
  }
  getRegression(id: string): Promise<Regression | undefined> {
    return this.read(this.path('regressions', `${id}.json`));
  }
  listRegressions(): Promise<Regression[]> {
    return this.list('regressions');
  }

  saveExperiment(experiment: Experiment): Promise<void> {
    return this.write(this.path('experiments', `${experiment.id}.json`), experiment);
  }
  getExperiment(id: string): Promise<Experiment | undefined> {
    return this.read(this.path('experiments', `${id}.json`));
  }
  listExperiments(): Promise<Experiment[]> {
    return this.list('experiments');
  }

  async baselines(): Promise<BaselineEntry[]> {
    return (await this.read<{ entries: BaselineEntry[] }>(this.path('baselines.json')))?.entries ?? [];
  }

  async addBaseline(entry: BaselineEntry): Promise<void> {
    const entries = await this.baselines();
    entries.push(entry);
    await this.write(this.path('baselines.json'), { entries });
  }

  /**
   * The newest baseline on this machine, other than `exceptSha`. With
   * `benchmarksHash`, only a baseline of the same benchmark set qualifies,
   * because a changed benchmark measures something else.
   */
  async latestBaseline(machine: string, exceptSha?: string): Promise<BaselineEntry | undefined> {
    const entries = await this.baselines();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.machine === machine && entry.sha !== exceptSha) return entry;
    }
    return undefined;
  }

  async baselineFor(sha: string, machine: string): Promise<BaselineEntry | undefined> {
    const entries = await this.baselines();
    return entries.findLast((entry) => entry.machine === machine && (entry.sha === sha || entry.sha.startsWith(sha)));
  }

  async patrolState(): Promise<PatrolState> {
    return (await this.read<PatrolState>(this.path('patrol.json'))) ?? { cycles: 0 };
  }
  savePatrolState(state: PatrolState): Promise<void> {
    return this.write(this.path('patrol.json'), state);
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    const file = this.path('sessions', event.sessionId, 'events.jsonl');
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`);
  }

  async events(sessionId: string): Promise<AgentEvent[]> {
    const file = this.path('sessions', sessionId, 'events.jsonl');
    if (!existsSync(file)) return [];
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
  }

  async sessions(): Promise<string[]> {
    const dir = this.path('sessions');
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).sort();
  }

  async statuses(): Promise<AgentStatus[]> {
    const map = (await this.read<Record<string, AgentStatus>>(this.path('agents.json'))) ?? {};
    return Object.values(map);
  }

  async setStatus(status: Omit<AgentStatus, 'pid' | 'updatedAt'>): Promise<void> {
    const file = this.path('agents.json');
    const map = (await this.read<Record<string, AgentStatus>>(file)) ?? {};
    map[status.role] = { ...status, pid: process.pid, updatedAt: new Date().toISOString() };
    await this.write(file, map);
  }
}
