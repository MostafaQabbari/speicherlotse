import { Component, computed, input } from '@angular/core';
import { type ChartBox, type ChartPoint, layout } from './chart-geometry';
import { formatMoment } from './time';

const BOX: ChartBox = { width: 640, height: 240, left: 56, right: 16, top: 16, bottom: 36 };
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** One channel over time, drawn as an SVG. The same numbers are available as a table next to it (see TelemetryPanel). */
@Component({
  selector: 'app-line-chart',
  template: `
    @if (geometry(); as g) {
      <svg [attr.viewBox]="'0 0 ' + box.width + ' ' + box.height" role="img" [attr.aria-label]="summary()" class="chart">
        <line class="grid" [attr.x1]="box.left" [attr.x2]="box.width - box.right" [attr.y1]="box.top" [attr.y2]="box.top" />
        <line class="grid" [attr.x1]="box.left" [attr.x2]="box.width - box.right" [attr.y1]="box.height - box.bottom" [attr.y2]="box.height - box.bottom" />
        <text class="tick" [attr.x]="box.left - 6" [attr.y]="box.top + 4" text-anchor="end">{{ format(g.max) }}</text>
        <text class="tick" [attr.x]="box.left - 6" [attr.y]="box.height - box.bottom" text-anchor="end">{{ format(g.min) }}</text>
        <text class="tick" [attr.x]="box.left" [attr.y]="box.height - 12" text-anchor="start">{{ moment(g.tMin) }}</text>
        <text class="tick" [attr.x]="box.width - box.right" [attr.y]="box.height - 12" text-anchor="end">{{ moment(g.tMax) }}</text>
        <path class="line" [attr.d]="g.path" fill="none" />
        @if (g.dots.length <= 60) {
          @for (dot of g.dots; track $index) {
            <circle class="dot" [attr.cx]="dot.x" [attr.cy]="dot.y" r="2.5" />
          }
        }
      </svg>
    }
  `,
})
export class LineChart {
  /** In time order; `null` where the channel has no value. */
  readonly points = input.required<readonly (ChartPoint | null)[]>();
  readonly label = input.required<string>();
  readonly unit = input('');

  protected readonly box = BOX;
  protected readonly geometry = computed(() => layout(this.points(), BOX));

  protected format(value: number): string {
    return number.format(value);
  }

  protected moment(t: number): string {
    return formatMoment(new Date(t).toISOString());
  }

  protected readonly summary = computed(() => {
    const g = this.geometry();
    if (!g) return `${this.label()}: no values`;
    const count = this.points().filter((p) => p !== null).length;
    const unit = this.unit() ? ' ' + this.unit() : '';
    return `${this.label()}: ${count} values from ${this.moment(g.tMin)} to ${this.moment(g.tMax)}, between ${this.format(g.min)}${unit} and ${this.format(g.max)}${unit}. The same numbers are in the table below.`;
  });
}
