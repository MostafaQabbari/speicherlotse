import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { createHome, stepHome, DEFAULT_HOME, type HomeConfig } from '../src/home.ts';
import { checkBalance } from '../src/balance.ts';
import { CHANNEL_NAMES, isPlausible } from '../src/channels.ts';
import type { Sample } from '../src/sample.ts';

// Local midnight of 2026-10-07 in UTC+2 is 22:00 UTC the evening before.
const DAY_START_MS = Date.UTC(2026, 9, 6, 22, 0, 0);

function simulate(cfg: HomeConfig, seed: number, startMs: number, steps: number, dtS: number): Sample[] {
  let state = createHome(cfg, seed);
  const samples: Sample[] = [];
  for (let i = 0; i < steps; i++) {
    const r = stepHome(cfg, state, startMs + i * dtS * 1000, dtS);
    state = r.state;
    samples.push(r.sample);
  }
  return samples;
}

const hourOf = (s: Sample): number => ((((s.wallMs / 1000 + DEFAULT_HOME.tzOffsetS) % 86_400) + 86_400) % 86_400) / 3_600;

test('the same seed gives exactly the same day', () => {
  const a = simulate(DEFAULT_HOME, 7, DAY_START_MS, 8_640, 10);
  const b = simulate(DEFAULT_HOME, 7, DAY_START_MS, 8_640, 10);
  assert.deepEqual(a, b);
});

test('different seeds give different days', () => {
  const a = simulate(DEFAULT_HOME, 1, DAY_START_MS, 8_640, 10);
  const b = simulate(DEFAULT_HOME, 2, DAY_START_MS, 8_640, 10);
  assert.notDeepEqual(a, b);
});

test('every sample of a day has all channels, plausible values and a balanced power flow', () => {
  for (const s of simulate(DEFAULT_HOME, 3, DAY_START_MS, 8_640, 10)) {
    for (const name of CHANNEL_NAMES) {
      const v = s.values[name];
      assert.ok(v !== undefined, `${name} missing at seq ${s.seq}`);
      assert.ok(isPlausible(name, v), `${name}=${v} implausible at seq ${s.seq}`);
    }
    assert.equal(checkBalance(s.values).status, 'ok', `unbalanced at seq ${s.seq}`);
  }
});

test('seq counts up by one and the monotonic clock follows the step length', () => {
  const samples = simulate(DEFAULT_HOME, 3, DAY_START_MS, 100, 10);
  samples.forEach((s, i) => {
    assert.equal(s.seq, i + 1);
    assert.equal(s.monoMs, (i + 1) * 10_000);
  });
});

test('there is no solar at night and plenty at noon', () => {
  const samples = simulate(DEFAULT_HOME, 3, DAY_START_MS, 8_640, 10);
  for (const s of samples) {
    const h = hourOf(s);
    if (h < 6.9 || h > 18.1) assert.equal(s.values.pvW, 0);
    if (h > 11.5 && h < 12.5) assert.ok((s.values.pvW ?? 0) > 1_000, `pv at ${h.toFixed(2)}h too low`);
  }
});

test('over a day the battery both charges and discharges, and surplus is exported', () => {
  const samples = simulate(DEFAULT_HOME, 3, DAY_START_MS, 8_640, 10);
  const batt = samples.map((s) => s.values.battW ?? 0);
  const grid = samples.map((s) => s.values.gridW ?? 0);
  assert.ok(Math.max(...batt) > 1_000, 'battery never charged');
  assert.ok(Math.min(...batt) < -1_000, 'battery never discharged');
  assert.ok(Math.min(...grid) < -500, 'nothing was exported');
  assert.ok(Math.max(...grid) > 500, 'nothing was imported');
});

test('the battery stays between the backup reserve and full for three days', () => {
  const reservePct = DEFAULT_HOME.reserveFrac * 100;
  for (const s of simulate(DEFAULT_HOME, 11, DAY_START_MS, 3 * 8_640, 10)) {
    const soc = s.values.battSoc ?? -1;
    assert.ok(soc >= reservePct - 0.1 && soc <= 100, `soc ${soc} out of range at seq ${s.seq}`);
  }
});

test('any seed, start time and step length gives valid, balanced samples', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2 ** 31 }),                                  // seed
      fc.integer({ min: 0, max: 86_400_000 * 365 }),                         // start time within a year after 1970
      fc.integer({ min: 1, max: 60 }),                                       // step length in seconds
      (seed, offsetMs, dtS) => {
        for (const s of simulate(DEFAULT_HOME, seed, DAY_START_MS + offsetMs, 600, dtS)) {
          if (checkBalance(s.values).status !== 'ok') return false;
          for (const name of CHANNEL_NAMES) {
            const v = s.values[name];
            if (v === undefined || !isPlausible(name, v)) return false;
          }
        }
        return true;
      },
    ),
    { numRuns: 50 },
  );
});
