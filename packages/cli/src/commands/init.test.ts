import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from './init.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'speedpatrol-init-'));
  roots.push(root);
  return root;
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

async function run(root: string) {
  const lines: string[] = [];
  await init(root, 'claude', (line) => lines.push(line));
  return { config: readFileSync(join(root, '.speedpatrol', 'speedpatrol.yml'), 'utf8'), lines };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('init detection', () => {
  it('offers a command benchmark and no server when a repo has no package.json', async () => {
    const root = workspace();
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:cjber/shortest-path-forever.git');

    const { config, lines } = await run(root);

    expect(config).toContain('name: shortest-path-forever');
    expect(config).not.toContain('BASE_URL');
    expect(config).toContain('kind: command');
    expect(lines[0]).toContain('no app type found');
    expect(lines[0]).not.toContain('api');
  });

  it('reads the repo name from an HTTPS origin with a .git suffix', async () => {
    const root = workspace();
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'https://github.com/cjber/hoard-forever.git');

    expect((await run(root)).config).toContain('name: hoard-forever');
  });

  it('falls back to the folder name when there is no origin', async () => {
    const root = join(workspace(), 'mayhem-fm');
    mkdirSync(root);

    expect((await run(root)).config).toContain('name: mayhem-fm');
  });

  it('keeps package.json detection and its name ahead of the remote', async () => {
    const root = workspace();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@acme/inbox', scripts: { dev: 'vite' }, devDependencies: { next: '15' } }),
    );
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/other.git');

    const { config, lines } = await run(root);

    expect(lines[0]).toContain('detected: web');
    expect(config).toContain('name: inbox');
    expect(config).toContain('BASE_URL: http://127.0.0.1:3000');
    expect(config).toContain('- run: npm run dev');
  });

  it('uses the remote name when package.json has none', async () => {
    const root = workspace();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/planner.git');

    const { config, lines } = await run(root);

    expect(lines[0]).toContain('detected: api');
    expect(config).toContain('name: planner');
  });
});
