import pg from 'pg';
import { DEFAULT_RULES } from '@speicherlotse/alarm-rules';
import { openKafkaSource, pump } from '@speicherlotse/service-kit';
import { RAW_TOPIC } from '@speicherlotse/wire';
import { AlarmEngine } from './alarm-engine.ts';
import { poolDatabase } from './db.ts';
import { alarmPipeline } from './pipeline.ts';

// ── settings (all optional, set as environment variables) ──────────
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';
// Its own consumer group: the alarm engine reads telemetry.raw independently of the writer and has its own offsets.
const GROUP_ID = process.env.GROUP_ID ?? 'speicherlotse-alarms';
const BATCH_MESSAGES = Number(process.env.BATCH_MESSAGES ?? 100);
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 500);

for (const [name, v] of Object.entries({ BATCH_MESSAGES, MAX_WAIT_MS })) {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
pool.on('error', (err) => console.error(`database connection lost (the pool reconnects): ${err.message}`));

const engine = new AlarmEngine(poolDatabase(pool), DEFAULT_RULES);
const pipeline = alarmPipeline({
  engine,
  maxMessages: BATCH_MESSAGES,
  maxWaitMs: MAX_WAIT_MS,
  log: (line) => console.log(line),
  onFatal: (err) => {
    console.error(`alarm engine cannot continue: ${err.message}`);
    console.error('Nothing after the last commit was acknowledged, so a restart continues from there without losing alarms.');
    process.exit(1);
  },
});

const line = (): string => {
  const s = pipeline.stats;
  return `${s.messages} messages (${s.samples} samples, ${engine.devices} devices) -> ${s.fired} fired, ${s.resolved} resolved, ${s.skippedOld} old samples skipped, ${s.skippedInvalid} invalid, ${s.undecodable} undecodable, ${s.retries} retries`;
};

let source;
try {
  source = await openKafkaSource({ brokers: KAFKA_BROKERS, groupId: GROUP_ID, topic: RAW_TOPIC, clientId: 'speicherlotse-alarms' });
} catch (err) {
  console.error(`cannot reach Kafka at ${KAFKA_BROKERS.join(',')}: ${(err as Error).message}`);
  await pool.end();
  process.exit(1);
}

pipeline.start();
console.log(`alarm engine running: Kafka ${KAFKA_BROKERS.join(',')} topic ${RAW_TOPIC} group ${GROUP_ID} -> ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
console.log(`rules: ${DEFAULT_RULES.map((r) => r.id).join(', ')}`);
const reporter = setInterval(() => console.log(line()), 5_000);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) {
    console.log('second signal: no longer waiting for the database');
    pipeline.abort();
    return;
  }
  stopping = true;
  console.log('stopping: handling what is buffered (press Ctrl+C again to stop waiting for a database that is down)');
  try {
    await pipeline.stop();
    await source.close();
    clearInterval(reporter);
    await pool.end();
    console.log(`stopped: ${line()}`);
    process.exit(0);
  } catch (err) {
    console.error(`stopped with unhandled messages (they stay uncommitted and will be read again): ${(err as Error).message}`);
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