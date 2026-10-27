export type Argv = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

const COMMANDS = new Set([
  'patrol',
  'init',
  'run',
  'compare',
  'scout',
  'analyze',
  'optimize',
  'publish',
  'dashboard',
  'baselines',
  'regressions',
  'doctor',
  'help',
]);

/** Flags that take a value. Every other flag is a boolean. */
const VALUED = new Set([
  'base',
  'head',
  'iterations',
  'rounds',
  'port',
  'focus',
  'agent',
  'markdown',
  'reason',
  'platform',
  'cwd',
]);

/**
 * `speedpatrol [command] [args] [--flag value | --flag]`. No command means
 * the patrol, as `npx bugpatrol` does.
 */
export function parseArgv(args: string[]): Argv {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (name.startsWith('no-')) flags[name.slice(3)] = false;
      else if (inline !== undefined) flags[name] = inline;
      else if (VALUED.has(name)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
        flags[name] = value;
        i++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  const command = positional[0] && COMMANDS.has(positional[0]) ? positional.shift()! : 'patrol';
  return { command, positional, flags };
}

export function intFlag(flags: Argv['flags'], name: string): number | undefined {
  const value = flags[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

export function strFlag(flags: Argv['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}
