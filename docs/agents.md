# Agents

| Role | Job | Writes code | Default runtime |
| --- | --- | --- | --- |
| Scout | Finds critical paths and writes benchmarks | `benchmarks.json` only | `claude` |
| Runner | Measures (code, no model) | | |
| Analyst | Explains a confirmed regression | | `claude` |
| Optimizer | Speeds up one benchmark in a worktree (off by default) | its worktree | `claude` |
| Publisher | Opens issues and PRs (code, no model) | | |

## Tools

The tools are the contract (ADR 0003). A CLI agent gets them over a local MCP server named `speedpatrol`; the model runtime calls them in-process.

- **Every role:** `list_files`, `read_file`, `search` (read-only, inside the repo or the worktree), `finish`.
- **Scout:** `benchmark_help`, `list_benchmarks`, `try_benchmark` (starts the app on first use, runs 3 trials), `save_benchmark` (only a benchmark that `try_benchmark` ran with exactly this definition), `remove_benchmark` (scouted ones only).
- **Analyst:** `git_log`, `git_show`, `profile_diff`, `measure_commit` (an A/B run of any commit against another, for a bisection), `write_analysis`.
- **Optimizer:** `get_target`, `set_hypothesis`, `git_diff`, `measure_change` (an A/B run of the worktree against the base).

## Presets

| `use:` | Scout and analyst | Optimizer |
| --- | --- | --- |
| `claude` | `claude -p --output-format json --tools 'Read,Grep,Glob' --mcp-config {mcp} --strict-mcp-config --allowedTools 'mcp__speedpatrol,Read,Grep,Glob'` | `claude -p --output-format json --permission-mode auto --mcp-config {mcp} --allowedTools mcp__speedpatrol` |
| `codex` | `codex exec --json --skip-git-repo-check --sandbox read-only -c mcp_servers.speedpatrol.url={mcpUrl} -` | the same with `--sandbox workspace-write` |
| `opencode` | `opencode run --format json`, with the MCP server and edits denied in `OPENCODE_CONFIG_CONTENT` | the same, edits allowed |

The prompt goes to the command's stdin and to the file `{prompt}`. A preset is only a default: `{ runtime: cli, command: "..." }` runs anything.

## Sessions

Each session writes `sessions/<id>/events.jsonl` and updates `agents.json`. Every secret value (`app.secrets` and captured values) is redacted from both. A role stops at `maxSteps` tool calls, `timeoutMinutes`, or `budgetUsd` (model runtime).
