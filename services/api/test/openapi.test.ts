// The OpenAPI description must say what the API does. Part 1 needs no database: the routes, the schemas and the file on
// disk. Part 2 (skipped without TEST_DATABASE_URL) calls every route against a real PostgreSQL and checks each answer,
// each page-size limit and each id range against the description.
import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CONTROLLERS } from '../src/app.module.ts';
import { createApp } from '../src/create-app.ts';
import { ALARM_EVENTS_LIMIT, TELEMETRY_LIMIT } from '../src/limits.ts';
import { buildOpenApi, openApiText } from '../src/openapi.ts';
import { signDevToken } from '../src/auth.ts';
import type { TenantDb } from '../src/tenant-db.ts';
import { A, B, T0, addAlarm, addDevice, addFullSample, addSample, addTenant, createTestDb, skip, type TestDb } from './support.ts';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256';
const spec = buildOpenApi() as any;

// The library is CommonJS; under Node's ESM rules its class sits on `.default` for the type checker.
const AjvClass = ((Ajv2020 as any).default ?? Ajv2020) as new (o: object) => any;
const addFormatsFn = ((addFormats as any).default ?? addFormats) as (ajv: any) => void;
const ajv = new AjvClass({ strict: false, allErrors: true });   // not strict: the OpenAPI document has keys (paths, info, ...) that are not JSON Schema
addFormatsFn(ajv);

/** Checks a value against a schema of the description (a schema may point into #/components). */
function check(schema: object, value: unknown, what: string): void {
  const validate = ajv.compile({ ...schema, components: spec.components });
  assert.ok(validate(value), `${what} does not match the description: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value).slice(0, 400)}`);
}
const responseSchema = (path: string, status: number): object => {
  const response = spec.paths[path]?.get?.responses?.[String(status)];
  assert.ok(response, `GET ${path} answered ${status}, which the description does not list`);
  return response.content['application/json'].schema;
};

/** "GET /v1/devices/{id}/telemetry" for every route that the application's controllers define. */
function routesOfTheApplication(): string[] {
  const methodName = (m: number): string => RequestMethod[m] ?? String(m);
  const join = (...parts: string[]): string => `/${parts.flatMap((p) => p.split('/')).filter((p) => p !== '').join('/')}`.replace(/:(\w+)/g, '{$1}');
  const routes: string[] = [];
  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata('path', controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as any)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method === undefined) continue;
      routes.push(`${methodName(method)} ${join(base, Reflect.getMetadata('path', handler) as string)}`);
    }
  }
  return routes.sort();
}
const routesInTheDescription = (): string[] =>
  Object.entries(spec.paths).flatMap(([path, item]) => Object.keys(item as object).map((m) => `${m.toUpperCase()} ${path}`)).sort();

test('every route of the application is described, and every described route exists', () => {
  assert.deepEqual(routesInTheDescription(), routesOfTheApplication());
});

test('every schema of the description compiles, and every $ref points at something', () => {
  for (const name of Object.keys(spec.components.schemas)) {
    assert.doesNotThrow(() => ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }), name);
  }
  const text = JSON.stringify(spec);
  for (const [, target] of text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)) {
    assert.ok(spec.components.schemas[target as string], `$ref to missing schema ${target}`);
  }
});

test('every operation has a distinct operationId, and every data route asks for the bearer token', () => {
  const ids = new Set<string>();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    const op = item.get;
    assert.ok(op.operationId && !ids.has(op.operationId), `${path}: operationId`);
    ids.add(op.operationId);
    const open = path === '/health' || path === '/openapi.json';
    assert.deepEqual(op.security ?? spec.security, open ? [] : [{ bearerAuth: [] }], path);
  }
});

test('services/api/openapi.json is what the code produces (run: pnpm --filter @speicherlotse/api openapi)', () => {
  const onDisk = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
  assert.equal(onDisk, openApiText());
});

test('the description is served without a token at /openapi.json', async () => {
  const stand = { ping: async () => {}, withTenant: async () => [] } as unknown as TenantDb;
  const app = await createApp({ tenantDb: stand, jwtSecret: SECRET, logLevels: false });
  await app.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await app.getUrl()}/openapi.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), JSON.parse(openApiText()));
  } finally {
    await app.close();
  }
});

// ---- part 2: the real routes against a real database ----

let t: TestDb;
let app: NestExpressApplication;
let base: string;

before(async () => {
  if (skip) return;
  t = await createTestDb('test_openapi');
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
  await addDevice(t.admin, 1, A);
  await addDevice(t.admin, 2, A);
  await addDevice(t.admin, 3, B);
});

const token = (tenantId: string): Promise<string> => signDevToken({ secret: SECRET, tenantId, subject: 'test' });
async function get(path: string, tok: string | null): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: tok === null ? {} : { authorization: `Bearer ${tok}` } });
  return { status: res.status, body: await res.json() };
}
/** Calls a route and checks status and body against the description. */
async function checked(descriptionPath: string, url: string, tok: string | null, expected: number): Promise<any> {
  const r = await get(url, tok);
  assert.equal(r.status, expected, `${url}: ${JSON.stringify(r.body)}`);
  check(responseSchema(descriptionPath, r.status), r.body, `${url} (${r.status})`);
  return r.body;
}

