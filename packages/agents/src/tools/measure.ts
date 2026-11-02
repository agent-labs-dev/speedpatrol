import type { LoadedConfig, Run, Store } from '@speedpatrol/core';
import { abCompare, checkout } from '@speedpatrol/probes';
import { comparisonMarkdown, diffHotspots, formatValue } from '@speedpatrol/stats';
import type { Tool } from '../types.js';
import { str, tool } from './schema.js';

/** The hottest functions of one benchmark in two runs, and what changed. */
export function profileDiffText(base: Run | undefined, head: Run | undefined, benchmark: string): string {
  const b = base?.results.find((result) => result.benchmark === benchmark)?.profile?.hotspots ?? [];
  const h = head?.results.find((result) => result.benchmark === benchmark)?.profile?.hotspots ?? [];
  if (!b.length && !h.length)
    return `No CPU profile for ${benchmark} (an HTTP benchmark profiles only the client; profile the server with a startup or custom benchmark).`;
  const rows = diffHotspots(b, h).map(
    (row) =>
      `${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs.toFixed(1)} ms  ${row.function}  ${row.location}  (${row.baseMs.toFixed(1)} -> ${row.headMs.toFixed(1)} ms self)`,
  );
  const top = h
    .slice(0, 10)
    .map((spot) => `${formatValue(spot.selfMs, 'ms')} self (${spot.selfPercent}%)  ${spot.function}  ${spot.location}`);
  return `Self-time change, largest first:\n${rows.join('\n')}\n\nHottest functions now:\n${top.join('\n')}`;
}

/**
 * A/B measures one commit against another for chosen benchmarks. The
 * analyst uses it to bisect: which commit in the range made it slower.
 */
export function measureCommitTool(loaded: LoadedConfig, store: Store, log: (line: string) => void): Tool {
  return tool(
    'measure_commit',
    'A/B measure a commit against a reference commit for some benchmarks, on this machine. Takes a minute or more. Use it to find the commit that caused a regression (bisect).',
    {
      sha: { type: 'string', description: 'The commit to measure.' },
      against: { type: 'string', description: 'The reference commit, e.g. the last good one.' },
      benchmarks: { type: 'array', items: { type: 'string' }, description: 'Benchmark ids.' },
    },
    ['sha', 'against', 'benchmarks'],
    async (input) => {
      const ids = (input.benchmarks as string[] | undefined) ?? [];
      const head = await checkout(loaded.source, store, str(input, 'sha'));
      const base = await checkout(loaded.source, store, str(input, 'against'));
      const { comparison } = await abCompare({
        loaded,
        store,
        base: { label: base.sha.slice(0, 8), dir: base.dir },
        head: { label: head.sha.slice(0, 8), dir: head.dir },
        only: ids,
        profile: false,
        log,
      });
      return {
        text: comparisonMarkdown(comparison),
        summary: `${head.sha.slice(0, 8)} vs ${base.sha.slice(0, 8)}: ${comparison.verdict}.`,
      };
    },
    { exclusive: true },
  );
}
