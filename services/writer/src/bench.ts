// Measures two numbers ADR-001 only assumed: bytes per stored row, and rows per second a writer can insert.
//   pnpm --filter @speicherlotse/writer bench
// Settings (environment variables):
//   DATABASE_URL       default postgres://postgres:postgres@localhost:5432/speicherlotse
//   BENCH_ROWS         rows to insert, default 1,000,000
//   BENCH_DEVICES      simulated devices, default 100
//   BENCH_BATCH        rows per insert call, default 1,000 (ADR-001: at least 1,000)
//   BENCH_CONNECTIONS  parallel database connections, default 1
//   BENCH_SYNC_OFF=1   do not wait for the disk flush at each commit (shows how much the disk costs)
//   BENCH_RESET=1      empty the table first
// It inserts into the table `telemetry` of the database you point it at.
import pg from 'pg';
import { createHome, stepHome, DEFAULT_HOME, type HomeConfig, type HomeState, type Sample } from '@speicherlotse/telemetry-model';
import { insertRows } from './insert.ts';
import { toRows } from './rows.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';
const ROWS = Number(process.env.BENCH_ROWS ?? 1_000_000);
const DEVICES = Number(process.env.BENCH_DEVICES ?? 100);
const BATCH = Number(process.env.BENCH_BATCH ?? 1_000);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 1);
const SYNC_OFF = process.env.BENCH_SYNC_OFF === '1';
for (const [k, v] of Object.entries({ ROWS, DEVICES, BATCH, CONNECTIONS })) {
  if (!Number.isInteger(v) || v < 1) throw new Error(`BENCH_${k} must be a positive integer`);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: CONNECTIONS,
  ...(SYNC_OFF ? { options: '-c synchronous_commit=off' } : {}),
});
if (process.env.BENCH_RESET === '1') await pool.query('truncate telemetry');
const before = Number((await pool.query('select count(*) from telemetry')).rows[0].count);

// The simulated fleet. Timestamps are the last ROWS/DEVICES seconds up to now, so a hypertable puts the rows in
// its newest chunks, like live data. Rows are produced second by second across all devices (device 1, 2, ... 100,
// then the next second), which is the interleaved order in which a Kafka consumer would see them.
const seconds = Math.ceil(ROWS / DEVICES);
const startMs = Math.floor(Date.now() / 1000) * 1000 - seconds * 1000;
const homes = Array.from({ length: DEVICES }, (_, i) => {
  const cfg: HomeConfig = { ...DEFAULT_HOME, deviceId: i + 1, bootId: 1, pvPeakW: 4_000 + ((i + 1) % 5) * 1_000 };
  return { cfg, state: createHome(cfg, i + 1) as HomeState };
});

let pending: Sample[] = [];
let stored = 0;
const running = new Set<Promise<void>>();

// Starts the insert of the pending batch; waits first if all connections are busy.
async function flush(): Promise<void> {
  const { rows } = toRows(pending);
  pending = [];
  while (running.size >= CONNECTIONS) await Promise.race(running);
  const p: Promise<void> = insertRows(pool, rows).then((n) => { stored += n; }).finally(() => { running.delete(p); });
  running.add(p);
}

const wall = performance.now();
let produced = 0;
for (let s = 0; s < seconds && produced < ROWS; s++) {
  for (const home of homes) {
    if (produced >= ROWS) break;
    const r = stepHome(home.cfg, home.state, startMs + s * 1000, 1);
    home.state = r.state;
    pending.push(r.sample);
    produced++;
    if (pending.length >= BATCH) await flush();
  }
}
if (pending.length > 0) await flush();
await Promise.all(running);
const wallS = (performance.now() - wall) / 1000;

await pool.query('analyze telemetry');
// A hypertable is many chunk tables; its size functions add them up. Plain PostgreSQL uses the table itself.
const hyper = (await pool.query("select 1 from pg_extension where extname = 'timescaledb'")).rows.length > 0
  && (await pool.query("select 1 from timescaledb_information.hypertables where hypertable_name = 'telemetry'")).rows.length > 0;
const sizes = (await pool.query(hyper
  ? "select total_bytes as total, index_bytes as idx from hypertable_detailed_size('telemetry')"
  : "select pg_total_relation_size('telemetry') as total, pg_indexes_size('telemetry') as idx")).rows[0];
const total = Number(sizes.total);
const idx = Number(sizes.idx);
const nowRows = Number((await pool.query('select count(*) from telemetry')).rows[0].count);
await pool.end();

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
console.log(`storage: ${hyper ? 'TimescaleDB hypertable' : 'plain PostgreSQL table'}`);
console.log(`rows produced ${fmt(produced)}, newly stored ${fmt(stored)}, duplicates skipped ${fmt(produced - stored)}, table now holds ${fmt(nowRows)} (was ${fmt(before)})`);
console.log(`batch ${fmt(BATCH)} rows, ${fmt(DEVICES)} devices, ${fmt(CONNECTIONS)} connection(s), commit wait ${SYNC_OFF ? 'OFF' : 'on'}`);
console.log(`time ${fmt(wallS)} s  ->  ${fmt(stored / wallS)} rows/s (wall clock, includes generating the data)`);
console.log(`size: total ${fmt(total / 1e6)} MB (1 MB = 1,000,000 bytes), of which indexes ${fmt(idx / 1e6)} MB`);
console.log(`bytes per row: ${fmt(total / nowRows)} total, ${fmt((total - idx) / nowRows)} table only, ${fmt(idx / nowRows)} index  (ADR-001 assumed 150)`);