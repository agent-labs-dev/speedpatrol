import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadConfig } from '@speedpatrol/core';

const exec = promisify(execFile);

async function version(command: string, args = ['--version']): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout: 15_000 });
    return (stdout || stderr).trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/** Checks what Speedpatrol needs and reports each item. Returns false if one required item fails. */
export async function doctor(cwd: string, log: (line: string) => void): Promise<boolean> {
  let ok = true;
  const check = (label: string, value: string | undefined, required: boolean) => {
    log(
      `${value ? '✓' : required ? '✗' : '-'} ${label}${value ? `: ${value}` : required ? ': missing' : ': not found (optional)'}`,
    );
    if (!value && required) ok = false;
  };
  check('node >= 22', Number(process.versions.node.split('.')[0]) >= 22 ? process.versions.node : undefined, true);
  check('git', await version('git'), true);
  try {
    const loaded = await loadConfig(cwd);
    check('config', `${loaded.benchmarks.length} benchmarks in ${loaded.dir}`, true);
    const kinds = new Set(loaded.benchmarks.map((b) => b.kind));
    if (kinds.has('web') || kinds.has('electron')) {
      const { chromium } = await import('playwright');
      check(
        'chromium for playwright',
        existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined,
        true,
      );
    }
    if (kinds.has('android')) check('adb', await version('adb', ['version']), true);
    if (kinds.has('ios')) check('xcrun simctl', await version('xcrun', ['simctl', 'help']), true);
    if (kinds.has('maestro')) check('maestro', await version('maestro'), true);
    const agents = loaded.config.agents;
    for (const [role, settings] of Object.entries({
      scout: agents.scout,
      analyst: agents.analyst,
      optimizer: agents.optimizer,
    })) {
      if (!settings.enabled) continue;
      const use = settings.use;
      if (use.runtime === 'cli') {
        const program = use.command
          ?.trim()
          .split(/\s+/)
          .find((word) => !/^[A-Za-z_]+=/.test(word));
        check(`${role} agent (${program})`, program ? await version(program) : undefined, true);
      } else {
        check(`${role} model ${use.via}:${use.model}`, 'API key read at run time', true);
      }
    }
    if (agents.github.enabled) check('gh', await version('gh'), true);
  } catch (error) {
    check('config', undefined, true);
    log(`  ${(error as Error).message}`);
  }
  return ok;
}
