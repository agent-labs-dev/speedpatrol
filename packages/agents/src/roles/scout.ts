import type { LoadedConfig, Store } from '@speedpatrol/core';
import { runRole } from '../session.js';
import { benchmarkTools, readInstructions } from '../tools/benchmarks.js';
import { repoTools } from '../tools/repo.js';
import { finishTool } from '../tools/schema.js';

const SYSTEM = `You are the scout of Speedpatrol, a team of agents that keeps an app fast.
Your job: find the critical paths of this app and turn each one into a benchmark that Speedpatrol measures on every commit.

Critical paths are what users wait for:
- API endpoints that screens call on load, search, list and detail reads, writes on the hot path, auth.
- App open: the server or worker cold start, the desktop or mobile app launch to its first screen.
- Screen navigation: the first page load and the moves between the main screens.
- Heavy commands developers or CI run: build, test, a CLI's main command.

How to work:
1. Read the app guide below, the README, the routes, the screens and the package scripts.
2. Call list_benchmarks to see what exists. Do not duplicate a path.
3. For each path, write a benchmark (benchmark_help shows the format), run try_benchmark, fix it until it works, then save_benchmark.
4. Mark the few paths users feel most as critical. Prefer 5 to 15 good benchmarks over many weak ones.
5. Remove a scouted benchmark only when its path no longer exists.
6. Call finish with what you added and why.

Rules: never benchmark a destructive write against real data; never put a secret value in a benchmark (use \${NAME}); keep each benchmark fast enough to repeat 15 times.`;

export async function runScout(options: {
  loaded: LoadedConfig;
  store: Store;
  log: (line: string) => void;
  focus?: string;
}) {
  const { loaded, store, log } = options;
  const scout = loaded.config.agents.scout;
  const bench = benchmarkTools(loaded, store, log);
  try {
    return await runRole({
      role: 'scout',
      use: scout.use,
      system: `${SYSTEM}\n\n# App guide\n\n${await readInstructions(loaded)}`,
      prompt: options.focus
        ? `Focus on: ${options.focus}`
        : 'Find the critical paths that have no benchmark yet, and add benchmarks for them.',
      tools: [...bench.tools, ...repoTools(loaded.source), finishTool('Finish the session with a summary.')],
      maxSteps: scout.maxSteps,
      timeoutMinutes: scout.timeoutMinutes,
      budgetUsd: scout.budgetUsd,
      workdir: loaded.source,
      store,
      secrets: loaded.config.app.secrets.map((name) => process.env[name] ?? '').filter(Boolean),
      log,
    });
  } finally {
    await bench.dispose();
  }
}
