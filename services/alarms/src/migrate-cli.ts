import pg from 'pg';
import { runMigrations } from '@speicherlotse/service-kit';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  console.log(`database: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  const applied = await runMigrations(db, new URL('../sql/', import.meta.url), { timescale: false });
  console.log(applied.length === 0 ? 'nothing to apply, schema is up to date' : `applied: ${applied.join(', ')}`);
} finally {
  await db.end();
}