import pg from 'pg';
import { DEFAULT_RETRY, describeError, withRetry } from '@speicherlotse/service-kit';
import { fromPg } from './db.ts';
import { Notifier } from './notifier.ts';
import { logSender, webhookSender, type Sender } from './sender.ts';
import { pendingCount } from './store.ts';

// ── settings (all optional, set as environment variables) ──────────
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';                       // empty: only print the notifications
const POLL_MS = Number(process.env.POLL_MS ?? 1000);                     // pause when nothing is waiting
const BATCH = Number(process.env.BATCH ?? 20);                           // notifications per pass
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 8);              // then the notification is abandoned
const BASE_DELAY_MS = Number(process.env.BASE_DELAY_MS ?? 2_000);        // wait after the first failure, doubling each time
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 300_000);        // but never longer than this
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 5_000);

for (const [name, v] of Object.entries({ POLL_MS, BATCH, MAX_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS, REQUEST_TIMEOUT_MS })) {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`);
}
if (WEBHOOK_URL !== '' && !/^https?:\/\//.test(WEBHOOK_URL)) throw new Error('WEBHOOK_URL must start with http:// or https://');

const sender: Sender = WEBHOOK_URL === ''
  ? logSender((line) => console.log(line))
  : webhookSender({ url: WEBHOOK_URL, timeoutMs: REQUEST_TIMEOUT_MS });

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
pool.on('error', (err) => console.error(`database connection lost (the pool reconnects): ${err.message}`));
const db = fromPg(pool);

const notifier = new Notifier(db, sender, {
  batchSize: BATCH, maxAttempts: MAX_ATTEMPTS, baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS,
  log: (line) => console.log(line),
});

console.log(`notifier running: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')} -> ${sender.name}${WEBHOOK_URL === '' ? '' : ` ${WEBHOOK_URL}`}`);

const line = async (): Promise<string> => {
  const s = notifier.stats;
  let pending = '?';
  try { pending = String(await pendingCount(db)); } catch { /* the database is down; the loop reports it */ }
  return `${s.sent} sent, ${s.retried} failed and will be retried, ${s.gaveUp} gave up, ${pending} waiting`;
};
const reporter = setInterval(() => void line().then((l) => console.log(l)), 5_000);

const stop = new AbortController();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

const loop = async (): Promise<void> => {
  while (!stop.signal.aborted) {
    try {
      // A database outage delays the notifier, it does not kill it; anything that is not an outage does.
      const r = await withRetry(() => notifier.runOnce(), {
        ...DEFAULT_RETRY,
        signal: stop.signal,
        onRetry: (err, attempt, delay) => console.error(`database not ready (${describeError(err)}); attempt ${attempt + 1} in ${Math.round(delay / 1000)} s`),
      });
      if (r.due < BATCH) await sleep(POLL_MS);   // a full batch means more may be waiting: go on at once
    } catch (err) {
      if (stop.signal.aborted) break;
      console.error(`notifier cannot continue: ${describeError(err)}`);
      console.error('Notifications that were not marked as sent stay in the outbox and are sent after a restart.');
      process.exit(1);
    }
  }
};

let stopping = false;
const shutdown = (): void => {
  if (stopping) {
    console.log('second signal: leaving now');
    process.exit(1);
  }
  stopping = true;
  console.log('stopping: finishing the notification in progress (press Ctrl+C again to leave now)');
  stop.abort();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await loop();
clearInterval(reporter);
console.log(`stopped: ${await line()}`);
await pool.end();