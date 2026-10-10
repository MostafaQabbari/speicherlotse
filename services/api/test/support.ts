// Shared by the tests that need a real PostgreSQL. Not a test itself (the name does not end in .test.ts).
import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';
import { CHANNEL_NAMES } from '@speicherlotse/telemetry-model';
import { columnFor } from '../src/queries.ts';
import { TenantDb, type TenantDbOptions } from '../src/tenant-db.ts';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const skip = DB_URL === undefined ? 'TEST_DATABASE_URL is not set' : false;

export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const C = '33333333-3333-4333-8333-333333333333';   // a tenant without devices
export const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

export interface TestDb {
  schema: string;
  /** The owner: sets up data the way the writer, the alarm engine and the seed script do. Skips row-level security. */
  admin: pg.Client;
  /** A pool whose connections work in the test schema, like the API's pool does in production. */
  makePool(max?: number): pg.Pool;
  tenantDb(options?: TenantDbOptions & { max?: number }): TenantDb;
  close(): Promise<void>;
}

/** A schema of its own with the tables of the writer, the alarm engine, the notifier and the API, as their migrations create them. */
export async function createTestDb(prefix: string): Promise<TestDb> {
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.query(`set search_path to ${schema}`);
  for (const dir of ['../../writer/sql/', '../../alarms/sql/', '../../notifier/sql/', '../sql/']) {
    await runMigrations(admin, new URL(dir, import.meta.url), { timescale: false });
  }
  const pools: pg.Pool[] = [];
  const makePool = (max = 4): pg.Pool => {
    const pool = new pg.Pool({ connectionString: DB_URL, max, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };
  return {
    schema,
    admin,
    makePool,
    tenantDb: (o = {}) => new TenantDb(makePool(o.max ?? 4), o),
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}

export const addTenant = (db: pg.Client, id: string, name: string): Promise<unknown> =>
  db.query('insert into tenant (id, name) values ($1, $2)', [id, name]);

export const addDevice = (db: pg.Client, deviceId: number, tenantId: string): Promise<unknown> =>
  db.query('insert into device (device_id, tenant_id, name) values ($1, $2, $3)', [deviceId, tenantId, `Home ${deviceId}`]);

/** One telemetry row, the way the writer stores it. */
export const addSample = (db: pg.Client, deviceId: number, tsMs: number, seq: number, battTempC: number | null = 25, bootId = 1): Promise<unknown> =>
  db.query(
    `insert into telemetry (ts, device_id, boot_id, seq, mono_ms, batt_temp_c, pv_w)
     values (to_timestamp($1::bigint / 1000.0), $2, $3, $4, $6, $5, 100)`,
    [tsMs, deviceId, bootId, seq, battTempC, seq * 1000]);

/** A telemetry row with every channel set to a different number (channel index + 1). */
export function addFullSample(db: pg.Client, deviceId: number, tsMs: number, seq: number): Promise<unknown> {
  const columns = CHANNEL_NAMES.map(columnFor);
  return db.query(
    `insert into telemetry (ts, device_id, boot_id, seq, mono_ms, ${columns.join(', ')})
     values (to_timestamp($1::bigint / 1000.0), $2, 1, $3, 0, ${columns.map((_, i) => `$${i + 4}`).join(', ')})`,
    [tsMs, deviceId, seq, ...CHANNEL_NAMES.map((_, i) => i + 1)]);
}

/** One alarm event, the way the alarm engine stores it. */
export const addAlarm = (db: pg.Client, deviceId: number, ruleId: string, event: 'fired' | 'resolved', atMs: number, severity: 'warning' | 'critical' = 'warning'): Promise<unknown> =>
  db.query(
    `insert into alarm_event (device_id, rule_id, severity, event, at_ms, at)
     values ($1, $2, $3, $4, $5::bigint, to_timestamp($5::bigint / 1000.0))`,
    [deviceId, ruleId, severity, event, atMs]);
