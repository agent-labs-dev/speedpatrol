import type { AgentRole } from '../types/agents.js';

/**
 * Local agent CLIs that can run a role (ADR 0003). The scout and the analyst
 * act through the Speedpatrol MCP tools and read the repo; the optimizer
 * edits files in its worktree, so its command runs in the CLI's auto
 * permission mode.
 *
 * `use: claude` in speedpatrol.yml expands to the preset for the role. A
 * `command` wins over the preset, for teams that need extra flags.
 */
export const CLI_AGENTS = ['claude', 'codex', 'opencode'] as const;
export type CliAgent = (typeof CLI_AGENTS)[number];

const PRESETS: Record<CliAgent, { tools: string; editor: string }> = {
  claude: {
    tools:
      "claude -p --output-format json --tools 'Read,Grep,Glob' --mcp-config {mcp} --strict-mcp-config --allowedTools 'mcp__speedpatrol,Read,Grep,Glob'",
    editor: 'claude -p --output-format json --permission-mode auto --mcp-config {mcp} --allowedTools mcp__speedpatrol',
  },
  codex: {
    tools: 'codex exec --json --skip-git-repo-check --sandbox read-only -c mcp_servers.speedpatrol.url={mcpUrl} -',
    editor:
      'codex exec --json --skip-git-repo-check --sandbox workspace-write -c mcp_servers.speedpatrol.url={mcpUrl} -',
  },
  opencode: {
    tools: `OPENCODE_CONFIG_CONTENT='{"mcp":{"speedpatrol":{"type":"remote","url":"'{mcpUrl}'","oauth":false}},"permission":{"edit":"deny","bash":"deny"}}' opencode run --format json`,
    editor: `OPENCODE_CONFIG_CONTENT='{"mcp":{"speedpatrol":{"type":"remote","url":"'{mcpUrl}'","oauth":false}}}' opencode run --format json`,
  },
};

export function cliPreset(agent: CliAgent, role: AgentRole): string {
  return role === 'optimizer' ? PRESETS[agent].editor : PRESETS[agent].tools;
}
