import { Component, inject } from '@angular/core';
import { AlarmPanel } from './alarm-panel';
import { ConnectPanel } from './connect-panel';
import { DashboardStore } from './dashboard-store';
import { TelemetryPanel } from './telemetry-panel';

@Component({
  selector: 'app-root',
  imports: [ConnectPanel, TelemetryPanel, AlarmPanel],
  template: `
    <a class="skip" href="#main">Skip to the content</a>
    <header class="top">
      <h1>Speicherlotse</h1>
      <p>Home batteries: devices, telemetry and alarms of one tenant.</p>
    </header>
    <div class="layout">
      <aside aria-label="Connection and devices">
        <app-connect-panel />
        @if (store.devices().length > 0) {
          <nav aria-labelledby="devices-heading" class="card">
            <h2 id="devices-heading">Devices</h2>
            <ul class="devices">
              @for (device of store.devices(); track device.deviceId) {
                <li>
                  <button type="button" class="device" [attr.aria-pressed]="store.selected()?.deviceId === device.deviceId" (click)="store.select(device)">
                    <span>{{ device.name }}</span>
                    <small>id {{ device.deviceId }}</small>
                  </button>
                </li>
              }
            </ul>
          </nav>
        }
      </aside>
      <main id="main" tabindex="-1">
        @if (store.selected(); as device) {
          <h2 class="device-title">{{ device.name }}</h2>
          <!-- Keyed by device: switching device builds the panels (and their filter forms) anew. -->
          @for (d of [device]; track d.deviceId) {
            <app-telemetry-panel />
            <app-alarm-panel />
          }
        } @else {
          <section class="card empty">
            <h2>No device selected</h2>
            <p>Connect to the API with a token. The devices of that token's tenant appear on the left.</p>
          </section>
        }
      </main>
    </div>
  `,
})
export class App {
  protected readonly store = inject(DashboardStore);
}
