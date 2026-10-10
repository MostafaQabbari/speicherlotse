import { Controller, Get, Inject, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentPrincipal } from './auth.guard.ts';
import type { Principal } from './auth.ts';
import { one, onlyKnown, parseDeviceId, parseLimit, parseRange } from './params.ts';
import { getDevice, listAlarmEvents, type AlarmEventView } from './queries.ts';
import { TenantDb } from './tenant-db.ts';

@Controller('v1/alarms')
@UseGuards(AuthGuard)
export class AlarmsController {
  readonly #db: TenantDb;

  constructor(@Inject(TenantDb) db: TenantDb) {
    this.#db = db;
  }

  /** Alarm events (fired, resolved) of the caller's devices, newest first. Optional: deviceId, from, to, limit (1 to 500, default 50). */
  @Get('events')
  async events(@CurrentPrincipal() who: Principal, @Query() query: Record<string, unknown>): Promise<{ events: AlarmEventView[] }> {
    onlyKnown(query, ['deviceId', 'from', 'to', 'limit']);
    const rawDevice = one(query.deviceId, 'deviceId');
    const deviceId = rawDevice === undefined ? undefined : parseDeviceId(rawDevice);
    const { from, to } = parseRange(one(query.from, 'from'), one(query.to, 'to'));
    const limit = parseLimit(one(query.limit, 'limit'), 50, 500);
    return this.#db.withTenant(who.tenantId, async (q) => {
      if (deviceId !== undefined && (await getDevice(q, deviceId)) === null) throw new NotFoundException('device not found');
      return { events: await listAlarmEvents(q, { deviceId, from, to, limit }) };
    });
  }
}
