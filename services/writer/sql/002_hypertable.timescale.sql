-- TimescaleDB only. Skipped automatically on plain PostgreSQL (the runner skips *.timescale.sql).
-- Safe to run twice: every call uses if_not_exists.

create extension if not exists timescaledb;

-- 6-hour chunks: at 1,000 systems one chunk holds ~21.6 million rows, and its index should fit in memory.
-- No default (ts) index: the primary key (device_id, ts, ...) already serves the device+time queries.
select create_hypertable(
  'telemetry', by_range('ts', interval '6 hours'),
  create_default_indexes => false, if_not_exists => true
);

-- ADR-001 section 5: compress after 1 day, drop raw rows after 14 days.
alter table telemetry set (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'device_id',
  timescaledb.orderby   = 'ts desc'
);

call add_columnstore_policy('telemetry', after => interval '1 day', if_not_exists => true);

select add_retention_policy('telemetry', drop_after => interval '14 days', if_not_exists => true);