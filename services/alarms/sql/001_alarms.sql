-- Alarm engine tables (ADR-004). Plain PostgreSQL; they work with and without TimescaleDB.
-- File names must be unique across services: all services share the schema_migrations table.

-- The newest sample time the engine has processed for each device ("watermark").
-- A sample that is not newer than this is skipped, which makes redelivered messages harmless.
-- Updated at every batch, so leave room on each page for in-place (HOT) updates.
create table if not exists alarm_device (
  device_id    integer primary key,
  last_wall_ms bigint  not null
) with (fillfactor = 70);

-- The current state of every alarm that is NOT normal (pending, firing, clearing).
-- "normal" has no row, so the table stays small however many devices there are.
create table if not exists alarm_state (
  device_id integer not null,
  rule_id   text    not null,
  state     jsonb   not null,     -- an AlarmState from packages/alarm-rules
  primary key (device_id, rule_id)
);

-- The history: every time an alarm fired or resolved. The notifier and the API read this table.
create table if not exists alarm_event (
  device_id integer     not null,
  rule_id   text        not null,
  severity  text        not null check (severity in ('warning', 'critical')),
  event     text        not null check (event in ('fired', 'resolved')),
  at_ms     bigint      not null,     -- event time: when the sample that caused it was measured
  at        timestamptz not null,     -- the same moment as a timestamp, for queries and charts
  primary key (device_id, rule_id, at_ms, event)
);

create index if not exists alarm_event_at_idx on alarm_event (at desc);