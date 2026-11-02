# Getting started

## Set up with your agent

1. Install the Speedpatrol skill in your repo:

   ```bash
   npx skills add agent-labs-dev/speedpatrol
   ```

   The [skills CLI](https://github.com/vercel-labs/skills) installs the skill for Claude Code, Codex, Cursor, and many other agents. It also writes `skills-lock.json` at the repo root. Commit both, so your team gets the skill too.

2. Give this prompt to your agent:

   ```text
   Set up Speedpatrol for this repo.
   ```

The [skill](../skills/speedpatrol/SKILL.md) tells the agent how to configure Speedpatrol for your app, prove that the setup works, run the scout, and read the results.

If your agent cannot install skills, give it the skill URL:

```text
Read https://raw.githubusercontent.com/agent-labs-dev/speedpatrol/main/skills/speedpatrol/SKILL.md and set up Speedpatrol for this repo.
```

## Set up by hand

You need Node 22 or later and `git`. For `web` and `electron` benchmarks, install Chromium for Playwright one time:

```bash
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx -y playwright@1.64.1 install chromium
```

1. Create the config:

   ```bash
   npx speedpatrol init            # --agent claude | codex | opencode
   ```

   `init` puts all the Speedpatrol files in one `.speedpatrol/` folder:

   ```text
   .speedpatrol/
     speedpatrol.yml   # the config: commit it
     instructions.md   # the app guide for the agents: commit it
     benchmarks.json   # the benchmarks the scout wrote: commit it
     runs/             # runs, baselines, comparisons, profiles, sessions: git ignores it
   ```

2. Tell Speedpatrol how to start your app in `app.setup`. Tell it how to install and build the app in `app.prepare`.

3. Write `instructions.md`. Tell the agents what the app is, and which paths users wait for.

4. Add benchmarks, or let the scout write them:

   ```bash
   npx speedpatrol scout
   ```

5. Measure, and start the patrol:

   ```bash
   npx speedpatrol run          # measure this checkout and record the baseline
   npx speedpatrol              # the patrol: every new commit on origin/main
   npx speedpatrol dashboard    # http://127.0.0.1:4321
   ```

[examples/fixture-app](../examples/fixture-app/.speedpatrol/speedpatrol.yml) has a complete config. [Configuration](configuration.md) tells each field. [Commands](commands.md) tells each command.
