import { writeFile } from 'node:fs/promises';
import { type Benchmark, type FlowStep, interpolate, type MetricSpec, type ProfileArtifact } from '@speedpatrol/core';
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from 'playwright';
import { type Background, startBackground, waitUntil } from '../exec.js';
import { type CpuProfile, hotspots } from '../profile.js';
import { resolveCwd, resolveEnv } from './command.js';
import type { Probe, ProbeContext, ProbeFactory } from './types.js';

/** Collects what navigation timing does not have: LCP, layout shifts and long tasks. */
const OBSERVERS = `(() => {
  const sp = (window.__speedpatrol = { lcp: 0, cls: 0, longTasks: [] });
  const watch = (type, fn) => { try { new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  watch('largest-contentful-paint', (e) => { sp.lcp = e.renderTime || e.loadTime || e.startTime; });
  watch('layout-shift', (e) => { if (!e.hadRecentInput) sp.cls += e.value; });
  watch('longtask', (e) => { sp.longTasks.push([e.startTime, e.duration]); });
})();`;

/** Reads the page's own timings. Runs in the page. */
const READ_METRICS = `(async () => {
  await new Promise((done) => setTimeout(done, 50));
  const sp = window.__speedpatrol || { lcp: 0, cls: 0, longTasks: [] };
  if (!sp.lcp) {
    // Not observed from the start (Electron): the buffered entries are still there.
    await new Promise((done) => {
      try {
        new PerformanceObserver((list) => { const e = list.getEntries().at(-1); if (e) sp.lcp = e.renderTime || e.loadTime || e.startTime; done(); })
          .observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { done(); }
      setTimeout(done, 100);
    });
  }
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
  const resources = performance.getEntriesByType('resource');
  const tbt = sp.longTasks.filter(([start]) => fcp === undefined || start >= fcp).reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0);
  const out = {
    requests: resources.length + 1,
    transfer_kb: ((nav?.transferSize || 0) + resources.reduce((sum, r) => sum + (r.transferSize || 0), 0)) / 1024,
    cls: sp.cls,
    tbt_ms: tbt,
  };
  if (nav) {
    out.ttfb_ms = nav.responseStart;
    out.dcl_ms = nav.domContentLoadedEventEnd;
    out.load_ms = nav.loadEventEnd;
  }
  if (fcp !== undefined) out.fcp_ms = fcp;
  if (sp.lcp) out.lcp_ms = sp.lcp;
  if (performance.memory) out.js_heap_mb = performance.memory.usedJSHeapSize / 1024 / 1024;
  return out;
})()`;

const NETWORK: Record<string, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  // The presets of Chrome DevTools and Lighthouse, in bytes per second.
  '4g': { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  'fast-3g': { latency: 562.5, downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 },
  'slow-3g': { latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
};

const PAGE_METRICS: Record<string, MetricSpec> = {
  ttfb_ms: { unit: 'ms', better: 'lower' },
  fcp_ms: { unit: 'ms', better: 'lower' },
  lcp_ms: { unit: 'ms', better: 'lower' },
  dcl_ms: { unit: 'ms', better: 'lower' },
  load_ms: { unit: 'ms', better: 'lower' },
  tbt_ms: { unit: 'ms', better: 'lower' },
  cls: { unit: 'score', better: 'lower' },
  requests: { unit: 'count', better: 'lower' },
  transfer_kb: { unit: 'kb', better: 'lower' },
  js_heap_mb: { unit: 'mb', better: 'lower' },
};

function stepMetrics(steps: FlowStep[]): Record<string, MetricSpec> {
  if (steps.length === 0) return {};
  return {
    ...Object.fromEntries(steps.map((step) => [`step.${step.name}_ms`, { unit: 'ms', better: 'lower' } as MetricSpec])),
    flow_ms: { unit: 'ms', better: 'lower' },
  };
}

/**
 * One flow step, timed from the action until its wait condition holds.
 *
 * The target is found and checked visible before the clock starts, and the
 * click and fill skip Playwright's actionability wait (`force`). That wait
 * checks the element is stable over animation frames, and a hidden or
 * occluded window (an e2e harness's quiet window, Xvfb) gets few frames: in
 * nebula-desktop it added 1-2 s to a 40 ms screen switch, so the step timed
 * the tool instead of the app.
 */
async function runStep(page: Page, step: FlowStep, context: ProbeContext): Promise<number> {
  const timeout = context.timeoutMs;
  const clickTarget = step.click ? page.locator(step.click).first() : undefined;
  const fillTarget = step.fill ? page.locator(step.fill.selector).first() : undefined;
  await clickTarget?.waitFor({ state: 'visible', timeout });
  await fillTarget?.waitFor({ state: 'visible', timeout });
  const started = performance.now();
  if (step.goto) await page.goto(interpolate(step.goto, context.vars), { waitUntil: 'load', timeout });
  if (clickTarget) await clickTarget.click({ force: true, timeout });
  if (fillTarget && step.fill)
    await fillTarget.fill(interpolate(step.fill.value, context.vars), { force: true, timeout });
  if (step.press) await page.keyboard.press(step.press);
  if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout });
  if (step.waitForNetworkIdle) await page.waitForLoadState('networkidle', { timeout });
  return performance.now() - started;
}

