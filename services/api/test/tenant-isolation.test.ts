// With a real PostgreSQL: the promise of ADR-006, that a tenant can never read another tenant's devices, telemetry or alarms,
// proven against the database itself. The queries under test are the ones the API runs, and none of them mentions the tenant.
// Skipped without TEST_DATABASE_URL. Each run works in a schema of its own.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { runMigrations } from '@speicherlotse/service-kit';
import { CHANNEL_NAMES } from '@speicherlotse/telemetry-model';
import { getDevice, listAlarmEvents, listDevices, recentTelemetry } from '../src/queries.ts';
import { APP_ROLE, TenantDb } from '../src/tenant-db.ts';
import { A, B, C, T0, addAlarm, addDevice, addFullSample, addSample, addTenant, createTestDb, skip, type TestDb } from './support.ts';

let t: TestDb;
let firstMigration: string[] = [];

before(async () => {
  if (skip) return;
  t = await createTestDb('test_iso');
});
after(async () => {
  if (skip) return;
  await t.close();
});

/**
 * The world for most tests:
 *   tenant A owns devices 1 and 2, tenant B owns device 3, tenant C owns nothing, device 9 is registered to nobody.
 *   Every device has 3 samples and 2 alarm events.
 */
beforeEach(async () => {
  if (skip) return;
  await t.admin.query('truncate telemetry, alarm_event, device, tenant cascade');
  await addTenant(t.admin, A, 'Alpha');
  await addTenant(t.admin, B, 'Beta');
  await addTenant(t.admin, C, 'Gamma');
  await addDevice(t.admin, 1, A);
  await addDevice(t.admin, 2, A);
  await addDevice(t.admin, 3, B);
  for (const d of [1, 2, 3, 9]) {
    for (let i = 0; i < 3; i++) await addSample(t.admin, d, T0 + i * 1000, i, 20 + d);
    await addAlarm(t.admin, d, 'battery-temp-high', 'fired', T0 + 1000);
    await addAlarm(t.admin, d, 'battery-temp-high', 'resolved', T0 + 5000);
  }
});

const ids = (rows: Array<{ deviceId: number }>): number[] => [...new Set(rows.map((r) => r.deviceId))].sort((x, y) => x - y);

