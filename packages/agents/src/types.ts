import type { AgentEvent, AgentRole } from '@speedpatrol/core';

/**
 * A tool is the contract between a role and its runtime (ADR 0003). The model
 * loop calls `run` in-process; the CLI runtime serves the same tool over MCP.
 * So a role behaves the same whatever runs it.
 */
export type ToolResult = {
  text: string;
  isError?: boolean;
  /** Set by `finish`: the runtime stops after this result. */
  done?: boolean;
  /** One sentence for the activity feed. The text is written for the model. */
  summary?: string;
};

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<ToolResult>;
};

export type RoleTask = {
  role: AgentRole;
  sessionId: string;
  /** Who the agent is, the rules, the app guide. */
  system: string;
  /** This session's goal and what is known. */
  prompt: string;
  tools: Tool[];
  maxSteps: number;
  budgetUsd?: number;
  timeoutMs: number;
  /** A CLI agent's working directory: the repo, or the experiment's worktree. */
  workdir: string;
};

export type RoleOutcome = {
  stop: 'done' | 'max-steps' | 'budget' | 'timeout' | 'error';
  steps: number;
  costUsd: number;
  /** The finish tool's summary, or the agent's last text. */
  summary?: string;
  finished: boolean;
  error?: string;
};

export type EventSink = (event: Omit<AgentEvent, 'at' | 'sessionId' | 'role'>) => void;

export interface Runtime {
  readonly label: string;
  run(task: RoleTask, emit: EventSink): Promise<RoleOutcome>;
}
