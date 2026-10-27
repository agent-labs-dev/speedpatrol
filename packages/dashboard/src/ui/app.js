// Speedpatrol dashboard. Vanilla ES modules and no build step, so the UI is
// served straight from source and works from a clone with only the CLI built.

const view = document.getElementById('view');
const agentsEl = document.getElementById('agents');
const metaEl = document.getElementById('meta');
const projectEl = document.getElementById('project-name');
const liveEl = document.getElementById('live');

const POLL_MS = 3000;
const ROLE_HINT = {
  scout: 'Writes benchmarks: speedpatrol scout',
  analyst: 'Explains confirmed regressions',
  optimizer: 'Proposes speed-ups in a worktree',
  runner: 'Measures commits: speedpatrol run',
  patrol: 'Watches main for new commits',
};

/** Specs of the charts on the page, drawn after the HTML lands so they can measure their width. */
let charts = new Map();
let rendered = '';

// ---------------------------------------------------------------- formatting

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

/** Mirrors formatValue in @speedpatrol/stats. */
function fmt(value, unit) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  switch (unit) {
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
    case 'bytes':
      return value >= 1024 * 1024
        ? `${(value / 1024 / 1024).toFixed(2)} MB`
        : value >= 1024
          ? `${(value / 1024).toFixed(1)} KB`
          : `${Math.round(value)} B`;
    case 'kb':
      return `${value.toFixed(1)} KB`;
    case 'mb':
      return `${value.toFixed(1)} MB`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'rps':
      return `${value.toFixed(1)}/s`;
    case 'score':
      return value.toFixed(3);
    default:
      return String(Math.round(value));
  }
}

/** Axis ticks: shorter than `fmt`, the unit carried once by the chart title. */
function fmtTick(value, unit) {
  if (unit === 'ms') return value >= 1000 ? `${trim(value / 1000)}s` : trim(value);
  if (unit === 'bytes') return value >= 1024 * 1024 ? `${trim(value / 1048576)}M` : `${trim(value / 1024)}K`;
  if (Math.abs(value) >= 1000) return `${trim(value / 1000)}K`;
  return trim(value);
}
const trim = (value) => String(Number(value.toPrecision(3)));

