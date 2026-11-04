# Mobile navigation measurement, 2026-11-04

## Finding

The measured mobile workload can resolve changes above a 5% publication floor. The box configuration required 10%, because `thresholds.relative: 0.10` and `agents.optimizer.minImprovement: 0.05` both apply. Statistical significance remains a separate requirement.

The nightly experiment that prompted this investigation was **desktop** navigation: experiment `20261104T102239-4c49`, comparison `20261104T103957-e47f`. Its reported -7.4% change had p = 0.42484 and a 95% interval of [-23.31%, +13.99%]. It failed significance as well as the configured 10% floor; it is not evidence of mobile variance.

## Protocol

One unchanged app commit (`7644165ebfaa89db0e0e9bceee7c142c1a22b569`) and one prepared Expo web **dev** export throughout. Six consecutive passes of the original harness (`cf014a4`), then six of this patch, with ten recorded iterations and three discarded warmups per pass. No profiling, builds, tests or optimizer work ran alongside the measurements. Other users' processes on the shared VM were left running.

Chromium from Playwright 1.64.1; Node 24.14.1; Linux, eight visible CPUs, AMD EPYC 9554P. Viewport 393 × 852. Each iteration creates a fresh browser context, signs the same disposable test user in, and opens the root page outside the clock. The clock covers two full document navigations: Inbox to its visible root and Home to its visible room feed. The app still reads its remote dev backend. This is a web deep-link workload, not native navigation or a loaded-content guarantee: the readiness markers also exist for pending or empty screens.

[Sanitized samples and diagnostic observations](2026-11-04-mobile-navigation.json) retain the run ids and raw flow values. No credentials, account identifiers or profile traces are included. The before/after phases are consecutive rather than randomized, so their overall median difference must not be treated as an app improvement.

| Unchanged-code flow metric | Original wait | Fixed polling |
| --- | ---: | ---: |
| Recorded samples | 60 | 60 |
| Pooled median | 1746.9 ms | 1741.9 ms |
| Sample standard deviation | 74.1 ms | 75.8 ms |
| Sample coefficient of variation | 4.20% | 4.36% |
| Six pass medians, range | 1734.8–1768.9 ms | 1697.2–1773.2 ms |
| Standard deviation of pass medians | 12.1 ms | 27.2 ms |
| Coefficient of variation of pass medians | 0.69% | 1.56% |
| Failed samples | 0 | 0 |

These CVs include every recorded sample, before the comparator's MAD trimming. The polling fix did **not** reduce overall sample variation in this calibration: it removed an avoidable observation delay. Pass drift remains material near the 5% boundary. More iterations within a single pass cannot remove that drift, which is why final verification retains alternating rounds.

## Source of variance and harness change

The original timed readiness wait used `locator.waitFor({ state: 'visible' })`. In the installed Playwright version its retry pauses grow through 20, 50, 100, 100 and 500 ms. A render between checks can therefore be reported hundreds of milliseconds late. A real-browser reproduction revealed a hidden screen after 350 ms and measured **453 ms** of additional detection delay against the original code. The retained regression test compares with the actual render timestamp, rather than assuming a timer fires on schedule, and also checks that missing readiness still raises a timeout.

