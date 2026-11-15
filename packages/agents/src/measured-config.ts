import { join, relative, sep } from 'node:path';
import { git, type LoadedConfig, loadConfigDir, newId, type Store } from '@speedpatrol/core';

/** Read committed metadata before setup can mutate a cached measurement checkout. */
export async function loadMeasuredConfig(loaded: LoadedConfig, store: Store, sha: string): Promise<LoadedConfig> {
  const configPath = relative(loaded.source, loaded.dir);
  // Profiles outside the source repository remain owned by the operator.
  if (configPath === '..' || configPath.startsWith(`..${sep}`)) return loaded;
  const dir = store.workspacePath('policy-checkouts', newId());
  await git(loaded.source, ['worktree', 'add', '--detach', dir, sha]);
  try {
    return { ...(await loadConfigDir(join(dir, configPath))), dir: loaded.dir, source: loaded.source };
  } finally {
    await git(loaded.source, ['worktree', 'remove', '--force', dir]);
  }
}
