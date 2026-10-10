import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { TenantDb } from './tenant-db.ts';

@Controller('health')
export class HealthController {
  readonly #db: TenantDb;

  constructor(@Inject(TenantDb) db: TenantDb) {
    this.#db = db;
  }

  /** No token needed: a load balancer or an operator asks "is it up and can it reach the database?". Returns no data. */
  @Get()
  async health(): Promise<{ status: 'ok' }> {
    try {
      await this.#db.ping();
    } catch {
      throw new ServiceUnavailableException('database not reachable');
    }
    return { status: 'ok' };
  }
}
