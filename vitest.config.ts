import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // The probe and agent tests time real processes: run files one at a time so
    // they never compete for the CPU (or for the fixture app's port).
    fileParallelism: false,
    // No test may reach a real model, whatever keys the shell holds.
    env: Object.fromEntries(
      [
        'OPENROUTER_API_KEY',
        'AI_GATEWAY_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'SPEEDPATROL_MODEL_ENDPOINT',
        'SPEEDPATROL_MODEL_API_KEY',
        'SPEEDPATROL_MODEL_NAME',
      ].map((key) => [key, '']),
    ),
  },
});
