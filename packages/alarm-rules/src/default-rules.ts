import type { AlarmRule } from './rule.ts';

const S = 1_000;
const MIN = 60 * S;

/** The first rule set. Numbers are starting points, to be tuned against simulated and real data. */
export const DEFAULT_RULES: readonly AlarmRule[] = [
  { id: 'battery-temp-high',     severity: 'warning',  forMs: 1 * MIN,  clearMs: 2 * MIN,
    when: { kind: 'threshold', channel: 'battTempC', op: '>', value: 45 } },
  { id: 'battery-temp-critical', severity: 'critical', forMs: 10 * S,   clearMs: 1 * MIN,
    when: { kind: 'threshold', channel: 'battTempC', op: '>', value: 55 } },
  { id: 'grid-frequency-low',    severity: 'warning',  forMs: 10 * S,   clearMs: 30 * S,
    when: { kind: 'threshold', channel: 'gridHz', op: '<', value: 49.8 } },
  { id: 'cell-imbalance',        severity: 'warning',  forMs: 5 * MIN,  clearMs: 5 * MIN,
    when: { kind: 'spread', high: 'cellMvMax', low: 'cellMvMin', above: 150 } },
];