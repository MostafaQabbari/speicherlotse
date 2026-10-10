import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import type { AlarmTransition } from '@speicherlotse/alarm-rules';
import { run, type DeviceRecord } from '../src/engine.ts';
import { at, HOT, span, T0 } from './helpers.ts';

const none = new Map<number, DeviceRecord>();

test('a sustained condition fires once, at the first sample 10 s after it began', () => {
  const r = run(none, span(1, 0, 30, 60), [HOT]);
  assert.deepEqual(r.events.map((e) => [e.event, e.atMs - T0]), [['fired', 10_000]]);
  assert.equal(r.changed.get(1)?.lastWallMs, T0 + 29_000);
  assert.equal(r.changed.get(1)?.alarms.get('hot')?.kind, 'firing');
});

test('run never modifies the map it was given', () => {
  const known = new Map<number, DeviceRecord>();
  run(known, span(1, 0, 30, 60), [HOT]);
  assert.equal(known.size, 0);
});

test('devices are independent: one fires, the other stays quiet', () => {
  const r = run(none, [...span(1, 0, 15, 60), ...span(2, 0, 15, 20)], [HOT]);
  assert.deepEqual(r.events.map((e) => e.deviceId), [1]);
  assert.equal(r.changed.get(2)?.alarms.size, 0);
});

test('the same samples delivered again change nothing: no event, no new state', () => {
  const samples = span(1, 0, 30, 60);
  const first = run(none, samples, [HOT]);
  const second = run(first.changed, samples, [HOT]);
  assert.equal(second.events.length, 0);
  assert.equal(second.skippedOld, 30);
  assert.equal(second.changed.size, 0);
});

test('an old sample cannot pull a firing alarm back: it is skipped, not evaluated', () => {
  const first = run(none, span(1, 0, 30, 60), [HOT]);          // firing since second 10
  const old = run(first.changed, [at(1, 5, 20)], [HOT]);       // a redelivered cool reading from second 5
  assert.equal(old.skippedOld, 1);
  assert.equal(old.changed.size, 0);
});

test('a missing temperature leaves the alarm exactly as it was, but moves the watermark', () => {
  const first = run(none, span(1, 0, 30, 60), [HOT]);
  const r = run(first.changed, [at(1, 30, undefined)], [HOT]);
  assert.equal(r.events.length, 0);
  assert.equal(r.changed.get(1)?.alarms.get('hot')?.kind, 'firing');
  assert.equal(r.changed.get(1)?.lastWallMs, T0 + 30_000);
});

test('a device clock outside 2000..2100 is ignored and does not move the watermark', () => {
  const unset = { ...at(1, 0, 60), wallMs: 0 };
  const farFuture = { ...at(1, 0, 60), wallMs: Date.UTC(2200, 0, 1) };
  const r = run(none, [unset, farFuture], [HOT]);
  assert.equal(r.skippedInvalid, 2);
  assert.equal(r.changed.size, 0);
});

test('a device id that does not fit the database column is ignored', () => {
  const r = run(none, [at(2_147_483_648, 0, 60), at(0, 0, 60)], [HOT]);
  assert.equal(r.skippedInvalid, 2);
  assert.equal(r.changed.size, 0);
});

test('fractional milliseconds are rounded once, so the watermark and the events use whole numbers', () => {
  const s = { ...at(1, 0, 60), wallMs: T0 + 0.6 };
  const r = run(none, [s], [HOT]);
  assert.equal(r.changed.get(1)?.lastWallMs, T0 + 1);
});

test('the alarm resolves after 5 s below the limit, and flapping shorter than that keeps one alarm', () => {
  const r = run(none, [...span(1, 0, 20, 60), ...span(1, 20, 23, 20), ...span(1, 23, 30, 60), ...span(1, 30, 40, 20)], [HOT]);
  assert.deepEqual(r.events.map((e) => [e.event, e.atMs - T0]), [['fired', 10_000], ['resolved', 35_000]]);
});

// ── the important property ──────────────────────────────────────────

/**
 * A random 1 Hz temperature series made of stretches: hot, cool or missing, each 1 to 25 s long. Stretches (not
 * independent random seconds) are needed to ever reach "firing", which takes 10 hot seconds in a row.
 */
const series = fc
  .array(fc.tuple(fc.constantFrom<number | undefined>(60, 20, undefined), fc.integer({ min: 1, max: 25 })), { minLength: 1, maxLength: 12 })
  .map((stretches) => stretches.flatMap(([temp, seconds]) => Array.from({ length: seconds }, () => temp)));

test('however a stream is cut into batches and however far Kafka rewinds, the events are the same', () => {
  fc.assert(
    fc.property(series, fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 30 }), fc.array(fc.nat(8), { minLength: 1, maxLength: 30 }), (temps, cuts, rewinds) => {
      const samples = temps.map((t, i) => at(1, i, t));
      const once = run(none, samples, [HOT]);

      const batches: (typeof samples)[] = [];
      for (let pos = 0, i = 0; pos < samples.length; i++) {
        const size = cuts[i % cuts.length] ?? 1;
        batches.push(samples.slice(pos, pos + size));
        pos += size;
      }

      // After every batch the log may "rewind": a crash before the commit means that the last r batches are
      // delivered again, in order, before anything new arrives.
      let known: ReadonlyMap<number, DeviceRecord> = none;
      const events: AlarmTransition[] = [];
      const deliver = (batch: typeof samples): void => {
        const r = run(known, batch, [HOT]);
        events.push(...r.events);
        known = new Map([...known, ...r.changed]);
      };
      batches.forEach((batch, i) => {
        deliver(batch);
        const back = Math.min(rewinds[i % rewinds.length] ?? 0, i);
        for (let j = i - back; j <= i; j++) deliver(batches[j]!);
      });

      assert.deepEqual(events, once.events);
      assert.deepEqual(known.get(1), once.changed.get(1));
    }),
    { numRuns: 500 },
  );
});