/**
 * Replaces `${NAME}` with values from `vars`. An unknown name is left as is,
 * so a shell variable in a command still reaches the shell.
 */
export function interpolate(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => vars[name] ?? match);
}

/** Removes every secret value from text that goes to a log or a model. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}
