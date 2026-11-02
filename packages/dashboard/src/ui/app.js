// Speedpatrol dashboard. Vanilla ES modules and no build step, so the UI is
// served straight from source and works from a clone with only the CLI built.
//
// The server computes the numbers once (`/api/summary`). Each page shows them
// and does not count again, so two pages cannot disagree.

const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const projectEl = document.getElementById('project-name');
const liveEl = document.getElementById('live');
const patrolEl = document.getElementById('patrol');
const machineEl = document.getElementById('machine');
const themeEl = document.getElementById('theme');

const POLL_MS = 3000;
const ROLE_HINT = {
  scout: 'Writes the benchmarks',
  analyst: 'Explains each confirmed regression',
  optimizer: 'Tries a speed-up in a worktree',
  runner: 'Measures each commit',
  patrol: 'Watches main for new commits',
};

/** Specs of the charts on the page, drawn after the HTML lands so they can measure their width. */
let charts = new Map();
let rendered = '';
/** The data of the current page, so a filter change renders again without a fetch. */
let current = null;

/** The filters of each page. They live here and not in the hash, so a link stays short. */
const ui = {
  benchFilter: 'all',
  benchQuery: '',
  regFilter: 'open',
  expFilter: 'all',
  runFilter: 'all',
  cmpFilter: 'changed',
};

// ---------------------------------------------------------------- icons

/** A 16×16 line icon from trusted path markup in this file. */
const icon = (paths) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  system: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 14h4M8 11v3"/>',
  light:
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  dark: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"/>',
  machine:
    '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01"/>',
  patrol: '<circle cx="8" cy="8" r="5.5"/><path d="M8 8l3-2.5"/><circle cx="8" cy="8" r="1"/>',
  fail: '<path d="M8 1.8 14.2 8 8 14.2 1.8 8Z"/><path d="M8 5.2v3.3M8 10.8h.01"/>',
  warn: '<path d="M8 2.2 14.3 13.3H1.7Z"/><path d="M8 6.5v3M8 11.6h.01"/>',
  pass: '<circle cx="8" cy="8" r="6"/><path d="m5.4 8.2 1.8 1.8 3.5-3.6"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.6M8 5.2h.01"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
};

// ---------------------------------------------------------------- theme

// The choice cycles system → light → dark. "System" follows the OS setting, also when it changes.
const THEMES = ['system', 'light', 'dark'];
const THEME_WORDS = { system: 'System', light: 'Light', dark: 'Dark' };
const lightQuery = matchMedia('(prefers-color-scheme: light)');
let themeChoice = THEMES.includes(localStorage.getItem('speedpatrol-theme'))
  ? localStorage.getItem('speedpatrol-theme')
  : 'system';

function applyTheme() {
  document.documentElement.dataset.theme =
    themeChoice === 'system' ? (lightQuery.matches ? 'light' : 'dark') : themeChoice;
  const next = THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length];
  themeEl.innerHTML = icon(ICONS[themeChoice]);
  themeEl.setAttribute('aria-label', `Theme: ${THEME_WORDS[themeChoice]}. Change the theme to ${THEME_WORDS[next]}.`);
  themeEl.title = `Theme: ${THEME_WORDS[themeChoice]}. Click for ${THEME_WORDS[next]}.`;
}
themeEl.addEventListener('click', () => {
  themeChoice = THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length];
  if (themeChoice === 'system') localStorage.removeItem('speedpatrol-theme');
  else localStorage.setItem('speedpatrol-theme', themeChoice);
  applyTheme();
});
lightQuery.addEventListener('change', applyTheme);

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
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
const date = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
const clock = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function duration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
const money = (usd) => (usd ? `$${usd.toFixed(2)}` : '-');

/** Only http(s) URLs become links: these strings come from agents. */
const link = (url, label) =>
  url && /^https?:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : '';
const issueLabel = (url) => {
  const number = url?.match(/\/(?:issues|pull)\/(\d+)/)?.[1];
  return number ? `#${number}` : 'link';
};

const VERDICT_GLYPH = { regression: '◆', improvement: '●', noisy: '◐', unchanged: '○', missing: '–' };
const verdict = (value) =>
  value
    ? `<span class="verdict ${esc(value)}"><i aria-hidden="true">${VERDICT_GLYPH[value] ?? '?'}</i>${esc(value)}</span>`
    : '';

/** Colour a change by its statistical verdict, never by the sign alone. */
function delta(value, verdictValue) {
  const cls = verdictValue === 'regression' ? 'worse' : verdictValue === 'improvement' ? 'better' : '';
  return `<span class="delta ${cls}">${pct(value)}</span>`;
}

/** Agent prose: escaped, with `code` spans kept. */
const inline = (text) =>
  esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/**
 * The analyst writes Markdown. A small, escaped subset is enough for it:
 * headings, fenced code, bullet lists, paragraphs, inline code and bold.
 */
const markdown = (text) => {
  const out = [];
  let inFence = false;
  for (const part of String(text).split('\n')) {
    if (part.trim().startsWith('```')) {
      out.push(inFence ? '</code></pre>' : '<pre><code>');
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`${esc(part)}\n`);
      continue;
    }
    const heading = part.match(/^#{1,6}\s+(.*)$/);
    const bullet = part.match(/^\s*[-*]\s+(.*)$/);
    if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
    else if (bullet) out.push(`<li>${inline(bullet[1])}</li>`);
    else if (part.trim()) out.push(`<p>${inline(part)}</p>`);
  }
  if (inFence) out.push('</code></pre>');
  return out
    .join('')
    .replace(/(<li>[\s\S]*?<\/li>)(?!<li>)/g, '$1</ul>')
    .replace(/(?<!<\/li>)<li>/g, '<ul><li>');
};

// ---------------------------------------------------------------- shared parts

const panel = (title, sub, body, right = '') =>
  `<section class="panel"><div class="panel-head"><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}${
    right ? `<span class="right">${right}</span>` : ''
  }</div>${body}</section>`;

/** One command with a Copy button. */
const command = (text) =>
  `<div class="command"><code>${esc(text)}</code><button type="button" class="copy" data-copy="${esc(
    text,
  )}" aria-label="Copy the command ${esc(text)}">Copy</button></div>`;

/**
 * The one empty state of the dashboard: what the block shows, why it is
 * empty now, and the one next step, as a command or a button.
 */
function emptyState({ title, why, cmd, action, compact = false }) {
  return `<div class="empty-state${compact ? ' compact' : ''}"><h3>${esc(title)}</h3>${why ? `<p>${esc(why)}</p>` : ''}${
    cmd ? command(cmd) : ''
  }${action ? `<button type="button" class="button" data-set="${esc(action.key)}" data-value="${esc(action.value)}">${esc(action.label)}</button>` : ''}</div>`;
}

/** The empty state of a project with no baseline yet: the summary owns the next step. */
const firstStep = (summary, title) => emptyState({ title, why: summary.next?.why, cmd: summary.next?.command });

