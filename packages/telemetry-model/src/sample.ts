import type { ChannelName } from './channels.ts';

export type ChannelValues = { [K in ChannelName]?: number };

export interface Sample {
  deviceId: number;
  bootId: number;    // changes at every restart of the device
  seq: number;       // +1 per sample within one boot
  wallMs: number;    // device wall clock, ms since 1970 (can jump)
  monoMs: number;    // ms since boot (never jumps, restarts at 0 on boot)
  values: ChannelValues;
}
