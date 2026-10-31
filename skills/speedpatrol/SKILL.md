---
name: speedpatrol
description: Set up and run Speedpatrol, a team of AI agents that measures an app's critical paths (API endpoints, app open, page loads, screen navigation, builds) on every commit, keeps a baseline dataset, catches and explains performance regressions, and proposes verified speed-ups. Use this skill when the user wants to add Speedpatrol to a repo, write or fix .speedpatrol/speedpatrol.yml, add benchmarks, compare a branch or worktree against main for performance, run the patrol, or read Speedpatrol's results.
---

# Speedpatrol

Speedpatrol measures the critical paths of an app and tells you, with statistics, what got slower or faster. The CLI is the npm package `speedpatrol`. Run it with `npx speedpatrol@latest <command>`; if the repo lists `speedpatrol` in `package.json`, use `npx speedpatrol <command>`.

Source and full docs: https://github.com/agent-labs-dev/speedpatrol

## 1. What it does

- The **scout** (an agent) finds critical paths and writes benchmarks to `.speedpatrol/benchmarks.json`, each one tried before it is saved.
- The **runner** (code) brings the app up with `app.setup`, measures every benchmark, and records a **baseline** per commit and machine.
- **Statistics** decide every verdict (Mann-Whitney U + bootstrap interval + thresholds). A suspected regression on main is re-measured A/B before it is recorded.
- The **analyst** explains a confirmed regression. The **optimizer** (off by default) tries a speed-up in a worktree, kept only when an A/B run proves it.
- `speedpatrol compare` A/B-measures two checkouts: a branch, a worktree, or the working tree against `origin/main`.

All files live in `.speedpatrol/`: `speedpatrol.yml`, `instructions.md` and `benchmarks.json` are committed; `runs/` is local data (git-ignored).

## 2. Set it up

Ask the user only for what you cannot find in the repo.

### 2.1 Two facts you must have

1. **How to start the app on this machine** (and how to install and build it).
2. **How to reach the critical paths**: the base URL, a test account or token if endpoints need auth, the CDP port for Electron, the bundle id or activity for mobile.

Read `package.json` scripts, the README, `docker-compose.yml`, `.env.example`, the router or route files, and existing E2E tests. Then prove the start command works yourself:

- Server or web app: start it, then `curl -sf <url> >/dev/null && echo up`, then stop it.
- Electron: start it with `--remote-debugging-port=<port>`, then `curl -sf http://127.0.0.1:<port>/json/version`.
- Android: `adb shell pm list packages | grep <package>`. iOS: `xcrun simctl listapps booted | grep <bundle id>`.

Do not continue until both facts are proven. If one is missing, stop and tell the user what you tried and what you need.

### 2.2 Write the config

```bash
npx speedpatrol@latest init --agent claude   # or codex, opencode
```

Edit `.speedpatrol/speedpatrol.yml`:

- `app.prepare`: install and build, once per checkout (e.g. `pnpm install --frozen-lockfile && pnpm build`). Never timed.
- `app.setup`: start the app as a `background: true` command with `readyUrl` or `readyWhen`. Use `${SPEEDPATROL_SOURCE}` only if a command must name the checkout explicitly; commands already run in it.
- `app.env` for values like `BASE_URL`; `app.secrets` for env var names whose values must never reach a log or a model. Never write a secret value in the config.
- Production build over dev server when you can: dev servers recompile and skew timings.

Write `.speedpatrol/instructions.md`: what the app is, which paths users wait for most, how to sign in, what must never be benchmarked (destructive writes, real payments, emails to real people).

### 2.3 Benchmarks

Either run the scout:

```bash
npx speedpatrol@latest scout
```

or write them yourself in `benchmarks:` (see https://github.com/agent-labs-dev/speedpatrol/blob/main/docs/configuration.md). Aim for 5 to 15, and mark the few most important ones `critical: true`. Kinds: `http`, `web` (page load + `steps` for screen navigation), `electron`, `startup`, `command`, `android`, `ios`, `maestro`, `custom`.

### 2.4 Prove it

```bash
npx speedpatrol@latest doctor
npx speedpatrol@latest run --iterations 5
```

Every benchmark must show a median and no errors. Fix the config until it does. Then show the user the table.

## 3. Use it

- `npx speedpatrol@latest run`: measure this checkout and record its baseline (clean tree only).
- `npx speedpatrol@latest compare`: working tree vs `origin/main`, A/B. `--head <dir|ref>`, `--base <ref>`, benchmark ids or tags as arguments. Exit 1 = regression.
- `npx speedpatrol@latest`: the patrol, all day, on a dedicated machine or VM. `--once` for one cycle. Before you set one up, read https://github.com/agent-labs-dev/speedpatrol/blob/main/docs/running-a-patrol.md (scheduling, test accounts, agent time limits, GitHub). When something fails, read https://github.com/agent-labs-dev/speedpatrol/blob/main/docs/troubleshooting.md.
- `npx speedpatrol@latest dashboard`: http://127.0.0.1:4321.
- `npx speedpatrol@latest regressions`, `analyze`, `optimize <benchmark>`, `publish --dry-run`.

When you change code for performance, verify with `compare` before claiming a speed-up, and quote its table: the verdict, the change and the interval. `noisy` means measure more (`--rounds 4`), not "faster".

## 4. Read the results

- A comparison row: verdict, base and head median, change, 95% interval, p. Only `regression` and `improvement` are findings.
- `.speedpatrol/runs/regressions/*.json`: confirmed regressions with the analyst's explanation and suspects.
- `.speedpatrol/runs/experiments/*.json`: optimizer attempts; `improved` ones have a branch ready for a PR.
- `.speedpatrol/runs/profiles/<run>/<benchmark>.cpuprofile`: open in Chrome DevTools or speedscope; the hotspots are in the run JSON.

## 5. CI

Add `.github/workflows/speedpatrol.yml` with `agent-labs-dev/speedpatrol@v0` (checkout with `fetch-depth: 0`) to post an A/B table on every pull request. See https://github.com/agent-labs-dev/speedpatrol/blob/main/docs/ci.md.
