import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { tryGit } from '@speedpatrol/core';
import type { Tool } from '../types.js';
import { optionalStr, str, tool } from './schema.js';

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..')) throw new Error(`${path} is outside the repository`);
  return full;
}

/**
 * Read-only repository tools. A CLI agent has its own file tools; these let
 * a model runtime read the code too, and keep every role inside the repo.
 */
export function repoTools(root: string): Tool[] {
  return [
    tool(
      'list_files',
      'List tracked files in the repository. Filter by a path substring, e.g. "routes" or ".tsx".',
      { filter: { type: 'string', description: 'Substring of the path. Optional.' } },
      [],
      async (input) => {
        const filter = optionalStr(input, 'filter');
        const files = ((await tryGit(root, ['ls-files'])) ?? '')
          .split('\n')
          .filter((file) => !filter || file.includes(filter));
        return {
          text: files.slice(0, 400).join('\n') + (files.length > 400 ? `\n... ${files.length - 400} more` : ''),
        };
      },
    ),
    tool(
      'read_file',
      'Read a file of the repository, with line numbers.',
      {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        start: { type: 'number', description: 'First line, 1-based. Default 1.' },
        lines: { type: 'number', description: 'How many lines. Default 250.' },
      },
      ['path'],
      async (input) => {
        const text = await readFile(inside(root, str(input, 'path')), 'utf8');
        const start = Math.max(1, Number(input.start ?? 1));
        const count = Math.min(1000, Number(input.lines ?? 250));
        const all = text.split('\n');
        const body = all
          .slice(start - 1, start - 1 + count)
          .map((line, index) => `${start + index}\t${line}`)
          .join('\n');
        return { text: `${body}\n(${all.length} lines in the file)` };
      },
    ),
    tool(
      'search',
      'Search the repository with git grep (a regular expression). Returns file:line:text.',
      { pattern: { type: 'string', description: 'The regular expression.' } },
      ['pattern'],
      async (input) => {
        const out = (await tryGit(root, ['grep', '-n', '-I', '-E', '--max-count=20', str(input, 'pattern')])) ?? '';
        const lines = out.split('\n').filter(Boolean);
        return { text: lines.slice(0, 200).join('\n') || 'No match.' };
      },
    ),
  ];
}

/** Git history tools for the analyst. */
export function gitTools(root: string): Tool[] {
  return [
    tool(
      'git_log',
      'The commits in a range, newest first, with the files each one changed.',
      { range: { type: 'string', description: 'e.g. "abc123..def456"' } },
      ['range'],
      async (input) => ({
        text:
          (await tryGit(root, [
            'log',
            '--max-count=40',
            '--stat=120',
            '--format=%n%H %s (%an)',
            str(input, 'range'),
          ])) ?? 'No commits.',
      }),
    ),
    tool(
      'git_show',
      'The diff of one commit, optionally for one path. Long diffs are cut.',
      {
        sha: { type: 'string', description: 'The commit.' },
        path: { type: 'string', description: 'Only this path. Optional.' },
      },
      ['sha'],
      async (input) => {
        const path = optionalStr(input, 'path');
        const out =
          (await tryGit(root, ['show', '--format=%H %s%n%b', str(input, 'sha'), ...(path ? ['--', path] : [])])) ?? '';
        return { text: out.length > 30_000 ? `${out.slice(0, 30_000)}\n... cut (${out.length} chars)` : out };
      },
    ),
  ];
}
