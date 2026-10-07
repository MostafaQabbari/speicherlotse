import { createHome, stepHome, DEFAULT_HOME } from '../src/home.ts';

// Simulate one local day (2026-10-07, midnight in UTC+2) with 10-second steps and print an hourly summary.
const startMs = Date.UTC(2026, 9, 6, 22, 0, 0);
const dtS = 10;
const stepsPerHour = 3_600 / dtS;

let state = createHome(DEFAULT_HOME, 42);
console.log('hour  pvW  loadW   evW  battW  gridW   soc%');
for (let hour = 0; hour < 24; hour++) {
  let pv = 0, load = 0, ev = 0, batt = 0, grid = 0, soc = 0;
  for (let i = 0; i < stepsPerHour; i++) {
    const wallMs = startMs + (hour * stepsPerHour + i) * dtS * 1000;
    const r = stepHome(DEFAULT_HOME, state, wallMs, dtS);
    state = r.state;
    const v = r.sample.values;
    pv += v.pvW ?? 0; load += v.loadW ?? 0; ev += v.evW ?? 0;
    batt += v.battW ?? 0; grid += v.gridW ?? 0; soc = v.battSoc ?? 0;
  }
  const avg = (sum: number) => String(Math.round(sum / stepsPerHour)).padStart(5);
  console.log(`${String(hour).padStart(4)} ${avg(pv)} ${avg(load)} ${avg(ev)} ${avg(batt)} ${avg(grid)} ${soc.toFixed(1).padStart(6)}`);
}
