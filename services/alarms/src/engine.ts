import type { Sample } from '@speicherlotse/telemetry-model';
import { evaluate, NO_ALARMS, type AlarmRule, type AlarmTransition, type DeviceAlarms } from '@speicherlotse/alarm-rules';
import { clockIsPlausible } from '@speicherlotse/wire';

const INT4_MAX = 2_147_483_647;

/** Everything the engine remembers about one device. */
export interface DeviceRecord {
  /** Event time of the newest sample processed. Older or equal samples are skipped. */
  lastWallMs: number;
  alarms: DeviceAlarms;
}

/** A device the engine has never seen. */
export const NEW_DEVICE: DeviceRecord = { lastWallMs: -Infinity, alarms: NO_ALARMS };

export interface RunResult {
  /** The new record of every device that had at least one new sample. Devices not in this map did not change. */
  changed: Map<number, DeviceRecord>;
  events: AlarmTransition[];
  /** Samples not newer than the device's watermark: redelivered messages, or a device that sent old data again. */
  skippedOld: number;
  /**
   * Samples the engine refuses to remember: a device clock outside 2000..2100 (it would move the watermark to a
   * nonsense value) or a device id that does not fit the database column. The writer rejects the same samples.
   */
  skippedInvalid: number;
}

/**
 * Feeds samples through the alarm rules, in the order given.
 *
 * Pure: it reads `known`, never changes it, and returns what changed. That is what makes a failed database
 * write harmless: nothing was remembered, so the same batch can simply be run again.
 *
 * Idempotent per sample: a sample whose event time is not newer than the device's watermark is skipped.
 * Without this, a redelivered OLD sample could push a firing alarm into "clearing" (condition false, old time).
 * Cost: samples that arrive out of order within one device are dropped. Kafka keeps one device in one
 * partition, in order, so this only happens if the device itself sends old data after newer data.
 */
export function run(known: ReadonlyMap<number, DeviceRecord>, samples: readonly Sample[], rules: readonly AlarmRule[]): RunResult {
  const changed = new Map<number, DeviceRecord>();
  const events: AlarmTransition[] = [];
  let skippedOld = 0;
  let skippedInvalid = 0;

  for (const raw of samples) {
    // The database stores whole milliseconds; use the same number for the rules, the watermark and the events.
    const sample = Number.isInteger(raw.wallMs) ? raw : { ...raw, wallMs: Math.round(raw.wallMs) };
    if (!clockIsPlausible(sample.wallMs) || !(sample.deviceId >= 1 && sample.deviceId <= INT4_MAX)) { skippedInvalid++; continue; }
    const record = changed.get(sample.deviceId) ?? known.get(sample.deviceId) ?? NEW_DEVICE;
    if (sample.wallMs <= record.lastWallMs) { skippedOld++; continue; }

    const result = evaluate(record.alarms, sample, rules);
    changed.set(sample.deviceId, { lastWallMs: sample.wallMs, alarms: result.alarms });
    for (const e of result.events) events.push(e);
  }
  return { changed, events, skippedOld, skippedInvalid };
}