function pct(delta) {
  if (delta === undefined || delta === null || !Number.isFinite(delta)) return '-';
  return `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
}

const short = (sha) => (sha ? String(sha).slice(0, 8) : '');

function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
const date = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

/** Only http(s) URLs become links: these strings come from agents. */
const link = (url, label) =>
  url && /^https?:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : '';

const VERDICT_GLYPH = { regression: '◆', improvement: '●', noisy: '◐', unchanged: '○', missing: '–' };
const verdict = (value) =>
  value ? `<span class="verdict ${esc(value)}"><i>${VERDICT_GLYPH[value] ?? '?'}</i>${esc(value)}</span>` : '';

/** Colour a change by its statistical verdict, never by the sign alone. */
function delta(value, verdictValue) {
  const cls = verdictValue === 'regression' ? 'worse' : verdictValue === 'improvement' ? 'better' : '';
  return `<span class="delta ${cls}">${pct(value)}</span>`;
}

/** Agent prose: escaped, with `code` spans kept. */
const prose = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

const empty = (html) => `<div class="empty">${html}</div>`;
const panel = (title, sub, body, right = '') =>
  `<section class="panel"><div class="panel-head"><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}${
    right ? `<span class="right">${right}</span>` : ''
  }</div>${body}</section>`;

// ---------------------------------------------------------------- data

async function get(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'benchmark' && parts[1]) return { name: 'benchmark', id: parts[1] };
  if (parts[0] === 'comparison' && parts[1]) return { name: 'comparison', id: parts[1] };
  return { name: 'home' };
}

async function load(current) {
  const overview = await get('/api/overview');
  if (current.name === 'benchmark') {
    const benchmark = await get(`/api/benchmarks/${encodeURIComponent(current.id)}`).catch(() => null);
    return { overview, benchmark };
  }
  if (current.name === 'comparison') {
    const comparison = await get(`/api/comparisons/${encodeURIComponent(current.id)}`).catch(() => null);
    return { overview, comparison };
  }
  const [benchmarks, comparisons, regressions, experiments, activity] = await Promise.all([
    get('/api/benchmarks'),
    get('/api/comparisons'),
    get('/api/regressions'),
    get('/api/experiments'),
    get('/api/activity?limit=40'),
  ]);
  return { overview, benchmarks, comparisons, regressions, experiments, activity };
}

async function refresh() {
  const current = route();
  let data;
  try {
    data = await load(current);
    liveEl.classList.remove('offline');
    liveEl.textContent = 'live';
  } catch {
    liveEl.classList.add('offline');
    liveEl.textContent = 'offline';
    return;
  }
  // Re-rendering resets hover and scroll in the feed: skip it when nothing changed.
  const key = JSON.stringify([current, data]);
  if (key === rendered) return;
  rendered = key;
  renderHeader(data.overview);
  charts = new Map();
  if (current.name === 'benchmark') view.innerHTML = renderBenchmark(data.benchmark, current.id, data.overview);
  else if (current.name === 'comparison') view.innerHTML = renderComparison(data.comparison, current.id);
  else view.innerHTML = renderHome(data);
  drawCharts();
}

// ---------------------------------------------------------------- header

function renderHeader(overview) {
  projectEl.textContent = overview.project.name;
  document.title = `${overview.project.name} · Speedpatrol`;
  const latest = overview.latest;
  metaEl.innerHTML = latest
    ? [
        `<span title="${esc(latest.machine.cpuModel)} · ${latest.machine.cpus} cpus · ${latest.machine.memoryGb} GB · node ${esc(
          latest.machine.node,
        )}"><span class="label">Machine</span><span class="mono">${esc(latest.machine.fingerprint)}</span> <span class="muted">${esc(
          latest.machine.hostname,
        )}</span></span>`,
        `<span title="${esc(latest.subject)}"><span class="label">Last measured</span><span class="mono">${short(
          latest.sha,
        )}</span> <span class="muted">${esc(latest.subject ?? '')} · ${ago(latest.startedAt)}</span></span>`,
      ].join('')
    : '<span class="muted">No runs yet</span>';
  agentsEl.innerHTML = overview.agents
    .map((agent) => {
      const label = agent.state === 'never' ? 'not run' : agent.state;
      const detail = agent.detail || ROLE_HINT[agent.role] || '';
      return `<div class="agent"><div class="agent-head"><span class="agent-role">${esc(agent.role)}</span><span class="state ${esc(
        agent.state,
      )}">${esc(label)}</span></div><div class="agent-detail" title="${esc(detail)}">${esc(detail)}</div><div class="agent-when">${
        agent.updatedAt ? ago(agent.updatedAt) : '&nbsp;'
      }</div></div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- home

function renderHome(data) {
  return `<div class="grid"><div class="stack">${benchmarksPanel(data.benchmarks)}${regressionsPanel(
    data.regressions,
  )}${experimentsPanel(data.experiments)}${comparisonsPanel(data.comparisons)}</div><div class="stack">${activityPanel(
    data.activity,
  )}</div></div>`;
}

