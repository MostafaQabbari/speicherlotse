export interface BatteryConfig {
  capacityWh: number;
  maxPowerW: number;
  efficiency: number;      // one-way, e.g. 0.96
}

/** requestedW > 0 charges, < 0 discharges. Returns the new state and the power actually used at the terminals. */
export function stepBattery(cfg: BatteryConfig, socWh: number, requestedW: number, dtS: number) {
  const p = Math.max(-cfg.maxPowerW, Math.min(cfg.maxPowerW, requestedW));
  const dtH = dtS / 3600;
  const wanted = p >= 0 ? p * dtH * cfg.efficiency : (p * dtH) / cfg.efficiency;   // change in stored energy
  const next = Math.max(0, Math.min(cfg.capacityWh, socWh + wanted));              // cannot over- or under-fill
  const stored = next - socWh;
  const actualW = stored >= 0 ? stored / cfg.efficiency / dtH : (stored * cfg.efficiency) / dtH;
  return { socWh: next, actualW };
}
