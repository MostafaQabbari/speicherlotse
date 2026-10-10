// With a real PostgreSQL: the outbox trigger, delivery, retries, giving up, and a crash between "sent" and "marked".
// Skipped without TEST_DATABASE_URL (see the writer's store.test.ts). Each run works in its own schema.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';
import { fromPg, type Db } from '../src/db.ts';
import type { NotificationMessage } from '../src/message.ts';
import { Notifier, type NotifierOptions } from '../src/notifier.ts';
import { SendError, type Sender } from '../src/sender.ts';

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL === undefined ? 'TEST_DATABASE_URL is not set' : false;
const SCHEMA = `test_notifier_${process.pid}_${Date.now()}`;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

let client: pg.Client;
let db: Db;
let firstMigration: string[];

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`create schema ${SCHEMA}`);
  await client.query(`set search_path to ${SCHEMA}`);
  db = fromPg(client);
  // The outbox trigger sits on alarm_event, which belongs to the alarms service: its tables come first.
  await runMigrations(client, new URL('../../alarms/sql/', import.meta.url), { timescale: false });
  firstMigration = await runMigrations(client, new URL('../sql/', import.meta.url), { timescale: false });
});
after(async () => {
  if (skip) return;
  await client.query(`drop schema ${SCHEMA} cascade`);
  await client.end();
});
beforeEach(async () => {
  if (skip) return;
  await client.query('truncate alarm_event, notification_outbox');
});

/** What the alarm engine does at the end of a batch, without the engine. */
const alarmEvent = (deviceId: number, ruleId: string, event: 'fired' | 'resolved', atMs: number, severity: 'warning' | 'critical' = 'critical'): Promise<unknown> =>
  client.query(
    `insert into alarm_event (device_id, rule_id, severity, event, at_ms, at)
     values ($1, $2, $3, $4, $5::bigint, to_timestamp($5::bigint / 1000.0)) on conflict do nothing`,
    [deviceId, ruleId, severity, event, atMs]);

const outbox = async (): Promise<Array<{ rule_id: string; event: string; attempts: number; sent: boolean; gave_up: boolean; last_error: string | null }>> =>
  (await client.query(
    `select rule_id, event, attempts, sent_at is not null as sent, gave_up_at is not null as gave_up, last_error
     from notification_outbox order by at_ms, event`)).rows;

/** A sender that records what it was asked to send and fails when told to. */
function fakeSender(plan: (m: NotificationMessage, call: number) => 'ok' | 'transient' | 'permanent' = () => 'ok') {
  const sent: NotificationMessage[] = [];
  const calls: string[] = [];
  const sender: Sender = {
    name: 'fake',
    async send(m) {
      calls.push(m.id);
      const verdict = plan(m, calls.length);
      if (verdict === 'transient') throw new SendError('receiver overloaded', false);
      if (verdict === 'permanent') throw new SendError('receiver refused (400)', true);
      sent.push(m);
    },
  };
  return { sender, sent, calls };
}

const options = (clock: { now: number }, extra: Partial<NotifierOptions> = {}): NotifierOptions => ({
  batchSize: 20, maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 60_000, now: () => clock.now, random: () => 1, ...extra,
});

test('migrate creates the outbox once and is a no-op the second time', { skip }, async () => {
  assert.deepEqual(firstMigration, ['001_notifications.sql']);
  assert.deepEqual(await runMigrations(client, new URL('../sql/', import.meta.url), { timescale: false }), []);
});

test('every alarm event is queued by the database itself, exactly once', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  await alarmEvent(2, 'hot', 'fired', T0);          // the engine's ON CONFLICT DO NOTHING: a repeated event
  await alarmEvent(2, 'hot', 'resolved', T0 + 60_000);
  assert.deepEqual((await outbox()).map((r) => [r.rule_id, r.event, r.attempts, r.sent]), [['hot', 'fired', 0, false], ['hot', 'resolved', 0, false]]);
});

