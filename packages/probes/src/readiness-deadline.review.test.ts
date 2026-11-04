import { setTimeout as delay } from 'node:timers/promises';
import { errors, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { runStep } from './probes/web.js';

it('does not accept a visibility response arriving after the readiness deadline', async () => {
  // Playwright isVisible sends its renderer query with kNoTimeout. A busy
  // renderer can therefore answer well after the benchmark's deadline.
  const page = {
    locator: () => ({
      first: () => ({
        isVisible: async () => {
          await delay(200);
          return true;
        },
      }),
    }),
  } as unknown as Page;
  await expect(
    runStep(
      page,
      { name: 'ready', waitFor: '#ready', waitForNetworkIdle: false },
      { source: process.cwd(), vars: {}, timeoutMs: 50, log: () => {} },
    ),
  ).rejects.toBeInstanceOf(errors.TimeoutError);
});
