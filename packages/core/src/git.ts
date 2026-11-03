import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigError } from './errors.js';

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/**
 * Runs the GitHub CLI. A missing `gh` or a missing login is a ConfigError:
 * the user must fix the machine, not retry.
 */
export async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: string };
    if (code === 'ENOENT') throw new ConfigError('gh is not installed. Install the GitHub CLI: https://cli.github.com');
    // gh exits 4 when it has no login; a bad token gives HTTP 401.
    if (code === 4 || /HTTP 401|gh auth login/.test(stderr ?? ''))
      throw new ConfigError('gh is not logged in. Run `gh auth login`, or set GH_TOKEN.');
    throw error;
  }
}

export type CommitInfo = { sha: string; subject: string; author: string; date: string };

export async function sourceInfo(
  dir: string,
): Promise<{ sha: string; branch?: string; dirty: boolean; subject?: string }> {
  const sha = (await tryGit(dir, ['rev-parse', 'HEAD'])) ?? 'unknown';
  const branch = await tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Speedpatrol's own runs folder is ignored, so it never makes a tree dirty.
  const status = await tryGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  const subject = await tryGit(dir, ['log', '-1', '--format=%s']);
  return { sha, branch: branch === 'HEAD' ? undefined : branch, dirty: Boolean(status), subject };
}

/** Commits in `base..head`, newest first. */
export async function commitsBetween(dir: string, base: string, head: string, limit = 50): Promise<CommitInfo[]> {
  const out = await tryGit(dir, ['log', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%an%x1f%cI', `${base}..${head}`]);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha = '', subject = '', author = '', date = ''] = line.split('\x1f');
    return { sha, subject, author, date };
  });
}
