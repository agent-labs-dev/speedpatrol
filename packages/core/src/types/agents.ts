/**
 * The four agent roles (ADR 0003). Each one has a runtime: a model loop, or
 * a local CLI agent with the same tools over MCP.
 *
 * - scout: reads the repo and the running app, and writes the benchmarks for
 *   the critical paths.
 * - analyst: explains a confirmed regression: which commit, which code, what
 *   the profile shows. Writes the issue. Never decides the verdict.
 * - optimizer: proposes a speed-up in its own worktree.
 * - publisher: is code, not a model; listed so the dashboard can show it.
 */
export const AGENT_ROLES = ['scout', 'analyst', 'optimizer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export type AgentEventKind = 'start' | 'thought' | 'tool-call' | 'tool-result' | 'finish' | 'error';

export type AgentEvent = {
  at: string;
  sessionId: string;
  role: AgentRole;
  kind: AgentEventKind;
  summary: string;
  tool?: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  costUsd?: number;
};

export type AgentState = 'idle' | 'running' | 'done' | 'failed';

export type AgentStatus = {
  role: AgentRole | 'runner' | 'publisher' | 'patrol';
  state: AgentState;
  detail: string;
  sessionId?: string;
  pid: number;
  updatedAt: string;
};

export type RegressionStatus = 'open' | 'filed' | 'dismissed' | 'fixed';

/** A confirmed slowdown on the main line. The issue analogue of Bugpatrol. */
export type Regression = {
  id: string;
  /** benchmark + metric. One regression per fingerprint is open at a time. */
  fingerprint: string;
  benchmark: string;
  metric: string;
  status: RegressionStatus;
  createdAt: string;
  updatedAt: string;
  /** The last good and the first bad commit that Speedpatrol measured. */
  goodSha: string;
  badSha: string;
  comparisonId: string;
  deltaPct: number;
  title: string;
  /** The analyst's explanation: suspect commits, hot functions, next steps. */
  analysis?: string;
  suspects?: { sha: string; subject: string; reason: string }[];
  issueUrl?: string;
  /** Dismissed by a human or the analyst, with the reason. */
  reason?: string;
};

export type ExperimentStatus = 'proposed' | 'measuring' | 'improved' | 'rejected' | 'failed' | 'published';

/** An optimizer's attempt at a speed-up. The fix analogue of Bugpatrol. */
export type Experiment = {
  id: string;
  target: { benchmark: string; metric: string };
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  branch: string;
  worktree: string;
  baseSha: string;
  headSha?: string;
  /** What the change does, in a reviewer's words. The commit subject and the PR title. */
  title?: string;
  hypothesis?: string;
  summary?: string;
  comparisonId?: string;
  deltaPct?: number;
  /** Other benchmarks that got slower. An experiment with any is rejected. */
  collateral?: string[];
  prUrl?: string;
  reason?: string;
};