/** A row of numbers. A stat with `href` is a link to its page. */
function band(stats, className = '') {
  return `<div class="band ${className}">${stats
    .filter(Boolean)
    .map(({ label, value, note, tone, href, glyph }) => {
      const tag = href ? 'a' : 'div';
      return `<${tag} class="stat${tone ? ` tone-${tone}` : ''}"${href ? ` href="${esc(href)}"` : ''}><span class="stat-label">${esc(
        label,
      )}</span><strong class="stat-value">${glyph && tone ? icon(ICONS[tone]) : ''}${esc(value)}</strong>${
        note ? `<span class="stat-note" title="${esc(note)}">${esc(note)}</span>` : ''
      }</${tag}>`;
    })
    .join('')}</div>`;
}

/** Filter buttons with counts. `key` names the field of `ui` that they set. */
function chips(key, options) {
  return `<div class="chips" role="group">${options
    .map(
      ({ value, label, count }) =>
        `<button type="button" class="chip${ui[key] === value ? ' active' : ''}" aria-pressed="${ui[key] === value}" data-set="${key}" data-value="${esc(
          value,
        )}">${esc(label)}${count === undefined ? '' : ` <span class="count">${count}</span>`}</button>`,
    )
    .join('')}</div>`;
}

const toneIcon = (tone) => `<span class="tone-icon tone-${tone}">${icon(ICONS[tone])}</span>`;

/** A link that opens or closes one row of a list: the hash holds the open row, so a poll keeps it open. */
const rowToggle = (page, id, open, html) =>
  `<a class="row-toggle" href="#/${page}${open ? '' : `/${encodeURIComponent(id)}`}" aria-expanded="${open}">${icon(
    ICONS.chevron,
  )}${html}</a>`;

const group = (label, count, extra = '') =>
  `<h3 class="group-head">${esc(label)} <span class="count">${count}</span>${extra}</h3>`;

// ---------------------------------------------------------------- data

async function get(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}
const maybe = (path) => get(path).catch(() => null);

const PAGES = ['overview', 'benchmarks', 'regressions', 'experiments', 'runs', 'activity'];

function route() {
  const [raw = '', id] = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  // The old singular routes stay valid, so links in issues still open.
  const page = { benchmark: 'benchmarks', comparison: 'comparisons' }[raw] ?? raw;
  if (page === 'benchmarks' && id) return { name: 'benchmark', tab: 'benchmarks', id };
  if (page === 'comparisons' && id) return { name: 'comparison', tab: 'runs', id };
  if (PAGES.includes(page)) return { name: page, tab: page, id };
  return { name: 'overview', tab: 'overview' };
}

async function load(at) {
  const enc = encodeURIComponent;
  const [summary, agents, page] = await Promise.all([
    get('/api/summary'),
    get('/api/agents'),
    (async () => {
      switch (at.name) {
        case 'overview': {
          const [benchmarks, runs] = await Promise.all([get('/api/benchmarks'), get('/api/runs')]);
          return { benchmarks, runs };
        }
        case 'benchmarks':
          return { benchmarks: await get('/api/benchmarks') };
        case 'benchmark':
          return { benchmark: await maybe(`/api/benchmarks/${enc(at.id)}`) };
        case 'regressions':
          return { regressions: await get('/api/regressions') };
        case 'experiments':
          return { experiments: await get('/api/experiments') };
        case 'runs':
          return { runs: await get('/api/runs') };
        case 'comparison':
          return { comparison: await maybe(`/api/comparisons/${enc(at.id)}`) };
        case 'activity': {
          const [sessions, events] = await Promise.all([
            get('/api/sessions'),
            at.id ? maybe(`/api/sessions/${enc(at.id)}/events`) : null,
          ]);
          return { sessions, events };
        }
      }
    })(),
  ]);
  return { summary, ...agents, ...page };
}

async function refresh() {
  const at = route();
  let data;
  try {
    data = await load(at);
    liveEl.classList.remove('offline');
    liveEl.title = 'Live: the dashboard reads .speedpatrol every 3 seconds.';
    liveEl.setAttribute('aria-label', 'Live');
  } catch {
    liveEl.classList.add('offline');
    liveEl.title = 'Offline: the dashboard cannot reach its server. Start it again with npx speedpatrol dashboard.';
    liveEl.setAttribute('aria-label', 'Offline');
    return;
  }
  // Rendering again resets hover and focus: skip it when nothing changed.
  const key = JSON.stringify([at, data]);
  if (key === rendered) return;
  rendered = key;
  current = { at, data };
  render();
}

function render() {
  if (!current) return;
  const { at, data } = current;
  renderHeader(data, at);
  // Keep the focus and the caret of a search box across a render.
  const focused = document.activeElement?.dataset?.query;
  const caret = focused ? document.activeElement.selectionStart : 0;
  charts = new Map();
  view.innerHTML = PAGE_RENDER[at.name](data, at);
  drawCharts();
  if (focused) {
    const input = view.querySelector(`[data-query="${focused}"]`);
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
}

// ---------------------------------------------------------------- header

function renderHeader(data, at) {
  const { summary, agents, patrol } = data;
  projectEl.textContent = summary.name;
  document.title = `${summary.name} · Speedpatrol`;
  const badges = {
    regressions: summary.regressions.open ? { count: summary.regressions.open, tone: 'fail' } : null,
    experiments: summary.experiments.waiting ? { count: summary.experiments.waiting, tone: 'warn' } : null,
  };
  for (const tab of tabsEl.querySelectorAll('a')) {
    const page = tab.dataset.page;
    const active = page === at.tab;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
    const badge = badges[page];
    tab.dataset.label ??= tab.textContent.trim();
    const label = tab.dataset.label;
    tab.innerHTML = `${esc(label)}${badge ? `<span class="tab-badge tone-${badge.tone}">${badge.count}</span>` : ''}`;
    if (badge)
      tab.setAttribute(
        'aria-label',
        `${label}: ${badge.count} ${page === 'regressions' ? 'open' : 'wait to be published'}`,
      );
    else tab.removeAttribute('aria-label');
  }

  const patrolAgent = agents.find((agent) => agent.role === 'patrol');
  const patrolState = patrolAgent?.state ?? 'never';
  const patrolText =
    patrolState === 'never'
      ? 'Patrol: not started. Start it with npx speedpatrol.'
      : `Patrol: ${patrolState}. ${plural(patrol.cycles ?? 0, 'cycle')}${patrol.lastCycleAt ? `, the last ${ago(patrol.lastCycleAt)}` : ''}.${
          patrolAgent?.detail ? ` ${patrolAgent.detail}.` : ''
        }`;
  patrolEl.className = `icon-chip state-${patrolState}`;
  patrolEl.innerHTML = icon(ICONS.patrol);
  patrolEl.title = patrolText;
  patrolEl.setAttribute('aria-label', patrolText);

  const machine = summary.machine;
  machineEl.hidden = !machine;
  if (machine) {
    const text = `Machine ${machine.fingerprint} (${machine.hostname}): ${machine.cpuModel}, ${machine.cpus} CPUs, ${machine.memoryGb} GB, Node ${machine.node}. Timings from other machines are not shown.`;
    machineEl.innerHTML = icon(ICONS.machine);
    machineEl.title = text;
    machineEl.setAttribute('aria-label', text);
  }
}

// ---------------------------------------------------------------- overview

function confidence(summary) {
  const { verdict: status, regressions, experiments, benchmarks, lastRun } = summary;
  const filed = regressions.byStatus.filed;
  const notFiled = regressions.byStatus.open;
  const coverage = benchmarks.defined ?? benchmarks.measured;
  return band(
    [
      { label: 'Status', value: status.text, note: status.detail, tone: status.tone, glyph: true },
      {
        label: 'Open regressions',
        value: regressions.open,
        note: regressions.open
          ? [filed && `${filed} filed`, notFiled && `${notFiled} not filed`].filter(Boolean).join(', ')
          : 'None',
        tone: regressions.open ? 'fail' : undefined,
        href: '#/regressions',
      },
      {
        label: 'To publish',
        value: experiments.waiting,
        note: experiments.waiting
          ? plural(experiments.waiting, 'verified speed-up')
          : experiments.active
            ? `None. ${plural(experiments.active, 'experiment')} in progress`
            : 'None',
        tone: experiments.waiting ? 'warn' : undefined,
        href: '#/experiments',
      },
      {
        label: 'Benchmarks measured',
        value: coverage ? `${benchmarks.measured} of ${coverage}` : '0',
        note: benchmarks.unmeasured.length
          ? `${plural(benchmarks.unmeasured.length, 'benchmark has', 'benchmarks have')} no baseline`
          : coverage
            ? `${benchmarks.critical} critical`
            : 'No benchmarks yet',
        tone: benchmarks.unmeasured.length ? 'warn' : undefined,
        href: '#/benchmarks',
      },
      {
        label: 'Last baseline',
        value: lastRun ? (lastRun.failed ? 'Failed' : ago(lastRun.startedAt)) : '-',
        note: lastRun
          ? `${short(lastRun.sha)} · ${
              lastRun.failed ??
              (lastRun.comparison
                ? `${lastRun.comparison.verdict} against the previous`
                : summary.runs.baselines <= 1
                  ? 'first baseline'
                  : 'not compared')
            }`
          : 'No run yet',
        tone: lastRun?.failed ? 'fail' : undefined,
        href: lastRun?.comparison ? `#/comparisons/${encodeURIComponent(lastRun.comparison.id)}` : '#/runs',
      },
    ],
    'confidence',
  );
}

