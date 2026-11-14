import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CLI_AGENTS, type CliAgent, CONFIG_DIR, CONFIG_FILE, ConfigError, tryGit } from '@speedpatrol/core';

type Platform = 'web' | 'electron' | 'mobile' | 'api' | 'cli';
/** `platform` is absent when no manifest was recognised: there is no app to start. */
type Detected = { platform?: Platform; start?: string; name: string };

/** The origin remote's repo name, so a worktree folder does not name the project. */
async function repoName(root: string): Promise<string | undefined> {
  const remote = await tryGit(root, ['remote', 'get-url', 'origin']);
  const name = remote
    ?.split(/[/:]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, '');
  return name || undefined;
}

/** Reads package.json for hints. A guess only: the user and the scout refine it. */
async function detect(root: string): Promise<Detected> {
  const name = (await repoName(root)) ?? basename(root);
  const file = join(root, 'package.json');
  // No recognised manifest: no app type, so init offers a command benchmark instead of inventing a server.
  if (!existsSync(file)) return { name };
  const pkg = JSON.parse(await readFile(file, 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin?: unknown;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string) => name in deps;
  const start = pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : undefined;
  const project = pkg.name?.replace(/^@[^/]+\//, '') ?? name;
  if (has('electron')) return { platform: 'electron', start, name: project };
  if (has('expo') || has('react-native')) return { platform: 'mobile', start, name: project };
  if (has('next') || has('vite') || has('react-scripts') || has('@sveltejs/kit') || has('nuxt'))
    return { platform: 'web', start, name: project };
  if (pkg.bin) return { platform: 'cli', start, name: project };
  return { platform: 'api', start, name: project };
}

function template(detected: Detected, agent: CliAgent): string {
  const setup = detected.start
    ? `  setup:
    # Starts the app. Speedpatrol waits for readyUrl before it measures.
    - run: ${detected.start}
      background: true
      readyUrl: \${BASE_URL}
`
    : `  setup: []
`;
  const env = detected.platform
    ? `  env:
    BASE_URL: http://127.0.0.1:3000
`
    : '';
  const benchmarks = detected.platform
    ? `benchmarks: []
`
    : `# This repo has no package.json, so init found no app type to start. A
# command benchmark times one command end to end: replace run with the test
# or bench command this repo already has.
benchmarks: []
# - id: command
#   kind: command
#   critical: true
#   run: ./tests/bench.sh
`;
  return `# Speedpatrol: https://github.com/agent-labs-dev/speedpatrol
# Commit this file, instructions.md and benchmarks.json. runs/ is local data.
version: 1
project:
  name: ${detected.name}
  source: .
app:
  # Run once per checkout, never timed: install and build.
  prepare: []
${setup}${env}  # Env var names whose values never reach a log or a model.
  secrets: []
defaults:
  iterations: 15
  warmup: 2
# Critical paths. Add your own, or run \`speedpatrol scout\` and the scout
# writes them to benchmarks.json after it has tried each one.
${benchmarks}thresholds:
  relative: 0.05   # ignore changes under 5%
  absolute: 1      # and under 1 ms
agents:
  scout: { use: ${agent} }
  analyst: { use: ${agent} }
  optimizer: { use: ${agent}, enabled: false }
  github: { enabled: false }
  patrol: { intervalMinutes: 30, pull: origin/main }
`;
}

const INSTRUCTIONS = (detected: Detected) => `# ${detected.name}

<!-- The agents read this guide. Plain English: what the app is, what users
wait for, how to sign in, what must never be benchmarked. -->

## What the app is

## Critical paths
<!-- e.g. "Opening the inbox (GET /api/threads) and opening a thread". -->

## Never
- Never benchmark writes against production data.
`;

export async function init(root: string, agentFlag: string | undefined, log: (line: string) => void): Promise<void> {
  const agent = (agentFlag ?? 'claude') as CliAgent;
  if (!CLI_AGENTS.includes(agent)) throw new ConfigError(`--agent must be one of ${CLI_AGENTS.join(', ')}`);
  const dir = join(root, CONFIG_DIR);
  const configFile = join(dir, CONFIG_FILE);
  if (existsSync(configFile)) throw new ConfigError(`${configFile} exists already.`);
  const detected = await detect(root);
  await mkdir(dir, { recursive: true });
  await writeFile(configFile, template(detected, agent));
  const instructions = join(dir, 'instructions.md');
  if (!existsSync(instructions)) await writeFile(instructions, INSTRUCTIONS(detected));
  const gitignore = join(root, '.gitignore');
  const ignored = existsSync(gitignore) ? await readFile(gitignore, 'utf8') : '';
  if (!ignored.includes('.speedpatrol/runs'))
    await appendFile(gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}.speedpatrol/runs/\n`);
  if (detected.platform) {
    log(`Created ${configFile} (detected: ${detected.platform}).`);
    log('Next: fill in app.setup and instructions.md, then run `speedpatrol scout` and `speedpatrol run`.');
  } else {
    log(`Created ${configFile} (no app type found; added a command benchmark example).`);
    log('Next: fill in instructions.md and the command benchmark, then run `speedpatrol scout` and `speedpatrol run`.');
  }
}
