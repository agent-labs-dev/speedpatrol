// @ts-check
// Writes a realistic `.speedpatrol/` tree so the dashboard can be looked at
// without running the real tool:
//
//   node packages/dashboard/scripts/fixture.mjs /tmp/demo
//   -> /tmp/demo/.speedpatrol (pass it to startDashboard as configDir)
//
// Deterministic: the same seed, commits and dates on every run.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '@speedpatrol/core';

/** @typedef {import('@speedpatrol/core').Run} Run */
/** @typedef {import('@speedpatrol/core').BenchmarkResult} BenchmarkResult */
/** @typedef {import('@speedpatrol/core').MetricSeries} MetricSeries */
/** @typedef {import('@speedpatrol/core').Summary} Summary */
/** @typedef {import('@speedpatrol/core').Unit} Unit */
/** @typedef {import('@speedpatrol/core').Better} Better */
/** @typedef {import('@speedpatrol/core').BenchmarkKind} BenchmarkKind */
/** @typedef {import('@speedpatrol/core').MetricComparison} MetricComparison */
/** @typedef {import('@speedpatrol/core').Comparison} Comparison */
/** @typedef {import('@speedpatrol/core').Verdict} Verdict */
/** @typedef {import('@speedpatrol/core').AgentEvent} AgentEvent */
/** @typedef {import('@speedpatrol/core').AgentStatus} AgentStatus */
/** @typedef {import('@speedpatrol/core').Hotspot} Hotspot */

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261027);
/** A right-skewed timing around `center`: most samples near it, a few slow ones. */
const sample = (/** @type {number} */ center, /** @type {number} */ cv) =>
  center * (1 + cv * (random() + random() + random() - 1.5) + (random() < 0.08 ? cv * 3 * random() : 0));

/** @param {readonly number[]} sorted @param {number} q */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** @param {number[]} values @returns {Summary} */
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const stddev = Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1));
  const median = quantile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median,
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    stddev,
    mad: quantile(deviations, 0.5) * 1.4826,
    cv: stddev / mean,
  };
}

/**
 * @typedef {{ name: string; unit: Unit; better: Better; base: number; cv: number;
 *   step?: (commit: number) => number }} MetricDef
 * @typedef {{ id: string; kind: BenchmarkKind; critical: boolean; primary: string; iterations: number;
 *   metrics: MetricDef[]; hotspots?: (commit: number) => Hotspot[] }} BenchmarkDef
 */

/** Commit 9 adds a synchronous JSON schema check on every list request. */
const REGRESSED_AT = 9;
const regressed = (/** @type {number} */ factor) => (/** @type {number} */ commit) =>
  commit >= REGRESSED_AT ? factor : 1;
/** A gentle downward drift, the kind that never trips a threshold on its own. */
const drift = (/** @type {number} */ per) => (/** @type {number} */ commit) => 1 - per * commit;