test('an alarm transaction that is rolled back queues nothing', { skip }, async () => {
  await client.query('begin');
  await alarmEvent(2, 'hot', 'fired', T0);
  await client.query('rollback');
  assert.deepEqual(await outbox(), []);
});

test('notifications are sent oldest first, marked as sent, and never sent again', { skip }, async () => {
  await alarmEvent(3, 'late', 'fired', T0 + 5_000);
  await alarmEvent(2, 'early', 'fired', T0);
  const { sender, sent, calls } = fakeSender();
  const n = new Notifier(db, sender, options({ now: T0 + 10_000 }));

  assert.deepEqual(await n.runOnce(), { due: 2, sent: 2, retried: 0, gaveUp: 0 });
  assert.deepEqual(sent.map((m) => m.ruleId), ['early', 'late']);
  assert.deepEqual((await outbox()).map((r) => [r.sent, r.attempts]), [[true, 1], [true, 1]]);

  assert.deepEqual(await n.runOnce(), { due: 0, sent: 0, retried: 0, gaveUp: 0 });
  assert.equal(calls.length, 2);
});

test('a failed delivery is retried later, with growing waits, and not before it is due', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  const clock = { now: T0 };
  const { sender, calls } = fakeSender((_m, call) => (call <= 2 ? 'transient' : 'ok'));
  const n = new Notifier(db, sender, options(clock));

  assert.deepEqual(await n.runOnce(), { due: 1, sent: 0, retried: 1, gaveUp: 0 });   // 1st failure: wait 1 s
  assert.deepEqual((await outbox())[0]?.last_error, 'receiver overloaded');

  clock.now += 500;
  assert.equal((await n.runOnce()).due, 0, 'it came back too early');

  clock.now += 600;                                                                  // 1.1 s after the failure
  assert.deepEqual(await n.runOnce(), { due: 1, sent: 0, retried: 1, gaveUp: 0 });   // 2nd failure: wait 2 s

  clock.now += 1_500;
  assert.equal((await n.runOnce()).due, 0, 'the second wait is longer than the first');

  clock.now += 600;
  assert.deepEqual(await n.runOnce(), { due: 1, sent: 1, retried: 0, gaveUp: 0 });
  assert.deepEqual((await outbox()).map((r) => [r.sent, r.attempts, r.last_error]), [[true, 3, null]]);
  assert.equal(new Set(calls).size, 1, 'every attempt carries the same id');
});

test('a refusal by the receiver is final: no retry, the row is kept with its error', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  const clock = { now: T0 };
  const { sender, calls } = fakeSender(() => 'permanent');
  const lines: string[] = [];
  const n = new Notifier(db, sender, options(clock, { log: (l) => lines.push(l) }));

  assert.deepEqual(await n.runOnce(), { due: 1, sent: 0, retried: 0, gaveUp: 1 });
  clock.now += 10 * 60_000;
  assert.equal((await n.runOnce()).due, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual((await outbox()).map((r) => [r.sent, r.gave_up, r.attempts, r.last_error]), [[false, true, 1, 'receiver refused (400)']]);
  assert.match(lines.join('\n'), /GAVE UP .*the receiver refused it/);
});

test('after maxAttempts failed attempts the notification is abandoned', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  const clock = { now: T0 };
  const { sender, calls } = fakeSender(() => 'transient');
  const n = new Notifier(db, sender, options(clock));   // maxAttempts: 4

  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await n.runOnce());
    clock.now += 120_000;                                // longer than any wait
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(results.map((r) => [r.retried, r.gaveUp]), [[1, 0], [1, 0], [1, 0], [0, 1], [0, 0], [0, 0]]);
  assert.deepEqual((await outbox()).map((r) => [r.sent, r.gave_up, r.attempts]), [[false, true, 4]]);
});

