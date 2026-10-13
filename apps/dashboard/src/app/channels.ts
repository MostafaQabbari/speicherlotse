import type { TelemetrySample } from './api/models';

/** The name of a channel exactly as the API writes it (taken from the generated client). */
export type ChannelKey = keyof TelemetrySample['values'];

export interface ChannelInfo {
  readonly key: ChannelKey;
  readonly label: string;
  readonly unit: string;
}

// A Record over every key: if the API gains or renames a channel, the generated type changes and this file stops compiling.
const NAMES: Record<ChannelKey, { label: string; unit: string }> = {
  pvW: { label: 'Solar generation', unit: 'W' },
  loadW: { label: 'House consumption', unit: 'W' },
  evW: { label: 'Wallbox power', unit: 'W' },
  battW: { label: 'Battery power (+ charging, − discharging)', unit: 'W' },
  gridW: { label: 'Grid power (+ import, − export)', unit: 'W' },
  battSoc: { label: 'Battery state of charge', unit: '%' },
  battSoh: { label: 'Battery state of health', unit: '%' },
  battTempC: { label: 'Battery temperature', unit: '°C' },
  battVoltageV: { label: 'Battery voltage', unit: 'V' },
  cellMvMin: { label: 'Lowest cell voltage', unit: 'mV' },
  cellMvMax: { label: 'Highest cell voltage', unit: 'mV' },
  gridHz: { label: 'Grid frequency', unit: 'Hz' },
  gridVoltageV: { label: 'Grid voltage', unit: 'V' },
  invTempC: { label: 'Inverter temperature', unit: '°C' },
  battStatus: { label: 'Battery status (code)', unit: '' },
  evStatus: { label: 'Wallbox status (code)', unit: '' },
};

export const CHANNELS: readonly ChannelInfo[] = (Object.keys(NAMES) as ChannelKey[]).map((key) => ({ key, ...NAMES[key] }));

export function channelInfo(key: ChannelKey): ChannelInfo {
  return { key, ...NAMES[key] };
}
