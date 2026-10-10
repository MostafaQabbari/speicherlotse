# ADR-002: Storage schema and write path

- Status: accepted. Row size, compression and write speed measured on TimescaleDB 2.29.2 (see Consequences); inserts into already compressed chunks are not measured yet.
- Date: 2026-10-09

## Context

ADR-001 chose wide rows (one row per device per second), batched inserts, compression after 1 day and retention of 14 days. This ADR fixes the concrete table, the duplicate guard and the rules for values that cannot be stored.

## Decision

### 1. Table

`telemetry`: `ts`, `device_id`, `boot_id`, `seq`, `mono_ms`, then one column per channel (16 today, `real`; status codes `smallint`). Column names are the channel names in snake_case; a test fails if the table and `CHANNELS` ever drift apart.

`ts` is the device wall clock. It can be wrong (a device that never synchronised its clock sends 1970). Rows outside 2000 to 2100 are rejected by the writer instead of creating chunks for the year 1970 or 50000. Open question: such a device loses all its data until its clock is fixed; a later change can fall back to the Kafka `received-at-ms` header.

### 2. One key for two jobs: `primary key (device_id, ts, boot_id, seq)`

- Duplicate guard. MQTT QoS 1 and Kafka replays deliver some samples twice with identical content. `insert ... on conflict do nothing` turns a duplicate into a no-op, and the number of rows actually inserted tells the writer how many were duplicates.
- Index for the dominant query, "one device, one time range".
- A unique index on a hypertable must contain the partitioning column, which is why `ts` is part of the key (and not just `(device_id, boot_id, seq)`).

Alternative measured: key order `(ts, device_id, boot_id, seq)`. Appends always go to the rightmost index page, so the index is dense, but a query for one device must scan every device's entries in the time range, and the uncompressed window (the newest 1 to 1.25 days) is exactly where the dashboard reads.

| 1 million rows, 100 devices, batches of 1,000, plain PostgreSQL 18 | `(device_id, ts, ...)` chosen | `(ts, device_id, ...)` |
|---|---|---|
| Table | 134 B/row | 134 B/row |
| Primary-key index | 89 B/row (leaf pages 50% full) | 49 B/row |
| Total | 223 B/row | 184 B/row |
| Insert speed (one connection, fsync off, on a sandbox VM) | 61,600 rows/s | 68,400 rows/s |

ADR-001 assumed 150 B/row. The table alone is 134 B/row, but the index was not counted, and with this key order the index is the larger part. Why the index is half empty: rows arrive in time order across many devices, so each insert lands in the middle of the index (a different device's range) and pages split in half. This only affects uncompressed data. Measured on TimescaleDB: after compression 1 million rows take 18 MiB instead of 213 MiB (see Consequences).

### 3. Hypertable settings (`sql/002_hypertable.timescale.sql`)

- Chunks of 6 hours. At 1,000 systems one chunk is 21.6 million rows, about 4.8 GB with its index; for 10,000 systems the interval must shrink (1 hour) so the active chunk's index stays in memory.
- No default `(ts)` index; the primary key covers the queries.
- Compression ("columnstore") after 1 day, segmented by `device_id`, ordered by `ts desc`. Retention drops chunks older than 14 days.
- Not measured yet: inserting duplicates or backfill into an already compressed chunk (a device that was offline for 2 days) takes a slower path. Measure it before promising the backfill numbers of ADR-001.

### 4. A bad value must never block the write path

The wire layer accepts any finite number, but a single number that does not fit its column makes PostgreSQL reject the whole statement. A writer that retries a failed Kafka batch forever would then be stuck on one sample for good. Rules, implemented in `rows.ts`:

| Problem | Handling |
|---|---|
| A channel value that overflows `real` (1e300), is not an integer for a status code, or does not fit `smallint` | stored as NULL ("unknown"), the rest of the sample is kept |
| Key or timestamp that cannot be stored (id out of range, clock before 2000 or after 2100, negative `monoMs`) | the sample is rejected and counted |
| Implausible but storable (900 °C battery) | stored as is; the rule layer decides what it means |

### 5. Insert path

Arrays instead of a long `VALUES` list: one `unnest` over 21 array parameters, so the statement has 21 parameters whether it inserts 1 or 5,000 rows. At most 5,000 rows per statement. `COPY` would be faster but cannot skip duplicates.

## Consequences

Measured on one development laptop (Windows, Docker Desktop, 4 logical CPUs, default durability, TimescaleDB 2.29.2 on PostgreSQL 18, 100 simulated devices, batches of 1,000 rows). A server with a fast disk will differ; the load report repeats these runs on the target machine.

- Row size is 222 B uncompressed, not 150 B: 134.5 B table plus 87.5 B primary-key index. For 1,000 systems that is 86.4 million rows and about 19 GB per day before compression.
- Compression: 1 million rows went from 213 MiB to 18 MiB, about 12x (roughly 19 B per row), which is inside the 10x to 20x assumption at its low end. The test used one chunk of smooth simulated data, so real telemetry may compress worse. Disk for the demo fleet (about one day uncompressed plus 13 days compressed) is roughly 40 to 45 GB, about 1.5 times the 21 to 30 GB of ADR-001.
- Writer throughput is not 50,000 rows/s. On this laptop (Intel i5-6300U, 2 cores and 4 threads, 16 GB RAM, Docker Desktop with 7.7 GiB) one connection inserts 7,000 to 9,000 rows/s, four connections about 15,000 rows/s. A plain PostgreSQL table in the same container reached 7,800 rows/s, so TimescaleDB is not the limit. Skipping the commit wait (`synchronous_commit` off) raised the speed by 28% to 11,400 rows/s, so the disk flush is a minor part. Generating and serialising the batches in Node is a small part as well (about 1.4 s per 300,000 rows when measured on another machine). What remains is the database inside Docker on a small laptop CPU; CPU load during a run was not measured.
- The 1,000-system demo needs 1,000 rows/s, so one writer has 7x to 9x headroom. With 1,000 live systems, a 6-hour backfill of 21.6 million rows drains in about 50 to 60 minutes.
- The 10,000-system target needs 10,000 rows/s of live traffic, more than one connection can write. It needs parallel writers (one consumer per group of partitions); at about 15,000 rows/s the backfill spare capacity is 5,000 rows/s and the drain takes about 72 minutes.

## Still to measure

| Item | How |
|---|---|
| Why one connection stops at about 9,000 rows/s (CPU of the Docker VM, virtual disk, or Windows networking) | Task Manager and `docker stats` during a 1-million-row run; the same bench on a Linux machine |
| What limits the writer here (disk flush, CPU, or Docker) | bench with `BENCH_SYNC_OFF=1`, and `docker stats` during a run |
| Insert into an already compressed chunk (device back after 2 days) | bench with timestamps older than 1 day |
| Throughput with Kafka in front of the writer | Step 2e, then load report v1 |
| Compression ratio on noisier data | fault-injection data from the fleet simulator |