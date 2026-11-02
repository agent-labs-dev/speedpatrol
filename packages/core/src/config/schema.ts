import { z } from 'zod';
import type { AgentRole } from '../types/agents.js';
import { CLI_AGENTS, cliPreset } from './agents.js';

/**
 * One setup or teardown command. `capture` pulls values out of the output by
 * regex (first group); later commands and benchmarks use them as `${NAME}`.
 */
export const appCommandSchema = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  capture: z.record(z.string()).default({}),
  /** Keep the process alive while the benchmarks run. */
  background: z.boolean().default(false),
  /** Background only: wait until this regex matches the output. */
  readyWhen: z.string().optional(),
  /** Background only: wait until this URL answers. */
  readyUrl: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
});
export type AppCommand = z.infer<typeof appCommandSchema>;

const profileSchema = z
  .object({
    /** Record a profile in one extra iteration that is not timed. */
    enabled: z.boolean().default(true),
    /**
     * command/startup/custom: `node` injects `--cpu-prof` through NODE_OPTIONS.
     * `command` wraps the run in `profile.command`, with `{cmd}` and `{out}`.
     */
    mode: z.enum(['auto', 'node', 'command', 'off']).default('auto'),
    command: z.string().optional(),
  })
  .default({});

const common = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dot, dash and underscore')
    .max(80),
  title: z.string().optional(),
  description: z.string().optional(),
  /** A critical path: a regression here is reported first and blocks CI. */
  critical: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  iterations: z.number().int().positive().optional(),
  warmup: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** The metric the verdict leads with. Default: the probe's own. */
  primary: z.string().optional(),
  profile: profileSchema,
};

const requestSchema = z.object({
  url: z.string(),
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).default({}),
  body: z.string().optional(),
});

const httpSchema = z.object({
  ...common,
  kind: z.literal('http'),
  request: requestSchema,
  expectStatus: z.number().int().default(200),
  /** Requests in flight at once. Above 1, the probe also reports `rps`. */
  concurrency: z.number().int().positive().default(1),
});

const commandSchema = z.object({
  ...common,
  kind: z.literal('command'),
  run: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  /** Run before each iteration and not timed, e.g. clearing a cache. */
  before: z.string().optional(),
});

const readySchema = z
  .object({
    output: z.string().optional(),
    url: z.string().optional(),
  })
  .refine((ready) => ready.output || ready.url, 'set ready.output or ready.url');

const startupSchema = z.object({
  ...common,
  kind: z.literal('startup'),
  run: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  ready: readySchema,
  before: z.string().optional(),
});

/** One step of a web or Electron flow. Each step is timed on its own. */
export const flowStepSchema = z.object({
  name: z.string(),
  goto: z.string().optional(),
  click: z.string().optional(),
  fill: z.object({ selector: z.string(), value: z.string() }).optional(),
  press: z.string().optional(),
  /** The step is done when this selector is visible. */
  waitFor: z.string().optional(),
  /** Or when the network has been idle. */
  waitForNetworkIdle: z.boolean().default(false),
});
export type FlowStep = z.infer<typeof flowStepSchema>;

const webSchema = z.object({
  ...common,
  kind: z.literal('web'),
  url: z.string(),
  /** Steps after the first load: screen navigation. */
  steps: z.array(flowStepSchema).default([]),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1280, height: 800 }),
  /** CPU slowdown factor, as in Chrome DevTools. */
  cpuThrottle: z.number().min(1).default(1),
  network: z.enum(['none', 'fast-3g', 'slow-3g', '4g']).default('none'),
  /** Steps that run before the timed load, e.g. sign-in. Not timed. */
  setup: z.array(flowStepSchema).default([]),
  /** Reuse the browser cache between iterations (a warm load). */
  warm: z.boolean().default(false),
});

/**
 * An Electron app. With `run`, each iteration launches the app (app open).
 * Without it, Speedpatrol attaches to an app that is already running on
 * `cdpPort` and times the steps in it (screen navigation), and with
 * `reload` also the window's reload until `readySelector` (renderer boot).
 */