function attentionPanel(summary) {
  const items = summary.attention;
  if (!items.length) {
    return panel(
      'Needs attention',
      '',
      `<p class="all-clear">${toneIcon('pass')}Nothing needs you now. The newest baseline has no open regression.</p>`,
    );
  }
  const rows = items
    .map(
      (item) => `<li class="attention-row tone-${item.tone}">${toneIcon(item.tone)}<div class="grow">
        <div class="attention-title">${item.href ? `<a href="${esc(item.href)}">${esc(item.title)}</a>` : esc(item.title)}</div>
        <div class="attention-detail">${esc(item.detail)}</div>
        ${item.command ? command(item.command) : ''}
      </div></li>`,
    )
    .join('');
  const fails = items.filter((item) => item.tone === 'fail').length;
  return panel(
    'Needs attention',
    [fails && `${fails} to fix`, items.length - fails && `${items.length - fails} to check`]
      .filter(Boolean)
      .join(' · '),
    `<ul class="attention">${rows}</ul>`,
  );
}

function agentsPanel(agents, onActivity = false) {
  const rows = agents
    .map((agent) => {
      const label = agent.state === 'never' ? 'not started' : agent.state;
      const detail = agent.detail || ROLE_HINT[agent.role] || '';
      return `<li class="agent-row"><span class="state ${esc(agent.state)}">${esc(capital(agent.role))}</span><span class="agent-detail" title="${esc(
        detail,
      )}">${esc(detail)}</span><span class="agent-when">${esc(label)}${agent.updatedAt ? ` · ${ago(agent.updatedAt)}` : ''}</span></li>`;
    })
    .join('');
  return panel(
    'Agents',
    '',
    `<ul class="agent-list">${rows}</ul>`,
    onActivity ? '' : '<a href="#/activity">Activity</a>',
  );
}

function runResult(run) {
  if (run.failed) {
    return `<span class="verdict regression" title="${esc(run.failed)}"><i aria-hidden="true">◆</i>failed</span>`;
  }
  if (run.comparison) {
    return `<a href="#/comparisons/${encodeURIComponent(run.comparison.id)}">${verdict(run.comparison.verdict)}</a>`;
  }
  return `<span class="muted">${run.first ? 'first baseline' : 'not compared'}</span>`;
}

const PURPOSE = { baseline: 'Baseline', compare: 'Compare', experiment: 'A/B', adhoc: 'Ad hoc' };

function recentRunsPanel(runs) {
  if (!runs.length) return '';
  const rows = runs
    .slice(0, 6)
    .map(
      (
        run,
      ) => `<tr><td class="muted nowrap">${ago(run.startedAt)}</td><td class="dim">${PURPOSE[run.purpose] ?? esc(run.purpose)}</td>
        <td class="mono" title="${esc(run.subject ?? '')}">${short(run.sha)}</td>
        <td class="nowrap">${runResult(run)}</td></tr>`,
    )
    .join('');
  return panel(
    'Recent runs',
    '',
    `<table class="compact"><tbody>${rows}</tbody></table>`,
    '<a href="#/runs">All runs</a>',
  );
}

function renderOverview(data) {
  const { summary, agents, benchmarks, runs } = data;
  const main = summary.lastRun
    ? `${attentionPanel(summary)}${
        benchmarks.benchmarks.length
          ? panel(
              'Benchmarks',
              'The primary metric of each, at the newest baseline',
              benchTable(benchmarks.benchmarks),
              '<a href="#/benchmarks">All benchmarks</a>',
            )
          : ''
      }`
    : panel('Get started', '', firstStep(summary, 'Speedpatrol has not measured this project yet'));
  return `${confidence(summary)}<div class="grid"><div class="stack">${main}</div><div class="stack">${recentRunsPanel(
    runs,
  )}${agentsPanel(agents)}</div></div>`;
}

// ---------------------------------------------------------------- benchmarks

const PROBLEM = {
  regression: (row) =>
    `<a class="problem tone-fail" href="#/regressions/${encodeURIComponent(row.regression.id)}"><i aria-hidden="true">◆</i>regressed ${pct(row.regression.deltaPct)} since ${short(row.regression.badSha)}, ${esc(row.regression.status)}</a>`,
  errors: (row) =>
    `<span class="problem tone-warn"><i aria-hidden="true">▲</i>${plural(row.errors, 'error')} in the last run</span>`,
  unmeasured: () => '<span class="problem tone-warn"><i aria-hidden="true">▲</i>no baseline yet</span>',
  stale: () => '<span class="problem tone-warn"><i aria-hidden="true">▲</i>not in the last baseline</span>',
};

