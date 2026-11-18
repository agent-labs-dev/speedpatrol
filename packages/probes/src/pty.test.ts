import { benchmarkSchema } from '@speedpatrol/core';
import { describe, expect, it } from 'vitest';
import { MarkerScan, ptyCommand, ptyProbe } from './probes/pty.js';

function probe(fields: Record<string, unknown>, timeoutMs = 10_000) {
  const benchmark = benchmarkSchema.parse({ id: 'tui', kind: 'pty', ...fields });
  if (benchmark.kind !== 'pty') throw new Error('Expected pty');
  return ptyProbe(benchmark, { source: process.cwd(), vars: {}, timeoutMs, log: () => {} });
}

describe('MarkerScan', () => {
  it('finds a marker split across chunks and returns the text after it', () => {
    const scan = new MarkerScan('<<reply>>');
    expect(scan.push('noise <<rep')).toBeUndefined();
    expect(scan.push('ly>> after')).toBe(' after');
  });

  it('matches exact text only', () => {
    const scan = new MarkerScan('READY');
    expect(scan.push('ready Ready R E A D Y')).toBeUndefined();
  });
});

describe('ptyCommand', () => {
  it('wraps the command in script for Linux and macOS and refuses elsewhere', () => {
    expect(ptyCommand('app', 80, 24, 'linux')).toBe(
      `exec script -qfec 'stty cols 80 rows 24 2>/dev/null; exec bash -c '\\''app'\\''' /dev/null`,
    );
    expect(ptyCommand('app', 80, 24, 'darwin')).toMatch(/^exec script -qF \/dev\/null bash -c /);
    expect(() => ptyCommand('app', 80, 24, 'win32')).toThrow('Linux and macOS');
  });
});

describe('schema', () => {
  it('refuses a marker the input would echo, and a marker equal to ready', () => {
    const parse = (fields: Record<string, unknown>) =>
      benchmarkSchema.safeParse({ id: 'tui', kind: 'pty', run: 'app', ...fields }).success;
    expect(parse({ marker: 'DONE' })).toBe(true);
    expect(parse({ marker: 'DONE', input: 'say DONE\r' })).toBe(false);
    expect(parse({ marker: 'DONE', ready: 'DONE' })).toBe(false);
  });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('ptyProbe', () => {
  it('runs the app on a terminal, types input at the ready marker and stops at the reply marker', async () => {
    // The app checks it has a terminal of the configured size, then replies after a delay.
    const app = [
      '[ -t 0 ] && [ -t 1 ] || exit 3',
      '[ "$(stty size)" = "30 100" ] || exit 4',
      'printf "SP_READY\\n"',
      'read -r line',
      'sleep 0.3',
      'printf "reply to %s SP_REPLY\\n" "$line"',
      'sleep 30',
    ].join('; ');
    const result = await probe({
      run: app,
      ready: 'SP_READY',
      input: 'hello\r',
      marker: 'SP_REPLY',
      cols: 100,
      rows: 30,
    }).sample();
    expect(result.ready_ms).toBeGreaterThan(0);
    expect(result.marker_ms).toBeGreaterThanOrEqual(300);
    expect(result.marker_ms).toBeLessThan(5000);
  });

  it('times from the spawn without a ready marker', async () => {
    const result = await probe({ run: 'sleep 0.2; printf "SP_DONE"; sleep 30', marker: 'SP_DONE' }).sample();
    expect(result.ready_ms).toBeUndefined();
    expect(result.marker_ms).toBeGreaterThanOrEqual(200);
  });

  it('fails a sample whose app exits or never writes the marker', async () => {
    await expect(probe({ run: 'printf "no marker"; exit 2', marker: 'SP_DONE' }).sample()).rejects.toThrow(
      'before writing the marker',
    );
    await expect(probe({ run: 'sleep 30', ready: 'SP_READY', marker: 'SP_DONE' }, 500).sample()).rejects.toThrow(
      'waiting for the ready marker',
    );
  });
});
