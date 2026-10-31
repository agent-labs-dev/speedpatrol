# Troubleshooting

Start with `speedpatrol doctor`. It checks Node, git, the config, Chromium, the agent CLIs and `gh`. The exit codes are 0 ok, 1 regression, 2 config error, 4 could not measure.

## Setup and first runs

**Exit 2 and a config error.** The config is checked before anything runs: an unknown `kind`, a missing field, or a duplicate benchmark id stops it. The message names the field.

**Exit 4, "could not measure".** A setup command failed, the app never became ready, or a benchmark failed three iterations in a row with no success (it is broken, not slow). The output shows the last 20 lines of the failing setup command, with secrets redacted. Run the setup command by hand in the checkout to see the full error.

**The second `run` shows no comparison.** `run` compares with the newest baseline of a *different* commit, measured on the same machine. Two runs of one commit do not compare. Commit a change and run again, or use `speedpatrol compare`. A run of a working tree with changes to tracked files is not recorded as a baseline; untracked files do not matter.

**`run` exits 0 on a regression.** That is the default. Add `--fail-on-regression` to exit 1. `compare` always exits 1 on a regression.

**"The benchmark definitions changed between the runs."** The two sides were measured with different benchmark sets: you edited a benchmark, or you measured a subset (`run api.items`) against a run of all of them. The numbers are still right for the benchmarks both sides have.

**`chromium for playwright: missing`, or a browser that disappears between runs.** A Playwright install of another version deletes the browsers of all other versions, Speedpatrol's included. Reinstall with `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx -y playwright@1.64.1 install chromium`, and set `PLAYWRIGHT_SKIP_BROWSER_GC=1` for everything on the machine that installs browsers. On a shared machine, reinstall before each scheduled run: it does nothing when the browser is there.

**An Electron benchmark cannot start a window on Linux.** There is no display. Run Xvfb and set `DISPLAY`.

**An attach benchmark waits for `readySelector` until it times out, while the app is up.** Another program (a browser, an e2e harness, a second app) already listens on `cdpPort`, so `readyUrl` answered and Speedpatrol attached to that program's window. Use a port nothing else on the machine uses, and set `page` to a part of your window's URL, so the benchmark can only attach to your app. [examples/electron-app](../examples/electron-app) does both.

**Some Electron launches never open a window.** A launched copy shares its profile with a copy that is already running (the one `app.setup` started). Give the launched copy its own profile, for example `--user-data-dir=.speedpatrol/runs/open-profile`.

## Timings

**Many `noisy` verdicts.** `noisy` means the change looks large but the samples vary too much (more than `thresholds.maxCv`) for a verdict. It is not a regression, and it does not start the analyst: the analyst only runs for a regression that the A/B confirmation reproduced. Usual causes, most likely first:

- The benchmark times a remote service (a shared dev or staging backend) whose latency changes from minute to minute. Measure a local server when you can, or accept that such a benchmark only catches large changes.
- Other work on the machine during the measurement. Move it to another time.
- Too few samples. Raise `iterations`, or `rounds` for A/B runs.

A run's verdict is the worst verdict of its benchmarks' primary metrics, so one noisy benchmark makes the whole run read `noisy` while the others are `unchanged`. Look at the per-benchmark rows.

**A web benchmark on a dev server times out or is very slow on cold loads.** Dev servers compile on the first request. Build the app in `app.prepare` (a production build, or a static export) and serve the build in `app.setup`.

**A click in a `web` step does nothing, or the step waits until its timeout.** Something covers the target: a cookie banner, a "what's new" sheet, an onboarding modal. Dismiss it in the benchmark's untimed `setup`, or open each screen by URL with `goto` instead of a click.

**A step in an Electron app is 1-2 s slower than it should be.** That is Playwright's actionability wait in a hidden or occluded window. Speedpatrol already skips it for clicks after the target is visible; if you wrote your own wait, remove it. See [the `electron` kind](configuration.md#electron).

## Agents

**The analyst stops before it names a commit.** It ran out of `timeoutMinutes` (30 by default) while bisecting. Each `measure_commit` call is a full A/B run, so an app whose A/B takes minutes needs a larger limit. [Agent time limits](running-a-patrol.md#agent-time-limits) shows how to size it. The regression stays `open` and is not published until `speedpatrol analyze` finishes it.

**"Every benchmark failed", `EADDRINUSE` or `ERR_CONNECTION_REFUSED` while the analyst or the optimizer runs.** Two A/B runs started the app on the same port at the same time. On current `main`, Speedpatrol runs an agent's A/B tool calls one at a time. Releases up to and including 0.1.1 do not: an agent that calls `measure_commit` twice in parallel collides with itself. Upgrade to a later release, or [build from source](running-a-patrol.md#install). The same symptom appears when another process on the machine (a second patrol, a dev server) uses the app's port.

**Claude Code abandons a long A/B and calls it again.** Claude Code gives up on an MCP tool call after its own timeout, and on any call that is silent for 300 s. Speedpatrol sets `MCP_TOOL_TIMEOUT` and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` to the role's timeout. Releases up to and including 0.1.1 set only `MCP_TOOL_TIMEOUT`, so with a recent Claude Code any A/B call longer than 300 s is aborted: upgrade, or build from source. A value exported in Speedpatrol's own environment wins, so remove any `export MCP_TOOL_TIMEOUT=...` or `export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=...` from the shell, unit or job that runs it.

**The optimizer's commit is rejected by a commit hook, or its PR fails a title lint.** The commit is `perf(<benchmark id>): ...` by default. Set `agents.optimizer.commitScope` to a scope your repo allows.

**An optimizer PR contains a file the optimizer never wrote.** Your setup creates a file or link in the checkout (test results, a cache) that git does not ignore. Ignore it in the repo's `.gitignore`. A symlink to a directory is a file to git: `test-results/` does not match it, `/test-results` does.

**An agent CLI is "not found", or exits at once.** `doctor` checks that the program in each enabled role's command runs. The CLI must be signed in for the user that runs the patrol (for example, `claude` once by hand). For a model runtime, set the API key: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `SPEEDPATROL_MODEL_API_KEY`.

## The patrol

**"`<ref>` is still `<sha>`, measured before: skipping the measurement."** The ref did not move since the last cycle. That is normal. `--force` measures it again.

**The patrol measures a commit you did not expect.** It measures `agents.patrol.pull` (`origin/main` by default) and fetches its remote first. When a scheduler moves the checkout itself, set `pull: HEAD`.

**A benchmark you added is not measured by the patrol.** The patrol reads the config from the commit it measures. A benchmark that exists only in your working tree is used by `run` and `compare`, not by the patrol. Commit it to `main`.

**Publishing fails.** Publishing uses `gh`. Run `gh auth status` as the user that runs the patrol. The token needs to create issues and labels, push branches, and open pull requests on `agents.github.repo`. `speedpatrol publish --dry-run` shows what it would open; `speedpatrol publish` retries.
