import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_NAMES, type Sample } from '@speicherlotse/telemetry-model';
import { CHANNEL_COLUMNS, columnFor, toRows } from '../src/rows.ts';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function sample(over: Partial<Sample> = {}): Sample {
  return { deviceId: 7, bootId: 1, seq: 10, wallMs: T0, monoMs: 5_000, values: { pvW: 1500, battSoc: 55.5, battStatus: 2 }, ...over };
}

test('column names are the channel names in snake_case', () => {
  assert.equal(columnFor('pvW'), 'pv_w');
  assert.equal(columnFor('battTempC'), 'batt_temp_c');
  assert.equal(columnFor('cellMvMin'), 'cell_mv_min');
  assert.equal(columnFor('gridHz'), 'grid_hz');
  assert.equal(new Set(CHANNEL_COLUMNS.map((c) => c.column)).size, CHANNEL_NAMES.length, 'no two channels share a column');
});

test('a normal sample becomes one row; missing channels are null', () => {
  const { rows, rejected } = toRows([sample()]);
  assert.equal(rejected.length, 0);
  const row = rows[0]!;
  assert.equal(row.values.length, CHANNEL_COLUMNS.length);
  assert.equal(row.values[CHANNEL_NAMES.indexOf('pvW')], 1500);
  assert.equal(row.values[CHANNEL_NAMES.indexOf('loadW')], null);
});

test('a value that does not fit its column becomes null, the rest of the sample survives', () => {
  const { rows, rejected } = toRows([sample({ values: { pvW: 1e300, loadW: 400, battStatus: 2.5, evStatus: 40_000, gridHz: 50.01 } })]);
  assert.equal(rejected.length, 0);
  const v = rows[0]!.values;
  assert.equal(v[CHANNEL_NAMES.indexOf('pvW')], null, 'overflows float4');
  assert.equal(v[CHANNEL_NAMES.indexOf('loadW')], 400);
  assert.equal(v[CHANNEL_NAMES.indexOf('battStatus')], null, 'a status code must be an integer');
  assert.equal(v[CHANNEL_NAMES.indexOf('evStatus')], null, 'does not fit smallint');
  assert.equal(v[CHANNEL_NAMES.indexOf('gridHz')], 50.01);
});

test('implausible but storable values are kept (plausibility is the rule layer\'s job)', () => {
  const { rows } = toRows([sample({ values: { battTempC: 900 } })]);
  assert.equal(rows[0]!.values[CHANNEL_NAMES.indexOf('battTempC')], 900);
});

test('samples that cannot be stored are rejected with a reason', () => {
  const cases: [Partial<Sample>, RegExp][] = [
    [{ deviceId: 2 ** 31 }, /deviceId/],
    [{ deviceId: 0 }, /deviceId/],
    [{ seq: 2 ** 31 }, /seq/],
    [{ seq: -1 }, /seq/],
    [{ wallMs: 0 }, /wallMs/],                       // clock never set
    [{ wallMs: Date.UTC(2200, 0, 1) }, /wallMs/],
    [{ monoMs: -5 }, /monoMs/],
  ];
  for (const [over, re] of cases) {
    const { rows, rejected } = toRows([sample(over)]);
    assert.equal(rows.length, 0, JSON.stringify(over));
    assert.match(rejected[0]!.reason, re);
  }
});

test('fractional milliseconds are rounded, one bad sample does not affect its neighbours', () => {
  const { rows, rejected } = toRows([sample({ seq: 1, wallMs: T0 + 0.4 }), sample({ seq: 2, wallMs: 0 }), sample({ seq: 3, wallMs: T0 + 2_000 })]);
  assert.deepEqual(rows.map((r) => r.seq), [1, 3]);
  assert.equal(rows[0]!.tsMs, T0);
  assert.equal(rejected.length, 1);
});