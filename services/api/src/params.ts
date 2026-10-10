/** A request parameter that is not acceptable. The HTTP layer answers it with 400 and this message. */
export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamError';
  }
}

const INT4_MAX = 2_147_483_647;

/** Express hands over string | string[] | object for a query parameter; only one plain string is accepted. */
export function one(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ParamError(`${name} must be given once, as plain text`);
  return raw;
}

/**
 * Refuses query parameters that this route does not know. A typo such as ?device_id=2 would otherwise be ignored
 * and the caller would get unfiltered data without noticing.
 */
export function onlyKnown(query: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(query).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new ParamError(`unknown parameter ${unknown.map((k) => JSON.stringify(k)).join(', ')}; allowed: ${allowed.join(', ')}`);
}

/** A device id: a positive whole number that fits the integer column. */
export function parseDeviceId(raw: string | undefined, name = 'deviceId'): number {
  if (raw === undefined || !/^\d{1,10}$/.test(raw)) throw new ParamError(`${name} must be a positive whole number`);
  const n = Number(raw);
  if (n < 1 || n > INT4_MAX) throw new ParamError(`${name} must be a positive whole number`);
  return n;
}

/** limit: a whole number from 1 to `max`; `def` when not given. Too large is an error, not silently cut. */
export function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) throw new ParamError(`limit must be a whole number from 1 to ${max}`);
  return n;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A moment as ISO 8601 with a time zone, e.g. 2026-10-10T12:00:00Z or 2026-10-10T14:00:00+02:00.
 * The zone is required: a time without one would be read in the server's zone. The year must be 2000 to 2100 (the
 * range the writer accepts). `new Date()` is not used to judge the text: it turns 31 February into 3 March.
 */
export function parseInstant(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined) return undefined;
  const fail = (): never => { throw new ParamError(`${name} must be a date and time like 2026-10-10T12:00:00Z (with a time zone)`); };
  const m = INSTANT.exec(raw);
  if (m === null) return fail();
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return fail();
  if (hour > 23 || minute > 59 || second > 59) return fail();
  let offsetMin = 0;
  const zone = m[8] as string;
  if (zone !== 'Z') {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return fail();
    offsetMin = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm);
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000);
}

/** `from` (inclusive) and `to` (exclusive), both optional; if both are given, from must be before to. */
export function parseRange(fromRaw: string | undefined, toRaw: string | undefined): { from: Date | undefined; to: Date | undefined } {
  const from = parseInstant(fromRaw, 'from');
  const to = parseInstant(toRaw, 'to');
  if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) throw new ParamError('from must be before to');
  return { from, to };
}
