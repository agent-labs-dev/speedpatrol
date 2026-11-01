# Running a patrol

[Getting started](getting-started.md) gets you to a first measured run. This page is for the next step: a patrol that measures every commit on `main`, day after day, on one machine.

## Install

The npm package is the normal way:

```bash
npx speedpatrol@latest --version
```

For a long-running patrol, pin the version (`npm install -D speedpatrol@<version>`, or `npx speedpatrol@<version>`), so an upgrade happens when you choose it, not in the middle of the night.

A release can lag `main`. To run `main` before it is released, build it from source (Node 22 or later):

```bash
git clone https://github.com/agent-labs-dev/speedpatrol ~/speedpatrol
cd ~/speedpatrol
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
node ~/speedpatrol/packages/speedpatrol/dist/bin.js --version
```

Put a small wrapper on your `PATH` so the rest of this page works the same way:

```bash
#!/usr/bin/env bash
exec node "$HOME/speedpatrol/packages/speedpatrol/dist/bin.js" "$@"
```

To update: `git pull`, then the install and build commands again. Restart the dashboard after a rebuild, so it does not serve a half-replaced bundle.

Then install Chromium for the `web` and `electron` benchmarks, one time:

```bash
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx -y playwright@1.64.1 install chromium
```

`PLAYWRIGHT_SKIP_BROWSER_GC=1` matters on a shared machine: without it, a Playwright install deletes the browsers of every other Playwright version, including the one that Speedpatrol uses. Set it in the environment of everything that runs on the machine.

## The machine

- **One machine, always the same one.** A baseline belongs to the machine that measured it ([ADR 0002](adr/0002-baselines-per-commit-per-machine.md)). A new machine starts a new history. To share one history across identical runners, set `SPEEDPATROL_MACHINE`.
- **A quiet machine.** Other work on the machine during a measurement makes timings noisy. Schedule other heavy jobs (builds, test suites, other patrols) at different times. Never run two Speedpatrol measurements at the same time on one machine: they share the CPU and, usually, the app's ports.
- **Keep `.speedpatrol/runs/`.** It is the history: baselines, regressions, experiments, profiles, agent sessions. Put it on a disk that survives a reboot, and back it up if the history matters to you. It is never committed.
- **A display for Electron.** On a Linux machine with no screen, run Xvfb (`Xvfb :99 &`) and set `DISPLAY=:99` for Speedpatrol.

## Commit the config

The patrol reads `speedpatrol.yml` and `benchmarks.json` from the commit that it measures, when that commit has them. A benchmark change then lands with the code it needs. So commit `.speedpatrol/speedpatrol.yml`, `instructions.md` and `benchmarks.json` to `main` before you start the patrol. Until they are on `main`, the patrol uses the config of the checkout it was started in.

## Two ways to run it

### All day

`speedpatrol` with no command is the patrol. It fetches `origin/main` every `agents.patrol.intervalMinutes` (30), measures each new commit, and waits for the next one. Run it under a process supervisor, in a dedicated clone of your repo that you never work in:

```ini
# /etc/systemd/system/speedpatrol.service
[Unit]
Description=Speedpatrol for my-app
After=network-online.target

[Service]
User=perf
WorkingDirectory=/srv/my-app
Environment=PLAYWRIGHT_SKIP_BROWSER_GC=1
EnvironmentFile=/etc/speedpatrol/my-app.env
ExecStart=/usr/bin/npx speedpatrol@<version>
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/etc/speedpatrol/my-app.env` holds the secrets that `app.secrets` names, and the API key of a model runtime if you use one. A second unit runs the dashboard: `ExecStart=/usr/bin/npx speedpatrol@<version> dashboard --port 4321`.

### As scheduled steps

Run the steps yourself when a scheduler (cron, CI, a job runner) owns the timing, or when the scheduler limits how long one call may run. Set the patrol to measure what the scheduler checked out:

```yaml
agents:
  patrol: { pull: HEAD }
```

Then each scheduled run is:

