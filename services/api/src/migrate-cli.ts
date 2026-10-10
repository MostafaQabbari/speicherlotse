import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  console.log(`database: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  // The tenant rules are attached to tables of the writer and the alarm engine: those come first.
  const missing: string[] = [];
  for (const [table, service] of [['telemetry', 'writer'], ['alarm_event', 'alarms']] as const) {
    if ((await db.query('select to_regclass($1) as t', [table])).rows[0]?.t === null) {
      missing.push(`the table ${table} does not exist yet: run "pnpm --filter @speicherlotse/${service} migrate" first`);
    }
  }
  if (missing.length > 0) {
    for (const m of missing) console.error(m);
    process.exitCode = 1;
  } else {
    const applied = await runMigrations(db, new URL('../sql/', import.meta.url), { timescale: false });
    console.log(applied.length === 0 ? 'nothing to apply, schema is up to date' : `applied: ${applied.join(', ')}`);
  }
} finally {
  await db.end();
}
