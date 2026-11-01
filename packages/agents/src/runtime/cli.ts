import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoleRuntime } from '@speedpatrol/core';
import { serveTools } from '../mcp-server.js';
import type { EventSink, RoleOutcome, RoleTask, Runtime } from '../types.js';

type CliUse = Extract<RoleRuntime, { runtime: 'cli' }>;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One line of output as feed text: a JSON event becomes its message, or nothing. */
function displayLine(line: string): string {
  if (!line.trimStart().startsWith('{')) return line;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: string };
      part?: { type?: string; text?: string };
    };
    if (event.type === 'item.completed' && typeof event.item?.text === 'string') return event.item.text;
    if (event.type === 'text' && typeof event.part?.text === 'string') return event.part.text;
    return '';
  } catch {
    return line;
  }
}

/**
 * What a CLI printed. `claude -p --output-format json` prints one object with
 * the result and its cost; `codex exec --json` and `opencode run --format
 * json` print one event per line.
 */
export function parseCliOutput(stdout: string): { text: string; costUsd: number; error?: string } {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const claude = JSON.parse(trimmed) as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
      if (typeof claude.result === 'string') {
        return {
          text: claude.result,
          costUsd: typeof claude.total_cost_usd === 'number' ? claude.total_cost_usd : 0,
          ...(claude.is_error === true ? { error: claude.result } : {}),
        };
      }
    } catch {
      /* not one object: read it line by line */
    }
  }
  const text = trimmed.split('\n').map(displayLine).filter(Boolean).join('\n');
  return { text, costUsd: 0 };
}

/**
 * A local agent CLI (claude, codex, opencode, or any command) runs the role.
 * It gets the prompt on stdin and in `{prompt}`, and the role's tools over a
 * local MCP server in `{mcp}` / `{mcpUrl}`.
 */
export class CliRuntime implements Runtime {
  readonly label: string;

  constructor(private readonly use: CliUse) {
    this.label = `cli:${use.agent ?? use.command?.trim().split(/\s+/)[0] ?? 'shell'}`;
  }

  async run(task: RoleTask, emit: EventSink): Promise<RoleOutcome> {
    const temp = await mkdtemp(join(tmpdir(), 'speedpatrol-agent-'));
    let summary = '';
    let finished = false;
    let steps = 0;
    const mcp = await serveTools(task.tools, {
      maxCalls: task.maxSteps,
      onCall(name, input, result, ms) {
        steps++;
        emit({ kind: 'tool-call', summary: `Called ${name}.`, tool: name, input });
        emit({
          kind: 'tool-result',
          summary: result.summary ?? `${name}: ${result.text.split('\n')[0]?.slice(0, 160) ?? ''}`,
          tool: name,
          output: result.text.slice(0, 2000),
          durationMs: ms,
        });
        if (result.done) {
          summary = result.text;
          finished = true;
        }
      },
    });
    try {
      const prompt = `${task.system}\n\n${task.prompt}`;
      const promptFile = join(temp, 'prompt.md');
      const mcpFile = join(temp, 'mcp.json');
      await writeFile(promptFile, prompt);
      await writeFile(mcpFile, JSON.stringify({ mcpServers: { speedpatrol: { type: 'http', url: mcp.url } } }));
      const values: Record<string, string> = {
        prompt: promptFile,
        mcp: mcpFile,
        mcpUrl: mcp.url,
        workdir: task.workdir,
      };
      const command = (this.use.command ?? '').replace(/\{(prompt|mcp|mcpUrl|workdir)\}/g, (_, name: string) =>
        quote(values[name]!),
      );
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: task.workdir,
        // measure_change runs for minutes; Claude Code's default MCP tool
        // timeout abandons it and the agent calls it again over the first. It also
        // aborts any call silent for 300 s (an A/B, or a call queued behind one).
        env: {
          MCP_TOOL_TIMEOUT: String(task.timeoutMs),
          CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(task.timeoutMs),
          ...process.env,
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);
      let stdout = '';
      let stderr = '';
      let partial = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = (partial + chunk.toString()).split('\n');
        partial = lines.pop() ?? '';
        const text = lines.map(displayLine).filter(Boolean).join('\n').trim();
        if (text) emit({ kind: 'thought', summary: text.slice(-300) });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
      }, task.timeoutMs);
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      }).finally(() => clearTimeout(timer));
      const parsed = parseCliOutput(stdout);
      if (parsed.text) emit({ kind: 'thought', summary: parsed.text.slice(-300), costUsd: parsed.costUsd });
      const base = { steps, costUsd: parsed.costUsd, summary: summary || parsed.text, finished };
      if (timedOut) return { ...base, stop: 'timeout' };
      if (code !== 0 || parsed.error) {
        return {
          ...base,
          stop: 'error',
          error: parsed.error || stderr.trim().split('\n').slice(-20).join('\n') || `CLI exited ${code}`,
        };
      }
      if (!finished && task.tools.some((tool) => tool.name === 'finish')) {
        return {
          ...base,
          stop: 'error',
          error: 'CLI exited without completing the finish tool. Check tool approvals and agent output.',
        };
      }
      return { ...base, stop: 'done' };
    } finally {
      await mcp.close();
      await rm(temp, { recursive: true, force: true });
    }
  }
}
