import { arch, cpus, hostname, loadavg, platform, totalmem } from 'node:os';
import { hash } from './ids.js';
import type { MachineInfo } from './types/run.js';

/**
 * The fingerprint covers what changes timings: the CPU, the core count, the
 * memory, the OS and the Node major. `SPEEDPATROL_MACHINE` overrides it, for a
 * fleet of identical runners that should share one baseline.
 */
export function machineInfo(): MachineInfo {
  const cpu = cpus();
  const info = {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpu[0]?.model.trim() ?? 'unknown',
    cpus: cpu.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
    load: { start: loadavg()[0] ?? 0 },
  };
  const fingerprint =
    process.env.SPEEDPATROL_MACHINE ||
    hash([info.platform, info.arch, info.cpuModel, info.cpus, info.memoryGb, info.node.split('.')[0]], 10);
  return { fingerprint, ...info };
}

/** Warns when the 1 minute load at the start or the end of a run exceeds the core count. */
export function loadWarning(machine: MachineInfo): string | undefined {
  if (!machine.load) return undefined;
  const { start, end } = machine.load;
  const [when, load] = end !== undefined && end > start ? ['end', end] : ['start', start];
  if (load <= machine.cpus) return undefined;
  return `Machine load ${load.toFixed(2)} on ${machine.cpus} cores at ${when}: timings are unreliable.`;
}
