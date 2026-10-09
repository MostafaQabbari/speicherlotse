// These tests need a real PostgreSQL. Set TEST_DATABASE_URL to run them, e.g.
//   postgres://postgres:postgres@localhost:5432/speicherlotse
// Without it they are skipped, so `pnpm test` still passes on a machine (or CI) with no database.
// Each run works in its own schema and removes it afterwards, so it never touches real data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CHANNELS, CHANNEL_NAMES, type Sample } from '@speicherlotse/telemetry-model';
import { CHANNEL_COLUMNS, toRows } from '../src/rows.ts';
import { insertRows, MAX_ROWS_PER_STATEMENT } from '../src/insert.ts';
import { migrate } from '../src/migrate.ts';

const URL = process.env.TEST_DATABASE_URL;
const skip = URL === undefined ? 'TEST_DATABASE_URL is not set' : false;
const SCHEMA = `test_${process.pid}_${Date.now()}`;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

let db: pg.Client;

before(async () => {
  if (skip) return;
  db = new pg.Client({ connectionString: URL });
  await db.connect();
  await db.query(`create schema ${SCHEMA}`);
  await db.query(`set search_path to ${SCHEMA}`);
});

after(async () => {
  if (skip) return;
  await db.query(`drop schema ${SCHEMA} cascade`);
  await db.end();
});

const count = async () => Number((await db.query('select count(*) from telemetry')).rows[0].count);

function sample(over: Partial<Sample> = {}): Sample {
  return { deviceId: 1, bootId: 1, seq: 0, wallMs: T0, monoMs: 0, values: { pvW: 1500.5, battSoc: 55.5, battStatus: 2 }, ...over };
}

async function store(samples: Sample[]): Promise<number> {
  return insertRows(db, toRows(samples).rows);
}

test('migrate creates the table once and is a no-op the second time', { skip }, async () => {
  assert.deepEqual(await migrate(db, { timescale: false }), ['001_telemetry.sql']);
  assert.deepEqual(await migrate(db, { timescale: false }), []);
});

test('the table has exactly one column per channel, with the right type', { skip }, async () => {
  const r = await db.query(
    'select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2',
    [SCHEMA, 'telemetry'],
  );
  const types = new Map(r.rows.map((x) => [x.column_name as string, x.data_type as string]));
  for (const c of CHANNEL_COLUMNS) {
    assert.equal(types.get(c.column), CHANNELS[c.name].unit === 'code' ? 'smallint' : 'real', `column ${c.column}`);
  }
  const keyColumns = ['ts', 'device_id', 'boot_id', 'seq', 'mono_ms'];
  assert.equal(types.size, keyColumns.length + CHANNEL_NAMES.length, 'no column without a channel, no channel without a column');
});

test('a sample survives the round trip (timestamp to the millisecond, values as float4)', { skip }, async () => {
  assert.equal(await store([sample({ seq: 1, wallMs: T0 + 123 })]), 1);
  const r = await db.query(
    "select (extract(epoch from ts) * 1000)::bigint as ms, pv_w, load_w, batt_soc, batt_status from telemetry where seq = 1",
  );
  const row = r.rows[0];
  assert.equal(Number(row.ms), T0 + 123);
  assert.equal(row.pv_w, 1500.5);
  assert.equal(row.load_w, null);
  assert.equal(row.batt_soc, 55.5);
  assert.equal(row.batt_status, 2);
});

test('a duplicate (redelivered message) is skipped and reported as zero new rows', { skip }, async () => {
  const before = await count();
  const s = [sample({ seq: 20 }), sample({ seq: 21, wallMs: T0 + 1000 })];
  assert.equal(await store(s), 2);
  assert.equal(await store(s), 0);
  assert.equal(await count(), before + 2);
});

test('duplicates inside one batch do not fail the insert', { skip }, async () => {
  const before = await count();
  assert.equal(await store([sample({ seq: 30 }), sample({ seq: 30 }), sample({ seq: 31, wallMs: T0 + 1000 })]), 2);
  assert.equal(await count(), before + 2);
});

test('after a reboot the same seq with a new boot_id is a different row', { skip }, async () => {
  const before = await count();
  assert.equal(await store([sample({ seq: 40, bootId: 1 }), sample({ seq: 40, bootId: 2 })]), 2);
  assert.equal(await count(), before + 2);
});

test('a batch with unstorable values still goes in: bad values become NULL, bad samples are rejected', { skip }, async () => {
  const before = await count();
  const batch = [
    sample({ seq: 50, values: { pvW: 1e300, loadW: 300, battStatus: 2.5 } }),
    sample({ seq: 51, wallMs: 0 }),
    sample({ seq: 52, wallMs: T0 + 2000 }),
  ];
  const { rows, rejected } = toRows(batch);
  assert.equal(rejected.length, 1);
  assert.equal(await insertRows(db, rows), 2);
  assert.equal(await count(), before + 2);
  const r = (await db.query('select pv_w, load_w, batt_status from telemetry where seq = 50')).rows[0];
  assert.equal(r.pv_w, null);
  assert.equal(r.load_w, 300);
  assert.equal(r.batt_status, null);
});

test('batches larger than one statement are split and fully inserted', { skip }, async () => {
  const before = await count();
  const n = MAX_ROWS_PER_STATEMENT * 2 + 123;
  const samples = Array.from({ length: n }, (_, i) => sample({ deviceId: 99, seq: i, wallMs: T0 + i * 1000, monoMs: i * 1000 }));
  assert.equal(await store(samples), n);
  assert.equal(await count(), before + n);
});

test('an empty batch is fine', { skip }, async () => {
  assert.equal(await insertRows(db, []), 0);
});