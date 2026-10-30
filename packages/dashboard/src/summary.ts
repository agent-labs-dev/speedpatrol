import type {
  BenchmarkKind,
  Comparison,
  Experiment,
  ExperimentStatus,
  MachineInfo,
  Regression,
  RegressionStatus,
  Run,
  RunPurpose,
  Verdict,
} from '@speedpatrol/core';

type Tone = 'pass' | 'warn' | 'fail' | 'info';

/** One thing that a person must act on, with the place to look and the command to run. */
type AttentionItem = {
  tone: 'fail' | 'warn';
  title: string;
  detail: string;
  /** A dashboard route, such as `#/regressions/<id>`. */
  href?: string;
  command?: string;
};

/** A benchmark that the config defines. Absent when the config does not load. */
export type DefinedBenchmark = { id: string; critical: boolean; kind: BenchmarkKind };

export type SummaryInput = {
  name: string;
  /** The benchmarks of the config, or the error that stopped the load. */
  config: { benchmarks: DefinedBenchmark[] } | { error: string };
  runs: Run[];
  /** The baselines of the shown machine, oldest first, failed runs left out. */
  baselines: Run[];
  comparisons: Comparison[];
  regressions: Regression[];
  experiments: Experiment[];
  /** The agents whose status says that they work, but whose process is gone. */
  stoppedAgents: string[];
};

type LastRun = {
  id: string;
  purpose: RunPurpose;
  sha: string;
  subject?: string;
  branch?: string;
  startedAt: string;
  finishedAt: string;
  failed?: string;
  benchmarks: number;
  /** The comparison that has this run on its head side. */
  comparison?: { id: string; verdict: Verdict };
};

/** The numbers of the whole project. Each page reads them from here, so two pages cannot disagree. */
export type ProjectSummary = {
  name: string;
  machine?: MachineInfo;
  configError?: string;
  verdict: { tone: Tone; text: string; detail: string };
  benchmarks: {
    /** Absent when the config does not load. */
    defined?: number;
    /** The benchmarks in the newest baseline. */
    measured: number;
    critical: number;
    /** The benchmarks with an open or filed regression. */
    regressed: number;
    /** The benchmarks whose newest baseline result has errors. */
    withErrors: string[];
    /** The defined benchmarks that the newest baseline does not have. */
    unmeasured: string[];
  };
  regressions: { open: number; byStatus: Record<RegressionStatus, number>; total: number };
  experiments: {
    /** Proposed or measuring now. */
    active: number;
    /** Improved, and not published yet. */
    waiting: number;
    published: number;
    /** Rejected or failed. */
    rejected: number;
    total: number;
  };
  runs: { total: number; baselines: number; failed: number; comparisons: number };
  /** The newest baseline run, failed or not. When there is none, the newest run. */
  lastRun?: LastRun;
  attention: AttentionItem[];
  /** The first command of a project that has no baseline yet. */
  next?: { why: string; command: string };
};

const OPEN: ReadonlySet<RegressionStatus> = new Set(['open', 'filed']);

export const isOpen = (regression: Regression): boolean => OPEN.has(regression.status);

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

const byStart = (a: Run, b: Run) => a.startedAt.localeCompare(b.startedAt);