/** @type {BenchmarkDef[]} */
const BENCHMARKS = [
  {
    id: 'api.items',
    kind: 'http',
    critical: true,
    primary: 'total_ms',
    iterations: 30,
    metrics: [
      { name: 'total_ms', unit: 'ms', better: 'lower', base: 42, cv: 0.06, step: regressed(1.34) },
      { name: 'ttfb_ms', unit: 'ms', better: 'lower', base: 38, cv: 0.07, step: regressed(1.37) },
      { name: 'bytes', unit: 'bytes', better: 'lower', base: 18_420, cv: 0 },
    ],
    hotspots: (commit) => [
      ...(commit >= REGRESSED_AT
        ? [
            {
              function: 'validateItems',
              location: 'src/api/items/schema.ts:41',
              selfMs: 11.8,
              totalMs: 13.2,
              selfPercent: 21.4,
            },
          ]
        : []),
      { function: 'serializeRow', location: 'src/db/serialize.ts:88', selfMs: 6.1, totalMs: 7.4, selfPercent: 11.0 },
      {
        function: 'Pool.query',
        location: 'node_modules/pg/lib/pool.js:312',
        selfMs: 4.9,
        totalMs: 19.6,
        selfPercent: 8.9,
      },
      { function: 'JSON.stringify', location: '(native)', selfMs: 3.7, totalMs: 3.7, selfPercent: 6.7 },
      { function: 'authorize', location: 'src/api/middleware/auth.ts:17', selfMs: 2.2, totalMs: 2.9, selfPercent: 4.0 },
      { function: 'parseQuery', location: 'src/api/items/query.ts:9', selfMs: 1.4, totalMs: 1.6, selfPercent: 2.5 },
    ],
  },
  {
    id: 'web.home',
    kind: 'web',
    critical: true,
    primary: 'flow_ms',
    iterations: 12,
    metrics: [
      { name: 'flow_ms', unit: 'ms', better: 'lower', base: 1_380, cv: 0.05, step: drift(0.006) },
      { name: 'fcp_ms', unit: 'ms', better: 'lower', base: 410, cv: 0.06 },
      { name: 'lcp_ms', unit: 'ms', better: 'lower', base: 880, cv: 0.07, step: drift(0.008) },
      { name: 'tbt_ms', unit: 'ms', better: 'lower', base: 96, cv: 0.18 },
    ],
  },
  {
    id: 'startup.server',
    kind: 'startup',
    critical: false,
    primary: 'ready_ms',
    iterations: 10,
    metrics: [{ name: 'ready_ms', unit: 'ms', better: 'lower', base: 640, cv: 0.04 }],
  },
  {
    id: 'cli.build',
    kind: 'command',
    critical: false,
    primary: 'wall_ms',
    iterations: 8,
    metrics: [
      { name: 'wall_ms', unit: 'ms', better: 'lower', base: 8_900, cv: 0.03 },
      { name: 'cpu_user_ms', unit: 'ms', better: 'lower', base: 14_200, cv: 0.03 },
      { name: 'max_rss_mb', unit: 'mb', better: 'lower', base: 512, cv: 0.02 },
    ],
  },
  {
    id: 'search.query',
    kind: 'custom',
    critical: false,
    primary: 'query_ms',
    iterations: 20,
    metrics: [
      { name: 'query_ms', unit: 'ms', better: 'lower', base: 7.4, cv: 0.12 },
      { name: 'rps', unit: 'rps', better: 'higher', base: 1_840, cv: 0.05 },
    ],
  },
];

const COMMITS = [
  'feat(api): paginate the items list',
  'chore: bump pg to 8.13',
  'fix(web): lazy-load the settings panel',
  'refactor(db): share the row serializer',
  'feat(search): typo tolerance',
  'docs: explain the cache headers',
  'perf(web): preload the hero font',
  'feat(api): filter items by tag',
  'feat(api): validate items against the public schema',
  'fix(web): debounce the search box',
  'chore(ci): cache the build output',
  'feat(web): show the onboarding checklist',
];
/** @param {number} index */
const shaOf = (index) => {
  const r = mulberry32(index * 7919 + 13);
  return Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
};

const MACHINE = {
  fingerprint: 'c3f1a9e2b7',
  hostname: 'perf-runner-01',
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'AMD EPYC 7B13',
  cpus: 8,
  memoryGb: 32,
  node: '22.11.0',
};

const START = Date.parse('2026-10-14T09:00:00Z');
const HOUR = 3_600_000;
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();
/** @param {number} ms */
const idAt = (ms) =>
  `${iso(ms)
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')}-${Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0')}`;

/** @param {MetricDef} def @param {number} commit @param {number} iterations @param {number} factor @returns {MetricSeries} */
function series(def, commit, iterations, factor = 1) {
  const center = def.base * (def.step?.(commit) ?? 1) * factor;
  const values = Array.from({ length: iterations }, () => (def.cv ? sample(center, def.cv) : center));
  return { unit: def.unit, better: def.better, values, summary: summarize(values) };
}

/**
 * @param {number} commit 1-based
 * @param {{ purpose?: Run['purpose']; at?: number; sha?: string; subject?: string; branch?: string;
 *   factors?: Record<string, number> }} [options]
 * @returns {Run}
 */
function makeRun(commit, options = {}) {
  const at = options.at ?? START + (commit - 1) * 26 * HOUR;
  const id = idAt(at);
  /** @type {BenchmarkResult[]} */
  const results = BENCHMARKS.map((def) => {
    /** @type {Record<string, MetricSeries>} */
    const metrics = {};
    for (const metric of def.metrics) {
      metrics[metric.name] = series(metric, commit, def.iterations, options.factors?.[def.id] ?? 1);
    }
    /** @type {BenchmarkResult} */
    const result = {
      benchmark: def.id,
      kind: def.kind,
      primary: def.primary,
      metrics,
      iterations: def.iterations,
      errors: [],
      durationMs: Math.round(def.iterations * (metrics[def.primary]?.summary.mean ?? 0) * 1.15),
      critical: def.critical,
    };
    if (def.hotspots) {
      result.profile = {
        path: `profiles/${id}/${def.id}.cpuprofile`,
        kind: 'cpuprofile',
        hotspots: def.hotspots(commit),
      };
    }
    return result;
  });
  return {
    id,
    purpose: options.purpose ?? 'baseline',
    startedAt: iso(at),
    finishedAt: iso(at + 4 * 60_000 + 12_000),
    source: {
      dir: '/srv/checkouts/shopfront',
      sha: options.sha ?? shaOf(commit),
      branch: options.branch ?? 'main',
      dirty: false,
      subject: options.subject ?? COMMITS[commit - 1],
    },
    machine: MACHINE,
    benchmarksHash: '5e0d2c71a9f4',
    results,
  };
}

