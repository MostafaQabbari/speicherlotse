import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, withRetry } from '../src/retry.ts';
import { codeError } from './helpers.ts';
import { describeError } from '../src/errors.ts';

test('connection problems and server restarts are transient', () => {
  assert.equal(isTransient(codeError('ECONNREFUSED')), true);
  assert.equal(isTransient(codeError('ECONNRESET')), true);
  assert.equal(isTransient(codeError('57P03')), true);          // server starting up: cannot connect now
  assert.equal(isTransient(codeError('57P01')), true);          // server shutting down
  assert.equal(isTransient(codeError('08006')), true);          // connection failure
  assert.equal(isTransient(codeError('40P01')), true);          // deadlock
  assert.equal(isTransient(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransient(new AggregateError([codeError('ECONNREFUSED'), codeError('ECONNREFUSED')])), true);
});

test('bad data, constraint and schema errors are not transient: waiting would never help', () => {
  assert.equal(isTransient(codeError('22003')), false);         // numeric value out of range
  assert.equal(isTransient(codeError('23505')), false);         // unique violation
  assert.equal(isTransient(codeError('42P01')), false);         // table does not exist
  assert.equal(isTransient(new Error('boom')), false);
  assert.equal(isTransient('a string'), false);
  assert.equal(isTransient(null), false);
});

const fast = { baseMs: 1, maxMs: 2, isRetryable: isTransient };

test('withRetry waits out transient failures and then returns the result', async () => {
  let calls = 0;
  let retries = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls <= 3) throw codeError('ECONNREFUSED');
    return 'ok';
  }, { ...fast, onRetry: () => { retries++; } });
  assert.equal(result, 'ok');
  assert.equal(calls, 4);
  assert.equal(retries, 3);
});

test('withRetry throws a non-transient error at once, without trying again', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw codeError('22003'); }, fast), /22003/);
  assert.equal(calls, 1);
});

test('aborting stops the waiting', async () => {
  const ac = new AbortController();
  const p = withRetry(async () => { throw codeError('ECONNREFUSED'); }, { baseMs: 10_000, maxMs: 10_000, isRetryable: isTransient, signal: ac.signal });
  setTimeout(() => ac.abort(new Error('stop')), 20);
  const started = Date.now();
  await assert.rejects(p, /stop/);
  assert.ok(Date.now() - started < 2_000, 'did not wait for the 10 s delay');
});

test('describeError gives a readable reason, also for the empty-message AggregateError Node throws', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  const noMessage = Object.assign(new AggregateError([refused, refused]), { code: 'ECONNREFUSED' });
  assert.equal(noMessage.message, '');
  assert.equal(describeError(noMessage), 'connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError('plain string'), 'plain string');
});