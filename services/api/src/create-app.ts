import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogLevel } from '@nestjs/common';
import { MIN_SECRET_LENGTH } from './auth.ts';
import { AppModule, type AppModuleOptions } from './app.module.ts';

export interface CreateAppOptions extends AppModuleOptions {
  logLevels?: LogLevel[] | false;
  /** Web pages (origins, see cors.ts) that a browser may let call this API. None by default. */
  corsOrigins?: readonly string[];
}

/** The whole HTTP application, not yet listening. Used by main.ts and by the tests. */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  if (options.jwtSecret.length < MIN_SECRET_LENGTH) throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    logger: options.logLevels ?? ['error', 'warn'],
    bodyParser: false,   // every route is a GET: there is no body to parse
  });
  app.disable('x-powered-by');
  if (options.corsOrigins !== undefined && options.corsOrigins.length > 0) {
    // Only GET and only the Authorization header. No cookies are used, so no `credentials`. The CORS layer answers the
    // browser's preflight (OPTIONS) itself, before the guard, which is right: a preflight carries no token.
    app.enableCors({ origin: [...options.corsOrigins], methods: ['GET'], allowedHeaders: ['Authorization'], maxAge: 600 });
  }
  return app;
}