Timed readiness now calls the public [`locator.isVisible()` API](https://playwright.dev/docs/api/class-locator#locator-is-visible) with a fixed 5 ms pause between checks. This preserves Playwright selector engines, first-match and visibility semantics. The browser round trip and scheduling also take time; 5 ms is a polling pause, not a promised detection deadline. The same helper covers web/Electron steps and Electron launch/reload readiness.

A separate instrumented replay of six flows per harness, after two warmups, observed the first visible animation frame and the subsequent measurement read-back:

| Route | Original observation lag, median (range) | Fixed polling, median (range) |
| --- | ---: | ---: |
| Inbox | 80.7 ms (14.8–182.7) | 14.1 ms (10.4–25.5) |
| Home | 25.3 ms (13.9–99.1) | 13.2 ms (6.4–90.6) |

This diagnostic includes the final browser evaluation and frame scheduling; it is an observation lag, not a pure estimate of Playwright sleep time. The controlled regression test isolates the backoff defect. Residual variation also comes from reloading and executing the dev bundle and real backend calls: document-content-loaded times ranged from 307–455 ms across these flows, and completed backend requests ranged from about 59–179 ms. No response stubbing or removal of application work was needed.

## Sampling and publication policy

Keep independent final A/B verification, alternating A B / B A, and the current statistical requirements: Mann–Whitney p < 0.01, seeded 95% median-change interval excluding zero, plus both practical thresholds. For a 5% policy on this workload:

```yaml
defaults:
  iterations: 10
  warmup: 3
  rounds: 2                 # 20 recorded samples per side
thresholds:
  relative: 0.05
  absolute: 5               # ms for the primary flow metric
  alpha: 0.01
  maxCv: 0.15
agents:
  optimizer:
    minImprovement: 0.05
```

The optimizer now reports the effective percentage floor, `max(minImprovement, relative)`, in a rejection. This clarifies the existing eligibility rule; it does not weaken significance or collateral regression checks.

The sensitivity replay pools two entire measured passes per side, using every disjoint choice of two base and two head passes from six: **90 overlapping directional comparisons** at 20 samples per side. Scaling the head values simulates a known effect. These are descriptive sensitivity checks on this small calibration set, not independent trials, a false-positive-rate estimate, or measured app speed-ups.

| Simulated head reduction | 5% floor, original | 5% floor, fixed polling | 10% floor, fixed polling |
| --- | ---: | ---: | ---: |
| 0% (unchanged-code A/A) | 0/90 | 0/90 | 0/90 |
| 5% | 45/90 | 45/90 | 0/90 |
| 7.4% | 90/90 | 80/90 | 10/90 |
| 10% | 90/90 | 90/90 | 45/90 |

Entries count `improvement` verdicts; the unchanged-code checks also produced zero regressions. With fixed polling, the same-code estimated changes ranged from -3.44% to +3.56%, below the 5% floor. A simulated 7.4% effect passed 80 of the 90 overlapping splits at a 5% floor. That supports the existing 20-sample-per-side budget for gains comfortably above 5%; it does not promise reliable acceptance of marginal gains. A 10% floor rejected 80 of those same 90 splits because their point estimates were below 10%.

At an effect exactly equal to a point-estimate floor, sampling puts estimates on either side of that floor. More samples narrow uncertainty but cannot guarantee publication exactly at the boundary. Do not rerun an unchanged candidate until it happens to pass. Choose the sampling budget before final verification; increase it in a new calibration if future pass drift grows. These results do not justify raising the 5% floor or relaxing alpha.

## Rollout and reproduction

Re-record web/Electron baselines after this harness change. Comparing an old harness baseline with a new harness run mixes measurement overhead with application performance. Choose `relative: 0.05` in the box configuration if the intended policy is 5%; leaving it at 0.10 retains a 10% effective floor. This PR does not deploy or change that box configuration.

To repeat the live calibration, prepare one checkout once, call the exported `measure` runner six times with `only: ['mobile.navigate']` and `profile: false`, and keep the application build and test identity fixed. Use the configured iteration/warmup counts: passing an `iterations` override deliberately reduces warmups in the runner. Repeat with each harness version, serially. Save every run, including outliers and failures.

To replay the recorded variance and sensitivity from the repository root after `pnpm build`:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { compareSamples, summarize } from './packages/stats/dist/index.js';
import { thresholdsSchema } from './packages/core/dist/index.js';
const data = JSON.parse(await readFile('docs/measurements/2026-11-04-mobile-navigation.json', 'utf8'));
const pairs = xs => xs.flatMap((a, i) => xs.slice(i + 1).map(b => [a, b]));
for (const group of ['before', 'after']) {
  const passes = data[group].map(p => p.flowMs);
  console.log(group, { samples: summarize(passes.flat()), passMedians: summarize(passes.map(p => summarize(p).median)) });
  const indices = passes.map((_, i) => i);
  for (const relative of [0.05, 0.10]) for (const effect of [0, 0.05, 0.074, 0.10]) {
    const verdicts = [];
    for (const [a, b] of pairs(indices)) for (const [c, d] of pairs(indices.filter(i => i !== a && i !== b))) {
      verdicts.push(compareSamples(
        [...passes[a], ...passes[b]],
        [...passes[c], ...passes[d]].map(v => v * (1 - effect)),
        'lower', thresholdsSchema.parse({ relative, absolute: 5 }),
      ).verdict);
    }
    console.log({ group, relative, effect, comparisons: verdicts.length,
      improvements: verdicts.filter(v => v === 'improvement').length,
      regressions: verdicts.filter(v => v === 'regression').length });
  }
}
JS
```
