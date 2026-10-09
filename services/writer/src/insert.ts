import { CHANNEL_COLUMNS, type Row } from './rows.ts';

/** Anything with a pg-style query method: a Client, a Pool, or a test double. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Rows per statement. ADR-001 wants batches of at least 1,000; very large arrays only add memory pressure. */
export const MAX_ROWS_PER_STATEMENT = 5_000;

// The key columns, then the channel columns. Each becomes ONE array parameter, so a statement has
// 21 parameters whether it inserts 1 row or 5,000 (a multi-row VALUES list would need 21 x N).
const KEY_COLUMNS = [
  { column: 'ts_ms', type: 'bigint' },
  { column: 'device_id', type: 'integer' },
  { column: 'boot_id', type: 'bigint' },
  { column: 'seq', type: 'integer' },
  { column: 'mono_ms', type: 'bigint' },
] as const;

const ALL_COLUMNS = [
  ...KEY_COLUMNS,
  ...CHANNEL_COLUMNS.map((c) => ({ column: c.column, type: c.isCode ? 'smallint' : 'real' })),
];

const SQL = `
insert into telemetry (ts, device_id, boot_id, seq, mono_ms, ${CHANNEL_COLUMNS.map((c) => c.column).join(', ')})
select timestamptz 'epoch' + t.ts_ms * interval '1 millisecond', t.device_id, t.boot_id, t.seq, t.mono_ms,
       ${CHANNEL_COLUMNS.map((c) => `t.${c.column}`).join(', ')}
from unnest(${ALL_COLUMNS.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ')})
     as t(${ALL_COLUMNS.map((c) => c.column).join(', ')})
on conflict do nothing`;

/**
 * Inserts rows and returns how many were NEW. A row whose key (device_id, ts, boot_id, seq) already exists
 * is skipped silently: that is how a redelivered MQTT message or a replayed Kafka batch becomes harmless.
 * The return value is rows.length minus the duplicates.
 */
export async function insertRows(db: Queryable, rows: readonly Row[]): Promise<number> {
  let inserted = 0;
  for (let from = 0; from < rows.length; from += MAX_ROWS_PER_STATEMENT) {
    const part = rows.slice(from, from + MAX_ROWS_PER_STATEMENT);
    const params: unknown[] = [
      part.map((r) => r.tsMs),
      part.map((r) => r.deviceId),
      part.map((r) => r.bootId),
      part.map((r) => r.seq),
      part.map((r) => r.monoMs),
      ...CHANNEL_COLUMNS.map((_, i) => part.map((r) => r.values[i] ?? null)),
    ];
    const res = await db.query(SQL, params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}