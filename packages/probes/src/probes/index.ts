import type { Benchmark } from '@speedpatrol/core';
import { commandProbe } from './command.js';
import { customProbe } from './custom.js';
import { httpProbe } from './http.js';
import { androidProbe, iosProbe, maestroProbe } from './mobile.js';
import { startupProbe } from './startup.js';
import type { Probe, ProbeContext } from './types.js';
import { electronProbe, webProbe } from './web.js';

export function createProbe(benchmark: Benchmark, context: ProbeContext): Probe {
  switch (benchmark.kind) {
    case 'http':
      return httpProbe(benchmark, context);
    case 'command':
      return commandProbe(benchmark, context);
    case 'startup':
      return startupProbe(benchmark, context);
    case 'custom':
      return customProbe(benchmark, context);
    case 'web':
      return webProbe(benchmark, context);
    case 'electron':
      return electronProbe(benchmark, context);
    case 'android':
      return androidProbe(benchmark, context);
    case 'ios':
      return iosProbe(benchmark, context);
    case 'maestro':
      return maestroProbe(benchmark, context);
  }
}
