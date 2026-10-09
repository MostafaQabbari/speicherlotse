import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { createHome, stepHome, DEFAULT_HOME, type Sample } from '@speicherlotse/telemetry-model';
import { decodeBatch, encodeBatch, parseTopic, topicFor, TELEMETRY_FILTER, MAX_SAMPLES_PER_BATCH } from '../src/index.ts';

const START = Date.UTC(2026, 9, 7, 10, 0, 0);

function simulate(seed: number, deviceId: number, n: number): Sample[] {
  const cfg = { ...DEFAULT_HOME, deviceId };
  let state = createHome(cfg, seed);
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const r = stepHome(cfg, state, START + i * 1000, 1);
    state = r.state;
    out.push(r.sample);
  }
  return out;
}

const decoded = (payload: string): Sample[] => {
  const r = decodeBatch(payload);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r.samples;
};

test('topics: build and parse agree, foreign topics are rejected', () => {
  assert.equal(topicFor(42), 'speicherlotse/v1/devices/42/telemetry');
  assert.deepEqual(parseTopic(topicFor(42)), { deviceId: 42 });
  assert.equal(TELEMETRY_FILTER, 'speicherlotse/v1/devices/+/telemetry');
  for (const bad of ['', 'other/1/telemetry', 'speicherlotse/v1/devices/0/telemetry', 'speicherlotse/v1/devices/-1/telemetry',
    'speicherlotse/v1/devices/1/telemetry/extra', 'speicherlotse/v1/devices/abc/telemetry', 'speicherlotse/v1/devices/1e3/telemetry']) {
    assert.equal(parseTopic(bad), null, bad);
  }
});

test('round trip: a simulated batch comes back exactly as it went in', () => {
  const batch = simulate(7, 3, 5);
  assert.deepEqual(decoded(encodeBatch(batch)), batch);
});

test('round trip holds for any seed, device and batch length', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 2 ** 31 }), fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 20 }),
    (seed, deviceId, n) => {
      const batch = simulate(seed, deviceId, n);
      assert.deepEqual(decoded(encodeBatch(batch)), batch);
    }), { numRuns: 100 });
});

test('the wire uses numeric channel ids, not names', () => {
  const msg = JSON.parse(encodeBatch(simulate(1, 1, 1)));
  assert.equal(msg.samples[0].values['1'] !== undefined, true);     // pvW has id 1
  assert.equal('pvW' in msg.samples[0].values, false);
});

test('encode refuses an empty batch, a mixed batch and an oversized batch', () => {
  assert.throws(() => encodeBatch([]));
  const [a] = simulate(1, 1, 1);
  const [b] = simulate(1, 2, 1);
  assert.throws(() => encodeBatch([a!, b!]));
  assert.throws(() => encodeBatch(simulate(1, 1, MAX_SAMPLES_PER_BATCH + 1)));
});

test('decode rejects a broken envelope with a reason, and never throws', () => {
  const good = JSON.parse(encodeBatch(simulate(1, 1, 2)));
  const cases: Record<string, unknown> = {
    'wrong version': { ...good, v: 2 },
    'no deviceId': { ...good, deviceId: undefined },
    'deviceId 0': { ...good, deviceId: 0 },
    'fractional deviceId': { ...good, deviceId: 1.5 },
    'empty samples': { ...good, samples: [] },
    'samples not an array': { ...good, samples: {} },
    'bad seq': { ...good, samples: [{ ...good.samples[0], seq: -1 }] },
    'bad monoMs': { ...good, samples: [{ ...good.samples[0], monoMs: 'x' }] },
    'values missing': { ...good, samples: [{ ...good.samples[0], values: undefined }] },
  };
  for (const [name, msg] of Object.entries(cases)) {
    const r = decodeBatch(JSON.stringify(msg));
    assert.equal(r.ok, false, name);
  }
  for (const junk of ['', 'not json', '[]', 'null', '42', '{']) assert.equal(decodeBatch(junk).ok, false, junk);
});

test('decode never throws on random bytes or random JSON', () => {
  fc.assert(fc.property(fc.string(), (s) => { decodeBatch(s); }));
  fc.assert(fc.property(fc.json(), (s) => { decodeBatch(s); }));
});

test('unknown channels and non-numeric values are skipped, the rest survives', () => {
  const msg = JSON.parse(encodeBatch(simulate(1, 1, 1)));
  msg.samples[0].values['999'] = 5;       // channel from newer firmware
  msg.samples[0].values['8'] = null;      // battTempC: a broken sensor reading
  msg.samples[0].values['9'] = 'hot';
  const [s] = decoded(JSON.stringify(msg));
  assert.equal('battTempC' in s!.values, false);
  assert.equal('battVoltageV' in s!.values, false);
  assert.equal(typeof s!.values.pvW, 'number');
  assert.equal(Object.keys(s!.values).length, 14);
});

test('an implausible value is NOT rejected here: that is the rule layer\'s job', () => {
  const msg = JSON.parse(encodeBatch(simulate(1, 1, 1)));
  msg.samples[0].values['8'] = 900;
  const [s] = decoded(JSON.stringify(msg));
  assert.equal(s!.values.battTempC, 900);
});