/** @param {number} a @param {number} b */
const ratio = (a, b) => a / b - 1;

/**
 * @param {Run} base @param {Run} head @param {Comparison['mode']} mode
 * @param {Record<string, Verdict>} verdicts `benchmark/metric` -> verdict; the rest are `unchanged`.
 * @returns {Comparison}
 */
function compare(base, head, mode, verdicts, at = Date.parse(head.finishedAt) + 30_000) {
  /** @type {MetricComparison[]} */
  const metrics = [];
  for (const result of head.results) {
    const baseResult = base.results.find((item) => item.benchmark === result.benchmark);
    for (const [name, headSeries] of Object.entries(result.metrics)) {
      const baseSeries = baseResult?.metrics[name];
      const b = baseSeries?.summary.median ?? Number.NaN;
      const h = headSeries.summary.median;
      const delta = ratio(h, b);
      const spread = Math.max(0.004, (headSeries.summary.cv + (baseSeries?.summary.cv ?? 0)) / 2.5);
      const verdict = verdicts[`${result.benchmark}/${name}`] ?? 'unchanged';
      metrics.push({
        benchmark: result.benchmark,
        metric: name,
        unit: headSeries.unit,
        better: headSeries.better,
        primary: name === result.primary,
        critical: result.critical,
        base: baseSeries?.summary,
        head: headSeries.summary,
        deltaPct: delta,
        deltaAbs: h - b,
        // A non-significant change has an interval that straddles zero.
        ci:
          verdict === 'regression' || verdict === 'improvement'
            ? [delta - spread, delta + spread]
            : [Math.min(delta - spread, -0.002), Math.max(delta + spread, 0.002)],
        pValue: verdict === 'regression' || verdict === 'improvement' ? 0.0002 : 0.18 + random() * 0.7,
        verdict,
      });
    }
  }
  /** @type {Verdict[]} */
  const order = ['regression', 'noisy', 'missing', 'improvement', 'unchanged'];
  const primary = metrics.filter((metric) => metric.primary).map((metric) => metric.verdict);
  return {
    id: idAt(at),
    createdAt: iso(at),
    mode,
    base: { runs: [base.id], sha: base.source.sha, label: mode === 'ab' ? 'main' : base.source.sha.slice(0, 8) },
    head: {
      runs: [head.id],
      sha: head.source.sha,
      label: mode === 'ab' ? (head.source.branch ?? 'head') : head.source.sha.slice(0, 8),
    },
    metrics,
    verdict: order.find((verdict) => primary.includes(verdict)) ?? 'unchanged',
    warnings: mode === 'ab' ? ['tbt_ms on web.home has a CV above 15%: its verdict is noisy.'] : [],
  };
}

