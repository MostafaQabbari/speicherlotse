import type pg from 'pg';

/** What the engine needs from a database connection. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A Queryable that can also run several statements as one all-or-nothing transaction. */
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

const wrap = (q: pg.ClientBase | pg.Pool): Queryable => ({
  async query<R>(text: string, values?: unknown[]) {
    const r = await q.query(text, values);
    return { rows: r.rows as R[], rowCount: r.rowCount };
  },
});

/** Production: every transaction gets its own connection from the pool. */
export function poolDatabase(pool: pg.Pool): Database {
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        return await runTransaction(client, fn);
      } finally {
        client.release();
      }
    },
  };
}

/** Tests: one connection (so that `set search_path` applies to everything). */
export function clientDatabase(client: pg.Client): Database {
  return { ...wrap(client), transaction: (fn) => runTransaction(client, fn) };
}

async function runTransaction<T>(client: pg.ClientBase, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (err) {
    // If the connection itself is gone the rollback fails too; the server rolls back an open transaction
    // when its connection ends, so the original error is the one to report.
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}