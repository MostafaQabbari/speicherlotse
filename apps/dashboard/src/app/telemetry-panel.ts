import { Component, computed, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import type { ChartPoint } from './chart-geometry';
import { type ChannelKey, CHANNELS, channelInfo } from './channels';
import { DashboardStore, TELEMETRY_LIMIT } from './dashboard-store';
import { LineChart } from './line-chart';
import { RangeFilter } from './range-filter';
import { formatMoment } from './time';

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

@Component({
  selector: 'app-telemetry-panel',
  imports: [ReactiveFormsModule, RangeFilter, LineChart],
  template: `
    <section aria-labelledby="telemetry-heading" class="card">
      <h2 id="telemetry-heading">Telemetry</h2>
      <app-range-filter [maxLimit]="limits.max" [defaultLimit]="limits.default" (applied)="store.loadTelemetry($event)" />

      @if (store.telemetryError(); as problem) {
        <p class="error" role="alert">{{ problem }}</p>
      }
      <p class="note" role="status">
        @if (store.telemetryBusy()) {
          Loading telemetry…
        } @else if (store.samples().length === 0) {
          @if (!store.telemetryError()) {
            No samples in this range.
          }
        } @else {
          {{ store.samples().length }} samples, newest {{ moment(store.samples()[0].ts) }}.
        }
      </p>

      @if (store.samples().length > 0) {
        <h3>Latest values</h3>
        <dl class="values">
          @for (item of latest(); track item.key) {
            <div>
              <dt>{{ item.label }}</dt>
              <dd>{{ item.text }}</dd>
            </div>
          }
        </dl>

        <h3 id="chart-heading">Over time</h3>
        <div class="field narrow">
          <label for="channel">Channel</label>
          <select id="channel" [formControl]="channel">
            @for (c of channels; track c.key) {
              <option [value]="c.key">{{ c.label }}{{ c.unit ? ' (' + c.unit + ')' : '' }}</option>
            }
          </select>
        </div>
        <app-line-chart [points]="points()" [label]="info().label" [unit]="info().unit" />
        <details>
          <summary>Show these numbers as a table</summary>
          <div class="scroll" tabindex="0" role="region" aria-label="Telemetry table, scrollable">
            <table>
              <caption>
                {{ info().label }}, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Device clock</th>
                  <th scope="col">{{ info().label }}{{ info().unit ? ' (' + info().unit + ')' : '' }}</th>
                </tr>
              </thead>
              <tbody>
                @for (s of store.samples(); track s.bootId + ':' + s.seq) {
                  <tr>
                    <td>
                      <time [attr.datetime]="s.ts">{{ moment(s.ts) }}</time>
                    </td>
                    <td class="num">{{ valueText(s.values[channel.value]) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </details>
      }
    </section>
  `,
})
export class TelemetryPanel {
  protected readonly store = inject(DashboardStore);
  protected readonly limits = TELEMETRY_LIMIT;
  protected readonly channels = CHANNELS;
  protected readonly channel = new FormControl<ChannelKey>('pvW', { nonNullable: true });
  private readonly channelKey = toSignal(this.channel.valueChanges, { initialValue: this.channel.value });
  protected readonly info = computed(() => channelInfo(this.channelKey()));

  /** The samples arrive newest first; a chart reads left (old) to right (new). */
  protected readonly points = computed<(ChartPoint | null)[]>(() => {
    const key = this.channelKey();
    return [...this.store.samples()].reverse().map((s) => {
      const v = s.values[key];
      return typeof v === 'number' ? { t: Date.parse(s.ts), v } : null;
    });
  });

  protected readonly latest = computed(() => {
    const values = this.store.samples()[0]?.values ?? {};
    return CHANNELS.filter((c) => typeof values[c.key] === 'number').map((c) => ({
      key: c.key,
      label: c.label,
      text: `${number.format(values[c.key] as number)}${c.unit ? ' ' + c.unit : ''}`,
    }));
  });

  protected moment = formatMoment;

  protected valueText(v: number | undefined): string {
    return typeof v === 'number' ? number.format(v) : '–';
  }
}
