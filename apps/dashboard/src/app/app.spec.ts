import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { App } from './app';
import { authInterceptor } from './auth.interceptor';

const API = 'http://127.0.0.1:3000';
const sample = (seq: number) => ({
  ts: new Date(Date.UTC(2026, 9, 10, 12, seq)).toISOString(),
  bootId: '1',
  seq,
  monoMs: seq * 1000,
  values: { pvW: 1000 + seq * 10, battSoc: 50 + seq, battTempC: 25 },
});

async function render() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, http: TestBed.inject(HttpTestingController) };
}

async function connect(fixture: Awaited<ReturnType<typeof render>>['fixture'], http: HttpTestingController) {
  const root = fixture.nativeElement as HTMLElement;
  const token = root.querySelector<HTMLInputElement>('#token')!;
  token.value = 'aaa.bbb.ccc';
  token.dispatchEvent(new Event('input'));
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await new Promise((r) => setTimeout(r));
  http.expectOne(`${API}/v1/devices`).flush({ devices: [{ deviceId: 1, name: 'Home 1' }, { deviceId: 2, name: 'Home 2' }] });
  await new Promise((r) => setTimeout(r));
  http.expectOne(`${API}/v1/devices/1/telemetry`).flush({ device: { deviceId: 1, name: 'Home 1' }, samples: [sample(3), sample(2), sample(1)] });
  http.expectOne(`${API}/v1/alarms/events?deviceId=1`).flush({
    events: [{ deviceId: 1, ruleId: 'battery_overtemp', severity: 'critical', event: 'fired', at: '2026-10-10T12:00:00.000Z', atMs: 1 }],
  });
  await new Promise((r) => setTimeout(r));
  fixture.detectChanges();
}

/** jsdom cannot compute colours or layout, so those rules are left out here (the browser run checked the page by eye). */
const AXE = { rules: { 'color-contrast': { enabled: false } } };
const violations = async (root: HTMLElement) => (await axe.run(root, AXE)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

describe('App', () => {
  it('starts with a connection form and a hint, and no data', async () => {
    const { root } = await render();
    expect(root.querySelector('h1')!.textContent).toBe('Speicherlotse');
    expect(root.querySelector('#api-url')).toBeTruthy();
    expect(root.textContent).toContain('No device selected');
    expect(root.querySelector('app-telemetry-panel')).toBeNull();
  });

  it('does not send anything until the form is valid, and says what is wrong', async () => {
    const { fixture, root, http } = await render();
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    http.expectNone(`${API}/v1/devices`);
    expect(root.querySelector('#token-problem')!.textContent).toContain('Paste a token');
  });

  it('shows the devices, the latest values, a chart with a text description, and the alarm table after connecting', async () => {
    const { fixture, root, http } = await render();
    await connect(fixture, http);

    expect(Array.from(root.querySelectorAll('button.device')).map((b) => b.querySelector('span')!.textContent)).toEqual(['Home 1', 'Home 2']);
    expect(root.querySelector('.device-title')!.textContent).toBe('Home 1');
    expect(root.textContent).toContain('3 samples');
    expect(root.querySelector('.values')!.textContent).toContain('Solar generation');
    const chart = root.querySelector('svg[role=img]')!;
    expect(chart.getAttribute('aria-label')).toContain('Solar generation: 3 values');
    expect(root.querySelector('app-alarm-panel table')!.textContent).toContain('battery_overtemp');
    http.verify();
  });

  it('has no accessibility violations that can be checked without a real browser, before and after connecting', async () => {
    const { fixture, root, http } = await render();
    expect(await violations(root)).toEqual([]);
    await connect(fixture, http);
    expect(await violations(root)).toEqual([]);
  });
});