function benchRow(row, index) {
  const spark = `spark-${index}`;
  charts.set(spark, { type: 'spark', points: row.series });
  const href = `#/benchmarks/${encodeURIComponent(row.id)}`;
  return `<tr class="clickable" data-href="${href}">
    <td><a class="bench-id" href="${href}">${esc(row.id)}</a>${row.critical ? '<span class="badge critical">critical</span>' : ''}</td>
    <td class="dim">${esc(row.kind)}</td>
    <td class="dim mono">${esc(row.primary || '-')}</td>
    <td class="num">${fmt(row.latest?.median, row.unit)}</td>
    <td class="num">${row.deltaPct === undefined ? '<span class="muted">-</span>' : delta(row.deltaPct, row.verdict)}</td>
    <td>${row.problem ? PROBLEM[row.problem](row) : verdict(row.verdict) || `<span class="muted">${row.series.length === 1 ? 'measured once' : '-'}</span>`}</td>
    <td><div class="chart" data-chart="${spark}" style="width:132px"></div></td>
  </tr>`;
}

/** The benchmarks, in two groups: the ones with a problem first, then the steady ones. */
function benchTable(rows) {
  const problems = rows.filter((row) => row.problem);
  // A benchmark with one baseline has nothing to compare with, so it is not "steady" yet.
  const steady = rows.filter((row) => !row.problem && row.series.length > 1);
  const once = rows.filter((row) => !row.problem && row.series.length <= 1);
  let index = 0;
  const section = (label, list) =>
    list.length
      ? `<tbody><tr class="group-row"><th colspan="7" scope="colgroup">${esc(label)} <span class="count">${list.length}</span></th></tr>${list
          .map((row) => benchRow(row, index++))
          .join('')}</tbody>`
      : '';
  return `<table><thead><tr><th>Benchmark</th><th>Kind</th><th>Primary metric</th><th class="num">Median</th><th class="num" title="The newest baseline against the one before it">Last step</th><th>Status</th><th>History</th></tr></thead>${section(
    'Needs a look',
    problems,
  )}${section(problems.length || once.length ? 'Steady' : 'All steady', steady)}${section('Measured once', once)}</table>`;
}

function renderBenchmarks(data) {
  const { summary, benchmarks } = data;
  const rows = benchmarks.benchmarks;
  const commits = Math.max(0, ...rows.map((row) => row.series.length));
  const head = band([
    {
      label: 'Measured',
      value:
        summary.benchmarks.defined === undefined
          ? summary.benchmarks.measured
          : `${summary.benchmarks.measured} of ${summary.benchmarks.defined}`,
      note: summary.runs.baselines ? 'In the newest baseline' : 'No baseline yet',
    },
    { label: 'Critical', value: summary.benchmarks.critical, note: 'A regression here blocks CI' },
    {
      label: 'Regressed',
      value: summary.benchmarks.regressed,
      note: summary.benchmarks.regressed ? 'with an open regression' : 'None',
      tone: summary.benchmarks.regressed ? 'fail' : undefined,
      href: '#/regressions',
    },
    {
      label: 'No baseline',
      value: summary.benchmarks.unmeasured.length,
      note: summary.benchmarks.unmeasured.join(', ') || 'None',
      tone: summary.benchmarks.unmeasured.length ? 'warn' : undefined,
    },
    {
      label: 'With errors',
      value: summary.benchmarks.withErrors.length,
      note: summary.benchmarks.withErrors.join(', ') || 'None',
      tone: summary.benchmarks.withErrors.length ? 'warn' : undefined,
    },
    {
      label: 'History',
      value: plural(commits, 'commit'),
      note: benchmarks.machine ? `on machine ${benchmarks.machine}` : 'No baseline',
    },
  ]);
  if (!rows.length) return `${head}${panel('Benchmarks', '', firstStep(summary, 'No benchmarks yet'))}`;

  const query = ui.benchQuery.trim().toLowerCase();
  const filters = {
    all: () => true,
    problems: (row) => !!row.problem,
    critical: (row) => row.critical,
  };
  const shown = rows.filter(filters[ui.benchFilter] ?? filters.all).filter((row) => !query || row.id.includes(query));
  const bar = `<div class="filters">${chips('benchFilter', [
    { value: 'all', label: 'All', count: rows.length },
    { value: 'problems', label: 'Needs a look', count: rows.filter(filters.problems).length },
    { value: 'critical', label: 'Critical', count: rows.filter(filters.critical).length },
  ])}<input type="search" class="search" placeholder="Filter by id, such as &quot;api&quot;" aria-label="Filter the benchmarks by id" data-query="benchQuery" value="${esc(
    ui.benchQuery,
  )}"></div>`;
  const body = shown.length
    ? benchTable(shown)
    : emptyState({
        title: 'No benchmark matches the filter',
        why: query ? `No benchmark id contains “${ui.benchQuery}”.` : 'No benchmark is in this group.',
        action: { key: 'benchReset', value: '1', label: 'Show all benchmarks' },
        compact: true,
      });
  return `${head}${panel('Benchmarks', 'Problems first, then the critical paths', `${bar}${body}`, benchmarks.machine ? `machine <span class="mono">${esc(benchmarks.machine)}</span>` : '')}`;
}

// ---------------------------------------------------------------- benchmark detail

