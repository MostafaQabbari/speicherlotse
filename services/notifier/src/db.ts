import type pg from 'pg';

/** What the notifier needs from a database connection: single statements, no transactions. */
export interface Db {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Wraps a pg Pool (production) or Client (tests) as a Db. */
export const fromPg = (q: pg.Pool | pg.Client): Db => ({
  async query<R>(text: string, values?: unknown[]) {
    const r = await q.query(text, values);
    return { rows: r.rows as R[], rowCount: r.rowCount };
  },
});