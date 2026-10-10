import pg from 'pg';
import { DEMO_TENANTS } from './demo.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/speicherlotse';

// Runs as the database owner (it creates tenants), which the API itself can never do.
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  await db.query('begin');
  for (const t of DEMO_TENANTS) {
    await db.query('insert into tenant (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name', [t.id, t.name]);
    for (const deviceId of t.devices) {
      await db.query(
        `insert into device (device_id, tenant_id, name) values ($1, $2, $3)
         on conflict (device_id) do update set tenant_id = excluded.tenant_id, name = excluded.name`,
        [deviceId, t.id, `Home ${deviceId}`]);
    }
  }
  await db.query('commit');
  for (const t of DEMO_TENANTS) console.log(`${t.key}: ${t.name}  id ${t.id}  devices ${t.devices.join(', ')}`);
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
