import { describe, expect, it } from 'vitest';
import { programWords } from './doctor.js';

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
