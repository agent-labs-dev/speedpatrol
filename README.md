<p align="center">
  <img src="assets/banner.png" alt="Speedpatrol: AI agents that measure your app and make it faster." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/speedpatrol"><img src="https://img.shields.io/npm/v/speedpatrol?color=fbbf24&label=npm" alt="npm version"></a>
  <a href="https://github.com/agent-labs-dev/speedpatrol/actions/workflows/ci.yml"><img src="https://github.com/agent-labs-dev/speedpatrol/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

Speedpatrol is a performance team made of agents. It measures the critical paths of your app on each commit to `main`: API endpoints, app open, page loads, screen navigation, builds, and commands. It keeps a baseline of each run, finds regressions with statistics, explains them, and proposes speed-ups that it measured itself. It is the performance sibling of [Bugpatrol](https://github.com/agent-labs-dev/bugpatrol).

- The **scout** agent reads the repo and the app, finds the critical paths, and writes a benchmark for each one.
- The **runner** is code, not a model. It starts the app, measures each benchmark, and records the **baseline** of the commit.
- **Statistics** decide each verdict. A second A/B measurement must confirm each regression.
- The **analyst** agent explains each confirmed regression: the suspect commits, the code, and the CPU profile.
- The **optimizer** agent (off by default) tries a speed-up in its own git worktree. An A/B run must prove it.
- Speedpatrol **publishes** to GitHub: an issue for each regression, and a draft PR for each verified speed-up.

```bash
npx speedpatrol
```

`npx speedpatrol` runs the patrol: measure each new commit on `main`, compare, confirm, explain, speed up, and publish. Then it waits for the next commit.

```mermaid
flowchart TB
  start(["npx speedpatrol"]) --> pull["Fetch origin/main, check it out in a worktree"]
  pull --> run{{"1 · Measure<br/>Runner: each benchmark, one profile each"}}
  run --> cmp["2 · Compare with the previous baseline<br/>Mann-Whitney U + bootstrap CI + thresholds"]
  cmp -->|"suspected regression"| confirm["3 · Confirm<br/>A/B: last good commit vs this one"]
  confirm -->|"confirmed"| analyst["4 · Explain<br/>LLM · Analyst reads commits, diffs, profiles"]
  cmp -->|"no regression"| opt
  analyst --> opt["5 · Speed up<br/>LLM · Optimizer edits a worktree, A/B verifies"]
  opt --> publish["6 · Publish<br/>Issues for regressions, draft PRs for speed-ups"]
  publish --> wait["Wait for a new commit on main"]
  wait -->|"next cycle"| pull

  subgraph legend ["Legend"]
    direction LR
    l1["LLM agent"] ~~~ l3["Code, no model"] ~~~ l4["Off by default"]
  end
  wait ~~~ legend

  classDef llm fill:#312e81,stroke:#a5b4fc,color:#ffffff
  classDef code fill:#1e293b,stroke:#64748b,color:#e2e8f0
  classDef off fill:#312e81,stroke:#a5b4fc,color:#ffffff,stroke-width:2px,stroke-dasharray:6 4
  class analyst,l1 llm
  class start,pull,run,cmp,confirm,wait,l3 code
  classDef offcode fill:#1e293b,stroke:#64748b,color:#e2e8f0,stroke-width:2px,stroke-dasharray:6 4
  class opt,l4 off
  class publish offcode
  style legend fill:transparent,stroke:#64748b
```

<img src="assets/dashboard.png" alt="The Speedpatrol dashboard: the agent cards, the benchmark trends, the regressions, the experiments, and the agent activity." width="100%">

The dashboard (`npx speedpatrol dashboard`) shows the benchmark trends, the regressions, the experiments, and each agent, live.

## Set up with your agent

1. Install the Speedpatrol skill in your repo:

   ```bash
   npx skills add agent-labs-dev/speedpatrol
   ```

2. Give this prompt to your agent:

   ```text
   Set up Speedpatrol for this repo.
   ```

If your agent cannot install skills, give it the skill URL:

```text
Read https://raw.githubusercontent.com/agent-labs-dev/speedpatrol/main/skills/speedpatrol/SKILL.md and set up Speedpatrol for this repo.
```

To set up by hand, read [Getting started](docs/getting-started.md).

## What is supported

| | Supported |
| --- | --- |
| Platforms | HTTP APIs, web pages (Chromium), Electron apps, server startup, Android, iOS simulators, Maestro flows, builds and CLI commands, custom scripts |
| Agent LLMs | Claude Code, Codex, OpenCode, or any agent CLI. API keys for OpenRouter, OpenAI, Anthropic, or a custom endpoint |
| GitHub | An issue for each regression, a draft PR for each speed-up, and an Action that posts an A/B table on each PR |
| Output | A dashboard, a Markdown or JSON comparison table, plain JSON data in `.speedpatrol/runs/`, and CPU profiles |

## Documentation

| Page | What it covers |
| --- | --- |
| [Getting started](docs/getting-started.md) | Set up with your agent or by hand |
| [Commands](docs/commands.md) | Each command, the patrol, and the two ways to compare |
| [Benchmarks and metrics](docs/benchmarks.md) | The benchmark kinds, their metrics, and the profiles |
| [Configuration](docs/configuration.md) | Each field of `speedpatrol.yml` |
| [How it works](docs/how-it-works.md) | The measurement protocol, the statistics, and the patrol cycle |
| [Agents](docs/agents.md) | The roles, the runtimes, and the tools |
| [Dashboard](docs/dashboard.md) | What the dashboard shows |
| [CI](docs/ci.md) | The GitHub Action for pull requests |
| [Data model](docs/data-model.md) | The files under `.speedpatrol/runs/` |
| [Decisions](docs/adr/) | Why Speedpatrol works this way |
| [Contributing](CONTRIBUTING.md) | Build, test, and release Speedpatrol |

## License

[Apache-2.0](LICENSE)

---

<p align="center">Made with ❤️ by the Nebula team.</p>
