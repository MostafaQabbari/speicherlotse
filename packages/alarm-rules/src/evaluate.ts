import type { Sample } from '../../telemetry-model/src/index.ts';
import { evaluateCondition, type AlarmRule, type Severity } from './rule.ts';
import { INITIAL_STATE, step, type AlarmEvent, type AlarmState } from './step.ts';

/** All alarm states of ONE device, keyed by rule id. A rule with no entry is 'normal'. */
export type DeviceAlarms = ReadonlyMap<string, AlarmState>;

export interface AlarmTransition {
  deviceId: number;
  ruleId: string;
  severity: Severity;
  event: AlarmEvent;
  atMs: number;        // event time of the sample that caused it
}

export const NO_ALARMS: DeviceAlarms = new Map();

/**
 * Feed one sample of one device through every rule.
 * Pure: returns a NEW map and a list of events; never changes its inputs, never reads a clock.
 * The caller (later: the Kafka consumer) stores the returned map and passes it back next time.
 */
export function evaluate(
  alarms: DeviceAlarms,
  sample: Sample,
  rules: readonly AlarmRule[],
): { alarms: DeviceAlarms; events: AlarmTransition[] } {
  const next = new Map(alarms);
  const events: AlarmTransition[] = [];

  for (const rule of rules) {
    const condition = evaluateCondition(rule.when, sample.values);
    if (condition === null) continue;   // unknown: leave this alarm exactly as it is

    const before = alarms.get(rule.id) ?? INITIAL_STATE;
    const [after, event] = step(before, condition, sample.wallMs, rule);

    if (after.kind === 'normal') next.delete(rule.id);   // keep the map small: normal = no entry
    else next.set(rule.id, after);

    if (event !== null) {
      events.push({
        deviceId: sample.deviceId,
        ruleId: rule.id,
        severity: rule.severity,
        event,
        atMs: sample.wallMs,
      });
    }
  }
  return { alarms: next, events };
}