import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { AUDIENCE, ISSUER, AuthError, signDevToken, verifyToken } from '../src/auth.ts';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256';
const OTHER = 'another-secret-that-is-also-long-enough-ok';
const TENANT = '11111111-1111-4111-8111-111111111111';

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A token signed with jose directly, so that single claims can be left out or changed. */
function custom(claims: Record<string, unknown>, o: { secret?: string; alg?: string; iss?: string; aud?: string; exp?: number | null; sub?: string | null } = {}): Promise<string> {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: o.alg ?? 'HS256' }).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? AUDIENCE);
  if (o.sub !== null) jwt.setSubject(o.sub ?? 'someone');
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 600);
  return jwt.sign(new TextEncoder().encode(o.secret ?? SECRET));
}

test('a token made by signDevToken is accepted and gives the tenant and the subject', async () => {
  const token = await signDevToken({ secret: SECRET, tenantId: TENANT, subject: 'alice' });
  assert.deepEqual(await verifyToken(token, SECRET), { tenantId: TENANT, subject: 'alice' });
});

test('the tenant id is returned in lower case, whatever case the token used', async () => {
  const token = await custom({ tenant: TENANT.toUpperCase() });
  assert.equal((await verifyToken(token, SECRET)).tenantId, TENANT);
});

test('a token signed with another secret is refused', async () => {
  await assert.rejects(verifyToken(await signDevToken({ secret: OTHER, tenantId: TENANT, subject: 'x' }), SECRET), AuthError);
});

test('an expired token is refused, and one second before expiry it still works', async () => {
  const issued = new Date('2026-10-10T12:00:00Z');
  const token = await signDevToken({ secret: SECRET, tenantId: TENANT, subject: 'x', ttlSeconds: 60, now: issued });
  await verifyToken(token, SECRET, new Date(issued.getTime() + 59_000));
  await assert.rejects(verifyToken(token, SECRET, new Date(issued.getTime() + 61_000)), AuthError);
});

test('a token without an expiry is refused', async () => {
  await assert.rejects(verifyToken(await custom({ tenant: TENANT }, { exp: null }), SECRET), AuthError);
});

test('a token without a subject, or without a tenant, is refused', async () => {
  await assert.rejects(verifyToken(await custom({ tenant: TENANT }, { sub: null }), SECRET), AuthError);
  await assert.rejects(verifyToken(await custom({}), SECRET), AuthError);
});

test('a tenant claim that is not a UUID is refused (including SQL and wrong types)', async () => {
  for (const tenant of ['not-a-uuid', "11111111-1111-4111-8111-111111111111'; drop table device;--", '', 42, null, ['11111111-1111-4111-8111-111111111111'], { id: TENANT }]) {
    await assert.rejects(verifyToken(await custom({ tenant }), SECRET), AuthError, `should refuse ${JSON.stringify(tenant)}`);
  }
});

test('a token for another issuer or another audience is refused', async () => {
  await assert.rejects(verifyToken(await custom({ tenant: TENANT }, { iss: 'someone-else' }), SECRET), AuthError);
  await assert.rejects(verifyToken(await custom({ tenant: TENANT }, { aud: 'another-api' }), SECRET), AuthError);
});

test('only HS256 is accepted: HS512 is refused', async () => {
  await assert.rejects(verifyToken(await custom({ tenant: TENANT }, { alg: 'HS512' }), SECRET), AuthError);
});

test('an unsigned token ("alg": "none") is refused, with and without an empty signature', async () => {
  const payload = { tenant: TENANT, sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 };
  const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
  await assert.rejects(verifyToken(unsigned, SECRET), AuthError);
  await assert.rejects(verifyToken(unsigned.slice(0, -1), SECRET), AuthError);
});

test('a token whose payload was changed after signing is refused', async () => {
  const [h, p, s] = (await signDevToken({ secret: SECRET, tenantId: TENANT, subject: 'x' })).split('.') as [string, string, string];
  const changed = { ...JSON.parse(Buffer.from(p, 'base64url').toString()), tenant: '22222222-2222-4222-8222-222222222222' };
  await assert.rejects(verifyToken(`${h}.${b64(changed)}.${s}`, SECRET), AuthError);
});

test('garbage is refused with an AuthError, never another error', async () => {
  for (const junk of ['', 'abc', 'a.b.c', '....', 'eyJ.eyJ.sig', 'Bearer x']) await assert.rejects(verifyToken(junk, SECRET), AuthError);
});

test('a secret that is too short is a configuration error, not a bad token', async () => {
  await assert.rejects(signDevToken({ secret: 'short', tenantId: TENANT, subject: 'x' }), /at least 32/);
  await assert.rejects(verifyToken('a.b.c', 'short'), (e) => !(e instanceof AuthError) && /at least 32/.test((e as Error).message));
});

test('signDevToken refuses a tenant id that is not a UUID', async () => {
  await assert.rejects(signDevToken({ secret: SECRET, tenantId: 'nope', subject: 'x' }), /UUID/);
});
