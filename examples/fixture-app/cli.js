import { ROUNDS, work } from './work.js';

const started = performance.now();
const checksum = work(ROUNDS * 20);
const elapsed = performance.now() - started;
if (process.argv.includes('--metrics')) {
  console.log(JSON.stringify({ metrics: { work_ms: elapsed, checksum_count: checksum % 10 } }));
}