test('the migration creates the tables, the role and the function once and is a no-op the second time', { skip }, async () => {
  assert.deepEqual(await runMigrations(t.admin, new URL('../sql/', import.meta.url), { timescale: false }), []);
  const role = await t.admin.query("select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1", [APP_ROLE]);
  assert.deepEqual(role.rows, [{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
});

test('the other services are not affected: the owner still reads and writes everything, and the outbox trigger still fires', { skip }, async () => {
  // The alarm engine and the notifier connect as the owner of the tables, which row-level security does not apply to.
  assert.equal((await t.admin.query('select count(*)::int as n from alarm_event')).rows[0].n, 8);   // all four devices, not just one tenant's
  assert.equal((await t.admin.query('select count(*)::int as n from device')).rows[0].n, 3);
  assert.equal((await t.admin.query('select count(*)::int as n from notification_outbox')).rows[0].n, 8);   // the trigger queued every event
  await addAlarm(t.admin, 3, 'grid-frequency-low', 'fired', T0 + 9000);
  assert.equal((await t.admin.query('select count(*)::int as n from notification_outbox')).rows[0].n, 9);
  // and the API role cannot see the outbox
  await assert.rejects(t.tenantDb().withTenant(A, (q) => q.query('select * from notification_outbox')), (e: { code?: string }) => e.code === '42501');
});

test('each tenant sees its own devices and nobody else\'s, with a query that has no tenant condition', { skip }, async () => {
  const db = t.tenantDb();
  assert.deepEqual(ids(await db.withTenant(A, listDevices)), [1, 2]);
  assert.deepEqual(ids(await db.withTenant(B, listDevices)), [3]);
  assert.deepEqual(ids(await db.withTenant(C, listDevices)), []);
});

test('a tenant\'s own device can be looked up; another tenant\'s device and a device nobody registered look exactly the same', { skip }, async () => {
  const db = t.tenantDb();
  assert.deepEqual(await db.withTenant(A, (q) => getDevice(q, 1)), { deviceId: 1, name: 'Home 1' });
  assert.equal(await db.withTenant(A, (q) => getDevice(q, 3)), null);     // B's
  assert.equal(await db.withTenant(A, (q) => getDevice(q, 9)), null);     // nobody's
  assert.equal(await db.withTenant(A, (q) => getDevice(q, 12345)), null); // does not exist
});

test('a tenant sees only its own row of the tenant table', { skip }, async () => {
  const rows = await t.tenantDb().withTenant(B, async (q) => (await q.query<{ id: string; name: string }>('select id, name from tenant')).rows);
  assert.deepEqual(rows, [{ id: B, name: 'Beta' }]);
});

test('alarm events: only those of the tenant\'s own devices, also for "select everything"', { skip }, async () => {
  const db = t.tenantDb();
  assert.deepEqual(ids(await db.withTenant(A, (q) => listAlarmEvents(q, { limit: 500 }))), [1, 2]);
  assert.deepEqual(ids(await db.withTenant(B, (q) => listAlarmEvents(q, { limit: 500 }))), [3]);
  assert.deepEqual(ids(await db.withTenant(C, (q) => listAlarmEvents(q, { limit: 500 }))), []);
  const raw = await db.withTenant(A, async (q) => (await q.query('select * from alarm_event')).rows.length);
  assert.equal(raw, 4);   // 2 devices x 2 events. A forgotten WHERE cannot widen it.
});

test('alarm events: asking for another tenant\'s device by id gives nothing', { skip }, async () => {
  assert.deepEqual(await t.tenantDb().withTenant(A, (q) => listAlarmEvents(q, { deviceId: 3, limit: 500 })), []);
  assert.deepEqual(await t.tenantDb().withTenant(A, (q) => listAlarmEvents(q, { deviceId: 9, limit: 500 })), []);
});

test('alarm events: newest first, with from, to, device and limit', { skip }, async () => {
  const db = t.tenantDb();
  const all = await db.withTenant(A, (q) => listAlarmEvents(q, { limit: 500 }));
  assert.deepEqual(all.map((e) => e.event), ['resolved', 'resolved', 'fired', 'fired']);
  assert.deepEqual(all[0], { deviceId: 1, ruleId: 'battery-temp-high', severity: 'warning', event: 'resolved', at: new Date(T0 + 5000).toISOString(), atMs: T0 + 5000 });
  assert.equal((await db.withTenant(A, (q) => listAlarmEvents(q, { limit: 3 }))).length, 3);
  assert.equal((await db.withTenant(A, (q) => listAlarmEvents(q, { deviceId: 2, limit: 500 }))).length, 2);
  assert.deepEqual((await db.withTenant(A, (q) => listAlarmEvents(q, { from: new Date(T0 + 2000), limit: 500 }))).map((e) => e.event), ['resolved', 'resolved']);
  assert.deepEqual((await db.withTenant(A, (q) => listAlarmEvents(q, { to: new Date(T0 + 5000), limit: 500 }))).map((e) => e.event), ['fired', 'fired']);   // to is exclusive
});

test('telemetry: a tenant reads its own device, newest first', { skip }, async () => {
  const samples = await t.tenantDb().withTenant(A, (q) => recentTelemetry(q, 1, { limit: 100 }));
  assert.deepEqual(samples.map((s) => s.seq), [2, 1, 0]);
  assert.deepEqual(samples[0], { ts: new Date(T0 + 2000).toISOString(), bootId: '1', seq: 2, monoMs: 2000, values: { battTempC: 21, pvW: 100 } });
});

test('telemetry: another tenant\'s device and an unregistered device return nothing', { skip }, async () => {
  const db = t.tenantDb();
  assert.deepEqual(await db.withTenant(A, (q) => recentTelemetry(q, 3, { limit: 100 })), []);     // B's
  assert.deepEqual(await db.withTenant(A, (q) => recentTelemetry(q, 9, { limit: 100 })), []);     // nobody's
  assert.deepEqual(await db.withTenant(C, (q) => recentTelemetry(q, 1, { limit: 100 })), []);     // C has no devices
  assert.equal((await db.withTenant(B, (q) => recentTelemetry(q, 3, { limit: 100 }))).length, 3);
});

test('telemetry: from is inclusive, to is exclusive, limit cuts from the newest end', { skip }, async () => {
  const db = t.tenantDb();
  const seqs = async (query: { from?: Date; to?: Date; limit: number }): Promise<number[]> => (await db.withTenant(A, (q) => recentTelemetry(q, 1, query))).map((s) => s.seq);
  assert.deepEqual(await seqs({ from: new Date(T0 + 1000), limit: 100 }), [2, 1]);
  assert.deepEqual(await seqs({ to: new Date(T0 + 1000), limit: 100 }), [0]);
  assert.deepEqual(await seqs({ from: new Date(T0 + 1000), to: new Date(T0 + 2000), limit: 100 }), [1]);
  assert.deepEqual(await seqs({ limit: 2 }), [2, 1]);
});

test('telemetry: the database caps one call at 1,000 rows, whatever the caller asks', { skip }, async () => {
  await t.admin.query(
    `insert into telemetry (ts, device_id, boot_id, seq, mono_ms)
     select to_timestamp(($1::bigint + g * 1000) / 1000.0), 1, 2, g, g from generate_series(0, 1199) g`, [T0 + 100_000]);
  const n = (await t.tenantDb().withTenant(A, (q) => recentTelemetry(q, 1, { limit: 100_000 }))).length;
  assert.equal(n, 1_000);
});

test('telemetry: every channel column comes back under its channel name (the table and CHANNELS agree)', { skip }, async () => {
  await t.admin.query('delete from telemetry where device_id = 1');
  await addFullSample(t.admin, 1, T0, 0);
  const [sample] = await t.tenantDb().withTenant(A, (q) => recentTelemetry(q, 1, { limit: 1 }));
  assert.deepEqual(Object.keys(sample!.values).sort(), [...CHANNEL_NAMES].sort());
  CHANNEL_NAMES.forEach((name, i) => assert.equal(sample!.values[name], i + 1, name));
});

test('with no tenant set the role sees nothing at all: no devices, no alarms, no telemetry', { skip }, async () => {
  const c = await t.makePool(1).connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${APP_ROLE}`);
    assert.equal((await c.query('select * from device')).rowCount, 0);
    assert.equal((await c.query('select * from tenant')).rowCount, 0);
    assert.equal((await c.query('select * from alarm_event')).rowCount, 0);
    assert.equal((await c.query('select * from api_telemetry(1, $1, $2, 100)', ['-infinity', 'infinity'])).rowCount, 0);
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('an unknown tenant id sees nothing, and so does an empty setting', { skip }, async () => {
  const stranger = '99999999-9999-4999-8999-999999999999';
  assert.deepEqual(await t.tenantDb().withTenant(stranger, listDevices), []);
  assert.deepEqual(await t.tenantDb().withTenant(stranger, (q) => listAlarmEvents(q, { limit: 500 })), []);
  const c = await t.makePool(1).connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${APP_ROLE}`);
    await c.query("select set_config('app.tenant_id', '', true)");
    assert.equal((await c.query('select * from device')).rowCount, 0);
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('the role cannot read telemetry, alarm_state, the alarm watermark or the outbox directly: permission denied', { skip }, async () => {
  const db = t.tenantDb();
  for (const table of ['telemetry', 'alarm_state', 'alarm_device', 'notification_outbox']) {
    await assert.rejects(db.withTenant(A, (q) => q.query(`select * from ${table}`)), (e: { code?: string }) => e.code === '42501', table);
  }
});

test('the role cannot write: not in a read-only request, and not even without one', { skip }, async () => {
  const db = t.tenantDb();
  await assert.rejects(db.withTenant(A, (q) => q.query("insert into device (device_id, tenant_id, name) values (99, $1, 'x')", [A])),
    (e: { code?: string }) => e.code === '25006' || e.code === '42501');
  await assert.rejects(db.withTenant(A, (q) => q.query("update device set tenant_id = $1 where device_id = 3", [A])),
    (e: { code?: string }) => e.code === '25006' || e.code === '42501');
  const c = await t.makePool(1).connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${APP_ROLE}`);
    for (const sql of ["insert into device (device_id, tenant_id, name) values (99, '" + A + "', 'x')", "delete from alarm_event", "update device set name = 'x'", 'truncate device']) {
      await assert.rejects(c.query(sql), (e: { code?: string }) => e.code === '42501', sql);
      await c.query('rollback');
      await c.query('begin');
      await c.query(`set local role ${APP_ROLE}`);
    }
  } finally {
    await c.query('rollback');
    c.release();
  }
  assert.equal((await t.admin.query('select count(*)::int as n from device')).rows[0].n, 3);
});

test('nothing leaks to the next request on the same connection: role and tenant are gone after the transaction', { skip }, async () => {
  const pool = t.makePool(1);                       // one connection: every request reuses it
  const db = new TenantDb(pool);
  await db.withTenant(A, listDevices);
  const after = (await pool.query("select current_user as who, current_setting('app.tenant_id', true) as tenant")).rows[0];
  assert.notEqual(after.who, APP_ROLE);
  assert.ok(after.tenant === '' || after.tenant === null, `tenant setting survived: ${after.tenant}`);
  assert.deepEqual(ids(await db.withTenant(B, listDevices)), [3]);   // B on the connection A just used
  assert.deepEqual(ids(await db.withTenant(A, listDevices)), [1, 2]);
});

test('a failing request is rolled back and the connection stays usable for the next tenant', { skip }, async () => {
  const pool = t.makePool(1);
  const db = new TenantDb(pool);
  await assert.rejects(db.withTenant(A, (q) => q.query('select * from no_such_table')), /no_such_table/);
  assert.deepEqual(ids(await db.withTenant(B, listDevices)), [3]);
  await assert.rejects(db.withTenant(A, async () => { throw new Error('handler failed'); }), /handler failed/);
  assert.deepEqual(ids(await db.withTenant(A, listDevices)), [1, 2]);
  assert.equal(pool.totalCount, 1);   // no connection was thrown away for ordinary errors
});

test('a query that runs too long is cancelled by the database', { skip }, async () => {
  const db = t.tenantDb({ statementTimeoutMs: 100, max: 1 });
  await assert.rejects(db.withTenant(A, (q) => q.query('select pg_sleep(5)')), (e: { code?: string }) => e.code === '57014');
  assert.deepEqual(ids(await db.withTenant(A, listDevices)), [1, 2]);   // the same connection works again
});

test('a tenant id that is not a UUID is refused before the database is touched', { skip }, async () => {
  for (const bad of ['', 'nope', "x'; drop table device; --", A + 'x', 'ａｂｃ']) {
    await assert.rejects(t.tenantDb().withTenant(bad, listDevices), TypeError, bad);
  }
});

test('interleaved requests of two tenants on a small pool never see each other\'s data', { skip }, async () => {
  const db = t.tenantDb({ max: 3 });
  const jobs = Array.from({ length: 60 }, (_, i) => {
    const mine = i % 2 === 0 ? A : B;
    const expected = mine === A ? [1, 2] : [3];
    return db.withTenant(mine, async (q) => {
      const devices = ids(await listDevices(q));
      const alarms = ids(await listAlarmEvents(q, { limit: 500 }));
      const own = await recentTelemetry(q, expected[0]!, { limit: 10 });
      const other = await recentTelemetry(q, mine === A ? 3 : 1, { limit: 10 });
      return { devices, alarms, own: own.length, other: other.length, expected };
    });
  });
  for (const r of await Promise.all(jobs)) {
    assert.deepEqual(r.devices, r.expected);
    assert.deepEqual(r.alarms, r.expected);
    assert.equal(r.own, 3);
    assert.equal(r.other, 0);
  }
});

test('for any split of devices between tenants, every tenant sees exactly its own and nothing else (model check)', { skip }, async () => {
  const DEVICES = [1, 2, 3, 4, 5, 6];
  const TENANTS = [A, B, C];
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom<string | null>(A, B, C, null), { minLength: DEVICES.length, maxLength: DEVICES.length }),
    async (owners) => {
      await t.admin.query('truncate telemetry, alarm_event, device');
      for (const [i, d] of DEVICES.entries()) {
        const owner = owners[i];
        if (owner !== null && owner !== undefined) await addDevice(t.admin, d, owner);
        await addSample(t.admin, d, T0, 1);
        await addSample(t.admin, d, T0 + 1000, 2);
        await addAlarm(t.admin, d, 'battery-temp-high', 'fired', T0 + 1000);
      }
      const db = t.tenantDb({ max: 2 });
      for (const tenant of TENANTS) {
        const mine = DEVICES.filter((_, i) => owners[i] === tenant);
        assert.deepEqual(ids(await db.withTenant(tenant, listDevices)), mine);
        assert.deepEqual(ids(await db.withTenant(tenant, (q) => listAlarmEvents(q, { limit: 500 }))), mine);
        for (const d of DEVICES) {
          const n = (await db.withTenant(tenant, (q) => recentTelemetry(q, d, { limit: 100 }))).length;
          assert.equal(n, mine.includes(d) ? 2 : 0, `tenant ${tenant} reading device ${d}`);
        }
      }
    }),
  { numRuns: 15 });
});
