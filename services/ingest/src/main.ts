import { startIngest } from './ingest.ts';
import { consoleSink, kafkaSink } from './sink.ts';

// ── settings (all optional, set as environment variables) ──────────
const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const DRY_RUN = process.env.DRY_RUN === '1';   // print instead of writing to Kafka; handy to test the MQTT side alone

const sink = DRY_RUN ? consoleSink() : kafkaSink(KAFKA_BROKERS);

const ingest = await startIngest({
  mqttUrl: MQTT_URL,
  sink,
  onFatal: (error) => {
    console.error(`accepted before the failure: ${ingest.stats.accepted} messages`);
    console.error('Kafka write failed, exiting without acknowledging the message (the broker will redeliver it):', error);
    process.exit(1);
  },
});
console.log(`ingest running: MQTT ${MQTT_URL} -> ${DRY_RUN ? 'console (dry run)' : `Kafka ${KAFKA_BROKERS.join(',')}`}`);

const reporter = setInterval(() => {
  const s = ingest.stats;
  console.log(`accepted ${s.accepted} messages (${s.samples} samples), rejected ${s.rejected}`);
}, 5_000);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(reporter);
  await ingest.stop();
  await sink.close();
  const s = ingest.stats;
  console.log(`stopped: accepted ${s.accepted}, rejected ${s.rejected}`);
  process.exit(0);
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });