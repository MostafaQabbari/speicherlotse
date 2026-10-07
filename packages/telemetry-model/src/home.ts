import { stepBattery, type BatteryConfig } from './battery.ts';
import { nextRandom } from './rng.ts';
import type { Sample } from './sample.ts';

export interface HomeConfig {
  deviceId: number;
  bootId: number;
  battery: BatteryConfig;
  pvPeakW: number;       // solar output on a perfectly clear noon
  baseLoadW: number;     // what the house draws when nobody is doing anything
  evChargeW: number;     // wallbox power while charging, 0 = no wallbox
  reserveFrac: number;   // the battery is never discharged below this share (backup reserve)
  ambientC: number;
  sunriseH: number;      // local hour, e.g. 7
  sunsetH: number;
  tzOffsetS: number;     // local time minus UTC, in seconds (CEST = 7200)
}

export interface HomeState {
  socWh: number;
  battTempC: number;
  cloud: number;         // 0.2 (overcast) .. 1 (clear), drifts slowly
  loadNoiseW: number;    // slowly drifting part of the house load
  rng: number;           // random generator state
  seq: number;
  monoMs: number;
}

export const DEFAULT_HOME: HomeConfig = {
  deviceId: 1,
  bootId: 1,
  battery: { capacityWh: 10_000, maxPowerW: 5_000, efficiency: 0.96 },
  pvPeakW: 6_000,
  baseLoadW: 300,
  evChargeW: 3_700,
  reserveFrac: 0.1,
  ambientC: 12,
  sunriseH: 7,
  sunsetH: 18,
  tzOffsetS: 7_200,
};

export function createHome(cfg: HomeConfig, seed: number, startSocFrac = 0.5): HomeState {
  return {
    socWh: cfg.battery.capacityWh * startSocFrac,
    battTempC: cfg.ambientC,
    cloud: 0.7,
    loadNoiseW: 0,
    rng: seed >>> 0,
    seq: 0,
    monoMs: 0,
  };
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** A smooth hill around centerH that is about 1 at the centre and fades out over widthH hours. */
const bump = (h: number, centerH: number, widthH: number): number =>
  Math.exp(-(((h - centerH) / widthH) ** 2));

/** Round like a sensor with limited resolution. Also turns -0 into 0. */
const round = (x: number, digits = 0): number => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

/**
 * One simulation step of one home. Pure: the same config, state, time and step length
 * always give the same sample. Time and randomness come in as arguments.
 */
export function stepHome(
  cfg: HomeConfig,
  state: HomeState,
  wallMs: number,
  dtS: number,
): { state: HomeState; sample: Sample } {
  // Random numbers: a small local helper that threads the generator state.
  let rng = state.rng;
  const draw = (): number => {
    const [value, next] = nextRandom(rng);
    rng = next;
    return value;
  };

  const localS = (((wallMs / 1000 + cfg.tzOffsetS) % 86_400) + 86_400) % 86_400;
  const hour = localS / 3_600;

  // Solar: a half-sine between sunrise and sunset, dimmed by slowly drifting cloud cover.
  const cloud = clamp(state.cloud + 0.001 * (0.7 - state.cloud) + (draw() - 0.5) * 0.04, 0.2, 1);
  const daylight = hour > cfg.sunriseH && hour < cfg.sunsetH
    ? Math.sin((Math.PI * (hour - cfg.sunriseH)) / (cfg.sunsetH - cfg.sunriseH))
    : 0;
  const pvW = cfg.pvPeakW * daylight * cloud;

  // House load: base + morning bump + evening bump + slow noise.
  const loadNoiseW = clamp(state.loadNoiseW * 0.98 + (draw() - 0.5) * 40, -150, 150);
  const loadW = Math.max(
    100,
    cfg.baseLoadW + 600 * bump(hour, 7.5, 1) + 1100 * bump(hour, 19, 1.8) + loadNoiseW,
  );

  // Wallbox: car plugged in from 18:00 to 07:00, charging on a fixed schedule from 19:00 to 22:00.
  const hasWallbox = cfg.evChargeW > 0;
  const plugged = hasWallbox && (hour >= 18 || hour < 7);
  const charging = hasWallbox && hour >= 19 && hour < 22;
  const evW = charging ? cfg.evChargeW : 0;

  // Controller "self-consumption": surplus solar charges the battery, a deficit discharges it,
  // but never below the backup reserve.
  const { capacityWh, maxPowerW, efficiency } = cfg.battery;
  const reserveWh = cfg.reserveFrac * capacityWh;
  const maxDischargeW = (Math.max(0, state.socWh - reserveWh) * efficiency) / (dtS / 3_600);
  const requestedW = Math.max(pvW - loadW - evW, -maxDischargeW);
  const { socWh, actualW: battW } = stepBattery(cfg.battery, state.socWh, requestedW, dtS);

  // Whatever the house, car and battery do not get from the sun comes from the grid.
  const gridW = loadW + evW + battW - pvW;

  // Temperatures drift toward a target that depends on how hard the battery and inverter work.
  const battTargetC = cfg.ambientC + (12 * Math.abs(battW)) / maxPowerW;
  const battTempC = state.battTempC + (battTargetC - state.battTempC) * Math.min(1, dtS / 600);
  const invTempC = cfg.ambientC + (25 * (Math.abs(battW) + pvW)) / 15_000;

  // Pack and cell voltages follow the state of charge (a 16-cell, 51.2 V style pack).
  const socPct = (100 * socWh) / capacityWh;
  const packV = 48 + (6 * socPct) / 100;
  const cellMidMv = (packV / 16) * 1000;
  const cellSpreadMv = 3 + (12 * Math.abs(battW)) / maxPowerW;

  const sample: Sample = {
    deviceId: cfg.deviceId,
    bootId: cfg.bootId,
    seq: state.seq + 1,
    wallMs,
    monoMs: state.monoMs + dtS * 1000,
    values: {
      pvW: round(pvW),
      loadW: round(loadW),
      evW: round(evW),
      battW: round(battW),
      gridW: round(gridW),
      battSoc: round(socPct, 1),
      battSoh: 100,
      battTempC: round(battTempC, 1),
      battVoltageV: round(packV, 1),
      cellMvMin: round(cellMidMv - cellSpreadMv / 2),
      cellMvMax: round(cellMidMv + cellSpreadMv / 2),
      gridHz: round(50 + (draw() - 0.5) * 0.04, 3),
      gridVoltageV: round(230 + (draw() - 0.5) * 4, 1),
      invTempC: round(invTempC, 1),
      battStatus: battW > 20 ? 2 : battW < -20 ? 3 : 1,
      evStatus: charging ? 2 : plugged ? 1 : 0,
    },
  };

  return {
    state: { socWh, battTempC, cloud, loadNoiseW, rng, seq: sample.seq, monoMs: sample.monoMs },
    sample,
  };
}
