import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ParamError, one, onlyKnown, parseDeviceId, parseInstant, parseLimit, parseRange } from '../src/params.ts';

test('a query parameter must be given once, as plain text', () => {
  assert.equal(one(undefined, 'x'), undefined);
  assert.equal(one('5', 'x'), '5');
  assert.throws(() => one(['1', '2'], 'x'), ParamError);        // ?x=1&x=2
  assert.throws(() => one({ a: '1' }, 'x'), ParamError);        // ?x[a]=1
});

test('device ids: positive whole numbers that fit the integer column', () => {
  assert.equal(parseDeviceId('1'), 1);
  assert.equal(parseDeviceId('2147483647'), 2_147_483_647);
  for (const bad of [undefined, '', '0', '-1', '1.5', '1e3', ' 1', '1 ', '+1', '0x10', '2147483648', '99999999999', 'abc', '1;drop table device']) {
    assert.throws(() => parseDeviceId(bad), ParamError, `should refuse ${String(bad)}`);
  }
});

test('limit: default when absent, 1 to max when given, an error (not a silent cut) above max', () => {
  assert.equal(parseLimit(undefined, 50, 500), 50);
  assert.equal(parseLimit('1', 50, 500), 1);
  assert.equal(parseLimit('500', 50, 500), 500);
  for (const bad of ['0', '501', '-5', '1.5', 'ten', '', '1e2', '9999999999']) assert.throws(() => parseLimit(bad, 50, 500), ParamError);
});

test('limit: whatever the text, the result is within 1..max or a ParamError, never anything else', () => {
  fc.assert(fc.property(fc.string(), (s) => {
    try {
      const n = parseLimit(s, 50, 500);
      return Number.isInteger(n) && n >= 1 && n <= 500;
    } catch (e) {
      return e instanceof ParamError;
    }
  }));
});

test('instants: ISO 8601 with a time zone; the zone is converted to UTC', () => {
  assert.equal(parseInstant('2026-10-10T12:00:00Z', 't')?.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(parseInstant('2026-10-10T14:00:00+02:00', 't')?.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(parseInstant('2026-10-10T07:30-04:30', 't')?.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(parseInstant('2026-10-10T12:00:00.5Z', 't')?.toISOString(), '2026-10-10T12:00:00.500Z');
  assert.equal(parseInstant('2028-02-29T00:00:00Z', 't')?.toISOString(), '2028-02-29T00:00:00.000Z');   // leap day
  assert.equal(parseInstant(undefined, 't'), undefined);
});

test('instants: no zone, impossible dates and out-of-range years are refused (31 February is not 3 March)', () => {
  for (const bad of [
    '2026-10-10T12:00:00', '2026-10-10', '2026-10-10 12:00:00Z', '1700000000000', 'yesterday', '',
    '2026-02-31T00:00:00Z', '2027-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-10-00T00:00:00Z',
    '2026-10-10T24:00:00Z', '2026-10-10T12:60:00Z', '2026-10-10T12:00:60Z', '2026-10-10T12:00:00+24:00', '2026-10-10T12:00:00+01:60',
    '1999-12-31T23:59:59Z', '2101-01-01T00:00:00Z',
  ]) {
    assert.throws(() => parseInstant(bad, 't'), ParamError, `should refuse ${bad}`);
  }
});

test('a range needs from before to; each end is optional', () => {
  assert.deepEqual(parseRange(undefined, undefined), { from: undefined, to: undefined });
  assert.equal(parseRange('2026-10-10T12:00:00Z', undefined).from?.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.throws(() => parseRange('2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z'), /before/);
  assert.throws(() => parseRange('2026-10-11T12:00:00Z', '2026-10-10T12:00:00Z'), /before/);
  assert.throws(() => parseRange('nope', undefined), /from must be/);
});

test('instants: whatever the text, a valid Date or a ParamError, never another error', () => {
  fc.assert(fc.property(fc.string(), (s) => {
    try {
      const d = parseInstant(s, 't');
      return d instanceof Date && !Number.isNaN(d.getTime());
    } catch (e) {
      return e instanceof ParamError;
    }
  }), { numRuns: 500 });
});

test('unknown query parameters are refused, so that a typo cannot silently return unfiltered data', () => {
  onlyKnown({}, ['a', 'b']);
  onlyKnown({ a: '1' }, ['a', 'b']);
  assert.throws(() => onlyKnown({ device_id: '2' }, ['deviceId', 'limit']), /unknown parameter "device_id"; allowed: deviceId, limit/);
  assert.throws(() => onlyKnown({ a: '1', x: '1', y: '1' }, ['a']), /"x", "y"/);
});