test('real answers match the description: success and every kind of error', { skip }, async () => {
  const alpha = await token(A);
  await addFullSample(t.admin, 1, T0, 1);
  await addSample(t.admin, 1, T0 + 1000, 2, null);            // a sample where one channel is missing
  await addAlarm(t.admin, 1, 'battery-temp-high', 'fired', T0 + 500, 'critical');
  await addAlarm(t.admin, 1, 'battery-temp-high', 'resolved', T0 + 900);
  await checked('/health', '/health', null, 200);
  assert.equal((await checked('/v1/devices', '/v1/devices', alpha, 200)).devices.length, 2);
  const tel = await checked('/v1/devices/{id}/telemetry', '/v1/devices/1/telemetry', alpha, 200);
  assert.equal(tel.samples.length, 2);
  await checked('/v1/devices/{id}/telemetry', '/v1/devices/1/telemetry?from=2026-10-10T12:00:00Z&to=2026-10-10T15:00:00%2B02:00&limit=1', alpha, 200);
  assert.equal((await checked('/v1/alarms/events', '/v1/alarms/events?deviceId=1', alpha, 200)).events.length, 2);
  await checked('/v1/alarms/events', '/v1/alarms/events', alpha, 200);
  // errors
  await checked('/v1/devices', '/v1/devices', null, 401);
  await checked('/v1/devices/{id}/telemetry', '/v1/devices/3/telemetry', alpha, 404);
  await checked('/v1/devices/{id}/telemetry', '/v1/devices/1/telemetry?limit=0', alpha, 400);
  await checked('/v1/alarms/events', '/v1/alarms/events?deviceId=3', alpha, 404);
  await checked('/v1/alarms/events', '/v1/alarms/events?from=yesterday', alpha, 400);
  await checked('/v1/alarms/events', '/v1/alarms/events?nothing=1', alpha, 400);
});

test('an empty tenant also matches the description', { skip }, async () => {
  const nobody = await token('33333333-3333-4333-8333-333333333333');
  const devices = await checked('/v1/devices', '/v1/devices', nobody, 200);
  assert.deepEqual(devices, { devices: [] });
  assert.deepEqual(await checked('/v1/alarms/events', '/v1/alarms/events', nobody, 200), { events: [] });
});

test('the page sizes and ranges in the description are the ones the routes enforce', { skip }, async () => {
  const alpha = await token(A);
  const limitOf = (path: string): { minimum: number; maximum: number; default: number } =>
    spec.paths[path].get.parameters.find((p: any) => p.name === 'limit').schema;
  assert.deepEqual(limitOf('/v1/devices/{id}/telemetry'), { type: 'integer', minimum: 1, maximum: TELEMETRY_LIMIT.max, default: TELEMETRY_LIMIT.default });
  assert.deepEqual(limitOf('/v1/alarms/events'), { type: 'integer', minimum: 1, maximum: ALARM_EVENTS_LIMIT.max, default: ALARM_EVENTS_LIMIT.default });
  for (const [path, url] of [['/v1/devices/{id}/telemetry', '/v1/devices/1/telemetry'], ['/v1/alarms/events', '/v1/alarms/events?deviceId=1']] as const) {
    const { minimum, maximum } = limitOf(path);
    const sep = url.includes('?') ? '&' : '?';
    await checked(path, `${url}${sep}limit=${minimum}`, alpha, 200);
    await checked(path, `${url}${sep}limit=${maximum}`, alpha, 200);
    await checked(path, `${url}${sep}limit=${minimum - 1}`, alpha, 400);
    await checked(path, `${url}${sep}limit=${maximum + 1}`, alpha, 400);
  }
  const idSchema = spec.paths['/v1/devices/{id}/telemetry'].get.parameters.find((p: any) => p.name === 'id').schema;
  await checked('/v1/devices/{id}/telemetry', `/v1/devices/${idSchema.maximum}/telemetry`, alpha, 404);      // valid, but nobody's
  await checked('/v1/devices/{id}/telemetry', `/v1/devices/${idSchema.maximum + 1}/telemetry`, alpha, 400);
  await checked('/v1/devices/{id}/telemetry', `/v1/devices/${idSchema.minimum - 1}/telemetry`, alpha, 400);
  await checked('/v1/alarms/events', `/v1/alarms/events?deviceId=${spec.paths['/v1/alarms/events'].get.parameters[0].schema.maximum + 1}`, alpha, 400);
});

test('without limit the routes return the default number of rows', { skip }, async () => {
  const alpha = await token(A);
  for (let i = 0; i < TELEMETRY_LIMIT.default + 3; i++) await addSample(t.admin, 1, T0 + i * 1000, i);
  for (let i = 0; i < ALARM_EVENTS_LIMIT.default + 3; i++) await addAlarm(t.admin, 1, `rule-${i}`, 'fired', T0 + i * 1000);
  assert.equal((await checked('/v1/devices/{id}/telemetry', '/v1/devices/1/telemetry', alpha, 200)).samples.length, TELEMETRY_LIMIT.default);
  assert.equal((await checked('/v1/alarms/events', '/v1/alarms/events', alpha, 200)).events.length, ALARM_EVENTS_LIMIT.default);
});
