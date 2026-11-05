import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctor, programWords } from './doctor.js';

describe('programWords', () => {
  it.each([
    ['node -e "a || b"', [{ word: 'node', checked: true }]],
    ['FOO=bar node server.js', [{ word: 'node', checked: true }]],
    ['$VAR serve', [{ word: '$VAR', checked: false }]],
    ['perf record -- {cmd}', [{ word: 'perf', checked: true }]],
    ['{cmd} --cpu-prof', [{ word: '{cmd}', checked: false }]],
    ['"./my tool" run', [{ word: '"./my', checked: false }]],
    [
      'cd sub && node server.js',
      [
        { word: 'cd', checked: true },
        { word: 'node', checked: true, cd: ['sub'] },
      ],
    ],
    [
      'cd a; cd ../b && ./tool',
      [
        { word: 'cd', checked: true },
        { word: 'cd', checked: true, cd: ['a'] },
        { word: './tool', checked: true, cd: ['a', '../b'] },
      ],
    ],
    [
      'cd sub | ./tool',
      [
        { word: 'cd', checked: true },
        { word: './tool', checked: true },
      ],
    ],
    [
      'cd $DIR && ./tool && node x',
      [
        { word: 'cd', checked: true },
        { word: './tool', checked: false },
        { word: 'node', checked: true },
      ],
    ],
    [
      "echo 'a ; b' | tee log",
      [
        { word: 'echo', checked: true },
        { word: 'tee', checked: true },
      ],
    ],
    [
      'npm run build\nnode src/index.js',
      [
        { word: 'npm', checked: true },
        { word: 'node', checked: true },
      ],
    ],
  ])('%s', (command, expected) => {
    expect(programWords(command)).toEqual(expected);
  });
});

describe('doctor', () => {
  it('resolves a program in the directory an earlier `cd` moved into', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-cd-'));
    try {
      await mkdir(join(root, '.speedpatrol'));
      await mkdir(join(root, 'tools'));
      await writeFile(join(root, 'tools', 'review-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(
        join(root, '.speedpatrol', 'speedpatrol.yml'),
        JSON.stringify({
          app: { setup: [{ run: 'cd tools && ./review-tool' }] },
          agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
        }),
      );
      const lines: string[] = [];
      const ok = await doctor(root, (line) => lines.push(line));
      expect(lines).toContain(`✓ ./review-tool: ./review-tool`);
      expect(ok, lines.join('\n')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not check a program whose PATH comes from a setup capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-capture-'));
    try {
      await mkdir(join(root, '.speedpatrol'));
      await writeFile(
        join(root, '.speedpatrol', 'speedpatrol.yml'),
        JSON.stringify({
          app: {
            setup: [
              { run: 'echo dir=/tmp', capture: { TOOL_DIR: 'dir=(.*)' } },
              { run: 'captured-only-tool', env: { PATH: '${TOOL_DIR}:/usr/bin:/bin' } },
            ],
          },
          agents: { scout: { enabled: false }, analyst: { enabled: false }, optimizer: { enabled: false } },
        }),
      );
      const lines: string[] = [];
      const ok = await doctor(root, (line) => lines.push(line));
      expect(lines).toContain('- captured-only-tool: not checked, PATH set at run time');
      expect(ok, lines.join('\n')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
