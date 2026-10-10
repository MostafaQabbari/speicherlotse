import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { retryDelayMs } from '../src/backoff.ts';

test('the wait doubles with every failure and is capped', () => {
  const full = () => 1;   // no reduction: the exact value
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(n, 1_000, 10_000, full)), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
});

test('jitter stays between half and all of the exact wait', () => {
  assert.equal(retryDelayMs(3, 1_000, 60_000, () => 0), 2_000);
  assert.equal(retryDelayMs(3, 1_000, 60_000, () => 1), 4_000);
});

test('for any number of failures the wait is positive and never above the cap', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 1, max: 600_000 }), (failures, base, max) => {
    const d = retryDelayMs(failures, base, max);
    return Number.isFinite(d) && d >= 1 && d <= max;
  }));
});