import { Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentPrincipal } from './auth.guard.ts';
import type { Principal } from './auth.ts';
import { one, onlyKnown, parseDeviceId, parseLimit, parseRange } from './params.ts';
import { getDevice, listDevices, recentTelemetry, type DeviceView, type TelemetrySample } from './queries.ts';
import { TenantDb } from './tenant-db.ts';

@Controller('v1/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  readonly #db: TenantDb;

  constructor(@Inject(TenantDb) db: TenantDb) {
    this.#db = db;
  }

  /** The caller's devices. */
  @Get()
  async list(@CurrentPrincipal() who: Principal): Promise<{ devices: DeviceView[] }> {
    return { devices: await this.#db.withTenant(who.tenantId, listDevices) };
  }

  /** Samples of one device, newest first. `from` (inclusive), `to` (exclusive), `limit` (1 to 1000, default 100). */
  @Get(':id/telemetry')
  async telemetry(
    @CurrentPrincipal() who: Principal,
    @Param('id') idRaw: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ device: DeviceView; samples: TelemetrySample[] }> {
    onlyKnown(query, ['from', 'to', 'limit']);
    const deviceId = parseDeviceId(idRaw, 'id');
    const { from, to } = parseRange(one(query.from, 'from'), one(query.to, 'to'));
    const limit = parseLimit(one(query.limit, 'limit'), 100, 1_000);
    return this.#db.withTenant(who.tenantId, async (q) => {
      // Somebody else's device and a device that does not exist give the same answer.
      const device = await getDevice(q, deviceId);
      if (device === null) throw new NotFoundException('device not found');
      return { device, samples: await recentTelemetry(q, deviceId, { from, to, limit }) };
    });
  }
}
