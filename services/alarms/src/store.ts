import type { AlarmState } from '@speicherlotse/alarm-rules';
import type { AlarmTransition } from '@speicherlotse/alarm-rules';
import type { Queryable } from './db.ts';
import { NEW_DEVICE, type DeviceRecord } from './engine.ts';

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Reads a stored state back. A row that does not look like an AlarmState means the table was changed by hand or
 * by another version of the program; guessing could hide or invent an alarm, so this throws (a non-transient
 * error: the service stops and says so).
 */
export function parseState(value: unknown): AlarmState {
  if (isObject(value)) {
    if (value.kind === 'normal') return { kind: 'normal' };
    if ((value.kind === 'pending' || value.kind === 'firing') && isNum(value.sinceMs)) return { kind: value.kind, sinceMs: value.sinceMs };
    if (value.kind === 'clearing' && isNum(value.sinceMs) && isNum(value.firedMs)) return { kind: 'clearing', sinceMs: value.sinceMs, firedMs: value.firedMs };
  }
  throw new Error(`alarm_state holds something that is not an alarm state: ${JSON.stringify(value)}`);
}

/** Reads the watermark and the alarm states of the given devices. A device that is not stored yet comes back as NEW_DEVICE. */
export async function loadDevices(db: Queryable, deviceIds: readonly number[]): Promise<Map<number, DeviceRecord>> {
  const out = new Map<number, DeviceRecord>();
  if (deviceIds.length === 0) return out;

  const devices = await db.query<{ device_id: number; last_wall_ms: string }>(
    'select device_id, last_wall_ms from alarm_device where device_id = any($1::int[])', [deviceIds]);
  const states = await db.query<{ device_id: number; rule_id: string; state: unknown }>(
    'select device_id, rule_id, state from alarm_state where device_id = any($1::int[])', [deviceIds]);

  const alarms = new Map<number, Map<string, AlarmState>>();
  for (const r of states.rows) {
    const m = alarms.get(r.device_id) ?? new Map<string, AlarmState>();
    m.set(r.rule_id, parseState(r.state));
    alarms.set(r.device_id, m);
  }
  const marks = new Map(devices.rows.map((r) => [r.device_id, Number(r.last_wall_ms)]));

  for (const id of deviceIds) {
    const lastWallMs = marks.get(id);
    out.set(id, lastWallMs === undefined ? NEW_DEVICE : { lastWallMs, alarms: alarms.get(id) ?? new Map() });
  }
  return out;
}

/**
 * Writes the new records and events. The caller runs this inside ONE transaction, so the watermark, the alarm
 * states and the events always agree: after a crash they are either all new or all old.
 * Each statement handles all devices of the batch at once (arrays), so the number of round trips does not
 * depend on the number of devices.
 */
export async function saveChanges(tx: Queryable, changed: ReadonlyMap<number, DeviceRecord>, events: readonly AlarmTransition[]): Promise<void> {
  if (changed.size === 0) return;
  const ids = [...changed.keys()];

  await tx.query(
    `insert into alarm_device (device_id, last_wall_ms)
     select * from unnest($1::int[], $2::bigint[])
     on conflict (device_id) do update set last_wall_ms = excluded.last_wall_ms`,
    [ids, ids.map((id) => changed.get(id)!.lastWallMs)]);

  // The alarm states of these devices are replaced as a whole: "normal" alarms simply have no row.
  await tx.query('delete from alarm_state where device_id = any($1::int[])', [ids]);
  const sDevice: number[] = [];
  const sRule: string[] = [];
  const sState: string[] = [];
  for (const [id, record] of changed) {
    for (const [ruleId, state] of record.alarms) {
      sDevice.push(id);
      sRule.push(ruleId);
      sState.push(JSON.stringify(state));
    }
  }
  if (sDevice.length > 0) {
    await tx.query(
      `insert into alarm_state (device_id, rule_id, state)
       select d, r, s::jsonb from unnest($1::int[], $2::text[], $3::text[]) as t(d, r, s)`,
      [sDevice, sRule, sState]);
  }

  if (events.length > 0) {
    await tx.query(
      `insert into alarm_event (device_id, rule_id, severity, event, at_ms, at)
       select d, r, sev, ev, ms, to_timestamp(ms / 1000.0)
       from unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::bigint[]) as t(d, r, sev, ev, ms)
       on conflict do nothing`,
      [events.map((e) => e.deviceId), events.map((e) => e.ruleId), events.map((e) => e.severity),
       events.map((e) => e.event), events.map((e) => e.atMs)]);
  }
}