async function runSteps(page: Page, steps: FlowStep[], context: ProbeContext): Promise<Record<string, number>> {
  if (steps.length === 0) return {};
  const out: Record<string, number> = {};
  let flow = 0;
  for (const step of steps) {
    const ms = await runStep(page, step, context);
    out[`step.${step.name}_ms`] = ms;
    flow += ms;
  }
  out.flow_ms = flow;
  return out;
}

async function startProfiler(cdp: CDPSession) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
}

async function stopProfiler(cdp: CDPSession, file: string): Promise<ProfileArtifact> {
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
  const path = `${file}.cpuprofile`;
  await writeFile(path, JSON.stringify(profile));
  return { path, kind: 'cpuprofile', hotspots: hotspots(profile) };
}

function clean(metrics: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

/**
 * A web page load and the screen navigation after it, in Chromium. Each
 * iteration gets a fresh browser context, so each load is cold (no cache,
 * no service worker), unless `warm` is set.
 */
export const webProbe: ProbeFactory<'web'> = (benchmark, context) => {
  let browser: Browser | undefined;
  let warmContext: BrowserContext | undefined;
  const url = interpolate(benchmark.url, context.vars);

  const iteration = async (file?: string) => {
    const browserContext =
      warmContext ?? (await browser!.newContext({ viewport: benchmark.viewport, ignoreHTTPSErrors: true }));
    if (benchmark.warm) warmContext = browserContext;
    try {
      const page = await browserContext.newPage();
      for (const step of benchmark.setup) await runStep(page, step, context);
      await page.addInitScript(OBSERVERS);
      const cdp = await browserContext.newCDPSession(page);
      if (benchmark.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: benchmark.cpuThrottle });
      const network = NETWORK[benchmark.network];
      if (network) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, ...network });
      }
      if (file) await startProfiler(cdp);
      await page.goto(url, { waitUntil: 'load', timeout: context.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      const metrics = clean((await page.evaluate(READ_METRICS)) as Record<string, unknown>);
      const steps = await runSteps(page, benchmark.steps, context);
      const artifact = file ? await stopProfiler(cdp, file) : undefined;
      await page.close();
      return { metrics: { ...metrics, ...steps }, artifact };
    } finally {
      if (!benchmark.warm) await browserContext.close();
    }
  };

  return {
    primary: benchmark.steps.length ? 'flow_ms' : 'lcp_ms',
    metrics: { ...PAGE_METRICS, ...stepMetrics(benchmark.steps) },
    async open() {
      browser = await chromium.launch({ headless: true });
    },
    async sample() {
      return (await iteration()).metrics;
    },
    async profile(file) {
      if (benchmark.profile.mode === 'off') return undefined;
      return (await iteration(file)).artifact;
    },
    async close() {
      await warmContext?.close();
      await browser?.close();
    },
  };
};

async function hasPageTarget(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    const targets = (await response.json()) as { type: string }[];
    return targets.some((target) => target.type === 'page');
  } catch {
    return false;
  }
}

/**
 * Electron app open: from the launch to the first window (`window_ms`) and
 * to the first screen being ready (`ready_ms`), then the flow steps. The app
 * must open CDP on `cdpPort`, e.g. with `--remote-debugging-port`. Without
 * `run`, the probe attaches to the running app instead (see `attachProbe`).
 */
