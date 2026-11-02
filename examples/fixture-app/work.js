// The code under test. A test makes it slower in a commit and expects
// Speedpatrol to flag the regression on exactly the benchmarks that use it.
export const ROUNDS = 20000;

export function work(rounds = ROUNDS) {
  let x = 0;
  for (let i = 0; i < rounds; i++) x = (x * 31 + i) % 1000003;
  return x;
}
