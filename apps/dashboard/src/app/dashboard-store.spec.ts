import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { authInterceptor } from './auth.interceptor';
import { DashboardStore } from './dashboard-store';
import { Session } from './session';

const API = 'http://127.0.0.1:3000';
const TOKEN = 'aaa.bbb.ccc';

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()] });
  return { store: TestBed.inject(DashboardStore), session: TestBed.inject(Session), http: TestBed.inject(HttpTestingController) };
}
/** Finds the request for this address; the query string is compared as people write it (':' not '%3A'). */
const only = (http: HttpTestingController, url: string) => http.expectOne((r) => decodeURIComponent(r.urlWithParams) === url);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sample = (seq: number) => ({ ts: '2026-10-10T12:00:00.000Z', bootId: '1', seq, monoMs: seq, values: { pvW: 100 + seq } });

describe('DashboardStore', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sends the token to the API, loads the devices, then the first device’s telemetry and alarms', async () => {
    const { store, http } = setup();
    const done = store.connect(API, TOKEN);

    const devices = http.expectOne(`${API}/v1/devices`);
    expect(devices.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    devices.flush({ devices: [{ deviceId: 1, name: 'Home 1' }, { deviceId: 2, name: 'Home 2' }] });
    await tick();

    http.expectOne(`${API}/v1/devices/1/telemetry`).flush({ device: { deviceId: 1, name: 'Home 1' }, samples: [sample(2), sample(1)] });
    http.expectOne(`${API}/v1/alarms/events?deviceId=1`).flush({ events: [] });
    await done;

    expect(store.devices().map((d) => d.name)).toEqual(['Home 1', 'Home 2']);
    expect(store.selected()?.deviceId).toBe(1);
    expect(store.samples()).toHaveLength(2);
    expect(store.connectionMessage()).toBe('Connected. 2 devices.');
    expect(store.connectionFailed()).toBe(false);
  });

  it('forgets the token and says why when the API refuses it', async () => {
    const { store, session, http } = setup();
    const done = store.connect(API, TOKEN);
    http.expectOne(`${API}/v1/devices`).flush({ statusCode: 401, error: 'Unauthorized', message: 'invalid token' }, { status: 401, statusText: 'Unauthorized' });
    await done;

    expect(session.signedIn()).toBe(false);
    expect(store.devices()).toEqual([]);
    expect(store.connectionFailed()).toBe(true);
    expect(store.connectionMessage()).toContain('did not accept the token');
  });

  it('never sends the token anywhere but to the API', async () => {
    const { session, http } = setup();
    session.signIn(API, TOKEN);
    const client = TestBed.inject((await import('@angular/common/http')).HttpClient);
    client.get('https://example.org/x').subscribe();
    client.get(`${API}.evil.example/x`).subscribe();
    expect(http.expectOne('https://example.org/x').request.headers.has('Authorization')).toBe(false);
    expect(http.expectOne(`${API}.evil.example/x`).request.headers.has('Authorization')).toBe(false);
  });

  it('passes the chosen range on to the API, and ignores an answer that arrives after a newer request', async () => {
    const { store, session, http } = setup();
    session.signIn(API, TOKEN);
    store.selected.set({ deviceId: 1, name: 'Home 1' });

    const slow = store.loadTelemetry({ limit: 10 });
    const fast = store.loadTelemetry({ from: '2026-10-10T00:00:00.000Z', limit: 3 });
    const first = only(http, `${API}/v1/devices/1/telemetry?limit=10`);
    const second = only(http, `${API}/v1/devices/1/telemetry?from=2026-10-10T00:00:00.000Z&limit=3`);
    second.flush({ device: { deviceId: 1, name: 'Home 1' }, samples: [sample(9)] });
    await fast;
    first.flush({ device: { deviceId: 1, name: 'Home 1' }, samples: [sample(1), sample(2)] });
    await slow;

    expect(store.samples().map((s) => s.seq)).toEqual([9]);
    expect(store.telemetryBusy()).toBe(false);
  });

  it('shows the problem next to the panel and keeps the rest working when a request fails', async () => {
    const { store, session, http } = setup();
    session.signIn(API, TOKEN);
    store.selected.set({ deviceId: 1, name: 'Home 1' });
    const done = store.loadAlarms({ limit: 9999 });
    http.expectOne(`${API}/v1/alarms/events?deviceId=1&limit=9999`).flush({ statusCode: 400, error: 'Bad Request', message: 'limit must be at most 500' }, { status: 400, statusText: 'Bad Request' });
    await done;
    expect(store.alarmError()).toContain('limit must be at most 500');
    expect(store.telemetryError()).toBe('');
  });
});
