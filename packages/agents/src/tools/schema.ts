import type { Tool, ToolResult } from '../types.js';

type Field = { type: string; description: string; items?: unknown; enum?: string[]; properties?: unknown };

/** A tool with a flat object schema: every field listed, `required` named. */
export function tool(
  name: string,
  description: string,
  fields: Record<string, Field>,
  required: string[],
  run: (input: Record<string, unknown>) => Promise<ToolResult>,
  options: { exclusive?: boolean } = {},
): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: fields, required, additionalProperties: false },
    run,
    ...options,
  };
}

export function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

export function optionalStr(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function finishTool(description: string, onFinish?: (summary: string) => Promise<void> | void): Tool {
  return tool(
    'finish',
    description,
    { summary: { type: 'string', description: 'What you did and what you found, for the team.' } },
    ['summary'],
    async (input) => {
      const summary = str(input, 'summary');
      await onFinish?.(summary);
      return { text: summary, done: true, summary: 'Finished.' };
    },
  );
}
