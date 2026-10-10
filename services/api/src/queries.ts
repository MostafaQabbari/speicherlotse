import { CHANNEL_NAMES, type ChannelName } from '@speicherlotse/telemetry-model';
import type { Queryable } from './tenant-db.ts';

// None of these queries mentions the tenant. They are written the way a careless developer would write them,
// because the point of ADR-006 is that the database applies the tenant filter, not the query: row-level security on
// device and alarm_event, and the tenant check inside api_telemetry(). The tests run these exact queries.

/** `battTempC` -> `batt_temp_c`: the table columns are the channel names in snake_case (see the writer). */
export const columnFor = (name: ChannelName): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export interface DeviceView {
  deviceId: number;
  name: string;
}

export async function listDevices(q: Queryable): Promise<DeviceView[]> {
  const r = await q.query<{ device_id: number; name: string }>('select device_id, name from device order by device_id');
  return r.rows.map((x) => ({ deviceId: x.device_id, name: x.name }));
}

/** null when the device does not exist or belongs to another tenant: the two cases look the same on purpose. */
export async function getDevice(q: Queryable, deviceId: number): Promise<DeviceView | null> {
  const r = await q.query<{ device_id: number; name: string }>('select device_id, name from device where device_id = $1', [deviceId]);
  const x = r.rows[0];
  return x === undefined ? null : { deviceId: x.device_id, name: x.name };
}

export interface TelemetrySample {
  ts: string;                                        // device clock, ISO 8601 in UTC
  bootId: string;                                    // a bigint: text, because it can exceed what a JSON number holds exactly
  seq: number;
  monoMs: number;
  values: Partial<Record<ChannelName, number>>;      // a channel the device did not send is left out
}

export interface TelemetryQuery {
  from?: Date | undefined;   // inclusive
  to?: Date | undefined;     // exclusive
  limit: number;
}

/** Newest first. Another tenant's device, or a device nobody registered, gives an empty list. */
export async function recentTelemetry(q: Queryable, deviceId: number, query: TelemetryQuery): Promise<TelemetrySample[]> {
  const r = await q.query<Record<string, unknown>>(
    'select * from api_telemetry($1, $2, $3, $4)',
    [deviceId, query.from ?? '-infinity', query.to ?? 'infinity', query.limit]);
  return r.rows.map((row) => {
    const values: Partial<Record<ChannelName, number>> = {};
    for (const name of CHANNEL_NAMES) {
      const v = row[columnFor(name)];
      if (typeof v === 'number') values[name] = v;
    }
    return {
      ts: (row.ts as Date).toISOString(),
      bootId: String(row.boot_id),
      seq: row.seq as number,
      monoMs: Number(row.mono_ms),
      values,
    };
  });
}

export interface AlarmEventView {
  deviceId: number;
  ruleId: string;
  severity: 'warning' | 'critical';
  event: 'fired' | 'resolved';
  at: string;      // ISO 8601 in UTC
  atMs: number;
}

export interface AlarmEventQuery {
  deviceId?: number | undefined;
  from?: Date | undefined;   // inclusive
  to?: Date | undefined;     // exclusive
  limit: number;
}

/** Newest first. Events of devices that are not the tenant's never appear, whatever the filter says. */
export async function listAlarmEvents(q: Queryable, query: AlarmEventQuery): Promise<AlarmEventView[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (query.deviceId !== undefined) add('device_id = ?', query.deviceId);
  if (query.from !== undefined) add('at >= ?', query.from);
  if (query.to !== undefined) add('at < ?', query.to);
  values.push(query.limit);
  const r = await q.query<{ device_id: number; rule_id: string; severity: 'warning' | 'critical'; event: 'fired' | 'resolved'; at_ms: string; at: Date }>(
    `select device_id, rule_id, severity, event, at_ms, at from alarm_event
     ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
     order by at desc, device_id, rule_id, event
     limit $${values.length}`,
    values);
  return r.rows.map((x) => ({
    deviceId: x.device_id, ruleId: x.rule_id, severity: x.severity, event: x.event, at: x.at.toISOString(), atMs: Number(x.at_ms),
  }));
}
