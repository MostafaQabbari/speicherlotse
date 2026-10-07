import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { step, INITIAL_STATE, type AlarmEvent, type Rule } from '../src/step.ts';

const rule: Rule = { forMs: 60_000, clearMs: 30_000 };

/** Feed a list of [secondsSincePreviousObservation, condition] pairs into one alarm. Returns the events with their times. */
function run(r: Rule, observations: Array<[number, boolean]>): Array<{ event: AlarmEvent; atMs: number }> {
  let s = INITIAL_STATE;
  let nowMs = 0;
  const events: Array<{ event: AlarmEvent; atMs: number }> = [];
  for (const [dtS, condition] of observations) {
    nowMs += dtS * 1000;
    const [next, event] = step(s, condition, nowMs, r);
    s = next;
    if (event !== null) events.push({ event, atMs: nowMs });
  }
  return events;
}

test('a condition shorter than forMs never fires', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 59 }), (blipS) => {
    // true at 0 s, still true at blipS, then false: the blip lasted less than 60 s
    const events = run(rule, [[0, true], [blipS, true], [1, false], [100, false]]);
    return events.length === 0;
  }));
});

test('a sustained condition fires exactly once, at the first sample at or after forMs', () => {
  const events = run(rule, [[0, true], [20, true], [20, true], [20, true], [20, true], [20, true]]);
  assert.deepEqual(events, [{ event: 'fired', atMs: 60_000 }]);
});

test('the alarm resolves only after the condition stayed false for clearMs', () => {
  // false first appears at 70 s, so the 30 s clearing period ends at 100 s
  const events = run(rule, [[0, true], [60, true], [10, false], [10, false], [10, false], [10, false]]);
  assert.deepEqual(events, [
    { event: 'fired', atMs: 60_000 },
    { event: 'resolved', atMs: 100_000 },
  ]);
});

test('a flap shorter than clearMs stays the same alarm: one fired, no resolved', () => {
  const events = run(rule, [[0, true], [60, true], [10, false], [10, true], [10, true]]);
  assert.deepEqual(events, [{ event: 'fired', atMs: 60_000 }]);
});

test('for any input, fired and resolved strictly alternate, starting with fired', () => {
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: 0, max: 120 }), fc.boolean()), { maxLength: 300 }),
    (observations) => {
      const events = run(rule, observations);
      return events.every((e, i) => e.event === (i % 2 === 0 ? 'fired' : 'resolved'));
    },
  ));
});

test('replaying the same observations gives the same events', () => {
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: 0, max: 120 }), fc.boolean()), { maxLength: 300 }),
    (observations) => {
      assert.deepEqual(run(rule, observations), run(rule, observations));
      return true;
    },
  ));
});