const electronSchema = z.object({
  ...common,
  kind: z.literal('electron'),
  /** Launches the app. Must open CDP on `cdpPort`. Leave it out to attach. */
  run: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  /** A number, or `${NAME}` from env or a setup capture. */
  cdpPort: z.union([z.number().int().positive(), z.string()]),
  /** Attach: the window whose URL contains this. Default: the first page. */
  page: z.string().optional(),
  /** Attach: reload the window each iteration and time it to `readySelector`. */
  reload: z.boolean().default(false),
  /** The window is ready when this selector is visible. */
  readySelector: z.string().optional(),
  steps: z.array(flowStepSchema).default([]),
});

const androidSchema = z.object({
  ...common,
  kind: z.literal('android'),
  /** `com.example/.MainActivity` */
  activity: z.string(),
  /** Stop the app before each launch, so each launch is cold. */
  cold: z.boolean().default(true),
  device: z.string().optional(),
});

const iosSchema = z.object({
  ...common,
  kind: z.literal('ios'),
  bundleId: z.string(),
  device: z.string().default('booted'),
  /** The app prints this to stdout when its first screen is ready. */
  readyOutput: z.string().optional(),
});

const maestroSchema = z.object({
  ...common,
  kind: z.literal('maestro'),
  /** A Maestro flow file: the whole flow is one timed screen journey. */
  flow: z.string(),
  device: z.string().optional(),
});

/**
 * Any command that prints its own metrics: the last stdout line that parses
 * as `{"metrics": {"name": number}}`. For k6, hyperfine, a test runner, or a
 * benchmark that the scout wrote.
 */
const customSchema = z.object({
  ...common,
  kind: z.literal('custom'),
  run: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  metrics: z
    .record(
      z.object({
        unit: z.enum(['ms', 'bytes', 'kb', 'mb', 'count', 'score', 'rps', 'percent']).default('ms'),
        better: z.enum(['lower', 'higher']).default('lower'),
      }),
    )
    .refine((metrics) => Object.keys(metrics).length > 0, 'declare at least one metric'),
});

export const benchmarkSchema = z.discriminatedUnion('kind', [
  httpSchema,
  commandSchema,
  startupSchema,
  webSchema,
  electronSchema,
  androidSchema,
  iosSchema,
  maestroSchema,
  customSchema,
]);
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type BenchmarkInput = z.input<typeof benchmarkSchema>;
export type BenchmarkKind = Benchmark['kind'];
export const BENCHMARK_KINDS = benchmarkSchema.options.map((option) => option.shape.kind.value);

export const thresholdsSchema = z
  .object({
    /** A change smaller than this fraction is never a verdict. 0.05 = 5%. */
    relative: z.number().min(0).max(10).default(0.05),
    /** Nor is a change smaller than this, in the metric's unit. */
    absolute: z.number().nonnegative().default(1),
    /** Two-sided significance level. */
    alpha: z.number().min(0.0001).max(0.5).default(0.01),
    /** Above this coefficient of variation, an inconclusive result is `noisy`. */
    maxCv: z.number().positive().default(0.15),
  })
  .default({});
export type Thresholds = z.infer<typeof thresholdsSchema>;

const modelRuntimeSchema = z.object({
  runtime: z.literal('model'),
  via: z.enum(['openrouter', 'openai', 'anthropic', 'custom']).default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-5.5'),
  /** custom: an OpenAI-compatible base URL. */
  endpoint: z.string().optional(),
});

const cliRuntimeSchema = z.object({
  runtime: z.literal('cli'),
  agent: z.enum(CLI_AGENTS).optional(),
  /** `{prompt}`, `{mcp}`, `{mcpUrl}` and `{workdir}` are filled in. */
  command: z.string().optional(),
});

/**
 * One role's runtime. `use: claude` is short for `{ runtime: cli, agent: claude }`;
 * a preset becomes the command here, so the roles only see a model or a command.
 */
