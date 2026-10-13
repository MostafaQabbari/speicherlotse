import { inject, Injectable, signal } from '@angular/core';
import { Api } from './api/api';
import type { AlarmEvent, Device, TelemetrySample } from './api/models';
import { getDeviceTelemetry } from './api/fn/devices/get-device-telemetry';
import { listAlarmEvents } from './api/fn/alarms/list-alarm-events';
import { listDevices } from './api/fn/devices/list-devices';
import { describeError } from './errors';
import { Session } from './session';

/** The page sizes the API enforces (also written in openapi.json). */
export const TELEMETRY_LIMIT = { default: 100, max: 1_000 } as const;
export const ALARM_LIMIT = { default: 50, max: 500 } as const;

export interface Range {
  from?: string;
  to?: string;
  limit?: number;
}

/** Everything the screen shows, and the calls that fill it. Plain signals: no framework beyond Angular itself. */
@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private readonly api = inject(Api);
  private readonly session = inject(Session);

  readonly devices = signal<Device[]>([]);
  readonly selected = signal<Device | undefined>(undefined);
  readonly samples = signal<TelemetrySample[]>([]);
  readonly events = signal<AlarmEvent[]>([]);

  readonly connecting = signal(false);
  readonly telemetryBusy = signal(false);
  readonly alarmsBusy = signal(false);

  readonly connectionMessage = signal('');
  readonly connectionFailed = signal(false);
  readonly telemetryError = signal('');
  readonly alarmError = signal('');

  // Answers that arrive after the person already asked for something else are dropped.
  private telemetryCall = 0;
  private alarmCall = 0;

  private explain(error: unknown): string {
    return describeError(error, this.session.apiUrl(), globalThis.location?.origin ?? 'this page');
  }

  async connect(apiUrl: string, token: string): Promise<void> {
    this.reset();
    this.session.signIn(apiUrl, token);
    this.connecting.set(true);
    try {
      const { devices } = await this.api.invoke(listDevices);
      this.devices.set(devices);
      this.connectionMessage.set(devices.length === 0 ? 'Connected. This tenant has no devices yet.' : `Connected. ${devices.length} device${devices.length === 1 ? '' : 's'}.`);
      if (devices[0]) await this.select(devices[0]);
    } catch (error) {
      this.session.signOut();
      this.connectionMessage.set(this.explain(error));
      this.connectionFailed.set(true);
    } finally {
      this.connecting.set(false);
    }
  }

  disconnect(): void {
    this.session.signOut();
    this.reset();
    this.connectionMessage.set('Disconnected. The token was forgotten.');
  }

  private reset(): void {
    this.telemetryCall++;
    this.alarmCall++;
    this.devices.set([]);
    this.selected.set(undefined);
    this.samples.set([]);
    this.events.set([]);
    this.telemetryError.set('');
    this.alarmError.set('');
    this.connectionMessage.set('');
    this.connectionFailed.set(false);
  }

  async select(device: Device): Promise<void> {
    this.selected.set(device);
    await Promise.all([this.loadTelemetry({}), this.loadAlarms({})]);
  }

  async loadTelemetry(range: Range): Promise<void> {
    const device = this.selected();
    if (!device) return;
    const call = ++this.telemetryCall;
    this.telemetryBusy.set(true);
    this.telemetryError.set('');
    try {
      const answer = await this.api.invoke(getDeviceTelemetry, { id: device.deviceId, ...range });
      if (call === this.telemetryCall) this.samples.set(answer.samples);
    } catch (error) {
      if (call === this.telemetryCall) {
        this.samples.set([]);
        this.telemetryError.set(this.explain(error));
      }
    } finally {
      if (call === this.telemetryCall) this.telemetryBusy.set(false);
    }
  }

  async loadAlarms(range: Range): Promise<void> {
    const device = this.selected();
    if (!device) return;
    const call = ++this.alarmCall;
    this.alarmsBusy.set(true);
    this.alarmError.set('');
    try {
      const answer = await this.api.invoke(listAlarmEvents, { deviceId: device.deviceId, ...range });
      if (call === this.alarmCall) this.events.set(answer.events);
    } catch (error) {
      if (call === this.alarmCall) {
        this.events.set([]);
        this.alarmError.set(this.explain(error));
      }
    } finally {
      if (call === this.alarmCall) this.alarmsBusy.set(false);
    }
  }
}
