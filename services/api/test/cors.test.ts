// CORS: which web pages may call the API from a browser. No database needed: /health with a stand-in database is enough.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseOrigins } from '../src/cors.ts';
import { createApp } from '../src/create-app.ts';
import type { TenantDb } from '../src/tenant-db.ts';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256';
const ALLOWED = 'http://localhost:4200';
const OTHER = 'http://evil.example';
const fakeDb = { ping: async () => {}, withTenant: async () => [] } as unknown as TenantDb;

test('parseOrigins: nothing set means nobody is allowed', () => {
  assert.deepEqual(parseOrigins(undefined), []);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins('   '), []);
});

test('parseOrigins: a list of origins, spaces ignored, duplicates dropped', () => {
  assert.deepEqual(parseOrigins('http://localhost:4200'), ['http://localhost:4200']);
  assert.deepEqual(parseOrigins(' http://localhost:4200 , https://app.example.org,http://localhost:4200'), ['http://localhost:4200', 'https://app.example.org']);
});

test('parseOrigins: no wildcard, no path, no trailing slash, no other scheme, no empty entry', () => {
  for (const bad of ['*', 'http://localhost:4200/', 'http://localhost:4200/app', 'localhost:4200', 'ftp://example.org', 'null', 'http://localhost:4200,,https://a.example', 'HTTP://LOCALHOST:4200', 'http://*.example.org']) {
    assert.throws(() => parseOrigins(bad), /CORS_ORIGINS/, bad);
  }
});

const apps: NestExpressApplication[] = [];
async function start(corsOrigins?: string[]): Promise<string> {
  const app = await createApp({ tenantDb: fakeDb, jwtSecret: SECRET, logLevels: false, ...(corsOrigins === undefined ? {} : { corsOrigins }) });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}
after(async () => { await Promise.all(apps.map((a) => a.close())); });

const preflight = (base: string, origin: string, headers = 'authorization'): Promise<Response> =>
  fetch(`${base}/v1/devices`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': headers } });

test('a listed origin gets its preflight answered without a token, for GET and the Authorization header only', async () => {
  const base = await start([ALLOWED]);
  const res = await preflight(base, ALLOWED);
  assert.equal(res.status, 204);            // not 401: the preflight carries no token and must not reach the guard
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization');
  assert.match(res.headers.get('vary') ?? '', /Origin/i);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('an origin that is not listed gets no permission', async () => {
  const base = await start([ALLOWED]);
  const res = await preflight(base, OTHER);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const get = await fetch(`${base}/health`, { headers: { origin: OTHER } });
  assert.equal(get.headers.get('access-control-allow-origin'), null);
});

test('an answer to a listed origin names exactly that origin, never "*"', async () => {
  const base = await start([ALLOWED, 'https://app.example.org']);
  const a = await fetch(`${base}/health`, { headers: { origin: ALLOWED } });
  assert.equal(a.headers.get('access-control-allow-origin'), ALLOWED);
  const b = await fetch(`${base}/health`, { headers: { origin: 'https://app.example.org' } });
  assert.equal(b.headers.get('access-control-allow-origin'), 'https://app.example.org');
});

test('without a list, no origin gets permission', async () => {
  const base = await start();
  const get = await fetch(`${base}/health`, { headers: { origin: ALLOWED } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('access-control-allow-origin'), null);
  assert.equal((await preflight(base, ALLOWED)).headers.get('access-control-allow-origin'), null);
  const empty = await start([]);
  assert.equal((await fetch(`${empty}/health`, { headers: { origin: ALLOWED } })).headers.get('access-control-allow-origin'), null);
});

test('CORS does not open the data routes: a request without a token is still 401', async () => {
  const base = await start([ALLOWED]);
  const res = await fetch(`${base}/v1/devices`, { headers: { origin: ALLOWED } });
  assert.equal(res.status, 401);
});