function renderBenchmark(data, at) {
  const { benchmark, summary } = data;
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="#/benchmarks">Benchmarks</a> / ${esc(at.id)}</nav>`;
  if (!benchmark) {
    return `${crumbs}${panel(
      esc(at.id),
      '',
      emptyState({
        title: `No baseline measured ${at.id} yet`,
        why: 'The page shows the history of a benchmark from its baselines. A run on a clean commit records one.',
        cmd: `npx speedpatrol run ${at.id}`,
      }),
    )}`;
  }
  const primary = benchmark.metrics.find((metric) => metric.primary) ?? benchmark.metrics[0];
  const others = benchmark.metrics.filter((metric) => metric !== primary);
  const markers = benchmark.regressions.map((item) => ({
    sha: item.badSha,
    label: `regression ${pct(item.deltaPct)}`,
  }));
  charts.set('main', { type: 'line', metric: primary, height: 300, markers });
  const series = primary.series;
  const latest = series.at(-1);
  const previous = series.at(-2);
  const first = series[0];
  const open = benchmark.regressions.filter((item) => item.status === 'open' || item.status === 'filed');

  const callouts = open
    .map(
      (item) => `<div class="callout tone-fail">${toneIcon('fail')}<div class="grow"><strong>${esc(item.title)}</strong>
        <div class="dim">${esc(item.metric)} ${pct(item.deltaPct)} since <span class="mono">${short(item.badSha)}</span>. ${capital(item.status)}${item.issueUrl ? ` as ${link(item.issueUrl, issueLabel(item.issueUrl))}` : ''}.</div></div>
        <a href="#/regressions/${encodeURIComponent(item.id)}">Open the regression</a></div>`,
    )
    .join('');

  const head = band([
    { label: 'Median', value: fmt(latest?.median, primary.unit), note: `${primary.name} at ${short(latest?.sha)}` },
    {
      label: 'Against the previous',
      value: previous ? pct(latest.median / previous.median - 1) : '-',
      note: previous ? `${short(previous.sha)}: ${fmt(previous.median, primary.unit)}` : 'Only one baseline',
    },
    {
      label: `Over ${plural(series.length, 'commit')}`,
      value: series.length > 1 ? pct(latest.median / first.median - 1) : '-',
      note: series.length > 1 ? `from ${fmt(first.median, primary.unit)} at ${short(first.sha)}` : 'Only one baseline',
      tone: open.length ? 'fail' : undefined,
    },
    {
      label: 'Spread',
      value: latest ? `${fmt(latest.min, primary.unit)} to ${fmt(latest.p95, primary.unit)}` : '-',
      note: 'min to p95 of the newest run',
    },
    { label: 'Iterations', value: benchmark.iterations, note: 'Timed samples in each run' },
    {
      label: 'Errors',
      value: benchmark.errors.length,
      note: benchmark.errors[0] ?? 'None in the newest baseline',
      tone: benchmark.errors.length ? 'warn' : undefined,
    },
  ]);

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
        `Self time, from the profile of <span class="mono">${short(benchmark.hotspots.sha)}</span> · ${date(benchmark.hotspots.at)}`,
        `<table><thead><tr><th>Function</th><th>Location</th><th class="num">Self</th><th class="num">Total</th><th class="num">Self %</th><th><span class="sr-only">Share</span></th></tr></thead><tbody>${benchmark.hotspots.hotspots
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
        emptyState({
          title: 'No profile yet',
          why: 'A run records a CPU profile in one extra iteration, when the probe can profile this kind.',
          cmd: `npx speedpatrol run ${benchmark.id}`,
          compact: true,
        }),
      );

  const history = benchmark.regressions.length
    ? panel(
        'Regressions of this benchmark',
        '',
        `<ul class="plain-list">${benchmark.regressions
          .map(
            (item) =>
              `<li><span class="status ${esc(item.status)}">${esc(item.status)}</span> <a href="#/regressions/${encodeURIComponent(item.id)}">${esc(
                item.title,
              )}</a> <span class="muted">${date(item.createdAt)}</span></li>`,
          )
          .join('')}</ul>`,
      )
    : '';
  const experiments = benchmark.experiments.length
    ? panel(
        'Experiments on this benchmark',
        '',
        `<ul class="plain-list">${benchmark.experiments
          .map(
            (item) =>
              `<li><span class="status ${esc(item.status)}">${esc(item.status)}</span> <a href="#/experiments/${encodeURIComponent(item.id)}">${esc(
                item.summary ?? item.hypothesis ?? item.branch,
              )}</a> ${item.deltaPct === undefined ? '' : `<span class="dim">${pct(item.deltaPct)}</span>`}</li>`,
          )
          .join('')}</ul>`,
      )
    : '';

  return `${crumbs}
    <div class="title-row"><h1>${esc(benchmark.id)}</h1>${benchmark.critical ? '<span class="badge critical">critical</span>' : ''}<span class="badge">${esc(
      benchmark.kind,
    )}</span><span class="facts">machine <span class="mono">${esc(summary.machine?.fingerprint ?? '')}</span></span></div>
    ${callouts}${head}
    <div class="stack">
      ${panel(
        `<span class="mono">${esc(primary.name)}</span>`,
        `Primary metric · ${esc(primary.unit)} · ${primary.better} is better`,
        `<div class="panel-body"><div class="chart" data-chart="main"></div></div>`,
        '<span class="key"><span class="line"></span>median</span><span class="key"><span class="band-key"></span>min to p95</span>',
      )}
      ${others.length ? `<div class="multiples">${multiples}</div>` : ''}
      ${hotspots}
      ${history}
      ${experiments}
    </div>`;
}

function bar(value, max) {
  const width = Math.max(2, (value / max) * 120);
  return `<svg width="124" height="8" aria-hidden="true"><rect x="0" y="0" width="${width}" height="8" rx="2" fill="var(--series)"/></svg>`;
}

// ---------------------------------------------------------------- regressions

const REG_GROUPS = [
  { label: 'Open', statuses: ['open', 'filed'] },
  { label: 'Fixed', statuses: ['fixed'] },
  { label: 'Dismissed', statuses: ['dismissed'] },
];