export function projectSummary(input: SummaryInput): ProjectSummary {
  const { config, runs, baselines, comparisons, regressions, experiments } = input;
  const configError = 'error' in config ? config.error : undefined;
  const defined = 'error' in config ? undefined : config.benchmarks;
  const newest = baselines.at(-1);
  const measuredIds = new Set(newest?.results.map((result) => result.benchmark) ?? []);
  const unmeasured = (defined ?? []).filter((benchmark) => !measuredIds.has(benchmark.id)).map((item) => item.id);
  const withErrors = (newest?.results ?? []).filter((result) => result.errors.length).map((item) => item.benchmark);
  const critical = defined
    ? defined.filter((benchmark) => benchmark.critical).length
    : (newest?.results.filter((result) => result.critical).length ?? 0);

  const open = regressions.filter(isOpen);
  const byStatus: Record<RegressionStatus, number> = { open: 0, filed: 0, dismissed: 0, fixed: 0 };
  for (const regression of regressions) byStatus[regression.status]++;

  const experimentCount = (...statuses: ExperimentStatus[]) =>
    experiments.filter((experiment) => statuses.includes(experiment.status)).length;
  const waiting = experiments.filter((experiment) => experiment.status === 'improved');

  const lastRun = pickLastRun(runs, comparisons);
  const machine = newest?.machine ?? runs.find((run) => run.id === lastRun?.id)?.machine;

  const attention: AttentionItem[] = [];
  if (configError) {
    attention.push({
      tone: 'fail',
      title: 'The config does not load',
      detail: configError,
      command: 'npx speedpatrol doctor',
    });
  }
  if (lastRun?.failed) {
    attention.push({
      tone: 'fail',
      title: 'The last run failed',
      detail: lastRun.failed,
      href: '#/runs',
      command: 'npx speedpatrol run',
    });
  }
  for (const regression of open) attention.push(regressionItem(regression));
  if (unmeasured.length) {
    attention.push({
      tone: 'warn',
      title: `${plural(unmeasured.length, 'benchmark has', 'benchmarks have')} no baseline`,
      detail: `The newest baseline does not measure ${unmeasured.join(', ')}.`,
      href: '#/benchmarks',
      command: 'npx speedpatrol run',
    });
  }
  if (withErrors.length) {
    attention.push({
      tone: 'warn',
      title: `${plural(withErrors.length, 'benchmark')} had errors in the last baseline`,
      detail: `Some iterations of ${withErrors.join(', ')} failed. Their medians use fewer samples.`,
      href: '#/benchmarks',
    });
  }
  for (const experiment of waiting) {
    attention.push({
      tone: 'warn',
      title: `A speed-up of ${experiment.target.benchmark} waits to be published`,
      detail: experiment.summary ?? experiment.hypothesis ?? `The A/B run confirmed it on ${experiment.branch}.`,
      href: `#/experiments/${encodeURIComponent(experiment.id)}`,
      command: 'npx speedpatrol publish',
    });
  }
  for (const role of input.stoppedAgents) {
    attention.push({
      tone: 'warn',
      title: `The ${role} stopped`,
      detail: 'Its status says that it works, but its process is gone. Start the patrol again.',
      href: '#/activity',
      command: 'npx speedpatrol',
    });
  }

  return {
    name: input.name,
    ...(machine ? { machine } : {}),
    ...(configError ? { configError } : {}),
    verdict: verdict({
      configError,
      lastRun,
      open,
      baselines: baselines.length,
      comparisons: comparisons.length,
      warnings: attention.filter((item) => item.tone === 'warn'),
      measured: measuredIds.size,
    }),
    benchmarks: {
      ...(defined ? { defined: defined.length } : {}),
      measured: measuredIds.size,
      critical,
      regressed: new Set(open.map((regression) => regression.benchmark)).size,
      withErrors,
      unmeasured,
    },
    regressions: { open: open.length, byStatus, total: regressions.length },
    experiments: {
      active: experimentCount('proposed', 'measuring'),
      waiting: waiting.length,
      published: experimentCount('published'),
      rejected: experimentCount('rejected', 'failed'),
      total: experiments.length,
    },
    runs: {
      total: runs.length,
      baselines: baselines.length,
      failed: runs.filter((run) => run.failed).length,
      comparisons: comparisons.length,
    },
    ...(lastRun ? { lastRun } : {}),
    attention,
    ...(baselines.length ? {} : { next: nextStep(defined?.length ?? 0) }),
  };
}

