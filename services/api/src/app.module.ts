import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AlarmsController } from './alarms.controller.ts';
import { AuthGuard, JWT_SECRET } from './auth.guard.ts';
import { DevicesController } from './devices.controller.ts';
import { HealthController } from './health.controller.ts';
import { ParamErrorFilter } from './param-error.filter.ts';
import { TenantDb } from './tenant-db.ts';

export interface AppModuleOptions {
  tenantDb: TenantDb;
  jwtSecret: string;
}

/** Built with `register` so that the database and the secret are handed in (tests use a database of their own). */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, DevicesController, AlarmsController],
      providers: [
        { provide: TenantDb, useValue: options.tenantDb },
        { provide: JWT_SECRET, useValue: options.jwtSecret },
        AuthGuard,
        { provide: APP_FILTER, useClass: ParamErrorFilter },
      ],
    };
  }
}
