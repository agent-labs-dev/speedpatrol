import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileArtifact } from '@speedpatrol/core';
import { type CpuProfile, hotspots } from '../profile.js';

/**
 * Profiles every Node process a command starts, through NODE_OPTIONS. The
 * preload turns SIGTERM and SIGINT into a normal exit, because V8 writes the
 * profile only on exit, and a server is stopped with a signal.
 */
export async function withNodeProfile<T>(
  run: (env: Record<string, string>) => Promise<T>,
  file: string,
): Promise<{ result: T; artifact?: ProfileArtifact }> {
  const dir = await mkdtemp(join(tmpdir(), 'speedpatrol-prof-'));
  const preload = join(dir, 'exit-on-signal.cjs');
  await writeFile(preload, "for (const s of ['SIGTERM','SIGINT']) process.once(s, () => process.exit(0));\n");
  const options = [
    process.env.NODE_OPTIONS ?? '',
    `--cpu-prof --cpu-prof-interval=100 --cpu-prof-dir=${dir}`,
    `--require=${preload}`,
  ]
    .join(' ')
    .trim();
  try {
    const result = await run({ NODE_OPTIONS: options });
    // The profile is written as the process exits; give a stopped server a moment.
    await new Promise((done) => setTimeout(done, 300));
    const profiles = (await readdir(dir)).filter((name) => name.endsWith('.cpuprofile'));
    if (profiles.length === 0) return { result };
    // A wrapper (npm, pnpm) also writes a profile; the busiest one is the app.
    const sized = await Promise.all(profiles.map(async (name) => ({ name, size: (await stat(join(dir, name))).size })));
    const biggest = sized.sort((a, b) => b.size - a.size)[0]!;
    const out = `${file}.cpuprofile`;
    await mkdir(join(out, '..'), { recursive: true });
    await copyFile(join(dir, biggest.name), out);
    const profile = JSON.parse(await readFile(out, 'utf8')) as CpuProfile;
    return { result, artifact: { path: out, kind: 'cpuprofile', hotspots: hotspots(profile) } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
