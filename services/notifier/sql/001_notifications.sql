-- Notification outbox (ADR-005). Plain PostgreSQL. Run the alarms migration first: this file adds a trigger to alarm_event.
-- File names must be unique across services: all services share the schema_migrations table.

-- One row per alarm event that has to be announced. It is created BY THE DATABASE in the same transaction that
-- writes the alarm event (see the trigger below), so an event can neither be announced without existing nor exist
-- without being queued. The notifier only reads and updates this table.
create table if not exists notification_outbox (
  device_id       integer     not null,
  rule_id         text        not null,
  event           text        not null check (event in ('fired', 'resolved')),
  at_ms           bigint      not null,
  severity        text        not null check (severity in ('warning', 'critical')),
  created_at      timestamptz not null default now(),
  attempts        integer     not null default 0,                 -- how many times sending was tried
  next_attempt_at timestamptz not null default '-infinity',       -- not before this moment; new rows are due at once
  last_error      text,
  sent_at         timestamptz,                                    -- set when the receiver accepted it
  gave_up_at      timestamptz,                                    -- set when it was abandoned (see ADR-005)
  primary key (device_id, rule_id, at_ms, event)                  -- the same key as alarm_event
);

-- Only the unfinished rows are indexed, so the index stays tiny however many notifications were sent.
create index if not exists notification_outbox_unsent_idx
  on notification_outbox (at_ms)
  where sent_at is null and gave_up_at is null;

create or replace function enqueue_notification() returns trigger language plpgsql as $$
begin
  insert into notification_outbox (device_id, rule_id, event, at_ms, severity)
  values (new.device_id, new.rule_id, new.event, new.at_ms, new.severity)
  on conflict do nothing;
  return new;
end
$$;

drop trigger if exists alarm_event_enqueue on alarm_event;
create trigger alarm_event_enqueue
  after insert on alarm_event
  for each row execute function enqueue_notification();