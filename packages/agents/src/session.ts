import { type AgentEvent, type AgentRole, newId, type RoleRuntime, redact, type Store } from '@speedpatrol/core';
import { createRuntime } from './runtime/index.js';
import type { RoleOutcome, RoleTask, Tool } from './types.js';

export type RoleRun = {
  role: AgentRole;
  use: RoleRuntime;
  system: string;
  prompt: string;
  tools: Tool[];
  maxSteps: number;
  timeoutMinutes: number;
  budgetUsd?: number;
  workdir: string;
  store: Store;
  secrets: string[];
  log?: (line: string) => void;
};

/**
 * Runs one role session: its events go to `sessions/<id>/events.jsonl` and
 * its status to `agents.json`, with every secret value redacted, so the
 * dashboard can show the session live.
 */
export async function runRole(run: RoleRun): Promise<RoleOutcome & { sessionId: string }> {
  const sessionId = `${newId()}-${run.role}`;
  const runtime = createRuntime(run.use);
  const clean = (text: string) => redact(text, run.secrets);
  const writes: Promise<void>[] = [];
  const record = (event: Omit<AgentEvent, 'at' | 'sessionId' | 'role'>) => {
    const full: AgentEvent = {
      ...event,
      summary: clean(event.summary),
      output: event.output === undefined ? undefined : clean(event.output),
      at: new Date().toISOString(),
      sessionId,
      role: run.role,
    };
    writes.push(run.store.appendEvent(full));
    if (event.kind !== 'tool-result') run.log?.(`[${run.role}] ${full.summary.split('\n')[0]}`);
  };
  await run.store.setStatus({ role: run.role, state: 'running', detail: `Running on ${runtime.label}`, sessionId });
  record({ kind: 'start', summary: `${run.role} started on ${runtime.label}.` });
  const task: RoleTask = {
    role: run.role,
    sessionId,
    system: run.system,
    prompt: run.prompt,
    tools: run.tools,
    maxSteps: run.maxSteps,
    budgetUsd: run.budgetUsd,
    timeoutMs: run.timeoutMinutes * 60_000,
    workdir: run.workdir,
  };
  let outcome: RoleOutcome;
  try {
    outcome = await runtime.run(task, record);
  } catch (error) {
    outcome = { stop: 'error', steps: 0, costUsd: 0, finished: false, error: (error as Error).message };
  }
  record({
    kind: outcome.stop === 'error' ? 'error' : 'finish',
    summary: outcome.error
      ? `Stopped: ${outcome.error}`
      : `Finished (${outcome.stop}): ${outcome.summary ?? ''}`.slice(0, 500),
    costUsd: outcome.costUsd,
  });
  await Promise.all(writes);
  await run.store.setStatus({
    role: run.role,
    state: outcome.stop === 'error' ? 'failed' : 'done',
    detail: (outcome.error ?? outcome.summary ?? outcome.stop).split('\n')[0]!.slice(0, 200),
    sessionId,
  });
  return { ...outcome, sessionId };
}
