import type pg from 'pg';

/** The restricted role from sql/001_tenants.sql. Every request runs as this role. */
export const APP_ROLE = 'speicherlotse_app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTenantId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/** What a request handler may do with the database: run queries. No transaction control, no connection. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface TenantDbOptions {
  /** A query that runs longer than this is cancelled by the database. */
  statementTimeoutMs?: number;
}

/**
 * The only way the API reaches the database. One call = one transaction in which
 *   1. the transaction is READ ONLY (a bug in a query cannot write),
 *   2. the role is switched to speicherlotse_app (row-level security applies to it),
 *   3. the tenant is set for this transaction only (set_config(..., true) = local),
 *   4. a statement timeout is set.
 * Role and tenant are local to the transaction, so a pooled connection that goes to the next request carries
 * nothing over. A request that never calls this has no database access at all.
 */
export class TenantDb {
  readonly #pool: pg.Pool;
  readonly #timeoutMs: number;

  constructor(pool: pg.Pool, options: TenantDbOptions = {}) {
    this.#pool = pool;
    this.#timeoutMs = options.statementTimeoutMs ?? 5_000;
  }

  async withTenant<T>(tenantId: string, work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!isTenantId(tenantId)) throw new TypeError('tenantId must be a UUID');
    const client = await this.#pool.connect();
    let started = false;
    let broken = false;
    try {
      await client.query('begin read only');
      started = true;
      await client.query(`set local role ${APP_ROLE}`);
      await client.query(
        "select set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)",
        [tenantId, String(this.#timeoutMs)]);
      const result = await work({ query: (text, values) => client.query(text, values) });
      await client.query('commit');
      return result;
    } catch (error) {
      // An ordinary error (a bad query, a timeout) is rolled back and the connection is reused.
      // If even 'begin' or 'rollback' fails, the connection is bad: throw it away instead of returning it to the pool.
      if (started) await client.query('rollback').catch(() => { broken = true; });
      else broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /** For the health check: is the database reachable? Does not touch any tenant data. */
  async ping(): Promise<void> {
    await this.#pool.query('select 1');
  }
}
