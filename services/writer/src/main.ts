import pg from 'pg';
import { openKafkaSource } from './kafka.ts';
import { Pipeline, pump } from './pipeline.ts';

// ── settings (all optional, set as environment variables) ──────────
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';
const GROUP_ID = process.env.GROUP_ID ?? 'speicherlotse-writer';
const BATCH_MESSAGES = Number(process.env.BATCH_MESSAGES ?? 200);   // 200 messages x 5 samples = 1,000 rows (ADR-001)
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 1_000);       // a small batch is written after this long
const RAW_TOPIC = 'telemetry.raw';                                   // must match services/ingest/src/route.ts

for (const [name, v] of Object.entries({ BATCH_MESSAGES, MAX_WAIT_MS })) {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
// A database restart makes idle connections fail. Without this listener Node would treat it as a crash.
pool.on('error', (err) => console.error(`database connection lost (the pool reconnects): ${err.message}`));

const pipeline = new Pipeline({
  db: pool,
  maxMessages: BATCH_MESSAGES,
  maxWaitMs: MAX_WAIT_MS,
  log: (line) => console.log(line),
  onFatal: (err) => {
    console.error(`writer cannot continue: ${err.message}`);
    console.error('Nothing after the last commit was acknowledged, so a restart continues from there without losing data.');
    process.exit(1);
  },
});

const line = (): string => {
  const s = pipeline.stats;
  return `${s.messages} messages (${s.samples} samples) -> ${s.inserted} rows stored, ${s.duplicates} duplicates, ${s.rejectedSamples} rejected samples, ${s.undecodable} undecodable, ${s.retries} retries`;
};

let source;
try {
  source = await openKafkaSource({ brokers: KAFKA_BROKERS, groupId: GROUP_ID, topic: RAW_TOPIC });
} catch (err) {
  console.error(`cannot reach Kafka at ${KAFKA_BROKERS.join(',')}: ${(err as Error).message}`);
  await pool.end();
  process.exit(1);
}

pipeline.start();
console.log(`writer running: Kafka ${KAFKA_BROKERS.join(',')} topic ${RAW_TOPIC} group ${GROUP_ID} -> ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
const reporter = setInterval(() => console.log(line()), 5_000);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) {
    console.log('second signal: no longer waiting for the database');
    pipeline.abort();
    return;
  }
  stopping = true;
  console.log('stopping: writing what is buffered (press Ctrl+C again to stop waiting for a database that is down)');
  try {
    await pipeline.stop();        // writes the buffer and commits, while the Kafka stream is still open
    await source.close();
    clearInterval(reporter);
    await pool.end();
    console.log(`stopped: ${line()}`);
    process.exit(0);
  } catch (err) {
    console.error(`stopped with unwritten messages (they stay uncommitted and will be read again): ${(err as Error).message}`);
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await pump(source.messages, pipeline);
} catch (err) {
  if (!stopping) {
    console.error(`Kafka stream failed: ${(err as Error).message}`);
    process.exit(1);
  }
}