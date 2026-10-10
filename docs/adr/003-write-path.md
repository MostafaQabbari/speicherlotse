# ADR-003: From Kafka to the database

- Status: accepted. Verified with a fake message source against a real PostgreSQL (including a database crash and restart), and by hand end to end against Redpanda and TimescaleDB, including stopping and starting the database while the writer runs.
- Date: 2026-10-10

## Context

ADR-001 puts a replayable log between ingest and storage, and ADR-002 fixes the table. This ADR fixes how the writer moves messages from `telemetry.raw` into the table without losing or doubling data when something fails.

## Decision

### 1. At-least-once everywhere, idempotent at the end

| Hop | Guarantee | What makes it safe |
|---|---|---|
| device to broker | MQTT QoS 1: delivered at least once | the device keeps the sample until the broker confirms |
| broker to ingest | the broker keeps a message until ingest confirms | ingest confirms only after the Kafka write |
| ingest to log | Kafka `acks = all` | |
| log to database | the writer commits its Kafka offset only after the insert | a crash in between means the batch is read again |
| database | `primary key (device_id, ts, boot_id, seq)` + `on conflict do nothing` | a batch that is read again adds no rows |

Every hop may repeat a message but none may drop one, and the last step removes the repeats. The stored result is exactly one row per sample.

### 2. The writer

- Offsets are committed manually (`autocommit: false`), after the insert, as the highest offset of each partition in the batch.
- Batches are written one at a time, in order. A later commit can never overtake an earlier batch.
- A batch is 200 messages (about 1,000 rows, ADR-001) or whatever has arrived after 1 second, so live data waits at most about a second.
- A group that has never committed starts at the beginning of the topic (`fallbackMode: earliest`). The client library's default is "latest", which would skip everything already in the log when the writer first starts.
- More throughput: start more writer processes with the same group id. Kafka divides the 6 partitions among them. One partition is always handled by one writer, so per-device order is kept.

### 3. Failure policy

| Situation | What the writer does |
|---|---|
| Database unreachable, restarting, deadlock (connection errors, SQLSTATE classes 08, 40, 53, 57, 58) | wait and retry forever, backoff 0.5 s doubling to 30 s with jitter; the Kafka stream is held back meanwhile (backpressure) and nothing is committed |
| Any other database error (bad data, missing table, syntax) | stop with exit code 1; nothing is committed, so a restart continues from the last commit. Retrying would never help and skipping would lose data silently |
| Message that cannot be decoded | skip it, count it, log the reason. Ingest has already validated everything on `telemetry.raw`, so this should not happen; retrying the same bytes would block the partition for good |
| Sample or value that cannot be stored (ADR-002 section 4) | NULL or counted rejection, the rest of the batch goes in |
| Commit to Kafka fails | log and continue. The rows are stored; at worst the batch is read again and the key discards the duplicates |
| Shutdown (Ctrl+C) | write the buffer, commit, then close. A second Ctrl+C stops waiting for a database that is down |

After an unrecoverable failure the pipeline refuses all further messages. If it kept running, committing a later offset would skip the batch that failed.

### 4. The guarantee depends on the database being durable

"Commit after insert" means nothing if the database forgets an acknowledged commit. Test with a hard crash of PostgreSQL in the middle of a run: with `fsync = off`, 190 of 200 rows survived (10 acknowledged rows lost); with default settings, 200 of 200. The writer's database must keep `fsync` and `synchronous_commit` on. The `BENCH_SYNC_OFF` switch of the benchmark is for measuring only.

## Consequences and known gaps

- A batch that fails with a non-transient error stops the writer until a human fixes the cause (a poison batch causes a restart loop). A later improvement is to split the batch, store what works, and send the offending message to a `telemetry.deadletter` topic.
- The topic name `telemetry.raw` is written in both ingest and writer. It should move to the `wire` package.
- Not yet covered: a rebalance while a batch is being written (duplicates are harmless, but the behaviour is not tested), and the throughput of the whole chain (load report v1).