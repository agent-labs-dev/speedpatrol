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
  options: { resamples?: number; level?: number; seed?: number } = {},
): [number, number] {
  const { resamples = 2000, level = 0.95, seed = 1 } = options;
  if (base.length === 0 || head.length === 0) return [Number.NaN, Number.NaN];
  const random = mulberry32(seed);
  const deltas = new Array<number>(resamples);
  for (let i = 0; i < resamples; i++) {
    const b = resampleMedian(base, random);
    const h = resampleMedian(head, random);
    deltas[i] = b === 0 ? (h === 0 ? 0 : Math.sign(h)) : h / b - 1;
  }
  deltas.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const at = (q: number) => deltas[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))]!;
  return [at(tail), at(1 - tail)];
}
