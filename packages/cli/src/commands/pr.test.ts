import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, type LoadedConfig, loadConfig, Store } from '@speedpatrol/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgv } from '../argv.js';
import { compareCommand } from './measure.js';
import { fetchPullRequest, prNumber } from './pr.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

function commit(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * Puts a fake `gh` first on PATH. It records its arguments and answers with
 * the given output and exit code, as the real gh does.
 */
function fakeGh(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(root, 'gh-calls');
  const answer = (reply: { stdout?: string; stderr?: string; code?: number }) => {
    writeFileSync(join(root, 'gh-stdout'), reply.stdout ?? '');
    writeFileSync(join(root, 'gh-stderr'), reply.stderr ?? '');
    writeFileSync(join(root, 'gh-code'), String(reply.code ?? 0));
  };
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> '${calls}'\ncat '${root}/gh-stdout'\ncat '${root}/gh-stderr' >&2\nexit $(cat '${root}/gh-code')\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  answer({});
  return {
    bin,
    answer,
    calls: () => {
      try {
        return readFileSync(calls, 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    },
    reset: () => rmSync(calls, { force: true }),
  };
}

describe('prNumber', () => {
  it('reads a number, #number, or a GitHub pull request URL', () => {
    expect(prNumber('42')).toBe(42);
    expect(prNumber('#42')).toBe(42);
    expect(prNumber('https://github.com/agent-labs-dev/speedpatrol/pull/42')).toBe(42);
    expect(prNumber('https://github.com/agent-labs-dev/speedpatrol/pull/42/files')).toBe(42);
  });

  it('refuses anything else as a config error', () => {
    for (const value of [
      '',
      'abc',
      '0',
      '-3',
      '4.5',
      'https://github.com/o/r/issues/42',
      'https://gitlab.com/o/r/pull/42',
    ])
      expect(() => prNumber(value), value).toThrow(ConfigError);
  });

  it('is a valued flag of compare', () => {
    expect(parseArgv(['compare', '--pr', '42', 'api.items'])).toEqual({
      command: 'compare',
      positional: ['api.items'],
      flags: { pr: '42' },
    });
    expect(() => parseArgv(['compare', '--pr'])).toThrow('--pr needs a value');
  });
});

/**
 * A repo whose origin has a pull request from a fork: its head commit is on
 * no branch of origin, only on refs/pull/7/head. After the clone, main moves on
 * in origin, so a fetch of the base branch shows.
 */
describe('fetchPullRequest', () => {
  let root: string;
  let repo: string;
  let prHead: string;
  let newMain: string;
  let gh: ReturnType<typeof fakeGh>;
  const path = process.env.PATH;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'speedpatrol-pr-'));
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    commit(upstream, 'a.txt', 'a');
    git(root, 'clone', '-q', '--bare', upstream, 'origin.git');
    const origin = join(root, 'origin.git');
    git(root, 'clone', '-q', origin, 'repo');
    repo = join(root, 'repo');
    git(upstream, 'checkout', '-q', '-b', 'fork-branch');
    prHead = commit(upstream, 'b.txt', 'b');
    git(upstream, 'push', '-q', origin, `${prHead}:refs/pull/7/head`);
    git(upstream, 'checkout', '-q', 'main');
    newMain = commit(upstream, 'c.txt', 'c');
    git(upstream, 'push', '-q', origin, 'main');
    gh = fakeGh(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    process.env.PATH = `${gh.bin}:${path}`;
    gh.reset();
    gh.answer({ stdout: JSON.stringify({ headRefOid: prHead, baseRefName: 'main' }) });
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  it('fetches the head of a fork pull request and the base branch', async () => {
    expect(git(repo, 'rev-parse', 'origin/main')).not.toBe(newMain);
    await expect(fetchPullRequest(repo, '7', { fetchBase: true })).resolves.toEqual({
      number: 7,
      head: prHead,
      base: 'origin/main',
    });
    expect(gh.calls()).toEqual(['pr view 7 --json headRefOid,baseRefName']);
    expect(git(repo, 'cat-file', '-t', prHead)).toBe('commit');
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(newMain);
  });

  it('gives a URL to gh as it is, so gh reads the repository of the URL', async () => {
    const url = 'https://github.com/agent-labs-dev/speedpatrol/pull/7';
    await expect(fetchPullRequest(repo, url, { fetchBase: false })).resolves.toMatchObject({ head: prHead });
    expect(gh.calls()).toEqual([`pr view ${url} --json headRefOid,baseRefName`]);
  });

  it('says when gh is not installed', async () => {
    process.env.PATH = join(root, 'empty');
    await expect(fetchPullRequest(repo, '7', { fetchBase: true })).rejects.toThrow(
      new ConfigError('gh is not installed. Install the GitHub CLI: https://cli.github.com'),
    );
  });

  it('says when gh is not logged in', async () => {
    gh.answer({ stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', code: 4 });
    await expect(fetchPullRequest(repo, '7', { fetchBase: true })).rejects.toThrow(/not logged in/);
    gh.answer({ stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n', code: 1 });
    await expect(fetchPullRequest(repo, '7', { fetchBase: true })).rejects.toThrow(/not logged in/);
  });

  it('passes on what gh says when the pull request does not exist', async () => {
    gh.answer({ stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7.\n', code: 1 });
    const failure = fetchPullRequest(repo, '7', { fetchBase: true });
    await expect(failure).rejects.toThrow(ConfigError);
    await expect(failure).rejects.toThrow('gh could not read pull request #7: GraphQL: Could not resolve');
  });

  it('refuses a pull request whose head origin does not have', async () => {
    gh.answer({ stdout: JSON.stringify({ headRefOid: 'f'.repeat(40), baseRefName: 'main' }) });
    await expect(fetchPullRequest(repo, '7', { fetchBase: true })).rejects.toThrow(/origin does not have it/);
  });

  describe('compare --pr', () => {
    let loaded: LoadedConfig;
    beforeAll(async () => {
      mkdirSync(join(repo, '.speedpatrol'));
      writeFileSync(
        join(repo, '.speedpatrol', 'speedpatrol.yml'),
        'version: 1\nproject: { name: pr-test, source: . }\nbenchmarks:\n  - id: noop\n    kind: command\n    run: "true"\n',
      );
      loaded = await loadConfig(repo);
    });

    const compare = (options: { base?: string; head?: string; pr?: string }) =>
      compareCommand({
        loaded,
        store: new Store(loaded.dir),
        ...options,
        only: [],
        rounds: 1,
        iterations: 1,
        log: () => {},
      });

    it('measures the pull request head against origin/<base branch>', async () => {
      const comparison = await compare({ pr: '7' });
      expect([comparison.base.label, comparison.head.label]).toEqual(['origin/main', '#7']);
      expect(comparison.head.sha).toBe(prHead);
      expect(comparison.base.sha).toBe(newMain);
    });

    it('lets --base override the base branch', async () => {
      const comparison = await compare({ pr: '7', base: 'HEAD' });
      expect(comparison.base.label).toBe('HEAD');
      expect(comparison.head.sha).toBe(prHead);
    });

    it('refuses --pr with --head before it calls gh', async () => {
      await expect(compare({ pr: '7', head: 'HEAD' })).rejects.toThrow(
        new ConfigError('Give --pr or --head, not both.'),
      );
      expect(gh.calls()).toEqual([]);
    });
  });
});
