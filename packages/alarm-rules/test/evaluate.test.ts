import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import type { ChannelValues, Sample } from '@speicherlotse/telemetry-model';
import { evaluate, NO_ALARMS, type AlarmTransition, type DeviceAlarms } from '../src/evaluate.ts';
import { evaluateCondition, type AlarmRule } from '../src/rule.ts';
import { DEFAULT_RULES } from '../src/default-rules.ts';

const hot: AlarmRule = {
  id: 'hot', severity: 'warning', forMs: 60_000, clearMs: 30_000,
  when: { kind: 'threshold', channel: 'battTempC', op: '>', value: 45 },
};
const imbalance: AlarmRule = {
  id: 'imbalance', severity: 'warning', forMs: 0, clearMs: 0,
  when: { kind: 'spread', high: 'cellMvMax', low: 'cellMvMin', above: 150 },
};

function sample(atS: number, values: ChannelValues): Sample {
  return { deviceId: 7, bootId: 1, seq: atS, wallMs: atS * 1000, monoMs: atS * 1000, values };
}

/** Feed [seconds, values] pairs into one device and collect all events. */
function run(rules: readonly AlarmRule[], inputs: Array<[number, ChannelValues]>) {
  let alarms: DeviceAlarms = NO_ALARMS;
  const events: AlarmTransition[] = [];
  for (const [atS, values] of inputs) {
    const r = evaluate(alarms, sample(atS, values), rules);
    alarms = r.alarms;
    events.push(...r.events);
  }
  return { alarms, events };
}

test('threshold: fires after forMs, with rule id, severity and event time', () => {
  const { events } = run([hot], [
    [0, { battTempC: 50 }], [30, { battTempC: 50 }], [60, { battTempC: 50 }], [90, { battTempC: 50 }],
  ]);
  assert.deepEqual(events, [
    { deviceId: 7, ruleId: 'hot', severity: 'warning', event: 'fired', atMs: 60_000 },
  ]);
});

test('threshold: exactly at the limit is not a violation (strictly greater)', () => {
  assert.equal(evaluateCondition(hot.when, { battTempC: 45 }), false);
  assert.equal(evaluateCondition(hot.when, { battTempC: 45.1 }), true);
});

test('spread: cell imbalance compares two channels', () => {
  assert.equal(evaluateCondition(imbalance.when, { cellMvMin: 3300, cellMvMax: 3440 }), false); // 140 mV
  assert.equal(evaluateCondition(imbalance.when, { cellMvMin: 3300, cellMvMax: 3460 }), true);  // 160 mV
});

test('a missing channel means "unknown", not "false"', () => {
  assert.equal(evaluateCondition(hot.when, {}), null);
  assert.equal(evaluateCondition(imbalance.when, { cellMvMax: 3500 }), null);   // one of two is missing
});

test('an impossible value (sensor glitch) is unknown, so it cannot fire an alarm', () => {
  assert.equal(evaluateCondition(hot.when, { battTempC: 999 }), null);   // battTempC max is 80
  assert.equal(evaluateCondition(hot.when, { battTempC: NaN }), null);
  const { events } = run([hot], [[0, { battTempC: 999 }], [120, { battTempC: 999 }]]);
  assert.deepEqual(events, []);
});

test('a sample without the channel leaves every alarm state exactly as it was', () => {
  const tempSeq = fc.array(fc.tuple(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 20, max: 70 })), { maxLength: 60 });
  fc.assert(fc.property(tempSeq, (steps) => {
    let t = 0;
    const inputs: Array<[number, ChannelValues]> = steps.map(([dt, temp]) => [t += dt, { battTempC: temp }]);
    const before = run([hot], inputs);
    const after = evaluate(before.alarms, sample(t + 1, { pvW: 1000 }), [hot]);   // no battTempC at all
    assert.deepEqual([...after.alarms], [...before.alarms]);
    assert.deepEqual(after.events, []);
    return true;
  }));
});

test('evaluate never modifies the map it was given', () => {
  const first = evaluate(NO_ALARMS, sample(0, { battTempC: 50 }), [hot]);
  const snapshot = JSON.stringify([...first.alarms]);
  evaluate(first.alarms, sample(60, { battTempC: 50 }), [hot]);   // this one fires
  assert.equal(JSON.stringify([...first.alarms]), snapshot);
});

test('rules are independent: one device, two alarms, separate life cycles', () => {
  const { events } = run([hot, imbalance], [
    [0,  { battTempC: 50, cellMvMin: 3300, cellMvMax: 3500 }],   // imbalance true, forMs 0 -> pending
    [1,  { battTempC: 50, cellMvMin: 3300, cellMvMax: 3500 }],   // imbalance fires
    [61, { battTempC: 50, cellMvMin: 3300, cellMvMax: 3350 }],   // hot fires, imbalance starts clearing
  ]);
  assert.deepEqual(events.map((e) => [e.ruleId, e.event, e.atMs]), [
    ['imbalance', 'fired', 1_000],
    ['hot', 'fired', 61_000],
  ]);
});

test('normal alarms are not stored: the map stays small', () => {
  const { alarms } = run([hot], [[0, { battTempC: 50 }], [10, { battTempC: 20 }]]);   // blip, back to normal
  assert.equal(alarms.size, 0);
});

test('replaying the same samples gives the same events (default rules, random data)', () => {
  const values = fc.record({
    battTempC: fc.integer({ min: 0, max: 70 }),
    gridHz: fc.double({ min: 49.5, max: 50.5, noNaN: true }),
  }, { requiredKeys: [] });
  fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 60 }), values), { maxLength: 200 }), (steps) => {
    let t = 0;
    const inputs: Array<[number, ChannelValues]> = steps.map(([dt, v]) => [t += dt, v]);
    assert.deepEqual(run(DEFAULT_RULES, inputs).events, run(DEFAULT_RULES, inputs).events);
    return true;
  }));
});

test('every default rule has a unique id and uses real channels', () => {
  const ids = DEFAULT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of DEFAULT_RULES) {
    // an empty sample must give "unknown", never throw, for every rule
    assert.equal(evaluateCondition(r.when, {}), null);
  }
});