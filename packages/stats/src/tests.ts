/** A small, seeded PRNG, so a bootstrap gives the same interval on every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Abramowitz and Stegun 7.1.26: good to 1.5e-7. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Two-sided Mann-Whitney U test, with the normal approximation, a tie
 * correction and a continuity correction. Rank-based, so a few slow outliers
 * cannot make a difference significant on their own, and no normality is
 * assumed: latency distributions are skewed.
 */
export function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { u: 0, p: 1 };
  const all = [...a.map((value) => ({ value, group: 0 })), ...b.map((value) => ({ value, group: 1 }))].sort(
    (x, y) => x.value - y.value,
  );
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.value === all[i]!.value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((item, index) => {
    if (item.group === 0) r1 += ranks[index]!;
  });
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const n = n1 + n2;
  const mean = (n1 * n2) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return { u, p: 1 };
  const z = (Math.abs(u1 - mean) - 0.5) / Math.sqrt(variance);
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))) };
}

/** Exact two-sided paired sign test; zero differences carry no directional evidence.
 * https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/signtest.htm
 */
export function pairedSignTest(base: readonly number[], head: readonly number[]): { p: number; direction: number } {
  if (base.length !== head.length) throw new Error('Paired samples must have equal lengths');
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < base.length; i++) {
    if (head[i]! > base[i]!) positive++;
    if (head[i]! < base[i]!) negative++;
  }
  const n = positive + negative;
  if (!n) return { p: 1, direction: 0 };
  let logChoose = 0;
  let tail = 0;
  for (let k = 0; k <= Math.min(positive, negative); k++) {
    if (k) logChoose += Math.log(n - k + 1) - Math.log(k);
    tail += Math.exp(logChoose - n * Math.LN2);
  }
  return { p: Math.min(1, 2 * tail), direction: Math.sign(positive - negative) };
}

/**
 * The fewest paired rounds for which the exact two-sided sign test reaches
 * p < alpha when `disagreeing` rounds point against the others. With no
 * disagreeing round this is the minimum an A/B comparison needs; each
 * disagreeing round tolerated costs more rounds.
 */
export function signTestRounds(alpha: number, disagreeing = 0): number {
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`alpha must be in (0, 1], got ${alpha}`);
  for (let n = 2 * disagreeing + 1; ; n++) {
    const head = Array.from({ length: n }, (_, i) => (i < disagreeing ? -1 : 1));
    if (pairedSignTest(Array(n).fill(0), head).p < alpha) return n;
  }
}

/**
 * The smallest p the test can give for these sample sizes: every head sample
 * beyond every base sample, all values distinct. When it is not below alpha, no
 * change, however large, can be significant. For the paired sign test the
 * sizes are the non-tied rounds, since tied rounds carry no evidence.
 */
export function lowestP(baseSize: number, headSize: number, paired: boolean): number {
  const base = Array.from({ length: baseSize }, (_, i) => i);
  const head = Array.from({ length: headSize }, (_, i) => baseSize + i);
  return (paired ? pairedSignTest(base, head) : mannWhitney(base, head)).p;
}

/**
 * The fewest samples per side for which the Mann-Whitney test reaches
 * p < alpha when `disagreeing` base samples lie beyond one head sample each,
 * the rank-test counterpart of `signTestRounds`. With no disagreeing sample
 * this is the minimum a comparison needs to decide anything.
 */
export function rankTestSamples(alpha: number, disagreeing = 0): number {
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`alpha must be in (0, 1], got ${alpha}`);
  for (let n = disagreeing + 1; ; n++) {
    const base = Array.from({ length: n }, (_, i) => i);
    const head = Array.from({ length: n }, (_, i) => n + i);
    // The largest base sample moves past `disagreeing` head samples: U = disagreeing.
    if (disagreeing) base[n - 1] = n + disagreeing - 0.5;
    if (mannWhitney(base, head).p < alpha) return n;
  }
}

function resampleMedian(values: readonly number[], random: () => number): number {
  const sample = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) sample[i] = values[Math.floor(random() * values.length)]!;
  sample.sort((x, y) => x - y);
  const mid = (sample.length - 1) / 2;
  return (sample[Math.floor(mid)]! + sample[Math.ceil(mid)]!) / 2;
}

/**
 * Percentile bootstrap of the relative change of the median (head / base - 1).
 * Seeded: the same samples always give the same interval.
 */
export function bootstrapDelta(
  base: readonly number[],
  head: readonly number[],
  options: { resamples?: number; level?: number; seed?: number; paired?: boolean } = {},
): [number, number] {
  const { resamples = 2000, level = 0.95, seed = 1 } = options;
  if (options.paired && base.length !== head.length) throw new Error('Paired samples must have equal lengths');
  if (base.length === 0 || head.length === 0) return [Number.NaN, Number.NaN];
  const random = mulberry32(seed);
  const deltas = new Array<number>(resamples);
  for (let i = 0; i < resamples; i++) {
    const indices = options.paired
      ? Array.from({ length: base.length }, () => Math.floor(random() * base.length))
      : undefined;
    const medianAt = (values: readonly number[]) => {
      const sample = indices!.map((index) => values[index]!).sort((a, b) => a - b);
      const mid = (sample.length - 1) / 2;
      return (sample[Math.floor(mid)]! + sample[Math.ceil(mid)]!) / 2;
    };
    const b = indices ? medianAt(base) : resampleMedian(base, random);
    const h = indices ? medianAt(head) : resampleMedian(head, random);
    deltas[i] = b === 0 ? (h === 0 ? 0 : Math.sign(h)) : h / b - 1;
  }
  deltas.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const at = (q: number) => deltas[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))]!;
  return [at(tail), at(1 - tail)];
}
