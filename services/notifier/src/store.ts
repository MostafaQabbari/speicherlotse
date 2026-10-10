import type { Db } from './db.ts';
import type { AlarmEventKind, OutboxRow, Severity } from './message.ts';

const isEvent = (x: string): x is AlarmEventKind => x === 'fired' || x === 'resolved';
const isSeverity = (x: string): x is Severity => x === 'warning' || x === 'critical';

interface DueRecord {
  device_id: number;
  rule_id: string;
  event: string;
  severity: string;
  at_ms: string;     // bigint comes back as text
  attempts: number;
}

/**
 * The notifications that are ready to be sent now, oldest event first.
 *
 * Order within one alarm (device + rule) is kept: a notification waits while an EARLIER one of the same alarm
 * is still unfinished (being retried), so a receiver never sees "resolved" before "fired". Other alarms are not
 * held up. Once the earlier one is sent or abandoned, the next one is due.
 *
 * The partial index on the table covers exactly the rows with neither sent_at nor gave_up_at, so this stays
 * fast however many were sent before.
 */
export async function due(db: Db, nowMs: number, limit: number): Promise<OutboxRow[]> {
  const r = await db.query<DueRecord>(
    `select o.device_id, o.rule_id, o.event, o.severity, o.at_ms, o.attempts
     from notification_outbox o
     where o.sent_at is null and o.gave_up_at is null and o.next_attempt_at <= to_timestamp($1::bigint / 1000.0)
       and not exists (
         select 1 from notification_outbox earlier
         where earlier.device_id = o.device_id and earlier.rule_id = o.rule_id and earlier.at_ms < o.at_ms
           and earlier.sent_at is null and earlier.gave_up_at is null)
     order by o.at_ms, o.device_id, o.rule_id
     limit $2`,
    [Math.floor(nowMs), limit]);
  return r.rows.map((x) => {
    // The table has CHECK constraints for these two; if they ever fail, the table was changed by hand. Stop and say so.
    if (!isEvent(x.event) || !isSeverity(x.severity)) throw new Error(`notification_outbox holds an unknown event or severity: ${JSON.stringify(x)}`);
    return { deviceId: x.device_id, ruleId: x.rule_id, event: x.event, severity: x.severity, atMs: Number(x.at_ms), attempts: x.attempts };
  });
}

const key = (r: OutboxRow): unknown[] => [r.deviceId, r.ruleId, r.atMs, r.event];
const WHERE = 'where device_id = $1 and rule_id = $2 and at_ms = $3::bigint and event = $4';

/** The receiver accepted the message. */
export async function markSent(db: Db, r: OutboxRow): Promise<void> {
  await db.query(`update notification_outbox set sent_at = now(), attempts = attempts + 1, last_error = null ${WHERE}`, key(r));
}

/** Sending failed; try again not before `nextAttemptMs`. */
export async function markRetry(db: Db, r: OutboxRow, error: string, nextAttemptMs: number): Promise<void> {
  await db.query(
    `update notification_outbox set attempts = attempts + 1, last_error = $5, next_attempt_at = to_timestamp($6::bigint / 1000.0) ${WHERE}`,
    [...key(r), error, Math.floor(nextAttemptMs)]);
}

/** Sending failed for good. The row stays, with its last error, for a human to look at. */
export async function markGaveUp(db: Db, r: OutboxRow, error: string): Promise<void> {
  await db.query(`update notification_outbox set attempts = attempts + 1, last_error = $5, gave_up_at = now() ${WHERE}`, [...key(r), error]);
}

/** How many notifications are waiting (new, or waiting for a retry). */
export async function pendingCount(db: Db): Promise<number> {
  const r = await db.query<{ n: string }>('select count(*) as n from notification_outbox where sent_at is null and gave_up_at is null');
  return Number(r.rows[0]?.n ?? 0);
}