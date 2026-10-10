import type { Client } from 'pg';
import { runMigrations, timescaleAvailable } from '@speicherlotse/service-kit';

const SQL_DIR = new URL('../sql/', import.meta.url);

/**
 * Applies the files in services/writer/sql in name order, each at most once (see runMigrations).
 * Files ending in `.timescale.sql` need the TimescaleDB extension and are skipped when `timescale` is false.
 */
export const migrate = (db: Client, opts: { timescale: boolean }): Promise<string[]> => runMigrations(db, SQL_DIR, opts);

export { timescaleAvailable };