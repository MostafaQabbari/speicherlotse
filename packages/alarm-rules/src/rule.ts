import type { ChannelName, ChannelValues } from '@speicherlotse/telemetry-model';
import { isPlausible } from '@speicherlotse/telemetry-model';
import type { Rule as Timing } from './step.ts';

export type Severity = 'warning' | 'critical';

/**
 * WHAT is being checked. Plain data (no functions), so it can later be stored in
 * PostgreSQL as JSON, edited in the dashboard, and sent over the wire.
 */
export type Condition =
  | { kind: 'threshold'; channel: ChannelName; op: '>' | '<'; value: number }
  // high - low > value, e.g. cell imbalance = cellMvMax - cellMvMin
  | { kind: 'spread'; high: ChannelName; low: ChannelName; above: number };

/** A complete alarm rule = what to check + how long + how serious. */
export interface AlarmRule extends Timing {
  id: string;          // stable name, used as the key for the alarm state
  severity: Severity;
  when: Condition;
}

/** Read one channel. Missing OR physically impossible values count as "unknown". */
function read(values: ChannelValues, name: ChannelName): number | null {
  const v = values[name];
  if (v === undefined) return null;
  return isPlausible(name, v) ? v : null;   // garbage is not evidence either way
}

/**
 * true  = the condition holds
 * false = the condition does not hold
 * null  = we cannot tell (a needed channel is missing or implausible)
 */
export function evaluateCondition(c: Condition, values: ChannelValues): boolean | null {
  switch (c.kind) {
    case 'threshold': {
      const v = read(values, c.channel);
      if (v === null) return null;
      return c.op === '>' ? v > c.value : v < c.value;
    }
    case 'spread': {
      const hi = read(values, c.high);
      const lo = read(values, c.low);
      if (hi === null || lo === null) return null;
      return hi - lo > c.above;
    }
    default:
      return assertNever(c);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled condition ${JSON.stringify(x)}`);
}