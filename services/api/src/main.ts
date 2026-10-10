import pg from 'pg';
import { MIN_SECRET_LENGTH } from './auth.ts';
import { createApp } from './create-app.ts';
import { TenantDb } from './tenant-db.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';             // only this computer, unless you say otherwise
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX ?? 10);
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS ?? 5_000);
const JWT_SECRET = process.env.JWT_SECRET ?? '';

for (const [name, v] of Object.entries({ PORT, DB_POOL_MAX, STATEMENT_TIMEOUT_MS })) {
  if (!Number.isInteger(v) || v < 1) {
    console.error(`${name} must be a positive whole number`);
    process.exit(1);
  }
}
if (JWT_SECRET.length < MIN_SECRET_LENGTH) {
  console.error(`JWT_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters. Make one with:`);
  console.error(`  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: DB_POOL_MAX });
// An idle connection that the database closes must not crash the process.
pool.on('error', (error) => console.error(`idle database connection failed: ${error.message}`));

const app = await createApp({ tenantDb: new TenantDb(pool, { statementTimeoutMs: STATEMENT_TIMEOUT_MS }), jwtSecret: JWT_SECRET });
await app.listen(PORT, HOST);
console.log(`api: listening on http://${HOST}:${PORT}  database: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`api: ${signal}, shutting down`);
  await app.close();      // stops accepting connections and waits for running requests
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
