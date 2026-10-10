// The whole HTTP application (Nest, guard, controllers, filter) in front of a real PostgreSQL, called over real HTTP.
// Skipped without TEST_DATABASE_URL. Each run works in a schema of its own.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import { AUDIENCE, ISSUER, signDevToken } from '../src/auth.ts';
import { createApp } from '../src/create-app.ts';
import type { TenantDb } from '../src/tenant-db.ts';
import { A, B, C, T0, addAlarm, addDevice, addSample, addTenant, createTestDb, skip, type TestDb } from './support.ts';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256';
let t: TestDb;
let app: NestExpressApplication;
let base: string;

before(async () => {
  if (skip) return;
  t = await createTestDb('test_http');
  app = await createApp({ tenantDb: t.tenantDb(), jwtSecret: SECRET, logLevels: false });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});
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

const tokenFor = (tenantId: string): Promise<string> => signDevToken({ secret: SECRET, tenantId, subject: 'test' });

async function get(path: string, token?: string | null, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}

test('GET /health needs no token and returns no data', { skip }, async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
});

test('without a valid token every data route answers 401, with the same message whatever was wrong', { skip }, async () => {
  const payload = { tenant: A, sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 };
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const expired = await signDevToken({ secret: SECRET, tenantId: A, subject: 'x', ttlSeconds: 60, now: new Date(Date.now() - 3_600_000) });
  const otherSecret = await signDevToken({ secret: 'another-secret-that-is-also-long-enough-ok', tenantId: A, subject: 'x' });
  const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
  const noTenant = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('x').setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));
  const attempts: Array<[string, string | null]> = [
    ['no header', null], ['garbage', 'not-a-token'], ['expired', expired], ['other secret', otherSecret], ['alg none', unsigned], ['no tenant claim', noTenant],
  ];
  for (const path of ['/v1/devices', '/v1/devices/1/telemetry', '/v1/alarms/events']) {
    for (const [what, token] of attempts) {
      const r = await get(path, token);
      assert.equal(r.status, 401, `${path} with ${what}`);
      assert.equal(r.body.message, 'missing or invalid token', `${path} with ${what}`);
    }
  }
  // Other ways to write the header are not accepted either.
  assert.equal((await get('/v1/devices', null, { authorization: `Basic ${await tokenFor(A)}` })).status, 401);
  assert.equal((await get('/v1/devices', null, { authorization: `Bearer ${await tokenFor(A)} extra` })).status, 401);
  assert.equal((await get('/v1/devices', null, { authorization: await tokenFor(A) })).status, 401);
});

test('a lower-case "bearer" scheme is accepted (the scheme name is case-insensitive)', { skip }, async () => {
  const r = await get('/v1/devices', null, { authorization: `bearer ${await tokenFor(A)}` });
  assert.equal(r.status, 200);
});

test('GET /v1/devices returns the caller\'s devices only', { skip }, async () => {
  assert.deepEqual((await get('/v1/devices', await tokenFor(A))).body, { devices: [{ deviceId: 1, name: 'Home 1' }, { deviceId: 2, name: 'Home 2' }] });
  assert.deepEqual((await get('/v1/devices', await tokenFor(B))).body, { devices: [{ deviceId: 3, name: 'Home 3' }] });
  assert.deepEqual((await get('/v1/devices', await tokenFor(C))).body, { devices: [] });
});

test('a valid token for a tenant that does not exist is allowed in and sees nothing', { skip }, async () => {
  const r = await get('/v1/devices', await tokenFor('99999999-9999-4999-8999-999999999999'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { devices: [] });
});

test('GET /v1/devices/:id/telemetry returns samples newest first with the device', { skip }, async () => {
  const r = await get('/v1/devices/1/telemetry', await tokenFor(A));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.device, { deviceId: 1, name: 'Home 1' });
  assert.deepEqual(r.body.samples.map((s: { seq: number }) => s.seq), [2, 1, 0]);
  assert.deepEqual(r.body.samples[0], { ts: new Date(T0 + 2000).toISOString(), bootId: '1', seq: 2, monoMs: 2000, values: { battTempC: 21, pvW: 100 } });
});

test('telemetry parameters: limit, from and to', { skip }, async () => {
  const token = await tokenFor(A);
  const seqs = async (q: string): Promise<number[]> => (await get(`/v1/devices/1/telemetry${q}`, token)).body.samples.map((s: { seq: number }) => s.seq);
  assert.deepEqual(await seqs('?limit=2'), [2, 1]);
  assert.deepEqual(await seqs(`?from=${new Date(T0 + 1000).toISOString()}`), [2, 1]);
  assert.deepEqual(await seqs(`?to=${new Date(T0 + 1000).toISOString()}`), [0]);
  assert.deepEqual(await seqs(`?from=${encodeURIComponent('2026-10-10T14:00:01+02:00')}&to=${encodeURIComponent('2026-10-10T12:00:02Z')}`), [1]);
});

