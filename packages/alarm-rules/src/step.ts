/** Where one alarm (one rule on one device) currently is in its life cycle. */
export type AlarmState =
  | { kind: 'normal' }
  | { kind: 'pending'; sinceMs: number }                    // condition is true, but not for long enough yet
  | { kind: 'firing'; sinceMs: number }                     // alarm is active
  | { kind: 'clearing'; sinceMs: number; firedMs: number }; // condition went false, waiting to be sure

export type AlarmEvent = 'fired' | 'resolved';

export interface Rule {
  forMs: number;     // the condition must hold this long before the alarm fires
  clearMs: number;   // the condition must stay false this long before the alarm resolves
}

export const INITIAL_STATE: AlarmState = { kind: 'normal' };

/**
 * Advance one alarm by one observation. Pure: no clock, no I/O.
 * `nowMs` is the sample's EVENT time (when it was measured), never Date.now(),
 * so replaying stored data gives exactly the same alarms.
 */
export function step(
  s: AlarmState,
  condition: boolean,
  nowMs: number,
  rule: Rule,
): [AlarmState, AlarmEvent | null] {
  switch (s.kind) {
    case 'normal':
      return condition ? [{ kind: 'pending', sinceMs: nowMs }, null] : [s, null];
    case 'pending':
      if (!condition) return [{ kind: 'normal' }, null];     // a short blip never becomes an alarm
      return nowMs - s.sinceMs >= rule.forMs
        ? [{ kind: 'firing', sinceMs: nowMs }, 'fired']
        : [s, null];
    case 'firing':
      return condition
        ? [s, null]
        : [{ kind: 'clearing', sinceMs: nowMs, firedMs: s.sinceMs }, null];
    case 'clearing':
      if (condition) return [{ kind: 'firing', sinceMs: s.firedMs }, null];   // flapped: still the same alarm
      return nowMs - s.sinceMs >= rule.clearMs
        ? [{ kind: 'normal' }, 'resolved']
        : [s, null];
    default:
      return assertNever(s);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled alarm state ${JSON.stringify(x)}`);
}
