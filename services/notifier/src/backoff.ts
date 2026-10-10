/**
 * How long to wait before the next attempt, after `failures` failed attempts (1 for the first failure):
 * baseMs, 2 x baseMs, 4 x baseMs ... capped at maxMs, then spread over 50..100 % so that many notifications
 * that failed together do not all come back at the same moment.
 */
export function retryDelayMs(failures: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exact = Math.min(maxMs, baseMs * 2 ** (failures - 1));
  return Math.round(exact * (0.5 + random() / 2));
}