import { Component, inject } from '@angular/core';
import { ALARM_LIMIT, DashboardStore } from './dashboard-store';
import { RangeFilter } from './range-filter';
import { formatMoment } from './time';

@Component({
  selector: 'app-alarm-panel',
  imports: [RangeFilter],
  template: `
    <section aria-labelledby="alarm-heading" class="card">
      <h2 id="alarm-heading">Alarm events</h2>
      <app-range-filter [maxLimit]="limits.max" [defaultLimit]="limits.default" (applied)="store.loadAlarms($event)" />

      @if (store.alarmError(); as problem) {
        <p class="error" role="alert">{{ problem }}</p>
      }
      <p class="note" role="status">
        @if (store.alarmsBusy()) {
          Loading alarm events…
        } @else if (store.events().length === 0 && !store.alarmError()) {
          No alarm events in this range.
        } @else if (store.events().length > 0) {
          {{ store.events().length }} events, newest first.
        }
      </p>

      @if (store.events().length > 0) {
        <div class="scroll" tabindex="0" role="region" aria-label="Alarm events table, scrollable">
          <table>
            <caption>
              Alarm events of {{ store.selected()?.name }}, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Rule</th>
                <th scope="col">Severity</th>
                <th scope="col">Event</th>
              </tr>
            </thead>
            <tbody>
              @for (e of store.events(); track e.atMs + ':' + e.ruleId + ':' + e.event) {
                <tr>
                  <td>
                    <time [attr.datetime]="e.at">{{ moment(e.at) }}</time>
                  </td>
                  <td>
                    <code>{{ e.ruleId }}</code>
                  </td>
                  <td>
                    <span class="badge" [class.critical]="e.severity === 'critical'">{{ e.severity }}</span>
                  </td>
                  <td>
                    <span class="badge" [class.fired]="e.event === 'fired'" [class.resolved]="e.event === 'resolved'">{{ e.event }}</span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class AlarmPanel {
  protected readonly store = inject(DashboardStore);
  protected readonly limits = ALARM_LIMIT;
  protected moment = formatMoment;
}