test('one failing notification does not hold back the ones behind it', { skip }, async () => {
  await alarmEvent(2, 'first', 'fired', T0);
  await alarmEvent(3, 'second', 'fired', T0 + 1_000);
  const { sender, sent } = fakeSender((m) => (m.ruleId === 'first' ? 'transient' : 'ok'));
  const n = new Notifier(db, sender, options({ now: T0 + 5_000 }));

  assert.deepEqual(await n.runOnce(), { due: 2, sent: 1, retried: 1, gaveUp: 0 });
  assert.deepEqual(sent.map((m) => m.ruleId), ['second']);
});

test('"resolved" is never sent before the "fired" of the same alarm, while other alarms are not held up', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  await alarmEvent(2, 'hot', 'resolved', T0 + 60_000);
  await alarmEvent(2, 'other', 'fired', T0 + 30_000);
  const clock = { now: T0 + 120_000 };
  const { sender, sent } = fakeSender((m, call) => (m.id.includes(':hot:') && call === 1 ? 'transient' : 'ok'));
  const n = new Notifier(db, sender, options(clock));

  assert.deepEqual(await n.runOnce(), { due: 2, sent: 1, retried: 1, gaveUp: 0 });   // hot/resolved was not even tried
  assert.deepEqual(sent.map((m) => m.ruleId), ['other']);

  clock.now += 2_000;
  assert.deepEqual(await n.runOnce(), { due: 1, sent: 1, retried: 0, gaveUp: 0 });   // hot/fired goes first
  assert.deepEqual(await n.runOnce(), { due: 1, sent: 1, retried: 0, gaveUp: 0 });   // then hot/resolved
  assert.deepEqual(sent.map((m) => `${m.ruleId}:${m.event}`), ['other:fired', 'hot:fired', 'hot:resolved']);
});

test('when the earlier notification of an alarm is abandoned, the later one is no longer held back', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  await alarmEvent(2, 'hot', 'resolved', T0 + 60_000);
  const { sender, sent } = fakeSender((m) => (m.event === 'fired' ? 'permanent' : 'ok'));
  const n = new Notifier(db, sender, options({ now: T0 + 120_000 }));

  assert.deepEqual(await n.runOnce(), { due: 1, sent: 0, retried: 0, gaveUp: 1 });
  assert.deepEqual(await n.runOnce(), { due: 1, sent: 1, retried: 0, gaveUp: 0 });
  assert.deepEqual(sent.map((m) => m.event), ['resolved']);
});

test('a crash between "receiver accepted" and "marked as sent" sends it again, with the same id', { skip }, async () => {
  await alarmEvent(2, 'hot', 'fired', T0);
  const { sender, sent, calls } = fakeSender();
  let crashed = false;
  const flaky: Db = {
    query: async (text, values) => {
      if (!crashed && text.includes('set sent_at')) {
        crashed = true;
        throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
      }
      return db.query(text, values);
    },
  };
  const n = new Notifier(flaky, sender, options({ now: T0 + 5_000 }));

  await assert.rejects(n.runOnce(), /connection terminated/);   // the receiver has the message, the table does not know
  assert.deepEqual((await outbox()).map((r) => r.sent), [false]);

  assert.deepEqual(await n.runOnce(), { due: 1, sent: 1, retried: 0, gaveUp: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], 'the duplicate carries the same id, so a receiver can drop it');
  assert.equal(sent.length, 2);
  assert.deepEqual((await outbox()).map((r) => r.sent), [true]);
});

test('a batch never takes more than batchSize notifications; the rest follow in the next run', { skip }, async () => {
  for (let i = 0; i < 5; i++) await alarmEvent(i + 1, 'hot', 'fired', T0 + i * 1_000);
  const { sender, sent } = fakeSender();
  const n = new Notifier(db, sender, options({ now: T0 + 60_000 }, { batchSize: 2 }));

  assert.equal((await n.runOnce()).sent, 2);
  assert.equal((await n.runOnce()).sent, 2);
  assert.equal((await n.runOnce()).sent, 1);
  assert.deepEqual(sent.map((m) => m.deviceId), [1, 2, 3, 4, 5]);
});