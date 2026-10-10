import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.ts';
import { codeError, fakeDb, message, raw } from './helpers.ts';

const fastRetry = { baseMs: 1, maxMs: 2 };

test('a message is committed only after its rows are stored, and only the highest offset per partition', async () => {
  const log: string[] = [];
  const p = new Pipeline({ db: fakeDb(log), maxMessages: 4, retry: fastRetry });
  await p.add(message(0, 10, 1, 0, 5, log));
  await p.add(message(0, 11, 1, 5, 5, log));
  await p.add(message(1, 40, 2, 0, 5, log));
  assert.deepEqual(log, [], 'nothing is written or committed before the batch is full');
  await p.add(message(1, 41, 2, 5, 5, log));
  assert.deepEqual(log, ['insert 20 rows', 'commit p0@11', 'commit p1@41']);
  assert.equal(p.stats.inserted, 20);
  assert.equal(p.stats.batches, 1);
});

test('a database outage is waited out: no commit during it, one commit after it, nothing lost', async () => {
  const log: string[] = [];
  const db = fakeDb(log, (n) => (n <= 3 ? codeError('ECONNREFUSED') : null));
  const p = new Pipeline({ db, maxMessages: 2, retry: fastRetry });
  await p.add(message(0, 0, 1, 0, 5, log));
  await p.add(message(0, 1, 1, 5, 5, log));
  assert.deepEqual(log, ['insert 10 rows', 'commit p0@1']);
  assert.equal(p.stats.retries, 3);
  assert.equal(p.stats.inserted, 10);
});

test('an unrecoverable error fails the pipeline: no commit, and every later message is refused', async () => {
  const log: string[] = [];
  const fatal: Error[] = [];
  const db = fakeDb(log, () => codeError('22003', 'numeric value out of range'));
  const p = new Pipeline({ db, maxMessages: 1, retry: fastRetry, onFatal: (e) => fatal.push(e) });
  await assert.rejects(p.add(message(0, 0, 1, 0, 5, log)), /out of range/);
  assert.equal(fatal.length, 1);
  assert.deepEqual(log, [], 'nothing committed');
  // If the process kept running, committing a LATER offset would silently skip the failed batch.
  await assert.rejects(p.add(message(0, 1, 1, 5, 5, log)), /out of range/);
  await assert.rejects(p.flush(), /out of range/);
  assert.equal(fatal.length, 1, 'onFatal is called once');
  assert.deepEqual(log, []);
});

test('a small batch is written after maxWaitMs, not held back forever', async () => {
  const log: string[] = [];
  const p = new Pipeline({ db: fakeDb(log), maxMessages: 100, maxWaitMs: 20, retry: fastRetry });
  p.start();
  await p.add(message(0, 0, 1, 0, 5, log));
  await new Promise((r) => setTimeout(r, 150));
  await p.stop();
  assert.deepEqual(log, ['insert 5 rows', 'commit p0@0']);
});

test('stop() writes what is buffered and then ignores new messages (they stay uncommitted)', async () => {
  const log: string[] = [];
  const p = new Pipeline({ db: fakeDb(log), maxMessages: 100, retry: fastRetry });
  await p.add(message(0, 0, 1, 0, 5, log));
  await p.stop();
  assert.deepEqual(log, ['insert 5 rows', 'commit p0@0']);
  await p.add(message(0, 1, 1, 5, 5, log));
  await p.flush();
  assert.deepEqual(log, ['insert 5 rows', 'commit p0@0'], 'the late message was neither written nor committed');
});

test('undecodable messages are skipped and committed; the rest of the batch is stored', async () => {
  const log: string[] = [];
  const lines: string[] = [];
  const p = new Pipeline({ db: fakeDb(log), maxMessages: 3, retry: fastRetry, log: (l) => lines.push(l) });
  await p.add(message(0, 0, 1, 0, 5, log));
  await p.add(raw(0, 1, 'this is not json', log));
  await p.add(raw(0, 2, null, log));
  assert.deepEqual(log, ['insert 5 rows', 'commit p0@2']);
  assert.equal(p.stats.undecodable, 2);
  assert.equal(p.stats.inserted, 5);
  assert.ok(lines.some((l) => l.includes('not valid JSON')), 'the reason is logged');
});

test('batches never overlap, even when many messages arrive at once', async () => {
  const log: string[] = [];
  const db = fakeDb(log);
  const p = new Pipeline({ db, maxMessages: 2, retry: fastRetry });
  await Promise.all(Array.from({ length: 8 }, (_, i) => p.add(message(0, i, 1, i * 5, 5, log))));
  await p.flush();
  assert.equal(db.maxConcurrent, 1);
  assert.equal(db.rows, 40);
  const commits = log.filter((l) => l.startsWith('commit')).map((l) => Number(l.split('@')[1]));
  assert.deepEqual(commits, [...commits].sort((a, b) => a - b), 'commits only move forward');
  assert.equal(commits.at(-1), 7);
});

test('abort() ends the wait for a database that stays down; the batch stays uncommitted', async () => {
  const log: string[] = [];
  const fatal: Error[] = [];
  const db = fakeDb(log, () => codeError('ECONNREFUSED'));
  const p = new Pipeline({ db, maxMessages: 100, retry: { baseMs: 10_000, maxMs: 10_000 }, onFatal: (e) => fatal.push(e) });
  await p.add(message(0, 0, 1, 0, 5, log));
  const flushing = p.flush();
  setTimeout(() => p.abort(), 30);
  await assert.rejects(flushing, /shutdown requested/);
  assert.equal(fatal.length, 1);
  assert.deepEqual(log, []);
});

test('a failing commit is counted but is not fatal: the rows are stored, and the next batch works', async () => {
  const log: string[] = [];
  const p = new Pipeline({ db: fakeDb(log), maxMessages: 1, retry: fastRetry });
  const bad = message(0, 0, 1, 0, 5, log);
  bad.commit = () => { throw new Error('rebalance in progress'); };
  await p.add(bad);
  assert.equal(p.stats.commitErrors, 1);
  assert.equal(p.stats.inserted, 5);
  await p.add(message(0, 1, 1, 5, 5, log));
  assert.deepEqual(log, ['insert 5 rows', 'insert 5 rows', 'commit p0@1']);
});