export const electronProbe: ProbeFactory<'electron'> = (benchmark, context) => {
  const port = Number(interpolate(String(benchmark.cdpPort), context.vars));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`cdpPort is not a port: ${benchmark.cdpPort}`);
  if (!benchmark.run) return attachProbe(benchmark, port, context);
  const cwd = resolveCwd(benchmark.cwd, context);
  const env = resolveEnv(benchmark.env, context);
  const command = interpolate(benchmark.run, context.vars);

  const iteration = async (file?: string) => {
    const started = performance.now();
    const app: Background = startBackground(command, cwd, env);
    let browser: Browser | undefined;
    try {
      await waitUntil(
        async () => {
          if (app.child.exitCode !== null) throw new Error(`The app exited with code ${app.child.exitCode}`);
          return hasPageTarget(port);
        },
        context.timeoutMs,
        'the first Electron window',
        10,
      );
      const windowMs = performance.now() - started;
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = await findPage(browser, undefined, context.timeoutMs);
      const cdp = await page.context().newCDPSession(page);
      if (file) await startProfiler(cdp);
      if (benchmark.readySelector) {
        await page.locator(benchmark.readySelector).first().waitFor({ state: 'visible', timeout: context.timeoutMs });
      } else {
        await page.waitForLoadState('load', { timeout: context.timeoutMs });
      }
      const readyMs = performance.now() - started;
      const metrics = clean((await page.evaluate(READ_METRICS)) as Record<string, unknown>);
      const steps = await runSteps(page, benchmark.steps, context);
      const artifact = file ? await stopProfiler(cdp, file) : undefined;
      return { metrics: { window_ms: windowMs, ready_ms: readyMs, ...metrics, ...steps }, artifact };
    } finally {
      await browser?.close().catch(() => undefined);
      await app.stop();
    }
  };

  return {
    primary: 'ready_ms',
    metrics: {
      window_ms: { unit: 'ms', better: 'lower' },
      ready_ms: { unit: 'ms', better: 'lower' },
      ...PAGE_METRICS,
      ...stepMetrics(benchmark.steps),
    },
    async sample() {
      return (await iteration()).metrics;
    },
    async profile(file) {
      if (benchmark.profile.mode === 'off') return undefined;
      return (await iteration(file)).artifact;
    },
  };
};

async function findPage(browser: Browser, match: string | undefined, timeoutMs: number): Promise<Page> {
  let page: Page | undefined;
  await waitUntil(
    () => {
      page = browser
        .contexts()
        .flatMap((item) => item.pages())
        .find((candidate) => !match || candidate.url().includes(match));
      return page !== undefined;
    },
    timeoutMs,
    match ? `a window whose URL contains "${match}"` : 'the first page',
  );
  return page!;
}

/**
 * Screen navigation in an Electron app that is already running: the app is
 * never launched or stopped, so the person (or an e2e harness) keeps it.
 * The steps must end where they started, so every iteration measures the
 * same moves. With `reload`, each iteration first reloads the window and
 * times it to `readySelector`: the renderer's boot, without the process start.
 */
function attachProbe(benchmark: Extract<Benchmark, { kind: 'electron' }>, port: number, context: ProbeContext): Probe {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const iteration = async (file?: string) => {
    const cdp = await page!.context().newCDPSession(page!);
    try {
      if (file) await startProfiler(cdp);
      const metrics: Record<string, number> = {};
      if (benchmark.reload) {
        const started = performance.now();
        await page!.reload({ waitUntil: 'load', timeout: context.timeoutMs });
        if (benchmark.readySelector) {
          await page!
            .locator(benchmark.readySelector)
            .first()
            .waitFor({ state: 'visible', timeout: context.timeoutMs });
        }
        metrics.ready_ms = performance.now() - started;
        Object.assign(metrics, clean((await page!.evaluate(READ_METRICS)) as Record<string, unknown>));
      }
      Object.assign(metrics, await runSteps(page!, benchmark.steps, context));
      const artifact = file ? await stopProfiler(cdp, file) : undefined;
      return { metrics, artifact };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  };
  return {
    primary: benchmark.steps.length ? 'flow_ms' : 'ready_ms',
    metrics: {
      ...(benchmark.reload ? { ready_ms: { unit: 'ms', better: 'lower' } as MetricSpec, ...PAGE_METRICS } : {}),
      ...stepMetrics(benchmark.steps),
    },
    async open() {
      if (!benchmark.reload && benchmark.steps.length === 0) {
        throw new Error('An attached electron benchmark needs steps, or reload: true');
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = await findPage(browser, benchmark.page, context.timeoutMs);
      if (benchmark.readySelector) {
        await page.locator(benchmark.readySelector).first().waitFor({ state: 'visible', timeout: context.timeoutMs });
      }
    },
    async sample() {
      return (await iteration()).metrics;
    },
    async profile(file) {
      if (benchmark.profile.mode === 'off') return undefined;
      return (await iteration(file)).artifact;
    },
    async close() {
      // Over CDP, close() only disconnects: the app keeps running.
      await browser?.close().catch(() => undefined);
    },
  };
}
