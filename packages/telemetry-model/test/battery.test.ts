import test from 'node:test';
import fc from 'fast-check';
import { stepBattery } from '../src/battery.ts';

const cfg = { capacityWh: 10_000, maxPowerW: 5_000, efficiency: 0.96 };

test('a battery never creates energy and never leaves its limits', () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 10_000, noNaN: true }),        // starting stored energy
    fc.double({ min: -20_000, max: 20_000, noNaN: true }),  // requested power
    fc.integer({ min: 1, max: 60 }),                        // step length in seconds
    (soc, req, dt) => {
      const { socWh, actualW } = stepBattery(cfg, soc, req, dt);
      const lossWh = (actualW * dt) / 3600 - (socWh - soc);  // terminal energy minus stored energy
      return socWh >= 0 && socWh <= cfg.capacityWh
          && Math.abs(actualW) <= cfg.maxPowerW + 1e-6
          && lossWh >= -1e-9;                                // losses are never negative
    },
  ));
});
