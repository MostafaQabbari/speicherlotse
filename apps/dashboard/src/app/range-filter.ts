import { Component, input, output } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors } from '@angular/forms';
import type { Range } from './dashboard-store';
import { localInputToIso } from './time';

let nextId = 0;

/** From / to / number of rows. Checked before anything is sent, with the same limits the API enforces. */
@Component({
  selector: 'app-range-filter',
  imports: [ReactiveFormsModule],
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" class="filter" novalidate>
      <div class="field">
        <label [for]="id + '-from'">From</label>
        <input [id]="id + '-from'" type="datetime-local" formControlName="from" />
      </div>
      <div class="field">
        <label [for]="id + '-to'">To</label>
        <input [id]="id + '-to'" type="datetime-local" formControlName="to" />
      </div>
      <div class="field">
        <label [for]="id + '-limit'">Rows (1 to {{ maxLimit() }}, newest first)</label>
        <input
          [id]="id + '-limit'"
          type="number"
          inputmode="numeric"
          step="1"
          [placeholder]="'' + defaultLimit()"
          formControlName="limit"
          [attr.aria-invalid]="form.controls.limit.invalid && form.controls.limit.touched ? 'true' : null"
          [attr.aria-describedby]="id + '-problems'"
        />
      </div>
      <button type="submit" class="secondary">Apply</button>
      <div [id]="id + '-problems'" class="problems" aria-live="polite">
        @if (form.controls.limit.invalid && form.controls.limit.touched) {
          <p>Rows must be a whole number from 1 to {{ maxLimit() }}.</p>
        }
        @if (form.hasError('order') && form.touched) {
          <p>“From” must be earlier than “To”.</p>
        }
      </div>
    </form>
  `,
})
export class RangeFilter {
  readonly maxLimit = input.required<number>();
  readonly defaultLimit = input.required<number>();
  readonly applied = output<Range>();

  protected readonly id = `range-${nextId++}`;

  protected readonly form = new FormGroup(
    {
      from: new FormControl('', { nonNullable: true }),
      to: new FormControl('', { nonNullable: true }),
      limit: new FormControl<number | null>(null, { validators: [(c) => this.checkLimit(c)] }),
    },
    { validators: [order] },
  );

  private checkLimit(control: AbstractControl): ValidationErrors | null {
    const value = control.value as number | string | null;
    if (value === null || value === '') return null;
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= this.maxLimit() ? null : { limit: true };
  }

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { from, to, limit } = this.form.getRawValue();
    const range: Range = {};
    const fromIso = localInputToIso(from);
    const toIso = localInputToIso(to);
    if (fromIso) range.from = fromIso;
    if (toIso) range.to = toIso;
    if (limit !== null && (limit as unknown) !== '') range.limit = limit;
    this.applied.emit(range);
  }
}

function order(group: AbstractControl): ValidationErrors | null {
  const from = localInputToIso(group.get('from')?.value ?? '');
  const to = localInputToIso(group.get('to')?.value ?? '');
  return from && to && new Date(from) >= new Date(to) ? { order: true } : null;
}
