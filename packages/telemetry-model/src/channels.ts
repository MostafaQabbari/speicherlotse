export type Unit = 'W' | '%' | '°C' | 'V' | 'mV' | 'Hz' | 'code';

export interface ChannelDef {
  id: number;    // stable forever, used on the wire and in stored data
  unit: Unit;
  min: number;   // lowest physically plausible value
  max: number;   // highest physically plausible value
  doc: string;   // meaning and sign convention
}

export const CHANNELS = {
  pvW:          { id: 1,  unit: 'W',    min: 0,       max: 30_000, doc: 'Solar generation, never negative' },
  loadW:        { id: 2,  unit: 'W',    min: 0,       max: 30_000, doc: 'House consumption, without the wallbox' },
  evW:          { id: 3,  unit: 'W',    min: 0,       max: 22_000, doc: 'Wallbox power into the car' },
  battW:        { id: 4,  unit: 'W',    min: -10_000, max: 10_000, doc: 'Battery power at the terminals: + charging, - discharging' },
  gridW:        { id: 5,  unit: 'W',    min: -30_000, max: 30_000, doc: 'Grid power: + import, - export' },
  battSoc:      { id: 6,  unit: '%',    min: 0,       max: 100,    doc: 'Battery state of charge' },
  battSoh:      { id: 7,  unit: '%',    min: 0,       max: 100,    doc: 'Battery state of health, 100 = like new' },
  battTempC:    { id: 8,  unit: '°C',   min: -20,     max: 80,     doc: 'Battery temperature' },
  battVoltageV: { id: 9,  unit: 'V',    min: 0,       max: 1_000,  doc: 'Battery pack voltage' },
  cellMvMin:    { id: 10, unit: 'mV',   min: 2_000,   max: 4_500,  doc: 'Lowest cell voltage in the pack' },
  cellMvMax:    { id: 11, unit: 'mV',   min: 2_000,   max: 4_500,  doc: 'Highest cell voltage in the pack' },
  gridHz:       { id: 12, unit: 'Hz',   min: 45,      max: 55,     doc: 'Grid frequency' },
  gridVoltageV: { id: 13, unit: 'V',    min: 0,       max: 300,    doc: 'Grid voltage, one phase' },
  invTempC:     { id: 14, unit: '°C',   min: -20,     max: 100,    doc: 'Inverter temperature' },
  battStatus:   { id: 15, unit: 'code', min: 0,       max: 15,     doc: '0 off, 1 standby, 2 charging, 3 discharging, 4 fault' },
  evStatus:     { id: 16, unit: 'code', min: 0,       max: 15,     doc: '0 no car, 1 connected, 2 charging, 3 fault' },
} as const satisfies Record<string, ChannelDef>;

export type ChannelName = keyof typeof CHANNELS;

export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];

export function isPlausible(name: ChannelName, value: number): boolean {
  const c = CHANNELS[name];
  return value >= c.min && value <= c.max;   // NaN fails both comparisons, so it is rejected
}