function benchmarksPanel({ benchmarks, machine }) {
  if (!benchmarks.length) {
    return panel(
      'Benchmarks',
      '',
      empty(
        'No baseline measurements yet. Run <code>speedpatrol scout</code> to write benchmarks for the critical paths, then <code>speedpatrol run</code> to measure this commit.',
      ),
    );
  }
  const rows = benchmarks
    .map((row, index) => {
      const spark = `spark-${index}`;
      charts.set(spark, { type: 'spark', points: row.series });
      return `<tr class="clickable" data-href="#/benchmark/${encodeURIComponent(row.id)}">
        <td><span class="bench-id">${esc(row.id)}</span>${row.critical ? '<span class="badge critical">critical</span>' : ''}</td>
        <td class="dim">${esc(row.kind)}</td>
        <td class="dim mono">${esc(row.primary)}</td>
        <td class="num">${fmt(row.latest?.median, row.unit)}</td>
        <td class="num">${row.deltaPct === undefined ? '<span class="muted">-</span>' : delta(row.deltaPct, row.verdict)}</td>
        <td>${verdict(row.verdict)}</td>
        <td><div class="chart" data-chart="${spark}" style="width:132px"></div></td>
      </tr>`;
    })
    .join('');
  const count = benchmarks[0]?.series.length ?? 0;
  return panel(
    'Benchmarks',
    `primary metric median across ${count} baseline commit${count === 1 ? '' : 's'}`,
    `<table><thead><tr><th>Benchmark</th><th>Kind</th><th>Primary</th><th class="num">Median</th><th class="num">vs previous</th><th>Verdict</th><th>History</th></tr></thead><tbody>${rows}</tbody></table>`,
    machine ? `machine <span class="mono">${esc(machine)}</span>` : '',
  );
}

