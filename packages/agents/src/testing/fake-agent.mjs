// A stand-in for `claude -p`: it connects to the Speedpatrol MCP server in the
// config file given as its argument and makes the tool calls listed in
// FAKE_AGENT_SCRIPT, in order. `{"edit": {"file", "from", "to"}}` edits a file
// in the working directory instead, the way an optimizer would. It prints the
// result the way `claude -p --output-format json` does.
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const steps = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? '[]');
const client = new Client({ name: 'fake-agent', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.speedpatrol.url)));
const { tools } = await client.listTools();
const log = [`tools: ${tools.map((tool) => tool.name).join(',')}`];
for (const step of steps) {
  if (step.edit) {
    const text = readFileSync(step.edit.file, 'utf8');
    writeFileSync(step.edit.file, text.replace(step.edit.from, step.edit.to));
    log.push(`edited ${step.edit.file}`);
    continue;
  }
  const result = await client.callTool({ name: step.tool, arguments: step.input ?? {} });
  const text = result.content.map((part) => part.text).join('\n');
  log.push(`${step.tool}: ${result.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
  if (result.isError && step.mustSucceed !== false) {
    console.log(JSON.stringify({ result: log.join('\n'), is_error: true, total_cost_usd: 0 }));
    process.exit(0);
  }
}
await client.close();
console.log(JSON.stringify({ result: log.join('\n'), total_cost_usd: 0.0123 }));
