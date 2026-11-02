import { describe, expect, it } from 'vitest';
import { parseMetricsLine } from './probes/custom.js';
import { parseAmStart } from './probes/mobile.js';
import { hotspots } from './profile.js';

describe('parseAmStart', () => {
  it('reads the launch times Android printed', () => {
    const output =
      'Starting: Intent { cmp=com.x/.Main }\nStatus: ok\nLaunchState: COLD\nActivity: com.x/.Main\nTotalTime: 812\nWaitTime: 830\nComplete\n';
    expect(parseAmStart(output)).toEqual({ totalTime: 812, waitTime: 830 });
    expect(parseAmStart('Error: Activity not started')).toEqual({ totalTime: undefined, waitTime: undefined });
  });
});

describe('parseMetricsLine', () => {
  it('takes the last metrics line and ignores logs and non-numbers', () => {
    const stdout = 'warming up\n{"metrics":{"a":1}}\n{"note":"x"}\n{"metrics":{"a":2,"b":"slow"}}\ndone\n';
    expect(parseMetricsLine(stdout)).toEqual({ a: 2 });
    expect(parseMetricsLine('no json here')).toBeUndefined();
  });

  it('reads the list form that an e2e harness prints', () => {
    const stdout =
      '{"eval":"boot","metrics":[{"name":"chat.content_ms","value":2927.1,"unit":"ms","better":"lower"},{"name":"chat.heap_mb","value":38.14},{"name":"bad"}]}';
    expect(parseMetricsLine(stdout)).toEqual({ 'chat.content_ms': 2927.1, 'chat.heap_mb': 38.14 });
  });
});

describe('hotspots', () => {
  it('attributes self time to the sampled frame and total time to its callers', () => {
    const frame = (functionName: string, url = 'file:///app/x.js', lineNumber = 0) => ({
      functionName,
      url,
      lineNumber,
      columnNumber: 0,
    });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', ''), children: [2, 4] },
        { id: 2, callFrame: frame('main'), children: [3] },
        { id: 3, callFrame: frame('work', 'file:///app/x.js', 9) },
        { id: 4, callFrame: frame('(idle)', '') },
      ],
      startTime: 0,
      endTime: 4000,
      samples: [3, 3, 2, 4],
      timeDeltas: [0, 1000, 1000, 1000],
    };
    const spots = hotspots(profile);
    expect(spots.map((spot) => spot.function)).toEqual(['work', 'main']);
    expect(spots[0]).toMatchObject({ location: '/app/x.js:10', selfMs: 2 });
    expect(spots[1]).toMatchObject({ selfMs: 1, totalMs: 3 });
  });
});