```bash
cd /srv/my-app
git fetch --quiet origin main
git checkout --quiet --detach origin/main
speedpatrol --once --no-optimize   # measure, confirm, explain, publish issues
speedpatrol optimize               # optional: one speed-up attempt and its A/B verification
speedpatrol publish                # PRs for verified speed-ups
```

`--once --no-optimize` prints `HEAD is still <sha>, measured before: skipping the measurement.` when `main` did not move. That is normal. `--force` measures the same commit again.

Give each step enough time in the scheduler: a measure step can include an A/B confirmation and a full analyst session (see [Agent time limits](#agent-time-limits)).

## Test accounts and tokens

Benchmarks that sign in need a token, and a token for a test account should not live forever. Mint one per run in `app.setup` and delete the account in `app.teardown`:

```yaml
app:
  setup:
    - run: node scripts/mint-test-user.js
      capture:
        TOKEN: 'token=(\S+)'      # a captured value is a secret: never logged, never shown to a model
  teardown:
    - run: node scripts/delete-test-user.js ${TOKEN}
```

If the token must come from outside (a vault, your scheduler), pass it as an environment variable and list its name in `app.secrets`.

## Agent time limits

Each agent role stops at the first of:

| Field | Default | |
| --- | --- | --- |
| `maxSteps` | 60 | tool calls |
| `timeoutMinutes` | 30 | wall clock of the whole session |
| `budgetUsd` | none | spend; model runtime only |

Set them per role in `speedpatrol.yml`. There is no command-line flag or environment variable for them.

```yaml
agents:
  analyst: { use: claude, timeoutMinutes: 60 }
  optimizer: { use: claude, enabled: true, timeoutMinutes: 20 }
```

**Size the analyst from your A/B time.** The analyst bisects with `measure_commit`, and each call is a full A/B run: `app.prepare` in both checkouts, then `rounds` x 2 measurements of every benchmark it names. The calls run one at a time. Time one yourself:

```bash
speedpatrol compare --base HEAD~1 --head HEAD <your critical benchmark ids>
```

A bisection over `n` suspect commits needs about log2(n) + 1 A/Bs, plus a few minutes of reading. An app whose A/B takes 7 minutes needed 27 minutes to bisect 10 commits, so a 30-minute limit was too tight and 60 left room. A fast app (A/Bs under a minute) is fine with the default.

When the analyst runs out of time before it writes its analysis, the regression stays `open`: it is recorded and shown on the dashboard, but no issue is published, and later cycles do not try again. Raise `timeoutMinutes`, then run `speedpatrol analyze` and `speedpatrol publish`. With the analyst off (`enabled: false`), regressions are published with the numbers alone.

**The optimizer's limit is its working time.** Speedpatrol's own A/B verification runs after the optimizer stops, so the optimize step takes `timeoutMinutes` plus one A/B.

**Agent CLIs get the limit too.** For a CLI runtime, Speedpatrol sets `MCP_TOOL_TIMEOUT` and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` to the role's timeout, so that Claude Code waits for a long A/B instead of abandoning it. A value already in Speedpatrol's environment wins over this, so do not export these two variables in the shell, unit or job that runs Speedpatrol.

## Publishing to GitHub

```yaml
agents:
  github: { enabled: true, repo: my-org/my-app, pullRequests: ready }
```

- Publishing uses the `gh` CLI, so `gh auth status` must pass for the user that runs the patrol. The token needs to create issues and labels, push branches, and open pull requests on `repo`.
- Speedpatrol creates its labels (`speedpatrol` by default) before the first issue or PR.
- The optimizer commits its change with the machine's git identity. If your repo's commit hooks or PR-title lint allow only some conventional-commit scopes, set `agents.optimizer.commitScope` to one of them (the default scope is the benchmark id).
- `speedpatrol publish --dry-run` shows what it would open.

## The dashboard

`speedpatrol dashboard --port 4321` serves the history of the `.speedpatrol/` folder it runs in, on `127.0.0.1` only. Run it in the same clone as the patrol. To show it to others, put an authenticating reverse proxy in front of it.

## When something goes wrong

[Troubleshooting](troubleshooting.md) lists the failures that real patrols have hit, and their fixes.
