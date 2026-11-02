import { ConfigError, type RoleRuntime } from '@speedpatrol/core';
import { callTool } from '../mcp-server.js';
import type { EventSink, RoleOutcome, RoleTask, Runtime } from '../types.js';

type ModelUse = Extract<RoleRuntime, { runtime: 'model' }>;
type Message = Record<string, unknown>;
type Call = { id: string; name: string; input: Record<string, unknown> };

const ENDPOINTS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: 'OPENROUTER_API_KEY' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', key: 'ANTHROPIC_API_KEY' },
  custom: { url: '', key: 'SPEEDPATROL_MODEL_API_KEY' },
} as const;

/**
 * Speedpatrol's own tool-use loop, for a team that runs roles on an API key
 * instead of a local CLI. OpenAI-compatible chat completions (OpenRouter,
 * OpenAI, any custom endpoint) or the Anthropic Messages API.
 */
export class ModelRuntime implements Runtime {
  readonly label: string;

  constructor(private readonly use: ModelUse) {
    this.label = `${use.via}:${use.model}`;
  }

  private endpoint(): { url: string; key: string; anthropic: boolean } {
    const entry = ENDPOINTS[this.use.via];
    const url =
      this.use.via === 'custom'
        ? `${(this.use.endpoint ?? process.env.SPEEDPATROL_MODEL_ENDPOINT ?? '').replace(/\/$/, '')}/chat/completions`
        : entry.url;
    const key = process.env[entry.key] ?? '';
    if (!key) throw new ConfigError(`Set ${entry.key} to run a role on ${this.use.via}.`);
    if (url === '/chat/completions') throw new ConfigError('Set agents.<role>.use.endpoint for a custom model.');
    return { url, key, anthropic: this.use.via === 'anthropic' };
  }

  async run(task: RoleTask, emit: EventSink): Promise<RoleOutcome> {
    const { url, key, anthropic } = this.endpoint();
    const deadline = Date.now() + task.timeoutMs;
    const budget = { calls: 0, max: task.maxSteps };
    const messages: Message[] = anthropic
      ? [{ role: 'user', content: task.prompt }]
      : [
          { role: 'system', content: task.system },
          { role: 'user', content: task.prompt },
        ];
    let costUsd = 0;
    let lastText = '';
    for (let turn = 0; ; turn++) {
      if (Date.now() > deadline)
        return { stop: 'timeout', steps: budget.calls, costUsd, summary: lastText, finished: false };
      if (task.budgetUsd !== undefined && costUsd >= task.budgetUsd) {
        return { stop: 'budget', steps: budget.calls, costUsd, summary: lastText, finished: false };
      }
      if (turn > task.maxSteps + 5)
        return { stop: 'max-steps', steps: budget.calls, costUsd, summary: lastText, finished: false };
      const response = await fetch(url, {
        method: 'POST',
        headers: anthropic
          ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(
          anthropic
            ? {
                model: this.use.model,
                max_tokens: 8192,
                system: task.system,
                messages,
                tools: task.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
              }
            : {
                model: this.use.model,
                messages,
                tools: task.tools.map((tool) => ({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                })),
                ...(this.use.via === 'openrouter' ? { usage: { include: true } } : {}),
              },
        ),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
      if (!response.ok) {
        const error = `${response.status} ${(await response.text()).slice(0, 500)}`;
        return { stop: 'error', steps: budget.calls, costUsd, error, finished: false };
      }
      const payload = (await response.json()) as Record<string, unknown>;
      costUsd += Number((payload.usage as { cost?: number } | undefined)?.cost ?? 0);
      const { text, calls, assistant } = anthropic ? parseAnthropic(payload) : parseOpenAi(payload);
      messages.push(assistant);
      if (text.trim()) {
        lastText = text;
        emit({ kind: 'thought', summary: text.slice(0, 300) });
      }
      if (calls.length === 0) return { stop: 'done', steps: budget.calls, costUsd, summary: lastText, finished: false };
      const results: Message[] = [];
      for (const call of calls) {
        emit({ kind: 'tool-call', summary: `Called ${call.name}.`, tool: call.name, input: call.input });
        const started = Date.now();
        const result = await callTool(task.tools, call.name, call.input, budget);
        emit({
          kind: 'tool-result',
          summary: result.summary ?? `${call.name}: ${result.text.split('\n')[0]?.slice(0, 160) ?? ''}`,
          tool: call.name,
          output: result.text.slice(0, 2000),
          durationMs: Date.now() - started,
        });
        results.push(
          anthropic
            ? { type: 'tool_result', tool_use_id: call.id, content: result.text, is_error: result.isError ?? false }
            : { role: 'tool', tool_call_id: call.id, content: result.text },
        );
        if (result.done) return { stop: 'done', steps: budget.calls, costUsd, summary: result.text, finished: true };
      }
      if (anthropic) messages.push({ role: 'user', content: results });
      else messages.push(...results);
    }
  }
}

function parseOpenAi(payload: Record<string, unknown>): { text: string; calls: Call[]; assistant: Message } {
  const message = (
    payload.choices as {
      message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    }[]
  )?.[0]?.message;
  const calls = (message?.tool_calls ?? []).map((call) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      /* the tool reports the missing fields */
    }
    return { id: call.id, name: call.function.name, input };
  });
  return {
    text: message?.content ?? '',
    calls,
    assistant: { role: 'assistant', content: message?.content ?? null, tool_calls: message?.tool_calls },
  };
}

function parseAnthropic(payload: Record<string, unknown>): { text: string; calls: Call[]; assistant: Message } {
  const blocks = (payload.content ?? []) as {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }[];
  return {
    text: blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n'),
    calls: blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} })),
    assistant: { role: 'assistant', content: blocks },
  };
}
