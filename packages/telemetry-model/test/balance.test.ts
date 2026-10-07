import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { checkBalance } from '../src/balance.ts';

test('the worked example balances', () => {
  const r = checkBalance({ pvW: 3200, loadW: 850, evW: 0, battW: 1500, gridW: -850 });
  assert.equal(r.status, 'ok');
});

test('a missing channel gives unknown, not a false alarm', () => {
  assert.equal(checkBalance({ pvW: 3200, loadW: 850 }).status, 'unknown');
});

test('a flipped grid sign is detected', () => {
  const r = checkBalance({ pvW: 3200, loadW: 850, evW: 0, battW: 1500, gridW: 850 });
  assert.equal(r.status, 'violated');
});

test('a physically consistent sample always balances', () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 30_000, noNaN: true }),        // solar
    fc.double({ min: 0, max: 30_000, noNaN: true }),        // house load
    fc.double({ min: 0, max: 22_000, noNaN: true }),        // car
    fc.double({ min: -10_000, max: 10_000, noNaN: true }),  // battery
    (pvW, loadW, evW, battW) => {
      const gridW = loadW + evW + battW - pvW;
      return checkBalance({ pvW, loadW, evW, battW, gridW }).status === 'ok';
    },
  ));
});

test('measurement noise below 40 W never causes a violation', () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 30_000, noNaN: true }),
    fc.double({ min: 0, max: 30_000, noNaN: true }),
    fc.double({ min: 0, max: 22_000, noNaN: true }),
    fc.double({ min: -10_000, max: 10_000, noNaN: true }),
    fc.double({ min: -40, max: 40, noNaN: true }),          // sensor noise
    (pvW, loadW, evW, battW, noiseW) => {
      const gridW = loadW + evW + battW - pvW + noiseW;
      return checkBalance({ pvW, loadW, evW, battW, gridW }).status === 'ok';
    },
  ));
});
