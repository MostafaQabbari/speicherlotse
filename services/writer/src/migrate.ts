import { readdir, readFile } from 'node:fs/promises';
import type { Client } from 'pg';

const SQL_DIR = new URL('../sql/', import.meta.url);

/**
 * Applies the files in services/writer/sql in name order, each at most once (recorded in schema_migrations).
 * Files ending in `.timescale.sql` need the TimescaleDB extension and are skipped when `timescale` is false.
 * Returns the names applied in this call.
 */
export async function migrate(db: Client, opts: { timescale: boolean }): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));

  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    if (file.endsWith('.timescale.sql') && !opts.timescale) continue;
    const sql = await readFile(new URL(file, SQL_DIR), 'utf8');
    // One simple-protocol query with several statements runs as one implicit transaction: all or nothing.
    await db.query(`${sql}\n;insert into schema_migrations (name) values ('${file}');`);
    applied.push(file);
  }
  return applied;
}

/** True when the server has the TimescaleDB extension available (installed or installable). */
export async function timescaleAvailable(db: Client): Promise<boolean> {
  const r = await db.query("select 1 from pg_available_extensions where name = 'timescaledb'");
  return r.rows.length > 0;
}