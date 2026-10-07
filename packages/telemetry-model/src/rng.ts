/**
 * Seeded pseudo-random numbers (the mulberry32 algorithm) as a pure function:
 * the generator state goes in, a number in [0, 1) and the NEXT state come out.
 * The same seed always produces the same sequence, so a simulation can be replayed exactly.
 */
export function nextRandom(state: number): [value: number, nextState: number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, s];
}