async function main() {
  const target = resolve(process.argv[2] ?? '.');
  const configDir = join(target, '.speedpatrol');
  await rm(join(configDir, 'runs'), { recursive: true, force: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'speedpatrol.yml'),
    'version: 1\nproject:\n  name: shopfront\n  source: .\n# Generated by packages/dashboard/scripts/fixture.mjs\n',
  );
  const store = new Store(configDir);

  /** @type {Run[]} */
  const baselines = [];
  for (let commit = 1; commit <= COMMITS.length; commit++) {
    const run = makeRun(commit);
    baselines.push(run);
    await store.saveRun(run);
    await store.addBaseline({
      sha: run.source.sha,
      runId: run.id,
      machine: MACHINE.fingerprint,
      benchmarksHash: run.benchmarksHash,
      branch: 'main',
      subject: run.source.subject,
      at: run.finishedAt,
    });
  }

  const good = baselines[REGRESSED_AT - 2];
  const bad = baselines[REGRESSED_AT - 1];
  const step = compare(good, bad, 'baseline', {
    'api.items/total_ms': 'regression',
    'api.items/ttfb_ms': 'regression',
    'web.home/tbt_ms': 'noisy',
  });
  await store.saveComparison(step);
  const latest = baselines.at(-1);
  const previous = baselines.at(-2);
  if (!latest || !previous) throw new Error('fixture needs at least two baselines');
  await store.saveComparison(compare(previous, latest, 'baseline', { 'web.home/tbt_ms': 'noisy' }));

  const regressedAt = Date.parse(step.createdAt);
  const regressionId = idAt(regressedAt + 60_000);
  await store.saveRegression({
    id: regressionId,
    fingerprint: 'api.items/total_ms',
    benchmark: 'api.items',
    metric: 'total_ms',
    status: 'filed',
    createdAt: iso(regressedAt + 60_000),
    updatedAt: iso(regressedAt + 14 * 60_000),
    goodSha: good.source.sha,
    badSha: bad.source.sha,
    comparisonId: step.id,
    deltaPct: step.metrics.find((metric) => metric.benchmark === 'api.items' && metric.primary)?.deltaPct ?? 0,
    title: 'api.items got 34% slower: schema validation on every list request',
    analysis:
      '`validateItems` (src/api/items/schema.ts:41) is new in the profile at 21% self time. It compiles the JSON ' +
      'schema on every request instead of once at startup. Hoist the `ajv.compile` call to module scope.',
    suspects: [
      {
        sha: bad.source.sha,
        subject: bad.source.subject ?? '',
        reason: 'Adds validateItems to the list handler; the new hotspot points at it.',
      },
    ],
    issueUrl: 'https://github.com/acme/shopfront/issues/482',
  });

  // An optimizer experiment on web.home: measured A/B against main, faster, and published as a PR.
  const expAt = Date.parse(latest.finishedAt) + 2 * HOUR;
  const expHead = makeRun(COMMITS.length, {
    purpose: 'experiment',
    at: expAt,
    sha: shaOf(99),
    branch: 'speedpatrol/web-home-defer-analytics',
    subject: 'perf(web): defer the analytics bundle until idle',
    factors: { 'web.home': 0.83 },
  });
  await store.saveRun(expHead);
  const expComparison = compare(
    latest,
    expHead,
    'ab',
    { 'web.home/flow_ms': 'improvement', 'web.home/lcp_ms': 'improvement', 'web.home/tbt_ms': 'noisy' },
    expAt + 6 * 60_000,
  );
  await store.saveComparison(expComparison);
  await store.saveExperiment({
    id: idAt(expAt - 20 * 60_000),
    target: { benchmark: 'web.home', metric: 'flow_ms' },
    status: 'published',
    createdAt: iso(expAt - 20 * 60_000),
    updatedAt: iso(expAt + 9 * 60_000),
    branch: 'speedpatrol/web-home-defer-analytics',
    worktree: '/srv/checkouts/.speedpatrol/worktrees/web-home-defer-analytics',
    baseSha: latest.source.sha,
    headSha: expHead.source.sha,
    hypothesis: 'The analytics bundle parses on the main thread before the hero renders.',
    summary: 'Load analytics with requestIdleCallback; the hero no longer waits on it.',
    comparisonId: expComparison.id,
    deltaPct: expComparison.metrics.find((metric) => metric.benchmark === 'web.home' && metric.primary)?.deltaPct,
    collateral: [],
    prUrl: 'https://github.com/acme/shopfront/pull/491',
  });
  await store.saveExperiment({
    id: idAt(expAt - 3 * HOUR),
    target: { benchmark: 'search.query', metric: 'query_ms' },
    status: 'rejected',
    createdAt: iso(expAt - 3 * HOUR),
    updatedAt: iso(expAt - 2.5 * HOUR),
    branch: 'speedpatrol/search-memo-tokenizer',
    worktree: '/srv/checkouts/.speedpatrol/worktrees/search-memo-tokenizer',
    baseSha: latest.source.sha,
    hypothesis: 'Memoizing the tokenizer skips repeated work on hot queries.',
    deltaPct: -0.04,
    collateral: ['startup.server'],
    reason: 'query_ms -4% but startup.server ready_ms +9%: the memo table is built at boot.',
  });
  await store.saveExperiment({
    id: idAt(Date.now() - 4 * 60_000),
    target: { benchmark: 'api.items', metric: 'total_ms' },
    status: 'measuring',
    createdAt: iso(Date.now() - 4 * 60_000),
    updatedAt: iso(Date.now() - 60_000),
    branch: 'speedpatrol/api-items-compile-schema-once',
    worktree: '/srv/checkouts/.speedpatrol/worktrees/api-items-compile-schema-once',
    baseSha: latest.source.sha,
    hypothesis: 'Compile the item schema once at module load.',
  });

  // Agent sessions: a finished analyst run and an optimizer that is measuring right now.
  const now = Date.now();
  /** @type {[string, AgentEvent['role'], number, [AgentEvent['kind'], string, string?][]][]} */
  const sessions = [
    [
      'analyst-api-items',
      'analyst',
      regressedAt + 2 * 60_000,
      [
        ['start', 'Explaining the regression in api.items total_ms (+34%)'],
        ['tool-call', 'Reading the comparison', 'read_comparison'],
        ['tool-result', 'total_ms and ttfb_ms regressed; p < 0.001', 'read_comparison'],
        ['tool-call', 'Diffing hotspots between the good and bad commit', 'diff_hotspots'],
        ['tool-result', 'New hotspot: validateItems at 21.4% self time', 'diff_hotspots'],
        ['thought', 'The schema is compiled per request; the suspect commit adds the call.'],
        ['tool-call', 'Filing the issue', 'file_issue'],
        ['finish', 'Filed acme/shopfront#482'],
      ],
    ],
    [
      'optimizer-web-home',
      'optimizer',
      expAt - 20 * 60_000,
      [
        ['start', 'Looking for a speed-up in web.home flow_ms'],
        ['tool-call', 'Reading the trace of the latest run', 'read_profile'],
        ['thought', 'analytics.js parses for 180 ms before first paint.'],
        ['tool-call', 'Editing src/app/analytics.ts', 'edit_file'],
        ['tool-call', 'Measuring A/B against main', 'compare'],
        ['tool-result', 'flow_ms -17.0%, no collateral', 'compare'],
        ['finish', 'Opened acme/shopfront#491'],
      ],
    ],
    [
      'optimizer-api-items',
      'optimizer',
      now - 4 * 60_000,
      [
        ['start', 'Looking for a speed-up in api.items total_ms'],
        ['tool-call', 'Reading the regression analysis', 'read_regression'],
        ['tool-call', 'Editing src/api/items/schema.ts', 'edit_file'],
        ['tool-call', 'Measuring A/B against main (round 2 of 5)', 'compare'],
      ],
    ],
  ];
  for (const [sessionId, role, at, events] of sessions) {
    for (const [index, [kind, summary, tool]] of events.entries()) {
      /** @type {AgentEvent} */
      const event = { at: iso(at + index * 37_000), sessionId, role, kind, summary };
      if (tool) event.tool = tool;
      if (kind === 'tool-result') event.durationMs = 1200 + Math.round(random() * 4000);
      if (kind === 'finish') event.costUsd = 0.04 + Math.round(random() * 100) / 1000;
      await store.appendEvent(event);
    }
  }

  // pid 1 is always alive, so these read as working; a dead pid would read as stopped.
  /** @type {Record<string, AgentStatus>} */
  const agents = {
    scout: {
      role: 'scout',
      state: 'done',
      detail: 'Wrote 5 benchmarks for 3 critical paths',
      pid: 1,
      updatedAt: iso(START - HOUR),
    },
    analyst: {
      role: 'analyst',
      state: 'done',
      detail: 'Filed acme/shopfront#482',
      sessionId: 'analyst-api-items',
      pid: 1,
      updatedAt: iso(regressedAt + 8 * 60_000),
    },
    optimizer: {
      role: 'optimizer',
      state: 'running',
      detail: 'Measuring api.items A/B, round 2 of 5',
      sessionId: 'optimizer-api-items',
      pid: 1,
      updatedAt: iso(now - 60_000),
    },
    runner: {
      role: 'runner',
      state: 'idle',
      detail: `Measured ${latest.source.sha.slice(0, 8)}`,
      pid: 1,
      updatedAt: latest.finishedAt,
    },
    patrol: {
      role: 'patrol',
      state: 'running',
      detail: 'Waiting for new commits on origin/main',
      pid: 1,
      updatedAt: iso(now - 90_000),
    },
  };
  await writeFile(store.path('agents.json'), `${JSON.stringify(agents, null, 2)}\n`);
  await store.savePatrolState({
    lastSha: latest.source.sha,
    lastRunId: latest.id,
    lastCycleAt: iso(now - 90_000),
    cycles: 12,
  });

  process.stdout.write(`${configDir}\n`);
}

await main();
