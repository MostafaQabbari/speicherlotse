import { encodeBatch } from '@speicherlotse/wire';
import type { RawMessage } from '@speicherlotse/service-kit';
import type { Sample } from '@speicherlotse/telemetry-model';
import type { AlarmRule } from '@speicherlotse/alarm-rules';

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** One sample per second of device `deviceId`; `temp` is the battery temperature, `undefined` = channel missing. */
export function at(deviceId: number, second: number, temp: number | undefined): Sample {
  return {
    deviceId, bootId: 1, seq: second, wallMs: T0 + second * 1000, monoMs: second * 1000,
    values: temp === undefined ? {} : { battTempC: temp },
  };
}

/** A test rule set with round numbers: hot (> 45 °C) must hold 10 s to fire and be gone 5 s to resolve. */
export const HOT: AlarmRule = {
  id: 'hot', severity: 'critical', forMs: 10_000, clearMs: 5_000,
  when: { kind: 'threshold', channel: 'battTempC', op: '>', value: 45 },
};

/** Samples for seconds [from, to) at the same temperature. */
export function span(deviceId: number, from: number, to: number, temp: number): Sample[] {
  return Array.from({ length: to - from }, (_, i) => at(deviceId, from + i, temp));
}

const encoder = new TextEncoder();

/** A Kafka message holding the given samples (they must share one device). */
export function message(partition: number, offset: number, samples: Sample[], log: string[] = []): RawMessage & { commit(): void } {
  return {
    topic: 'telemetry.raw', partition, offset: BigInt(offset),
    value: encoder.encode(encodeBatch(samples)),
    commit: () => { log.push(`commit p${partition}@${offset}`); },
  };
}