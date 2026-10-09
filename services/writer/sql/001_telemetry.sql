-- One wide row per device per sample (ADR-001, section 2).
-- Plain PostgreSQL: this file works with and without TimescaleDB.
-- The channel columns must match CHANNELS in packages/telemetry-model; a test checks that.

create table if not exists telemetry (
  ts             timestamptz not null,   -- device wall clock (can be wrong; see received-at note in the ADR)
  device_id      integer     not null,
  boot_id        bigint      not null,   -- changes at every restart of the device
  seq            integer     not null,   -- +1 per sample within one boot
  mono_ms        bigint      not null,   -- ms since boot, never jumps

  pv_w           real,
  load_w         real,
  ev_w           real,
  batt_w         real,
  grid_w         real,
  batt_soc       real,
  batt_soh       real,
  batt_temp_c    real,
  batt_voltage_v real,
  cell_mv_min    real,
  cell_mv_max    real,
  grid_hz        real,
  grid_voltage_v real,
  inv_temp_c     real,
  batt_status    smallint,
  ev_status      smallint,

  -- Doubles as the duplicate guard (MQTT QoS 1 can deliver a message twice) and as the index for
  -- "one device, one time range". A unique index on a hypertable must contain the time column, hence ts.
  primary key (device_id, ts, boot_id, seq)
);