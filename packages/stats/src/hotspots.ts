import type { Hotspot } from '@speedpatrol/core';

export type HotspotDelta = {
  function: string;
  location: string;
  baseMs: number;
  headMs: number;
  deltaMs: number;
};

/**
 * Which functions gained or lost self time between two profiles, largest
 * change first. The analyst reads this to name the code behind a regression.
 */
export function diffHotspots(base: readonly Hotspot[], head: readonly Hotspot[], limit = 15): HotspotDelta[] {
  const key = (spot: Hotspot) => `${spot.function}@${spot.location}`;
  const merged = new Map<string, HotspotDelta>();
  for (const spot of base) {
    merged.set(key(spot), {
      function: spot.function,
      location: spot.location,
      baseMs: spot.selfMs,
      headMs: 0,
      deltaMs: 0,
    });
  }
  for (const spot of head) {
    const entry = merged.get(key(spot)) ?? {
      function: spot.function,
      location: spot.location,
      baseMs: 0,
      headMs: 0,
      deltaMs: 0,
    };
    entry.headMs = spot.selfMs;
    merged.set(key(spot), entry);
  }
  return [...merged.values()]
    .map((entry) => ({ ...entry, deltaMs: entry.headMs - entry.baseMs }))
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))
    .slice(0, limit);
}
