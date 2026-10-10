import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  console.log(`database: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  // The outbox trigger is attached to alarm_event, which the alarms service creates.
  const alarms = await db.query("select to_regclass('alarm_event') as t");
  if (alarms.rows[0]?.t === null) {
    console.error('the table alarm_event does not exist yet: run "pnpm --filter @speicherlotse/alarms migrate" first');
    process.exitCode = 1;
  } else {
    const applied = await runMigrations(db, new URL('../sql/', import.meta.url), { timescale: false });
    console.log(applied.length === 0 ? 'nothing to apply, schema is up to date' : `applied: ${applied.join(', ')}`);
  }
} finally {
  await db.end();
}