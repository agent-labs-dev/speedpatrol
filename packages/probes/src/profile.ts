import type { Hotspot } from '@speedpatrol/core';

/** The V8 `.cpuprofile` format, as written by `--cpu-prof` and CDP `Profiler.stop`. */
export type CpuProfile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
    hitCount?: number;
  }[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

const IDLE = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

/**
 * The functions that spent the most time on the CPU themselves (self time),
 * with their total (inclusive) time. Idle and the root are left out, except
 * the garbage collector, which is reported because allocation churn is a
 * common cause of a slowdown.
 */
export function hotspots(profile: CpuProfile, limit = 20): Hotspot[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    // Each sample's time is the delta to the next sample.
    const us = Math.max(0, deltas[i + 1] ?? 0);
    selfUs.set(samples[i]!, (selfUs.get(samples[i]!) ?? 0) + us);
  }
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

  const totalUs = new Map<number, number>();
  for (const [id, us] of selfUs) {
    // Count a frame once per sample path, even when it recurses.
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const key = frameKey(byId.get(at)!);
      if (seen.has(key)) continue;
      seen.add(key);
      totalUs.set(at, (totalUs.get(at) ?? 0) + us);
    }
  }

  const merged = new Map<string, Hotspot>();
  const totalTime = [...selfUs.values()].reduce((sum, us) => sum + us, 0) || 1;
  for (const node of profile.nodes) {
    const name = node.callFrame.functionName || '(anonymous)';
    if (IDLE.has(name) && name !== '(garbage collector)') continue;
    const key = frameKey(node);
    const self = (selfUs.get(node.id) ?? 0) / 1000;
    const total = (totalUs.get(node.id) ?? 0) / 1000;
    const entry = merged.get(key) ?? {
      function: name,
      location: location(node.callFrame),
      selfMs: 0,
      totalMs: 0,
      selfPercent: 0,
    };
    entry.selfMs += self;
    entry.totalMs = Math.max(entry.totalMs, total);
    merged.set(key, entry);
  }
  return [...merged.values()]
    .map((entry) => ({ ...entry, selfPercent: (entry.selfMs * 1000 * 100) / totalTime }))
    .filter((entry) => entry.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      selfMs: round(entry.selfMs),
      totalMs: round(entry.totalMs),
      selfPercent: round(entry.selfPercent),
    }));
}

function frameKey(node: CpuProfile['nodes'][number]): string {
  return `${node.callFrame.functionName}@${location(node.callFrame)}`;
}

function location(frame: CpuProfile['nodes'][number]['callFrame']): string {
  if (!frame.url) return '(native)';
  const url = frame.url.replace(/^file:\/\//, '');
  return `${url}:${frame.lineNumber + 1}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