/**
 * The newest baseline run, also when it failed: a failed patrol run must not
 * hide behind the older run that worked. An A/B run of an experiment says
 * nothing about the main line, so it counts only when there is no baseline.
 */
function pickLastRun(runs: Run[], comparisons: Comparison[]): LastRun | undefined {
  const sorted = [...runs].sort(byStart);
  const run = sorted.filter((item) => item.purpose === 'baseline').at(-1) ?? sorted.at(-1);
  if (!run) return undefined;
  const comparison = [...comparisons]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((item) => item.head.runs.includes(run.id));
  return {
    id: run.id,
    purpose: run.purpose,
    sha: run.source.sha,
    ...(run.source.subject ? { subject: run.source.subject } : {}),
    ...(run.source.branch ? { branch: run.source.branch } : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.failed ? { failed: run.failed } : {}),
    benchmarks: run.results.length,
    ...(comparison ? { comparison: { id: comparison.id, verdict: comparison.verdict } } : {}),
  };
}

function nextStep(defined: number): ProjectSummary['next'] {
  if (!defined) {
    return {
      why: 'The project has no benchmarks yet. The scout finds the critical paths and writes them.',
      command: 'npx speedpatrol scout',
    };
  }
  return {
    why: `The config has ${plural(defined, 'benchmark')}, but no baseline. A run on a clean commit records one.`,
    command: 'npx speedpatrol run',
  };
}

function regressionItem(regression: Regression): AttentionItem {
  const href = `#/regressions/${encodeURIComponent(regression.id)}`;
  const title = regression.title || `${regression.benchmark} ${regression.metric} got slower`;
  if (regression.status === 'open' && !regression.analysis) {
    return {
      tone: 'fail',
      title,
      detail: 'Confirmed. The analyst did not explain it yet.',
      href,
      command: `npx speedpatrol analyze ${regression.id}`,
    };
  }
  if (!regression.issueUrl) {
    return {
      tone: 'fail',
      title,
      detail: 'Explained. No issue is open for it yet.',
      href,
      command: 'npx speedpatrol publish',
    };
  }
  return {
    tone: 'fail',
    title,
    detail: 'Filed. The patrol closes it when a baseline is back within the thresholds.',
    href,
  };
}

function verdict(facts: {
  configError?: string;
  lastRun?: LastRun;
  open: Regression[];
  baselines: number;
  comparisons: number;
  warnings: AttentionItem[];
  measured: number;
}): ProjectSummary['verdict'] {
  if (facts.configError) return { tone: 'fail', text: 'Config error', detail: 'Speedpatrol cannot read the config.' };
  if (!facts.lastRun) {
    return { tone: 'info', text: 'Not measured yet', detail: 'No run is recorded for this project.' };
  }
  if (facts.lastRun.failed) {
    return { tone: 'fail', text: 'Last run failed', detail: 'The newest numbers are older than the last run.' };
  }
  if (facts.open.length) {
    return {
      tone: 'fail',
      text: facts.open.length === 1 ? '1 open regression' : `${facts.open.length} open regressions`,
      detail: `Slower: ${[...new Set(facts.open.map((item) => item.benchmark))].join(', ')}.`,
    };
  }
  if (!facts.baselines) {
    return { tone: 'info', text: 'No baseline yet', detail: 'A run on a clean commit records the first baseline.' };
  }
  const [warning] = facts.warnings;
  if (warning) {
    return {
      tone: 'warn',
      text: facts.warnings.length === 1 ? 'One item needs you' : `${facts.warnings.length} items need you`,
      detail: warning.title,
    };
  }
  if (facts.baselines <= 1 && !facts.comparisons) {
    return {
      tone: 'info',
      text: 'First baseline recorded',
      detail: 'Speedpatrol compares the next commit with it.',
    };
  }
  return {
    tone: 'pass',
    text: 'No open regressions',
    detail: `${plural(facts.measured, 'benchmark')} measured on the last baseline.`,
  };
}
