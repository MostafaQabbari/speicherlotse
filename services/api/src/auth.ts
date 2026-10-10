import { SignJWT, jwtVerify } from 'jose';
import { isTenantId } from './tenant-db.ts';

export const ISSUER = 'speicherlotse-dev';
export const AUDIENCE = 'speicherlotse-api';
export const MIN_SECRET_LENGTH = 32;

/** Who is calling: the tenant decides what the request may see. */
export interface Principal {
  tenantId: string;
  subject: string;
}

/** The token is missing, malformed, expired, signed by somebody else, or not meant for this API. The reason stays in the log. */
export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}

function keyFrom(secret: string): Uint8Array {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  return new TextEncoder().encode(secret);
}

export interface DevTokenOptions {
  secret: string;
  tenantId: string;
  subject: string;
  ttlSeconds?: number;
  now?: Date;
}

/** A development token (HS256, shared secret). A real deployment would verify tokens from an identity provider instead. */
export async function signDevToken(o: DevTokenOptions): Promise<string> {
  if (!isTenantId(o.tenantId)) throw new Error('tenantId must be a UUID');
  const now = Math.floor((o.now ?? new Date()).getTime() / 1000);
  return new SignJWT({ tenant: o.tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(o.subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.ttlSeconds ?? 3_600))
    .sign(keyFrom(o.secret));
}

/** Checks signature (HS256 only), issuer, audience, expiry and the tenant claim. Throws AuthError, never anything else. */
export async function verifyToken(token: string, secret: string, now: Date = new Date()): Promise<Principal> {
  const key = keyFrom(secret);   // a too-short secret is a configuration error, not a bad token: let it through as an Error
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ['exp', 'sub', 'tenant'],
      currentDate: now,
    });
    if (!isTenantId(payload.tenant)) throw new AuthError('tenant claim is not a UUID');
    return { tenantId: payload.tenant.toLowerCase(), subject: String(payload.sub) };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(error instanceof Error ? error.message : 'invalid token', { cause: error });
  }
}
