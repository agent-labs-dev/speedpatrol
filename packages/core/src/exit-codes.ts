export const EXIT = {
  ok: 0,
  /** A comparison found a regression on a primary metric. */
  regression: 1,
  config: 2,
  /** Speedpatrol could not measure, e.g. the app did not start. */
  infra: 4,
} as const;