function regressionsPanel(regressions) {
  if (!regressions.length) {
    return panel(
      'Regressions',
      '',
      empty('No regressions. <code>speedpatrol compare</code> checks a commit against its baseline.'),
    );
  }
  const rows = regressions
    .map(
      (item) => `<tr class="clickable" data-href="#/comparison/${encodeURIComponent(item.comparisonId)}">
        <td><span class="status ${esc(item.status)}">${esc(item.status)}</span></td>
        <td class="wrap" title="${esc(item.title)}">${esc(item.title)}<div class="muted mono">${esc(item.benchmark)} · ${esc(
          item.metric,
        )}</div></td>
        <td class="num"><span class="delta ${item.deltaPct > 0 ? 'worse' : 'better'}">${pct(item.deltaPct)}</span></td>
        <td class="wrap">${(item.suspects ?? [])
          .map(
            (suspect) =>
              `<span class="mono">${short(suspect.sha)}</span> <span class="dim">${esc(suspect.subject)}</span>`,
          )
          .join('<br>')}</td>
        <td>${link(item.issueUrl, issueLabel(item.issueUrl))}</td>
      </tr>`,
    )
    .join('');
  const open = regressions.filter((item) => item.status === 'open' || item.status === 'filed').length;
  return panel(
    'Regressions',
    `${open} open`,
    `<table><thead><tr><th>Status</th><th>Regression</th><th class="num">Delta</th><th>Suspects</th><th>Issue</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

const issueLabel = (url) =>
  url ? (url.match(/\/(?:issues|pull)\/(\d+)/)?.[1] ? `#${url.match(/(\d+)$/)?.[1]}` : 'link') : '';

function experimentsPanel(experiments) {
  if (!experiments.length) {
    return panel('Experiments', '', empty('No optimizer experiments yet.'));
  }
  const rows = experiments
    .map(
      (item) => `<tr class="${item.comparisonId ? 'clickable' : ''}" ${
        item.comparisonId ? `data-href="#/comparison/${encodeURIComponent(item.comparisonId)}"` : ''
      }>
        <td><span class="status ${esc(item.status)}">${esc(item.status)}</span></td>
        <td style="white-space:nowrap"><span class="bench-id">${esc(item.target.benchmark)}</span> <span class="muted mono">${esc(item.target.metric)}</span></td>
        <td class="num">${
          item.deltaPct === undefined
            ? '<span class="muted">-</span>'
            : `<span class="delta ${item.status === 'improved' || item.status === 'published' ? 'better' : ''}">${pct(item.deltaPct)}</span>`
        }</td>
        <td class="wrap mono dim" title="${esc(item.branch)}">${esc(item.branch)}</td>
        <td>${link(item.prUrl, issueLabel(item.prUrl))}</td>
        <td class="wrap dim" title="${esc(item.reason ?? item.summary ?? item.hypothesis ?? '')}">${esc(
          item.reason ?? item.summary ?? item.hypothesis ?? '',
        )}</td>
      </tr>`,
    )
    .join('');
  return panel(
    'Experiments',
    '',
    `<table><thead><tr><th>Status</th><th>Target</th><th class="num">Delta</th><th>Branch</th><th>PR</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function comparisonsPanel(comparisons) {
  if (!comparisons.length) {
    return panel(
      'Comparisons',
      '',
      empty('No comparisons yet. Run <code>speedpatrol compare</code> to measure a change against the baseline.'),
    );
  }
  const rows = comparisons
    .map((item) => {
      const counts = ['regression', 'improvement', 'noisy']
        .filter((key) => item.verdicts[key])
        .map((key) => `${item.verdicts[key]} ${key}${item.verdicts[key] === 1 ? '' : 's'}`)
        .join(' · ');
      return `<tr class="clickable" data-href="#/comparison/${encodeURIComponent(item.id)}">
        <td>${verdict(item.verdict)}</td>
        <td class="dim">${esc(item.mode === 'ab' ? 'A/B' : 'baseline')}</td>
        <td><span class="mono">${esc(item.head.label)}</span> <span class="muted">vs</span> <span class="mono">${esc(item.base.label)}</span></td>
        <td class="dim">${esc(counts || 'no significant change')}</td>
        <td class="num muted">${ago(item.createdAt)}</td>
      </tr>`;
    })
    .join('');
  return panel(
    'Comparisons',
    '',
    `<table><thead><tr><th>Verdict</th><th>Mode</th><th>Head vs base</th><th>Metrics</th><th class="num">When</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function activityPanel(events) {
  if (!events.length) {
    return panel(
      'Agent activity',
      '',
      empty('No agent sessions yet. <code>speedpatrol scout</code> starts the first one.'),
    );
  }
  const items = events
    .map(
      (event) =>
        `<li><span class="dot ${esc(event.kind)}"></span><div><div class="what">${esc(event.summary)}</div><div class="who"><b>${esc(
          event.role,
        )}</b> · ${esc(event.kind)}${event.tool ? ` · <span class="mono">${esc(event.tool)}</span>` : ''} · ${ago(event.at)}</div></div></li>`,
    )
    .join('');
  return panel('Agent activity', 'live', `<ul class="feed">${items}</ul>`);
}

// ---------------------------------------------------------------- benchmark detail

function renderBenchmark(benchmark, id, overview) {
  const crumbs = `<div class="crumbs"><a href="#/">Overview</a> / ${esc(id)}</div>`;
  if (!benchmark) {
    return `${crumbs}${panel('Benchmark', '', empty(`No baseline run measured <code>${esc(id)}</code>. Run <code>speedpatrol run</code>.`))}`;
  }
  const primary = benchmark.metrics.find((metric) => metric.primary) ?? benchmark.metrics[0];
  const others = benchmark.metrics.filter((metric) => metric !== primary);
  const markers = benchmark.regressions.map((item) => ({
    sha: item.badSha,
    label: `regression · ${pct(item.deltaPct)}`,
  }));
  charts.set('main', { type: 'line', metric: primary, height: 300, markers });
  const latest = primary.series.at(-1);
  const previous = primary.series.at(-2);
  const change = latest && previous ? latest.median / previous.median - 1 : undefined;

  const multiples = others
    .map((metric, index) => {
      const key = `multiple-${index}`;
      charts.set(key, { type: 'line', metric, height: 150, compact: true, markers });
      return panel(
        `<span class="mono">${esc(metric.name)}</span>`,
        `${esc(metric.unit)} · ${metric.better} is better`,
        `<div class="panel-body"><div class="chart" data-chart="${key}"></div></div>`,
        fmt(metric.series.at(-1)?.median, metric.unit),
      );
    })
    .join('');

  const hotspots = benchmark.hotspots
    ? panel(
        'Hotspots',
        `self time, from the profile of <span class="mono">${short(benchmark.hotspots.sha)}</span> · ${date(benchmark.hotspots.at)}`,
        `<table><thead><tr><th>Function</th><th>Location</th><th class="num">Self</th><th class="num">Total</th><th class="num">Self %</th><th></th></tr></thead><tbody>${benchmark.hotspots.hotspots
          .map(
            (spot) =>
              `<tr><td class="mono">${esc(spot.function)}</td><td class="mono dim">${esc(spot.location)}</td><td class="num">${fmt(
                spot.selfMs,
                'ms',
              )}</td><td class="num dim">${fmt(spot.totalMs, 'ms')}</td><td class="num">${spot.selfPercent.toFixed(1)}%</td><td style="width:140px">${bar(
                spot.selfPercent,
                benchmark.hotspots.hotspots[0]?.selfPercent ?? 100,
              )}</td></tr>`,
          )
          .join('')}</tbody></table>`,
      )
    : panel(
        'Hotspots',
        '',
        empty(
          'No profile recorded for this benchmark yet. Profiles are taken on the next <code>speedpatrol run</code>.',
        ),
      );

  const regressions = benchmark.regressions.length
    ? panel(
        'Regressions',
        '',
        benchmark.regressions
          .map(
            (item) =>
              `<div class="panel-body"><span class="status ${esc(item.status)}">${esc(item.status)}</span> ${esc(item.title)} ${link(
                item.issueUrl,
                issueLabel(item.issueUrl),
              )}</div>${item.analysis ? `<p class="analysis">${prose(item.analysis)}</p>` : ''}`,
          )
          .join(''),
      )
    : '';

  return `${crumbs}
    <div class="title-row"><h1>${esc(benchmark.id)}</h1>${benchmark.critical ? '<span class="badge critical">critical</span>' : ''}<span class="badge">${esc(
      benchmark.kind,
    )}</span>
      <div class="facts"><span>${benchmark.iterations} iterations</span><span>${primary.series.length} baseline commits</span>${
        benchmark.errors.length ? `<span>${benchmark.errors.length} errors</span>` : ''
      }<span>machine <span class="mono">${esc(overview.latest?.machine.fingerprint ?? '')}</span></span></div></div>
    <div class="stack">
      ${panel(
        `<span class="mono">${esc(primary.name)}</span>`,
        `primary metric · ${esc(primary.unit)} · ${primary.better} is better`,
        `<div class="hero"><span class="value">${fmt(latest?.median, primary.unit)}</span><span class="dim">median at <span class="mono">${short(
          latest?.sha,
        )}</span></span>${change === undefined ? '' : `<span>${delta(change, undefined)} <span class="muted">vs previous</span></span>`}</div>
        <div class="panel-body"><div class="chart" data-chart="main"></div></div>`,
        '<span class="key"><span class="line"></span>median</span><span class="key"><span class="band"></span>min to p95</span>',
      )}
      ${others.length ? `<div class="multiples">${multiples}</div>` : ''}
      ${hotspots}
      ${regressions}
    </div>`;
}

function bar(value, max) {
  const width = Math.max(2, (value / max) * 120);
  return `<svg width="124" height="8" aria-hidden="true"><rect x="0" y="0" width="${width}" height="8" rx="2" fill="var(--series)"/></svg>`;
}

// ---------------------------------------------------------------- comparison detail

function renderComparison(comparison, id) {
  const crumbs = `<div class="crumbs"><a href="#/">Overview</a> / comparison ${esc(id)}</div>`;
  if (!comparison) return `${crumbs}${panel('Comparison', '', empty('No such comparison.'))}`;
  const rows = [...comparison.metrics]
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.benchmark.localeCompare(b.benchmark))
    .map(
      (metric) => `<tr${metric.primary ? '' : ' class="secondary"'}>
        <td>${verdict(metric.verdict)}</td>
        <td><span class="bench-id">${esc(metric.benchmark)}</span>${metric.critical && metric.primary ? '<span class="badge critical">critical</span>' : ''}</td>
        <td class="mono ${metric.primary ? '' : 'dim'}">${esc(metric.metric)}${metric.primary ? ' <span class="badge">primary</span>' : ''}</td>
        <td class="num">${fmt(metric.base?.median, metric.unit)}</td>
        <td class="num">${fmt(metric.head?.median, metric.unit)}</td>
        <td class="num">${delta(metric.deltaPct, metric.verdict)}</td>
        <td class="num dim">${pct(metric.ci[0])} to ${pct(metric.ci[1])}</td>
        <td class="num dim">${metric.pValue < 0.001 ? '&lt;0.001' : metric.pValue.toFixed(3)}</td>
      </tr>`,
    )
    .join('');
  const warnings = comparison.warnings.length
    ? `<div class="warnings">${comparison.warnings.map(esc).join('<br>')}</div>`
    : '';
  return `${crumbs}
    <div class="title-row"><h1>${esc(comparison.head.label)} <span class="muted">vs</span> ${esc(comparison.base.label)}</h1>${verdict(
      comparison.verdict,
    )}
      <div class="facts"><span>${comparison.mode === 'ab' ? 'A/B' : 'baseline'}</span><span>head <span class="mono">${short(
        comparison.head.sha,
      )}</span></span><span>base <span class="mono">${short(comparison.base.sha)}</span></span><span>${date(comparison.createdAt)}</span></div></div>
    ${panel(
      'Metrics',
      'medians, change of head against base, bootstrap 95% CI, Mann-Whitney p',
      `${warnings}<table><thead><tr><th>Verdict</th><th>Benchmark</th><th>Metric</th><th class="num">Base</th><th class="num">Head</th><th class="num">Change</th><th class="num">95% CI</th><th class="num">p</th></tr></thead><tbody>${rows}</tbody></table>`,
    )}`;
}

// ---------------------------------------------------------------- charts

function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function drawCharts() {
  for (const el of view.querySelectorAll('[data-chart]')) {
    const spec = charts.get(el.dataset.chart);
    if (!spec) continue;
    if (spec.type === 'spark') drawSpark(el, spec);
    else drawLine(el, spec);
  }
}

function drawSpark(el, { points }) {
  const width = 132;
  const height = 28;
  if (points.length < 2) {
    el.innerHTML = '<span class="muted">-</span>';
    return;
  }
  const values = points.map((p) => p.median);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  // Floor the span at 10% of the mean so run-to-run noise reads as flat, not as a trend.
  const half = Math.max(Math.max(...values) - Math.min(...values), mean * 0.1) / 2;
  const mid = (Math.max(...values) + Math.min(...values)) / 2;
  const lo = mid - half;
  const hi = mid + half;
  const x = (i) => 3 + (i / (points.length - 1)) * (width - 8);
  const y = (v) => height - 4 - ((v - lo) / (hi - lo || 1)) * (height - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = values.length - 1;
  el.innerHTML = `<svg class="spark" width="${width}" height="${height}" aria-label="history of ${values.length} medians"><path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(
    last,
  )}" cy="${y(values[last])}" r="3" fill="var(--series)" stroke="var(--surface)" stroke-width="1.5"/></svg>`;
}

function drawLine(el, spec) {
  const { metric, height, compact, markers = [] } = spec;
  const points = metric.series;
  const width = Math.max(240, el.clientWidth);
  if (!points.length) {
    el.innerHTML = '<span class="muted">No data</span>';
    return;
  }
  const m = { top: compact ? 10 : 18, right: compact ? 12 : 72, bottom: 24, left: compact ? 40 : 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const lows = points.map((p) => p.min);
  const highs = points.map((p) => p.p95);
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  const pad = (hi - lo || hi || 1) * 0.08;
  lo -= pad;
  hi += pad;
  if (lo < 0 && Math.min(...lows) >= 0) lo = 0;
  const ticks = niceTicks(lo, hi, compact ? 3 : 5);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks.at(-1));
  const x = (i) => m.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const grid = ticks
    .map(
      (t) =>
        `<line x1="${m.left}" x2="${m.left + plotW}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/><text class="tick" x="${
          m.left - 8
        }" y="${y(t) + 4}" text-anchor="end">${esc(fmtTick(t, metric.unit))}</text>`,
    )
    .join('');
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / (compact ? 90 : 76)))));
  const xTicks = points
    .map((p, i) =>
      i % every === 0 || i === points.length - 1
        ? (i === points.length - 1 || points.length - 1 - i >= every * 0.6) &&
          `<text class="tick sha" x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(short(p.sha).slice(0, 7))}</text>`
        : '',
    )
    .filter(Boolean)
    .join('');
  const band = `${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.p95)}`).join('')}${[...points]
    .reverse()
    .map((p, j) => `L${x(points.length - 1 - j)},${y(p.min)}`)
    .join('')}Z`;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.median)}`).join('');
  const last = points.length - 1;
  const markerSvg = markers
    .map((marker) => {
      const index = points.findIndex((p) => p.sha === marker.sha);
      if (index < 0) return '';
      return `<line x1="${x(index)}" x2="${x(index)}" y1="${m.top}" y2="${m.top + plotH}" stroke="var(--critical)" stroke-width="1" opacity="0.7"/>${
        compact ? '' : `<text class="marker-label" x="${x(index) + 6}" y="${m.top + 10}">${esc(marker.label)}</text>`
      }`;
    })
    .join('');

  el.innerHTML = `<svg width="${width}" height="${height}" role="img" aria-label="${esc(metric.name)} median over ${points.length} commits">
    ${grid}
    ${xTicks}
    <line x1="${m.left}" x2="${m.left + plotW}" y1="${m.top + plotH}" y2="${m.top + plotH}" stroke="var(--axis)" stroke-width="1"/>
    ${markerSvg}
    <path d="${band}" fill="var(--series-wash)" stroke="none"/>
    <path d="${line}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last)}" cy="${y(points[last].median)}" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
    ${
      compact
        ? ''
        : `<text class="end-label" x="${x(last) + 10}" y="${y(points[last].median) + 4}">${esc(fmt(points[last].median, metric.unit))}</text>`
    }
    <g class="hover" visibility="hidden">
      <line class="cross" y1="${m.top}" y2="${m.top + plotH}" stroke="var(--muted)" stroke-width="1"/>
      <circle class="hover-dot" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
    </g>
    <rect class="hit" x="${m.left - 10}" y="0" width="${plotW + 20}" height="${height}" fill="transparent"/>
  </svg><div class="tooltip" hidden></div>`;

  const svg = el.querySelector('svg');
  const hover = svg.querySelector('.hover');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.hover-dot');
  const tip = el.querySelector('.tooltip');
  const show = (event) => {
    const box = svg.getBoundingClientRect();
    const px = event.clientX - box.left;
    const i =
      points.length === 1 ? 0 : Math.max(0, Math.min(last, Math.round(((px - m.left) / plotW) * (points.length - 1))));
    const p = points[i];
    hover.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.median));
    const prev = points[i - 1];
    tip.innerHTML = `<div class="t-head"><span class="mono">${esc(short(p.sha))}</span><span>${esc(date(p.at))}</span></div>
      <div class="t-subject" title="${esc(p.subject ?? '')}">${esc(p.subject ?? '')}</div>
      <div class="t-row"><span>median</span><b>${esc(fmt(p.median, metric.unit))}</b></div>
      ${prev ? `<div class="t-row"><span>vs previous</span><span>${pct(p.median / prev.median - 1)}</span></div>` : ''}
      <div class="t-row"><span>min to p95</span><span>${esc(fmt(p.min, metric.unit))} to ${esc(fmt(p.p95, metric.unit))}</span></div>
      <div class="t-row"><span>samples</span><span>${p.n}</span></div>`;
    tip.hidden = false;
    const left = x(i) + 14 + tip.offsetWidth > width ? x(i) - 14 - tip.offsetWidth : x(i) + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, Math.min(height - tip.offsetHeight, y(p.median) - tip.offsetHeight / 2))}px`;
  };
  const hide = () => {
    hover.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerleave', hide);
}

// ---------------------------------------------------------------- wiring

view.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  const row = event.target.closest('[data-href]');
  if (row) location.hash = row.dataset.href;
});

window.addEventListener('hashchange', () => {
  rendered = '';
  window.scrollTo(0, 0);
  refresh();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 120);
});

refresh();
setInterval(refresh, POLL_MS);
