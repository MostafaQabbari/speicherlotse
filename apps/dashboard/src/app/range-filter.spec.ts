import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Range } from './dashboard-store';
import { RangeFilter } from './range-filter';

@Component({ imports: [RangeFilter], template: `<app-range-filter [maxLimit]="1000" [defaultLimit]="100" (applied)="seen.push($event)" />` })
class Host {
  seen: Range[] = [];
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const type = (label: RegExp, value: string) => {
    const input = Array.from(root.querySelectorAll('label')).find((l) => label.test(l.textContent ?? ''))!.control as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const apply = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, root, host: fixture.componentInstance, type, apply };
}

describe('RangeFilter', () => {
  it('applies with nothing filled in as "no filter" (the API then uses its default page)', async () => {
    const { host, apply } = setup();
    await apply();
    expect(host.seen).toEqual([{}]);
  });

  it('sends the times as UTC instants and the rows as a number', async () => {
    const { host, type, apply } = setup();
    type(/From/, '2026-10-10T12:00');
    type(/To/, '2026-10-10T15:30');
    type(/Rows/, '25');
    await apply();
    expect(host.seen).toEqual([{ from: new Date('2026-10-10T12:00').toISOString(), to: new Date('2026-10-10T15:30').toISOString(), limit: 25 }]);
  });

  it.each(['0', '1001', '2.5', '-3'])('refuses %s rows, says so, and sends nothing', async (rows) => {
    const { host, root, type, apply } = setup();
    type(/Rows/, rows);
    await apply();
    expect(host.seen).toEqual([]);
    expect(root.querySelector('.problems')!.textContent).toContain('whole number from 1 to 1000');
    expect(root.querySelector('input[type=number]')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a range that ends before it starts', async () => {
    const { host, root, type, apply } = setup();
    type(/From/, '2026-10-10T15:00');
    type(/To/, '2026-10-10T12:00');
    await apply();
    expect(host.seen).toEqual([]);
    expect(root.querySelector('.problems')!.textContent).toContain('earlier than');
  });
});
