// End to end with a real PostgreSQL: messages in, rows in the table, commits after the rows are visible.
// Skipped without TEST_DATABASE_URL (see store.test.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { Pipeline } from '../src/pipeline.ts';
import { message } from './helpers.ts';

const URL = process.env.TEST_DATABASE_URL;
const skip = URL === undefined ? 'TEST_DATABASE_URL is not set' : false;
const SCHEMA = `test_e2e_${process.pid}_${Date.now()}`;

let db: pg.Client;
before(async () => {
  if (skip) return;
  db = new pg.Client({ connectionString: URL });
  await db.connect();
  await db.query(`create schema ${SCHEMA}`);
  await db.query(`set search_path to ${SCHEMA}`);
  await migrate(db, { timescale: false });
});
after(async () => {
  if (skip) return;
  await db.query(`drop schema ${SCHEMA} cascade`);
  await db.end();
});

const count = async (): Promise<number> => Number((await db.query('select count(*) from telemetry')).rows[0].count);

test('at the moment of each commit, the rows of that message are already in the table', { skip }, async () => {
  const seenAtCommit: number[] = [];
  const mk = (offset: number, device: number, firstSeq: number) => {
    const m = message(0, offset, device, firstSeq, 5);
    m.commit = async () => { seenAtCommit.push(await count()); };
    return m;
  };
  const p = new Pipeline({ db, maxMessages: 2 });
  const start = await count();
  await p.add(mk(0, 10, 0));
  await p.add(mk(1, 10, 5));    // full batch: 10 rows, one commit
  await p.add(mk(2, 10, 10));
  await p.add(mk(3, 10, 15));   // second batch: 20 rows
  assert.deepEqual(seenAtCommit.map((n) => n - start), [10, 20]);
});

test('a redelivered message (same samples, new offset) changes nothing and is counted as duplicates', { skip }, async () => {
  const p = new Pipeline({ db, maxMessages: 2 });
  const start = await count();
  await p.add(message(0, 100, 20, 0, 5));
  await p.add(message(0, 101, 21, 0, 5));
  assert.equal((await count()) - start, 10);
  await p.add(message(0, 102, 20, 0, 5));   // the same five samples again
  await p.add(message(0, 103, 21, 0, 5));
  assert.equal((await count()) - start, 10, 'no new rows');
  assert.equal(p.stats.inserted, 10);
  assert.equal(p.stats.duplicates, 10);
});