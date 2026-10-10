import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage } from '../src/message.ts';
import { SendError, webhookSender } from '../src/sender.ts';

const message = buildMessage({ deviceId: 2, ruleId: 'battery-temp-high', event: 'fired', severity: 'warning', atMs: Date.UTC(2026, 9, 10, 14, 0, 0), attempts: 0 });

const withFetch = (fn: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 1_000) =>
  webhookSender({ url: 'http://receiver.test/hook', timeoutMs, fetch: ((url: string, init: RequestInit) => fn(url, init)) as typeof fetch });

const failure = async (p: Promise<void>): Promise<SendError> => {
  try { await p; } catch (err) { assert.ok(err instanceof SendError, `expected a SendError, got ${String(err)}`); return err; }
  assert.fail('expected the send to fail');
};

test('a 2xx answer is a success; the request is a JSON POST with the message id as Idempotency-Key', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  await withFetch(async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); }).send(message);

  assert.equal(seen?.url, 'http://receiver.test/hook');
  assert.equal(seen?.init.method, 'POST');
  assert.equal(seen?.init.redirect, 'manual');
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers['idempotency-key'], message.id);
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(seen?.init.body)), message);
});

test('server errors, timeouts, early requests and "too many requests" are worth another try', async () => {
  for (const status of [500, 502, 503, 408, 425, 429]) {
    const err = await failure(withFetch(async () => new Response('later', { status })).send(message));
    assert.equal(err.permanent, false, `status ${status}`);
    assert.match(err.message, new RegExp(String(status)));
  }
});

test('the receiver refusing the message itself is permanent: wrong address, bad request, no permission', async () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    const err = await failure(withFetch(async () => new Response('no', { status })).send(message));
    assert.equal(err.permanent, true, `status ${status}`);
  }
});

test('a redirect is permanent: a POST that is redirected is a wrong address', async () => {
  const err = await failure(withFetch(async () => new Response(null, { status: 301, headers: { location: 'http://elsewhere.test/' } })).send(message));
  assert.equal(err.permanent, true);
});

test('no answer at all (connection refused) may pass: not permanent', async () => {
  const err = await failure(withFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }).send(message));
  assert.equal(err.permanent, false);
  assert.match(err.message, /not reachable/);
});

test('a receiver that never answers is cut off after the timeout and counts as not permanent', async () => {
  // A real request keeps the process alive with its socket; AbortSignal.timeout's own timer does not, so hold it open here.
  const hang = (_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => undefined, 5_000);
    init.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal?.reason); }, { once: true });
  });
  const started = Date.now();
  const err = await failure(withFetch(hang, 30).send(message));
  assert.equal(err.permanent, false);
  assert.ok(Date.now() - started < 1_000, 'the timeout did not cut the request off');
});