test('another tenant\'s device and a device that does not exist give the same 404, for telemetry and for alarms', { skip }, async () => {
  const token = await tokenFor(A);
  const foreign = await get('/v1/devices/3/telemetry', token);       // B's
  const nobody = await get('/v1/devices/9/telemetry', token);        // registered to nobody
  const missing = await get('/v1/devices/777/telemetry', token);     // does not exist
  for (const r of [foreign, nobody, missing]) assert.equal(r.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.deepEqual(nobody.body, missing.body);
  for (const id of [3, 9, 777]) assert.equal((await get(`/v1/alarms/events?deviceId=${id}`, token)).status, 404, `alarms of ${id}`);
});

test('GET /v1/alarms/events returns the events of the caller\'s devices only, newest first', { skip }, async () => {
  const a = await get('/v1/alarms/events', await tokenFor(A));
  assert.equal(a.status, 200);
  assert.deepEqual([...new Set(a.body.events.map((e: { deviceId: number }) => e.deviceId))].sort(), [1, 2]);
  assert.equal(a.body.events.length, 4);
  assert.deepEqual(a.body.events.map((e: { event: string }) => e.event), ['resolved', 'resolved', 'fired', 'fired']);
  assert.deepEqual((await get('/v1/alarms/events?deviceId=2&limit=1', await tokenFor(A))).body.events.map((e: { deviceId: number }) => e.deviceId), [2]);
  const b = await get('/v1/alarms/events', await tokenFor(B));
  assert.deepEqual([...new Set(b.body.events.map((e: { deviceId: number }) => e.deviceId))], [3]);
  assert.deepEqual((await get('/v1/alarms/events', await tokenFor(C))).body, { events: [] });
});

test('bad parameters answer 400 with the reason, and never reach the database', { skip }, async () => {
  const token = await tokenFor(A);
  const bad = [
    '/v1/devices/abc/telemetry', '/v1/devices/0/telemetry', '/v1/devices/1;drop/telemetry', '/v1/devices/99999999999/telemetry',
    '/v1/devices/1/telemetry?limit=0', '/v1/devices/1/telemetry?limit=1001', '/v1/devices/1/telemetry?limit=ten',
    '/v1/devices/1/telemetry?limit=1&limit=2', '/v1/devices/1/telemetry?from=yesterday', '/v1/devices/1/telemetry?from=2026-10-10T12:00:00',
    '/v1/devices/1/telemetry?from=2026-02-31T00:00:00Z', `/v1/devices/1/telemetry?from=${new Date(T0 + 1).toISOString()}&to=${new Date(T0).toISOString()}`,
    '/v1/alarms/events?deviceId=x', '/v1/alarms/events?limit=501', '/v1/alarms/events?from=nope', '/v1/alarms/events?deviceId[a]=1', '/v1/alarms/events?device_id=2', '/v1/devices/1/telemetry?since=2026-10-10T12:00:00Z',
  ];
  for (const path of bad) {
    const r = await get(path, token);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error, 'Bad Request', path);
    assert.equal(typeof r.body.message, 'string', path);
  }
});

test('a token is checked before parameters: bad parameters without a token are 401, not 400', { skip }, async () => {
  assert.equal((await get('/v1/devices/abc/telemetry?limit=0')).status, 401);
});

test('an unexpected failure answers 500 with a generic message and leaks nothing', { skip }, async () => {
  const broken = {
    withTenant: async () => { throw new Error('connection to postgres://admin:hunter2@db.internal:5432 failed'); },
    ping: async () => {},
  } as unknown as TenantDb;
  const failing = await createApp({ tenantDb: broken, jwtSecret: SECRET, logLevels: false });
  await failing.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await failing.getUrl()}/v1/devices`, { headers: { authorization: `Bearer ${await tokenFor(A)}` } });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.ok(!/hunter2|postgres:|db\.internal/.test(text), text);
  } finally {
    await failing.close();
  }
});

test('/health answers 503 when the database cannot be reached', { skip }, async () => {
  const down = { ping: async () => { throw new Error('ECONNREFUSED'); }, withTenant: async () => [] } as unknown as TenantDb;
  const failing = await createApp({ tenantDb: down, jwtSecret: SECRET, logLevels: false });
  await failing.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await failing.getUrl()}/health`);
    assert.equal(res.status, 503);
  } finally {
    await failing.close();
  }
});

test('the server does not announce its framework, and unknown routes are 404', { skip }, async () => {
  const r = await get('/health');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal((await get('/v1/nothing', await tokenFor(A))).status, 404);
  assert.equal((await get('/v1/devices/1', await tokenFor(A))).status, 404);
});

test('a secret that is too short stops the application from starting', { skip }, async () => {
  await assert.rejects(createApp({ tenantDb: t.tenantDb(), jwtSecret: 'short', logLevels: false }), /at least 32/);
});
