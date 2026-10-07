import type { ChannelValues } from './sample.ts';

export type BalanceResult =
  | { status: 'unknown' }
  | { status: 'ok' | 'violated'; residualW: number; toleranceW: number };

/**
 * Power balance at the house connection point:
 * gridW = loadW + evW + battW - pvW   (grid + import, battery + charging)
 */
export function checkBalance(v: ChannelValues): BalanceResult {
  const { pvW, loadW, evW, battW, gridW } = v;
  if (pvW === undefined || loadW === undefined || evW === undefined
      || battW === undefined || gridW === undefined) {
    return { status: 'unknown' };
  }
  const residualW = gridW - (loadW + evW + battW - pvW);
  const largestW = Math.max(
    Math.abs(pvW), Math.abs(loadW), Math.abs(evW), Math.abs(battW), Math.abs(gridW),
  );
  const toleranceW = 50 + 0.02 * largestW;
  return {
    status: Math.abs(residualW) <= toleranceW ? 'ok' : 'violated',
    residualW,
    toleranceW,
  };
}
