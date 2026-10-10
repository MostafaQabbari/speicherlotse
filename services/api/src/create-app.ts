import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogLevel } from '@nestjs/common';
import { MIN_SECRET_LENGTH } from './auth.ts';
import { AppModule, type AppModuleOptions } from './app.module.ts';

export interface CreateAppOptions extends AppModuleOptions {
  logLevels?: LogLevel[] | false;
}

/** The whole HTTP application, not yet listening. Used by main.ts and by the tests. */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  if (options.jwtSecret.length < MIN_SECRET_LENGTH) throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    logger: options.logLevels ?? ['error', 'warn'],
    bodyParser: false,   // every route is a GET: there is no body to parse
  });
  app.disable('x-powered-by');
  return app;
}
