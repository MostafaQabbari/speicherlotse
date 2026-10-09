import pg from 'pg';
import { migrate, timescaleAvailable } from './migrate.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  const timescale = process.env.NO_TIMESCALE !== '1' && (await timescaleAvailable(db));
  console.log(`database: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`TimescaleDB available: ${timescale ? 'yes' : 'NO (hypertable, compression and retention steps are skipped)'}`);
  const applied = await migrate(db, { timescale });
  console.log(applied.length === 0 ? 'nothing to apply, schema is up to date' : `applied: ${applied.join(', ')}`);
} finally {
  await db.end();
}