function regressionDetail(item) {
  const next =
    item.status === 'open' && !item.analysis
      ? `<p class="dim">The analyst did not explain this regression yet.</p>${command(`npx speedpatrol analyze ${item.id}`)}`
      : (item.status === 'open' || item.status === 'filed') && !item.issueUrl
        ? `<p class="dim">No issue is open for it yet.</p>${command('npx speedpatrol publish')}`
        : '';
  return `<div class="row-detail">
    <dl class="facts-list">
      <div><dt>Change</dt><dd><span class="delta worse">${pct(item.deltaPct)}</span> on <span class="mono">${esc(item.metric)}</span></dd></div>
      <div><dt>Last good</dt><dd class="mono">${short(item.goodSha)}</dd></div>
      <div><dt>First bad</dt><dd class="mono">${short(item.badSha)}</dd></div>
      <div><dt>Evidence</dt><dd><a href="#/comparisons/${encodeURIComponent(item.comparisonId)}">The comparison</a> · <a href="#/benchmarks/${encodeURIComponent(item.benchmark)}">The history</a></dd></div>
      ${item.issueUrl ? `<div><dt>Issue</dt><dd>${link(item.issueUrl, issueLabel(item.issueUrl))}</dd></div>` : ''}
    </dl>
    ${item.reason ? `<p class="dim">${esc(item.reason)}</p>` : ''}
    ${item.analysis ? `<h4>Analysis</h4><div class="analysis">${markdown(item.analysis)}</div>` : ''}
    ${
      item.suspects?.length
        ? `<h4>Suspect commits</h4><ul class="plain-list">${item.suspects
            .map(
              (suspect) =>
                `<li><span class="mono">${short(suspect.sha)}</span> ${esc(suspect.subject)}<div class="dim">${esc(suspect.reason)}</div></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    ${next}
  </div>`;
}

function renderRegressions(data, at) {
  const { summary, regressions } = data;
  const counts = summary.regressions.byStatus;
  const head = band([
    {
      label: 'Open',
      value: summary.regressions.open,
      note: summary.regressions.open
        ? [counts.filed && `${counts.filed} filed`, counts.open && `${counts.open} not filed`]
            .filter(Boolean)
            .join(', ')
        : 'None',
      tone: summary.regressions.open ? 'fail' : undefined,
    },
    { label: 'Fixed', value: counts.fixed, note: 'Back within the thresholds, or closed on GitHub' },
    { label: 'Dismissed', value: counts.dismissed, note: 'Closed as not planned' },
    {
      label: 'Comparisons',
      value: summary.runs.comparisons,
      note: 'Steps between baselines, and A/B runs',
      href: '#/runs',
    },
  ]);
  if (!regressions.length) {
    const body = summary.runs.baselines
      ? emptyState({
          title: 'No regressions',
          why: summary.runs.comparisons
            ? `Speedpatrol made ${plural(summary.runs.comparisons, 'comparison')} and confirmed no slowdown. The patrol compares each new commit on main.`
            : 'Speedpatrol has one baseline and nothing to compare with yet. Start the patrol: it compares each new commit on main with it.',
          cmd: 'npx speedpatrol',
        })
      : firstStep(summary, 'No regressions yet');
    return `${head}${panel('Regressions', '', body)}`;
  }
  const filter = {
    open: (item) => item.status === 'open' || item.status === 'filed',
    closed: (item) => item.status === 'fixed' || item.status === 'dismissed',
    all: () => true,
  };
  const shown = regressions.filter(filter[ui.regFilter] ?? filter.all);
  const bar = `<div class="filters">${chips('regFilter', [
    { value: 'open', label: 'Open', count: regressions.filter(filter.open).length },
    { value: 'closed', label: 'Closed', count: regressions.filter(filter.closed).length },
    { value: 'all', label: 'All', count: regressions.length },
  ])}</div>`;
  const groups = REG_GROUPS.map(({ label, statuses }) => {
    const items = shown.filter((item) => statuses.includes(item.status));
    if (!items.length) return '';
    const rows = items
      .map((item) => {
        const open = at.id === item.id;
        return `<li class="row${open ? ' open' : ''}">${rowToggle(
          'regressions',
          item.id,
          open,
          `<span class="row-status"><span class="status ${esc(item.status)}">${esc(item.status)}</span></span><span class="row-main"><span class="row-title">${esc(item.title)}</span><span class="row-meta mono">${esc(
            item.benchmark,
          )} · ${esc(item.metric)}</span></span><span class="delta worse num">${pct(item.deltaPct)}</span><span class="muted nowrap">${ago(item.createdAt)}</span>`,
        )}${open ? regressionDetail(item) : ''}</li>`;
      })
      .join('');
    return `${group(label, items.length)}<ul class="rows">${rows}</ul>`;
  }).join('');
  const body = shown.length
    ? groups
    : emptyState({
        title: ui.regFilter === 'open' ? 'No open regressions' : 'No closed regressions',
        why:
          ui.regFilter === 'open'
            ? 'Each regression that Speedpatrol confirmed is fixed or dismissed.'
            : 'No regression is fixed or dismissed yet.',
        action: { key: 'regFilter', value: 'all', label: 'Show all regressions' },
        compact: true,
      });
  return `${head}${panel('Regressions', 'Open regressions first. Open a row to see the analysis.', `${bar}${body}`)}`;
}

// ---------------------------------------------------------------- experiments

const EXP_GROUPS = [
  { key: 'waiting', label: 'Wait to be published', statuses: ['improved'] },
  { key: 'active', label: 'In progress', statuses: ['proposed', 'measuring'] },
  { key: 'published', label: 'Published', statuses: ['published'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected', 'failed'] },
];

function experimentDetail(item) {
  return `<div class="row-detail">
    <dl class="facts-list">
      <div><dt>Branch</dt><dd class="mono">${esc(item.branch)}</dd></div>
      <div><dt>Base</dt><dd class="mono">${short(item.baseSha)}</dd></div>
      ${item.headSha ? `<div><dt>Head</dt><dd class="mono">${short(item.headSha)}</dd></div>` : ''}
      ${item.comparisonId ? `<div><dt>Evidence</dt><dd><a href="#/comparisons/${encodeURIComponent(item.comparisonId)}">The A/B comparison</a></dd></div>` : ''}
      ${item.prUrl ? `<div><dt>Pull request</dt><dd>${link(item.prUrl, issueLabel(item.prUrl))}</dd></div>` : ''}
    </dl>
    ${item.hypothesis ? `<h4>Hypothesis</h4><p>${inline(item.hypothesis)}</p>` : ''}
    ${item.summary ? `<h4>Change</h4><p>${inline(item.summary)}</p>` : ''}
    ${item.reason ? `<h4>Reason</h4><p>${inline(item.reason)}</p>` : ''}
    ${item.collateral?.length ? `<p class="dim">Slower as a side effect: <span class="mono">${item.collateral.map(esc).join(', ')}</span></p>` : ''}
    ${item.status === 'improved' && !item.prUrl ? `<p class="dim">The A/B run confirmed this speed-up. Publish it as a pull request.</p>${command('npx speedpatrol publish')}` : ''}
  </div>`;
}

function renderExperiments(data, at) {
  const { summary, experiments } = data;
  const counts = summary.experiments;
  const head = band([
    {
      label: 'Wait to be published',
      value: counts.waiting,
      note: counts.waiting ? 'Verified speed-ups' : 'None',
      tone: counts.waiting ? 'warn' : undefined,
    },
    { label: 'In progress', value: counts.active, note: 'Proposed or measured now' },
    { label: 'Published', value: counts.published, note: 'Pull requests open' },
    { label: 'Rejected', value: counts.rejected, note: 'No speed-up, or slower elsewhere' },
  ]);
  if (!experiments.length) {
    const body = summary.runs.baselines
      ? emptyState({
          title: 'No experiments yet',
          why: 'The optimizer tries a speed-up in a worktree, and an A/B run checks it.',
          cmd: 'npx speedpatrol optimize',
        })
      : firstStep(summary, 'No experiments yet');
    return `${head}${panel('Experiments', '', body)}`;
  }
  const options = [{ value: 'all', label: 'All', count: experiments.length }];
  for (const { key, label, statuses } of EXP_GROUPS) {
    const count = experiments.filter((item) => statuses.includes(item.status)).length;
    if (count) options.push({ value: key, label, count });
  }
  const groups = EXP_GROUPS.filter(({ key }) => ui.expFilter === 'all' || ui.expFilter === key)
    .map(({ label, statuses }) => {
      const items = experiments.filter((item) => statuses.includes(item.status));
      if (!items.length) return '';
      const rows = items
        .map((item) => {
          const open = at.id === item.id;
          const better = item.status === 'improved' || item.status === 'published';
          return `<li class="row${open ? ' open' : ''}">${rowToggle(
            'experiments',
            item.id,
            open,
            `<span class="row-status"><span class="status ${esc(item.status)}">${esc(item.status)}</span></span><span class="row-main"><span class="row-title">${esc(
              item.summary ?? item.hypothesis ?? item.branch,
            )}</span><span class="row-meta mono">${esc(item.target.benchmark)} · ${esc(item.target.metric)}</span></span><span class="num delta ${better ? 'better' : ''}">${pct(
              item.deltaPct,
            )}</span><span class="muted nowrap">${ago(item.updatedAt)}</span>`,
          )}${open ? experimentDetail(item) : ''}</li>`;
        })
        .join('');
      return `${group(label, items.length)}<ul class="rows">${rows}</ul>`;
    })
    .join('');
  return `${head}${panel(
    'Experiments',
    'Verified speed-ups first. Open a row to see the change.',
    `<div class="filters">${chips('expFilter', options)}</div>${groups || emptyState({ title: 'No experiment in this group', action: { key: 'expFilter', value: 'all', label: 'Show all experiments' }, compact: true })}`,
  )}`;
}

// ---------------------------------------------------------------- runs

function renderRuns(data) {
  const { summary, runs } = data;
  const head = band([
    { label: 'Runs', value: summary.runs.total, note: 'All purposes' },
    {
      label: 'Baselines',
      value: summary.runs.baselines,
      note: summary.machine ? `on machine ${summary.machine.fingerprint}` : 'None yet',
    },
    {
      label: 'Failed',
      value: summary.runs.failed,
      note: summary.runs.failed ? 'The app did not start, or no benchmark ran' : 'None',
      tone: summary.runs.failed ? 'fail' : undefined,
    },
    { label: 'Comparisons', value: summary.runs.comparisons, note: 'Steps between baselines, and A/B runs' },
  ]);
  if (!runs.length) return `${head}${panel('Runs', '', firstStep(summary, 'No runs yet'))}`;
  const filter = {
    all: () => true,
    baseline: (run) => run.purpose === 'baseline',
    other: (run) => run.purpose !== 'baseline',
    failed: (run) => !!run.failed,
  };
  const options = [
    { value: 'all', label: 'All', count: runs.length },
    { value: 'baseline', label: 'Baselines', count: runs.filter(filter.baseline).length },
    { value: 'other', label: 'A/B and compare', count: runs.filter(filter.other).length },
    { value: 'failed', label: 'Failed', count: runs.filter(filter.failed).length },
  ];
  const shown = runs.filter(filter[ui.runFilter] ?? filter.all);
  // Failed runs first, then the last 7 days, then the rest, newest first.
  const failed = shown.filter(filter.failed);
  const week = Date.now() - 7 * 86_400_000;
  const days = new Map();
  for (const run of shown.filter((item) => !item.failed)) {
    const key = Date.parse(run.startedAt) >= week ? 'Last 7 days' : 'Earlier';
    days.set(key, [...(days.get(key) ?? []), run]);
  }
  const row = (run) => `<tr${run.failed ? ' class="failed-row"' : ''}>
      <td class="muted nowrap">${date(run.startedAt)}</td>
      <td class="dim">${PURPOSE[run.purpose] ?? esc(run.purpose)}</td>
      <td class="truncate"><span class="mono">${short(run.sha)}</span> ${esc(run.subject ?? '')}${run.branch ? ` <span class="muted mono">${esc(run.branch)}</span>` : ''}${
        run.failed ? `<div class="fail-text">${esc(run.failed)}</div>` : ''
      }</td>
      <td class="num">${run.failed ? '<span class="muted">-</span>' : run.benchmarks}${run.errors ? ` <span class="problem tone-warn" title="${plural(run.errors, 'benchmark')} with errors">▲ ${run.errors}</span>` : ''}</td>
      <td class="nowrap">${runResult(run)}</td>
    </tr>`;
  const section = (label, list) =>
    `<tbody><tr class="group-row"><th colspan="5" scope="colgroup">${esc(label)} <span class="count">${list.length}</span></th></tr>${list.map(row).join('')}</tbody>`;
  const table = shown.length
    ? `<table><thead><tr><th>Started</th><th>Purpose</th><th>Commit</th><th class="num">Benchmarks</th><th>Result</th></tr></thead>${
        failed.length ? section('Failed', failed) : ''
      }${[...days].map(([label, list]) => section(label, list)).join('')}</table>`
    : emptyState({
        title: 'No run in this group',
        action: { key: 'runFilter', value: 'all', label: 'Show all runs' },
        compact: true,
      });
  return `${head}${panel('Runs', 'Failed runs first. Open a result to see its comparison.', `<div class="filters">${chips('runFilter', options)}</div>${table}`)}`;
}

// ---------------------------------------------------------------- comparison detail

const VERDICT_ORDER = ['regression', 'noisy', 'missing', 'improvement', 'unchanged'];

function renderComparison(data, at) {
  const { comparison } = data;
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="#/runs">Runs</a> / comparison ${esc(at.id)}</nav>`;
  if (!comparison) {
    return `${crumbs}${panel(
      'Comparison',
      '',
      emptyState({
        title: 'No such comparison',
        why: 'The file of this comparison is not in .speedpatrol/runs/comparisons. It was removed, or the link is wrong.',
        cmd: 'npx speedpatrol compare',
      }),
    )}`;
  }
  const counts = {};
  for (const metric of comparison.metrics) counts[metric.verdict] = (counts[metric.verdict] ?? 0) + 1;
  const primaries = (value) => comparison.metrics.filter((metric) => metric.primary && metric.verdict === value).length;
  const stat = (value, label, tone) => ({
    label,
    value: counts[value] ?? 0,
    note: counts[value] ? `${primaries(value)} on a primary metric` : 'None',
    tone: counts[value] ? tone : undefined,
  });
  const head = band([
    {
      label: 'Verdict',
      value: comparison.verdict,
      note: 'The worst verdict of the primary metrics',
      tone: { regression: 'fail', noisy: 'warn', improvement: 'pass' }[comparison.verdict],
    },
    stat('regression', 'Regressions', 'fail'),
    stat('improvement', 'Improvements', 'pass'),
    stat('noisy', 'Noisy', 'warn'),
    stat('unchanged', 'Unchanged'),
    {
      label: 'Mode',
      value: comparison.mode === 'ab' ? 'A/B' : 'Baseline',
      note: comparison.mode === 'ab' ? 'Alternating rounds on one machine' : 'Two baselines',
    },
  ]);
  const warnings = comparison.warnings.length
    ? `<div class="callout tone-warn">${toneIcon('warn')}<div class="grow">${comparison.warnings.map(esc).join('<br>')}</div></div>`
    : '';
  const changed = (metric) => metric.verdict !== 'unchanged';
  const shown = comparison.metrics.filter((metric) => ui.cmpFilter === 'all' || changed(metric));
  const benchmarks = new Map();
  for (const metric of shown) benchmarks.set(metric.benchmark, [...(benchmarks.get(metric.benchmark) ?? []), metric]);
  const rank = (metric) => VERDICT_ORDER.indexOf(metric.verdict);
  const groups = [...benchmarks]
    .map(([id, metrics]) => ({
      id,
      metrics: metrics.sort((a, b) => Number(b.primary) - Number(a.primary) || rank(a) - rank(b)),
    }))
    .sort((a, b) => Math.min(...a.metrics.map(rank)) - Math.min(...b.metrics.map(rank)) || a.id.localeCompare(b.id));
  const rows = groups
    .map(({ id, metrics }) => {
      const worst = [...metrics].sort((a, b) => rank(a) - rank(b))[0];
      const critical = metrics.some((metric) => metric.critical);
      return `<tbody><tr class="group-row"><th colspan="7" scope="colgroup"><a class="bench-id" href="#/benchmarks/${encodeURIComponent(id)}">${esc(id)}</a>${
        critical ? '<span class="badge critical">critical</span>' : ''
      } <span class="count">${plural(metrics.length, 'metric')}</span> ${verdict(worst.verdict)}</th></tr>${metrics
        .map(
          (metric) => `<tr>
        <td class="mono ${metric.primary ? '' : 'dim'}">${esc(metric.metric)}${metric.primary ? ' <span class="badge">primary</span>' : ''}</td>
        <td>${verdict(metric.verdict)}</td>
        <td class="num">${fmt(metric.base?.median, metric.unit)}</td>
        <td class="num">${fmt(metric.head?.median, metric.unit)}</td>
        <td class="num">${delta(metric.deltaPct, metric.verdict)}</td>
        <td class="num dim">${pct(metric.ci[0])} to ${pct(metric.ci[1])}</td>
        <td class="num dim">${metric.pValue < 0.001 ? '&lt;0.001' : metric.pValue.toFixed(3)}</td>
      </tr>`,
        )
        .join('')}</tbody>`;
    })
    .join('');
  const unchanged = counts.unchanged ?? 0;
  const table = groups.length
    ? `<table><thead><tr><th>Metric</th><th>Verdict</th><th class="num">Base</th><th class="num">Head</th><th class="num">Change</th><th class="num">95% CI</th><th class="num">p</th></tr></thead>${rows}</table>`
    : emptyState({
        title: 'Each metric is unchanged',
        why: `The ${plural(unchanged, 'metric')} of this comparison are within the thresholds.`,
        action: { key: 'cmpFilter', value: 'all', label: 'Show all metrics' },
        compact: true,
      });
  return `${crumbs}
    <div class="title-row"><h1>${esc(comparison.head.label)} <span class="muted">vs</span> ${esc(comparison.base.label)}</h1>${verdict(comparison.verdict)}
      <span class="facts"><span>head <span class="mono">${short(comparison.head.sha)}</span></span><span>base <span class="mono">${short(comparison.base.sha)}</span></span><span>${date(comparison.createdAt)}</span></span></div>
    ${head}${warnings}
    ${panel(
      'Metrics',
      'Medians, change of head against base, bootstrap 95% CI, Mann-Whitney p',
      `<div class="filters">${chips('cmpFilter', [
        { value: 'changed', label: 'Changed', count: comparison.metrics.filter(changed).length },
        { value: 'all', label: 'All metrics', count: comparison.metrics.length },
      ])}</div>${table}`,
    )}`;
}

// ---------------------------------------------------------------- activity

const SESSION_GROUPS = [
  { label: 'Running sessions', states: ['running'] },
  { label: 'Stopped or failed', states: ['stopped', 'failed'] },
  { label: 'Done', states: ['done', 'empty'] },
];

function timeline(events) {
  if (!events) return '<p class="muted">The events of this session do not load.</p>';
  return `<ol class="timeline">${events
    .map(
      (event) =>
        `<li><span class="dot ${esc(event.kind)}" aria-hidden="true"></span><span class="t-time mono">${clock(event.at)}</span><div><div>${esc(
          event.summary,
        )}</div><div class="muted">${esc(event.kind)}${event.tool ? ` · <span class="mono">${esc(event.tool)}</span>` : ''}${
          event.durationMs ? ` · ${duration(event.durationMs)}` : ''
        }${event.costUsd ? ` · ${money(event.costUsd)}` : ''}</div></div></li>`,
    )
    .join('')}</ol>`;
}

function renderActivity(data, at) {
  const { sessions, events, agents } = data;
  const count = (...states) => sessions.filter((session) => states.includes(session.state)).length;
  const cost = sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0);
  const head = band([
    {
      label: 'Sessions',
      value: sessions.length,
      note: sessions[0] ? `Last event ${ago(sessions[0].lastAt)}` : 'None yet',
    },
    { label: 'Running sessions', value: count('running'), note: count('running') ? 'Their agent works now' : 'None' },
    {
      label: 'Stopped or failed',
      value: count('stopped', 'failed'),
      note: count('stopped', 'failed') ? 'No finish event' : 'None',
      tone: count('stopped', 'failed') ? 'warn' : undefined,
    },
    {
      label: 'Tool calls',
      value: sessions.reduce((sum, session) => sum + session.toolCalls, 0),
      note: 'In all sessions',
    },
    { label: 'Model cost', value: money(cost), note: cost ? 'As the runtime reported it' : 'No cost reported' },
  ]);
  const agentPanel = agentsPanel(agents, true);
  if (!sessions.length) {
    return `${head}<div class="grid"><div class="stack">${panel(
      'Sessions',
      '',
      emptyState({
        title: 'No agent sessions yet',
        why: 'An agent writes a session when it works: the scout first, when it writes the benchmarks.',
        cmd: 'npx speedpatrol scout',
      }),
    )}</div><div class="stack">${agentPanel}</div></div>`;
  }
  const groups = SESSION_GROUPS.map(({ label, states }) => {
    const items = sessions.filter((session) => states.includes(session.state));
    if (!items.length) return '';
    const rows = items
      .map((session) => {
        const open = at.id === session.id;
        return `<li class="row${open ? ' open' : ''}">${rowToggle(
          'activity',
          session.id,
          open,
          `<span class="row-status"><span class="state ${esc(session.state)}">${esc(capital(session.role ?? 'agent'))}</span></span><span class="row-main"><span class="row-title">${esc(
            session.goal ?? session.last ?? session.id,
          )}</span><span class="row-meta">${esc(session.last ?? '')}</span></span><span class="row-stats muted">${plural(session.toolCalls, 'tool call')} · ${duration(
            session.durationMs,
          )}${session.costUsd ? ` · ${money(session.costUsd)}` : ''}</span><span class="muted nowrap">${ago(session.lastAt)}</span>`,
        )}${open ? `<div class="row-detail">${timeline(events)}</div>` : ''}</li>`;
      })
      .join('');
    return `${group(label, items.length)}<ul class="rows">${rows}</ul>`;
  }).join('');
  return `${head}<div class="grid"><div class="stack">${panel('Sessions', 'Open a session to see its timeline.', groups)}</div><div class="stack">${agentPanel}</div></div>`;
}

const PAGE_RENDER = {
  overview: renderOverview,
  benchmarks: renderBenchmarks,
  benchmark: renderBenchmark,
  regressions: renderRegressions,
  experiments: renderExperiments,
  runs: renderRuns,
  comparison: renderComparison,
  activity: renderActivity,
};

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
  const m = { top: compact ? 10 : 18, right: compact ? 32 : 72, bottom: 24, left: compact ? 40 : 52 };
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
          `<text class="tick sha" x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(short(p.sha))}</text>`
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
        compact
          ? ''
          : // Near the right edge, the label goes to the left of the line so it is not cut.
            `<text class="marker-label" x="${x(index) > m.left + plotW * 0.75 ? x(index) - 6 : x(index) + 6}" y="${m.top + 10}" text-anchor="${x(index) > m.left + plotW * 0.75 ? 'end' : 'start'}">${esc(marker.label)}</text>`
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

document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1500);
    return;
  }
  const setter = event.target.closest('[data-set]');
  if (setter) {
    if (setter.dataset.set === 'benchReset') Object.assign(ui, { benchFilter: 'all', benchQuery: '' });
    else ui[setter.dataset.set] = setter.dataset.value;
    render();
    return;
  }
  // A row is a pointer shortcut to the link in its first cell, which the keyboard reaches.
  if (event.target.closest('a, button, input')) return;
  const row = event.target.closest('[data-href]');
  if (row && !window.getSelection()?.toString()) location.hash = row.dataset.href;
});

view.addEventListener('input', (event) => {
  const key = event.target.dataset?.query;
  if (!key) return;
  ui[key] = event.target.value;
  render();
});

let lastPage = route().tab;
window.addEventListener('hashchange', () => {
  const at = route();
  // Opening a row keeps the scroll position. A new page starts at the top.
  if (at.tab !== lastPage || !['regressions', 'experiments', 'activity'].includes(at.name)) window.scrollTo(0, 0);
  lastPage = at.tab;
  rendered = '';
  refresh();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 120);
});

applyTheme();
refresh();
setInterval(refresh, POLL_MS);
