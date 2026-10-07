# ADR-001: Scope and numbers

- Status: accepted
- Date: 2026-10-07

## Context

Speicherlotse is a monitoring and energy-management cloud for home storage systems (PV, battery, wallbox). It is a portfolio project built part-time by one person, which sets two hard limits: the core build has to fit in roughly 120 to 130 hours, and the demo has to run on one laptop.

At the same time, the design should be honest about real-product scale. The interesting engineering problems (ingest rate, storage growth, burst handling) only appear at scale, and a design that only works for ten simulated systems proves nothing.

Before choosing technology we need numbers: how much data arrives, how much we store, and how bad a burst can get. Every later decision (batching, a log between ingest and storage, compression, retention) is justified or rejected against the numbers in this document.

## Decision

### 1. Two fleet sizes

- Design target: 10,000 systems. The architecture must reach this by adding instances, not by redesign.
- Demo target: 1,000 systems. This is what actually runs on a laptop and what the load report measures. The 10,000 case is extrapolated from measured per-instance throughput (a scale-out curve), not claimed from a single run.

### 2. Data shape (assumptions)

- Each system reports 1 sample per second. This is a typical control cycle for home energy management systems, and it matches the 1-second load profiles we seed the simulator from.
- A sample has about 30 channels: power flows, state of charge, temperatures, cell voltages, grid frequency, status.
- Storage format: one wide row per system per second, about 150 bytes. Estimate: 8-byte timestamp + 4-byte device id + 30 channels x 4 bytes = 132 bytes, plus about 24 bytes of row overhead.
- Each device sends one batch of 5 samples every 5 seconds, so one MQTT message is about 5 x 150 = 750 bytes. This treats wire size as equal to row size, which is conservative because a Protobuf payload will probably be smaller.

### 3. Steady-state numbers

| Quantity | Formula | 1,000 systems | 10,000 systems |
|---|---|---|---|
| Samples per second (= rows per second) | systems x 1 | 1,000 | 10,000 |
| MQTT messages per second | systems / 5 s | 200 | 2,000 |
| Ingress data rate | rows per second x 150 B | 150 KB/s | 1.5 MB/s |
| Rows per day | rows per second x 86,400 | 86.4 million | 864 million |
| Raw size per day | rows per day x 150 B | 13.0 GB | 129.6 GB |
| Compressed size per day (10x to 20x) | raw / 20 to raw / 10 | 0.65 to 1.3 GB | 6.5 to 13 GB |
| 1-minute aggregate rows per day | systems x 1,440 | 1.44 million | 14.4 million |

The 1-minute aggregate has 60 times fewer rows than the raw data (86,400 seconds / 1,440 minutes), which is why dashboards read aggregates and not raw rows.

### 4. Backfill storm

Scenario: 1,000 devices lose their connection for 6 hours, reconnect, and upload everything they buffered, while the other 9,000 systems keep sending live data.

| Quantity | Formula | Result |
|---|---|---|
| Backlog rows | 1,000 devices x 6 h x 3,600 s/h | 21.6 million |
| Backlog size | 21.6 million x 150 B | 3.24 GB |
| Live load during the drain | 10,000 systems x 1 row/s | 10,000 rows/s |
| Writer capacity (assumption) | one measured value, see section 8 | 50,000 rows/s |
| Spare capacity | 50,000 - 10,000 | 40,000 rows/s |
| Drain time | 21.6 million / 40,000 | 540 s = 9 minutes |

Sensitivity: the drain time depends entirely on the spare capacity, which is why writer throughput must be measured and not guessed.

| Writer capacity | Spare capacity | Drain time |
|---|---|---|
| 50,000 rows/s | 40,000 rows/s | 9 minutes |
| 15,000 rows/s | 5,000 rows/s | 72 minutes |
| 10,000 rows/s or less | 0 | never drains |

### 5. Retention

- Raw 1 Hz rows: kept for 14 days, compressed after 1 day.
- 1-minute aggregates: kept for 90 days.
- 15-minute and 1-hour aggregates: kept without limit. At 1,000 systems the hourly aggregate adds 1,000 x 24 = 24,000 rows per day, which is negligible.
- Laptop disk estimate for the demo fleet: day 1 uncompressed (13 GB) plus 13 days compressed (13 x 0.65 to 13 x 1.3 = 8.4 to 16.8 GB) is about 21 to 30 GB.

### 6. Scope

In scope (core, about 120 to 130 hours, which is 6 to 8 weeks at 15 to 20 hours per week):

- fleet simulator for up to 1,000 systems
- MQTT broker, ingest service, Kafka-compatible log (Redpanda), TSDB writer
- PostgreSQL with TimescaleDB, with continuous aggregates
- NestJS API with multi-tenant row-level security and an OpenAPI description
- React dashboard
- alarm engine and notifier
- load and chaos report (backfill storm, kill tests, scale-out curve)

Out of scope for now:

- the Rust OCPP gateway (LadeLotse), which is a separate project
- the Raspberry Pi edge agent
- MongoDB device twins
- Kubernetes
- real hardware
- the home-charging reimbursement module
- the Python optimizer (stretch goal)

If time runs short, cut in this order: Rust track, Raspberry Pi, MongoDB, Kubernetes. These are never cut: the pipeline, the API with row-level security, the dashboard, the alarms, the load report.

## Alternatives considered

Narrow rows (one row per channel per sample) instead of wide rows: 10,000 systems x 30 channels x 86,400 s = 25.9 billion rows per day. At about 42 bytes per row (8 timestamp + 4 device id + 2 channel id + 4 value + 24 overhead) that is about 1.1 TB per day, roughly 8 times the storage of wide rows and 30 times the row count. Rejected. The cost of wide rows is a schema change when a new channel appears, which is acceptable because the channel list is versioned in the telemetry model.

10-second sampling instead of 1-second: 10 times less data everywhere. Rejected as the default because the alarm-latency and live-view stories need 1-second data and our seed profiles are 1-second. The interval stays a configuration value, so a cheaper profile can be tested.

## Consequences

- Batching is mandatory. At 10,000 rows per second, one insert per row is wasteful. The writer inserts batches of at least 1,000 rows, which is about 10 batches per second at steady state.
- Compression and retention are mandatory. At 130 GB per day raw, nothing can be kept uncompressed for long.
- Bursts need a buffer. A 21.6 million row backlog arriving on top of live traffic must be absorbed by a replayable log and drained at a controlled rate. Devices rate-limit their backfill uploads, and live rows take priority over backfill rows.
- Writer throughput becomes the key measured quantity, because it decides drain time and how many writer instances the design target needs.
- Later ADRs follow from these numbers: the log between ingest and storage, the wide-row schema, backpressure at every hop.

## Assumptions to verify

| Assumption | Value used | How to measure | When |
|---|---|---|---|
| Row size | 150 B | insert 1 million rows, divide the table size (`pg_total_relation_size`) by the row count | week 3 |
| Message size on the wire | 750 B | log the size of real Protobuf messages from the simulator | week 3 |
| Compression ratio | 10x to 20x | enable TimescaleDB compression on a day of data and compare sizes | week 4 |
| Writer throughput | 50,000 rows/s | load-test a single writer instance against the real schema | week 4 (load report v1) |

This ADR gets a revision note after load report v1, listing which assumptions held and which numbers changed.
