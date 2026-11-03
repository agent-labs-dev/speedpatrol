import { ConfigError, gh, git, tryGit } from '@speedpatrol/core';

/** `123`, `#123`, or a pull request URL such as `https://github.com/o/r/pull/123/files`. */
export function prNumber(value: string): number {
  const match = value.trim().match(/^#?(\d+)$|^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/);
  const number = Number(match?.[1] ?? match?.[2]);
  if (!Number.isInteger(number) || number <= 0)
    throw new ConfigError(`--pr must be a pull request number or URL, not "${value}"`);
  return number;
}

export type PullRequest = {
  number: number;
  /** The sha of the pull request's head commit, fetched from origin. */
  head: string;
  /** `origin/<base branch>`. */
  base: string;
};

/**
 * Reads a pull request with gh, then fetches its head from origin as
 * `refs/pull/<n>/head`, which also holds the head of a pull request from a
 * fork. Fetches the base branch too, unless the caller has its own base.
 */
export async function fetchPullRequest(
  repo: string,
  value: string,
  options: { fetchBase: boolean },
): Promise<PullRequest> {
  const number = prNumber(value);
  let view: { headRefOid: string; baseRefName: string };
  try {
    // A URL goes to gh as it is, so gh reads the repository that the URL names.
    const target = value.startsWith('https://') ? value : String(number);
    view = JSON.parse(await gh(repo, ['pr', 'view', target, '--json', 'headRefOid,baseRefName']));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const reason = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new ConfigError(`gh could not read pull request #${number}: ${reason}`);
  }
  const refspecs = [`refs/pull/${number}/head`];
  if (options.fetchBase) refspecs.push(`+refs/heads/${view.baseRefName}:refs/remotes/origin/${view.baseRefName}`);
  try {
    await git(repo, ['fetch', '--quiet', 'origin', ...refspecs]);
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new ConfigError(`Could not fetch pull request #${number} from origin: ${reason}`);
  }
  // origin is a different repository than the one gh read, or the PR got a new push.
  if (!(await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${view.headRefOid}^{commit}`])))
    throw new ConfigError(
      `Pull request #${number} has head ${view.headRefOid.slice(0, 10)}, but origin does not have it. Is origin the repository of the pull request?`,
    );
  return { number, head: view.headRefOid, base: `origin/${view.baseRefName}` };
}
