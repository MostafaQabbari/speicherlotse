// With a real PostgreSQL: messages in, alarm events and state in the tables, commits after the transaction.
// Skipped without TEST_DATABASE_URL (see the writer's store.test.ts). Each run works in its own schema.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';
import { AlarmEngine } from '../src/alarm-engine.ts';
import { clientDatabase, type Database } from '../src/db.ts';
import { alarmPipeline } from '../src/pipeline.ts';
import { at, HOT, message, span, T0 } from './helpers.ts';

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL === undefined ? 'TEST_DATABASE_URL is not set' : false;
const SCHEMA = `test_alarms_${process.pid}_${Date.now()}`;
const fastRetry = { baseMs: 1, maxMs: 2 };

let client: pg.Client;
let db: Database;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`create schema ${SCHEMA}`);
  await client.query(`set search_path to ${SCHEMA}`);
  db = clientDatabase(client);
});
after(async () => {
  if (skip) return;
  await client.query(`drop schema ${SCHEMA} cascade`);
  await client.end();
});

const events = async (device: number): Promise<Array<{ rule_id: string; event: string; at_ms: number }>> =>
  (await client.query('select rule_id, event, at_ms::float8 as at_ms from alarm_event where device_id = $1 order by at_ms, event', [device])).rows;
const states = async (device: number): Promise<Array<{ rule_id: string; state: { kind: string } }>> =>
  (await client.query('select rule_id, state from alarm_state where device_id = $1 order by rule_id', [device])).rows;
const watermark = async (device: number): Promise<number | null> => {
  const r = await client.query('select last_wall_ms::float8 as w from alarm_device where device_id = $1', [device]);
  return r.rows[0]?.w ?? null;
};

test('migrate creates the tables once and is a no-op the second time', { skip }, async () => {
  const dir = new URL('../sql/', import.meta.url);
  assert.deepEqual(await runMigrations(client, dir, { timescale: false }), ['001_alarms.sql']);
  assert.deepEqual(await runMigrations(client, dir, { timescale: false }), []);
});

test('a firing alarm leaves its event, its state and the watermark in the database', { skip }, async () => {
  const engine = new AlarmEngine(db, [HOT]);
  const out = await engine.handle([message(0, 0, span(11, 0, 30, 60))]);

  assert.equal(out.samples, 30);
  assert.deepEqual(out.events.map((e) => e.event), ['fired']);
  assert.deepEqual(await events(11), [{ rule_id: 'hot', event: 'fired', at_ms: T0 + 10_000 }]);
  assert.deepEqual((await states(11)).map((s) => [s.rule_id, s.state.kind]), [['hot', 'firing']]);
  assert.equal(await watermark(11), T0 + 29_000);
});

test('after a restart the engine continues where it stopped: a pending alarm still fires on time', { skip }, async () => {
  const before = new AlarmEngine(db, [HOT]);
  await before.handle([message(0, 0, span(12, 0, 8, 60))]);       // 8 hot seconds: pending, not firing yet
  assert.deepEqual(await events(12), []);

  const afterRestart = new AlarmEngine(db, [HOT]);                  // empty memory, same database
  assert.equal(afterRestart.devices, 0);
  await afterRestart.handle([message(0, 1, span(12, 8, 15, 60))]);
  assert.deepEqual(await events(12), [{ rule_id: 'hot', event: 'fired', at_ms: T0 + 10_000 }]);
});

test('messages delivered again after a restart add no events and change nothing', { skip }, async () => {
  const first = new AlarmEngine(db, [HOT]);
  await first.handle([message(0, 0, span(13, 0, 30, 60))]);
  const marks = await watermark(13);

  const second = new AlarmEngine(db, [HOT]);
  const out = await second.handle([message(0, 0, span(13, 0, 30, 60))]);
  assert.equal(out.skippedOld, 30);
  assert.equal(out.events.length, 0);
  assert.equal((await events(13)).length, 1);
  assert.equal(await watermark(13), marks);
});

test('several devices in one batch are stored together, each with its own state', { skip }, async () => {
  const engine = new AlarmEngine(db, [HOT]);
  await engine.handle([
    message(0, 0, span(21, 0, 20, 60)),
    message(1, 0, span(22, 0, 20, 20)),
    message(2, 0, span(23, 0, 5, 60)),
  ]);
  assert.deepEqual((await states(21)).map((s) => s.state.kind), ['firing']);
  assert.deepEqual(await states(22), []);                                    // normal = no row
  assert.deepEqual((await states(23)).map((s) => s.state.kind), ['pending']);
  assert.equal(await watermark(22), T0 + 19_000);
});

test('a transaction that fails halfway leaves nothing behind; the retry stores everything once', { skip }, async () => {
  let attempts = 0;
  const seenAfterFailure: number[] = [];
  const flaky: Database = {
    ...db,
    async transaction(fn) {
      attempts++;
      if (attempts > 1) return db.transaction(fn);
      // First attempt: do all the writes, then fail before the commit (the server went away).
      await assert.rejects(db.transaction(async (tx) => {
        await fn(tx);
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      }));
      seenAfterFailure.push((await events(31)).length, (await states(31)).length, (await watermark(31)) === null ? 0 : 1);
      throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    },
  };

  const log: string[] = [];
  const pipeline = alarmPipeline({ engine: new AlarmEngine(flaky, [HOT]), maxMessages: 1, retry: fastRetry });
  const m = message(0, 0, span(31, 0, 30, 60), log);
  await pipeline.add(m);

  assert.deepEqual(seenAfterFailure, [0, 0, 0]);       // rolled back: no event, no state, no watermark
  assert.equal(pipeline.stats.retries, 1);
  assert.equal((await events(31)).length, 1);
  assert.deepEqual(log, ['commit p0@0']);              // committed once, after the stored transaction
});

test('a commit that fails after the transaction is harmless: the redelivered batch adds nothing', { skip }, async () => {
  const pipeline = alarmPipeline({ engine: new AlarmEngine(db, [HOT]), maxMessages: 1, retry: fastRetry });
  const first = message(0, 0, span(41, 0, 30, 60));
  first.commit = () => { throw new Error('kafka went away'); };
  await pipeline.add(first);
  assert.equal(pipeline.stats.commitErrors, 1);

  await pipeline.add(message(0, 0, span(41, 0, 30, 60)));        // Kafka delivers the same offset again
  assert.equal(pipeline.stats.skippedOld, 30);
  assert.equal((await events(41)).length, 1);
});

test('the full life cycle is recorded: fired, then resolved', { skip }, async () => {
  const engine = new AlarmEngine(db, [HOT]);
  await engine.handle([message(0, 0, [...span(51, 0, 20, 60), ...span(51, 20, 40, 20)])]);
  assert.deepEqual((await events(51)).map((e) => [e.event, e.at_ms - T0]), [['fired', 10_000], ['resolved', 25_000]]);
  assert.deepEqual(await states(51), []);
});

test('a message that cannot be decoded is skipped and counted; the rest of the batch is used', { skip }, async () => {
  const engine = new AlarmEngine(db, [HOT]);
  const bad = message(0, 0, [at(61, 0, 60)]);
  bad.value = new TextEncoder().encode('not json');
  const out = await engine.handle([bad, message(0, 1, span(61, 0, 30, 60))]);
  assert.equal(out.undecodable, 1);
  assert.equal((await events(61)).length, 1);
});