function runtimeFor(role: AgentRole) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' ? { runtime: 'cli', agent: value } : value),
      z.discriminatedUnion('runtime', [modelRuntimeSchema, cliRuntimeSchema]),
    )
    .default({ runtime: 'cli', agent: 'claude' })
    .superRefine((use, ctx) => {
      if (use.runtime === 'cli' && !use.command && !use.agent) {
        ctx.addIssue({ code: 'custom', message: `agents.${role}.use: set agent or command` });
      }
    })
    .transform((use) =>
      use.runtime === 'model'
        ? use
        : { runtime: 'cli' as const, agent: use.agent, command: use.command ?? cliPreset(use.agent!, role) },
    );
}
export type RoleRuntime = z.output<ReturnType<typeof runtimeFor>>;

const roleBase = {
  maxSteps: z.number().int().positive().default(60),
  timeoutMinutes: z.number().positive().default(30),
  budgetUsd: z.number().positive().optional(),
};

export const agentsSchema = z
  .object({
    scout: z.object({ ...roleBase, enabled: z.boolean().default(true), use: runtimeFor('scout') }).default({}),
    analyst: z.object({ ...roleBase, enabled: z.boolean().default(true), use: runtimeFor('analyst') }).default({}),
    optimizer: z
      .object({
        ...roleBase,
        enabled: z.boolean().default(false),
        use: runtimeFor('optimizer'),
        /** Experiments per patrol cycle, hottest target first. */
        maxPerCycle: z.number().int().nonnegative().default(1),
        /** An improvement smaller than this is not published. */
        minImprovement: z.number().min(0).default(0.05),
        /**
         * Conventional-commit scope of an experiment's commit and PR title
         * (default: the benchmark id). Set it when the repo's commit hooks or
         * PR-title lint allow only their own scopes.
         */
        commitScope: z.string().optional(),
      })
      .default({}),
    github: z
      .object({
        enabled: z.boolean().default(false),
        repo: z.string().optional(),
        pullRequests: z.enum(['draft', 'ready']).default('draft'),
        labels: z.array(z.string()).default(['speedpatrol']),
      })
      .default({}),
    patrol: z
      .object({
        intervalMinutes: z.number().positive().default(30),
        /** The ref each cycle measures. */
        pull: z.string().default('origin/main'),
        /** 0 = run until stopped. */
        cycles: z.number().int().nonnegative().default(0),
      })
      .default({}),
  })
  .default({});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  project: z
    .object({
      name: z.string().default('app'),
      /** The repository. Relative to the config file's folder's parent. */
      source: z.string().default('.'),
    })
    .default({}),
  app: z
    .object({
      /** Plain-English guide for the agents: what the app is, what is critical. */
      instructions: z.string().default('instructions.md'),
      /**
       * Run once per checkout before any measurement, and never timed: install
       * dependencies, build. A/B compares run it in each worktree.
       */
      prepare: z.array(appCommandSchema).default([]),
      /** Brings the app up before the benchmarks run, e.g. starts the server. */
      setup: z.array(appCommandSchema).default([]),
      teardown: z.array(appCommandSchema).default([]),
      env: z.record(z.string()).default({}),
      /** Env var names whose values are redacted from logs and never sent to a model. */
      secrets: z.array(z.string()).default([]),
    })
    .default({}),
  defaults: z
    .object({
      iterations: z.number().int().positive().default(15),
      warmup: z.number().int().nonnegative().default(2),
      timeoutMs: z.number().int().positive().default(60_000),
      /** A/B compare: how many alternating rounds of base and head. */
      rounds: z.number().int().positive().default(2),
    })
    .default({}),
  benchmarks: z.array(benchmarkSchema).default([]),
  thresholds: thresholdsSchema,
  agents: agentsSchema,
});

export type SpeedpatrolConfig = z.infer<typeof configSchema>;
export type SpeedpatrolConfigInput = z.input<typeof configSchema>;
