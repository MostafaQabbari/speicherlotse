import { connectAsync } from 'mqtt';
import { createHome, stepHome, DEFAULT_HOME, type HomeConfig, type HomeState, type Sample } from '@speicherlotse/telemetry-model';
import { encodeBatch, topicFor } from '@speicherlotse/wire';

// ── settings (all optional, set as environment variables) ──────────
const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SYSTEMS = Number(process.env.SYSTEMS ?? 3);          // how many simulated homes
const TICK_MS = Number(process.env.TICK_MS ?? 1000);       // real time between samples; 1000 = real time, 100 = 10x faster
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 5);    // samples per MQTT message (ADR-001: 5)
const SECONDS = Number(process.env.SECONDS ?? 0);          // stop after this many real seconds; 0 = run until Ctrl+C

// A simple fault, to see alarms: this home's battery reads 60 °C from HOT_FROM_S for HOT_FOR_S seconds of
// simulated time (one simulated second per tick). 0 = no fault. The fleet simulator will replace this with real fault injection.
const HOT_DEVICE = Number(process.env.HOT_DEVICE ?? 0);
const HOT_FROM_S = Number(process.env.HOT_FROM_S ?? 10);
const HOT_FOR_S = Number(process.env.HOT_FOR_S ?? 90);
const HOT_TEMP_C = 60;

for (const [name, v] of Object.entries({ SYSTEMS, TICK_MS, BATCH_SIZE, SECONDS, HOT_DEVICE, HOT_FROM_S, HOT_FOR_S })) {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
}

// ── the simulated fleet ────────────────────────────────────────────
interface Home { cfg: HomeConfig; state: HomeState; buffer: Sample[] }

const homes: Home[] = Array.from({ length: SYSTEMS }, (_, i) => {
  const deviceId = i + 1;
  // Same model, slightly different roofs, so the homes do not all look identical.
  const cfg: HomeConfig = { ...DEFAULT_HOME, deviceId, bootId: 1, pvPeakW: 4_000 + (deviceId % 5) * 1_000 };
  return { cfg, state: createHome(cfg, deviceId), buffer: [] };
});

const client = await connectAsync(MQTT_URL);
console.log(`connected to ${MQTT_URL}; ${homes.length} homes, one sample every ${TICK_MS} ms, ${BATCH_SIZE} samples per message`);

let published = 0;
const startMs = Date.now();
let simMs = startMs;      // simulated device clock; advances 1 s per tick

async function publish(home: Home): Promise<void> {
  const payload = encodeBatch(home.buffer);
  home.buffer = [];
  // QoS 1 = "at least once": the broker acknowledges, and a retry after a lost ack can deliver a duplicate.
  // That is why every sample carries (deviceId, bootId, seq): readers can drop duplicates later.
  await client.publishAsync(topicFor(home.cfg.deviceId), payload, { qos: 1 });
  published++;
}

async function tick(): Promise<void> {
  simMs += 1_000;
  const sends: Promise<void>[] = [];
  for (const home of homes) {
    const r = stepHome(home.cfg, home.state, simMs, 1);
    home.state = r.state;
    const simS = (simMs - startMs) / 1_000;
    const hot = home.cfg.deviceId === HOT_DEVICE && simS >= HOT_FROM_S && simS < HOT_FROM_S + HOT_FOR_S;
    home.buffer.push(hot ? { ...r.sample, values: { ...r.sample.values, battTempC: HOT_TEMP_C } } : r.sample);
    if (home.buffer.length >= BATCH_SIZE) sends.push(publish(home));
  }
  await Promise.all(sends);
}

let busy = false;
const timer = setInterval(() => {
  if (busy) return;               // never let ticks pile up if the broker is slow
  busy = true;
  tick().catch((e) => console.error('tick failed:', e)).finally(() => { busy = false; });
}, TICK_MS);

const reporter = setInterval(() => console.log(`published ${published} messages`), 5_000);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(reporter);
  while (busy) await new Promise((r) => setTimeout(r, 10));
  for (const home of homes) if (home.buffer.length > 0) await publish(home);   // flush the partial batch
  await client.endAsync();
  console.log(`done: ${published} messages published`);
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
if (SECONDS > 0) setTimeout(() => { void stop(); }, SECONDS * 1_000);