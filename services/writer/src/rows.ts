import { CHANNELS, CHANNEL_NAMES, type ChannelName, type Sample } from '@speicherlotse/telemetry-model';

/** `battTempC` -> `batt_temp_c`. The table columns are the channel names in snake_case. */
export function columnFor(name: ChannelName): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Channel columns in table order (the order of CHANNELS). */
export const CHANNEL_COLUMNS: readonly { name: ChannelName; column: string; isCode: boolean }[] =
  CHANNEL_NAMES.map((name) => ({ name, column: columnFor(name), isCode: CHANNELS[name].unit === 'code' }));

/** One row of the `telemetry` table. `values[i]` belongs to CHANNEL_COLUMNS[i]; null = channel missing. */
export interface Row {
  tsMs: number;
  deviceId: number;
  bootId: number;
  seq: number;
  monoMs: number;
  values: (number | null)[];
}

export interface Rejected {
  sample: Sample;
  reason: string;
}

const INT4_MAX = 2_147_483_647;
const INT2_MAX = 32_767;
// Device clocks that were never set show 1970; a typo can show year 50000. Neither fits a sane chart.
const MIN_TS_MS = Date.UTC(2000, 0, 1);
const MAX_TS_MS = Date.UTC(2100, 0, 1);

/**
 * Turns decoded samples into rows. The wire layer is deliberately lenient about values (any finite number),
 * but the database is not: one number that does not fit its column makes the WHOLE insert fail, and because
 * the writer would retry the same Kafka batch forever, one bad sample would block a partition. So everything
 * that cannot be stored is dealt with here, before the insert:
 *  - a sample whose key or timestamp cannot be stored is rejected (and reported to the caller);
 *  - a single channel value that does not fit its column becomes NULL ("unknown"), the rest of the sample is kept.
 * Plausibility (is 900 degC a real battery temperature?) is still NOT checked: the rule layer does that.
 */
export function toRows(samples: readonly Sample[]): { rows: Row[]; rejected: Rejected[] } {
  const rows: Row[] = [];
  const rejected: Rejected[] = [];

  for (const s of samples) {
    const tsMs = Math.round(s.wallMs);
    const monoMs = Math.round(s.monoMs);
    let reason: string | null = null;
    if (!Number.isInteger(s.deviceId) || s.deviceId < 1 || s.deviceId > INT4_MAX) reason = 'deviceId out of range';
    else if (!Number.isSafeInteger(s.bootId) || s.bootId < 0) reason = 'bootId out of range';
    else if (!Number.isInteger(s.seq) || s.seq < 0 || s.seq > INT4_MAX) reason = 'seq out of range';
    else if (!(tsMs >= MIN_TS_MS && tsMs < MAX_TS_MS)) reason = 'wallMs outside 2000..2100';
    else if (!Number.isSafeInteger(monoMs) || monoMs < 0) reason = 'monoMs out of range';
    if (reason !== null) {
      rejected.push({ sample: s, reason });
      continue;
    }
    rows.push({
      tsMs,
      deviceId: s.deviceId,
      bootId: s.bootId,
      seq: s.seq,
      monoMs,
      values: CHANNEL_COLUMNS.map((c) => fit(s.values[c.name], c.isCode)),
    });
  }
  return { rows, rejected };
}

/** A value that fits its column, or null. `real` is a 32-bit float; `code` channels are smallint. */
function fit(v: number | undefined, isCode: boolean): number | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  if (isCode) return Number.isInteger(v) && Math.abs(v) <= INT2_MAX ? v : null;
  return Number.isFinite(Math.fround(v)) ? v : null;   // 1e300 rounds to Infinity as float4: PostgreSQL would raise "out of range"
}