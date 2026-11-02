export const USAGE = `speedpatrol: a team of agents that keeps your app fast.

Usage: speedpatrol [command] [options]

Commands:
  (none), patrol         Measure origin/main on every new commit, confirm and explain
                         regressions, try speed-ups, publish. --once, --force,
                         --no-optimize (measure and publish only)
  init                   Create .speedpatrol/ with a config for this repo. --agent claude|codex|opencode
  run [ids|tags...]      Measure this checkout, record it as the baseline of its commit
                         when it is clean, and compare with the previous baseline.
                         --iterations N, --json, --fail-on-regression
  compare [ids|tags...]  A/B two checkouts on this machine: --base <ref> (default
                         origin/main), --head <dir|ref> (default: this checkout, with
                         its uncommitted changes). --rounds N, --iterations N,
                         --markdown <file>, --json. Exits 1 on a regression.
  scout                  The scout finds critical paths and writes benchmarks. --focus "<text>"
  analyze [id]           The analyst explains open regressions.
  optimize [benchmark]   The optimizer tries a speed-up in a worktree, then Speedpatrol
                         verifies it with an A/B run.
  publish                Open issues for regressions and PRs for verified speed-ups.
                         --dry-run
  dashboard              Serve the dashboard. --port N (default 4321)
  baselines              List the recorded baselines.
  regressions            List regressions. 'regressions dismiss <id> --reason "..."'
  doctor                 Check the config, git, Chromium and the agent CLIs.

Options:
  --cwd <dir>            Run as if started in <dir>.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes: 0 ok, 1 regression, 2 config error, 4 could not measure.
Docs: https://github.com/agent-labs-dev/speedpatrol`;
