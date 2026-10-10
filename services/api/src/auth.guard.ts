import { Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthError, verifyToken, type Principal } from './auth.ts';

/** The injection token for the shared secret that signs the tokens. */
export const JWT_SECRET = Symbol('JWT_SECRET');

type AuthedRequest = Request & { principal?: Principal };

const BEARER = /^Bearer ([A-Za-z0-9\-_.]+)$/i;

/**
 * Lets a request through only with a valid "Authorization: Bearer <token>". The answer is always the same 401,
 * whatever was wrong, so a caller learns nothing about why; the reason goes to the log.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  readonly #secret: string;
  readonly #log = new Logger('Auth');

  constructor(@Inject(JWT_SECRET) secret: string) {
    this.#secret = secret;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    if (token === undefined) throw new UnauthorizedException('missing or invalid token');
    try {
      request.principal = await verifyToken(token, this.#secret);
      return true;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      this.#log.warn(`token refused: ${error.message}`);
      throw new UnauthorizedException('missing or invalid token');
    }
  }
}

/** The caller of this request, as the guard verified it. Only usable on routes behind AuthGuard. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
  if (principal === undefined) throw new UnauthorizedException('missing or invalid token');
  return principal;
});
