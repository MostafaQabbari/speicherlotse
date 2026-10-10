export type Severity = 'warning' | 'critical';
export type AlarmEventKind = 'fired' | 'resolved';

/** One row of the outbox: an alarm event that has to be announced. */
export interface OutboxRow {
  deviceId: number;
  ruleId: string;
  event: AlarmEventKind;
  severity: Severity;
  atMs: number;
  /** How many times sending was tried before. */
  attempts: number;
}

/** What goes out. `id` is the same for every attempt of the same alarm event, so a receiver can drop duplicates. */
export interface NotificationMessage {
  id: string;
  deviceId: number;
  ruleId: string;
  severity: Severity;
  event: AlarmEventKind;
  /** Event time: when the reading that caused the alarm was measured (device clock), ISO 8601. */
  at: string;
  text: string;
}

/** Stable and unique per alarm event: it is the primary key of alarm_event written as text. */
export const notificationId = (r: Pick<OutboxRow, 'deviceId' | 'ruleId' | 'atMs' | 'event'>): string =>
  `${r.deviceId}:${r.ruleId}:${r.atMs}:${r.event}`;

export function buildMessage(r: OutboxRow): NotificationMessage {
  const at = new Date(r.atMs).toISOString();
  return {
    id: notificationId(r),
    deviceId: r.deviceId,
    ruleId: r.ruleId,
    severity: r.severity,
    event: r.event,
    at,
    // The same wording as the alarm engine's own log line.
    text: `ALARM ${r.event.toUpperCase()} ${r.ruleId} (${r.severity}) device ${r.deviceId} at ${at}`,
  };
}