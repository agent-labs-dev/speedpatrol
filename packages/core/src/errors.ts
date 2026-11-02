/** A problem in the user's config or environment. The CLI exits with code 2. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** A measurement or agent session failed. The CLI exits with code 4. */
export class MeasureError extends Error {
  override readonly name = 'MeasureError';
}
