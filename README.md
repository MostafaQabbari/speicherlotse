# Speicherlotse

![CI](https://github.com/MostafaQabbari/speicherlotse/actions/workflows/ci.yml/badge.svg)

A monitoring and energy-management cloud for home storage systems (PV, battery, wallbox), built as a portfolio project. Simulated homes send telemetry; the cloud ingests it, stores it, raises alarms and shows it live.

**Status: in progress.** The path from a simulated home to the database works end to end and is tested, including database outages. The alarm engine, API and dashboard are planned and not built yet. This README says which is which.

## What exists today

| Piece | What it does |
|---|---|
| `packages/telemetry-model` | The shared data contract: 16 channels with units and plausible ranges, the `Sample` type with three clocks, a power-balance check, a battery model, and a seeded simulator of one home (solar, house load, wallbox, self-consumption controller with backup reserve) |
| `packages/alarm-rules` | A pure alarm state machine (normal, pending, firing, clearing) driven by event time, plus a rule layer: rules are plain data (a threshold on one channel, or the spread between two). A missing or implausible reading leaves an alarm unchanged. Four default rules ship (battery temperature at two levels, grid frequency, cell imbalance) |
| `packages/wire` | The MQTT wire format: topics, versioned JSON envelope, encode and decode. Decoding never throws and rejects broken input with a reason |
| `services/publisher` | Simulated homes publishing telemetry to MQTT (QoS 1, batches of 5 samples) |
| `services/ingest` | Subscribes to MQTT, validates, writes to Kafka topic `telemetry.raw` (key = device id) and acknowledges the MQTT message only after Kafka confirmed the write |
| `services/writer` | Kafka consumer group to TimescaleDB: batched, idempotent insert; offsets committed only after the rows are stored; waits out database outages with backoff |
| `docs/adr/` | Decision records: scope and numbers (001), storage schema (002), write path (003) |
| CI | Typecheck and all tests on every push, with a real PostgreSQL for the writer's database tests |

Packages contain no I/O and are covered by example tests and property-based tests (random inputs checked against rules such as "a battery never creates energy" and "alarms strictly alternate between fired and resolved"). The services are covered by tests with fake brokers, plus database tests against a real PostgreSQL. The Kafka adapter and the outage behaviour were also tried by hand against Redpanda and TimescaleDB (stop and start the database while the writer runs; no sample lost or doubled).

## Architecture

```mermaid
flowchart LR
  sim[Simulated homes] --> mqtt[MQTT broker]
  mqtt --> ingest[Ingest]
  ingest --> log[Kafka log]
  log --> writer[TSDB writer]
  writer --> db[(PostgreSQL + TimescaleDB)]
  log -.-> alarms[Alarm engine]
  alarms -.-> notifier[Notifier]
  db -.-> api[API]
  api -.-> ui[Dashboard]
```

Solid arrows exist. Dotted arrows are planned. Delivery is at-least-once at every hop and the final insert is idempotent, so a redelivered message adds no rows (see [ADR-003](docs/adr/003-write-path.md)).

## Design targets and measurements

From [ADR-001](docs/adr/001-scope-and-numbers.md), revised with measurements in [ADR-002](docs/adr/002-storage-schema.md).

| Quantity | 1,000 systems (demo) | 10,000 systems (design target) |
|---|---|---|
| Rows per day (1 sample/s each) | 86.4 million | 864 million |
| Raw size per day (measured 222 B/row incl. index) | 19 GB | 190 GB |
| MQTT messages per second (5 s batches) | 200 | 2,000 |
| Rows per second the writer must sustain | 1,000 | 10,000 |

Measured on one development laptop (Intel i5-6300U, 2 cores, 16 GB, Docker Desktop, TimescaleDB 2.29.2 on PostgreSQL 18, default durability):

- Compression: 1 million rows went from 213 MiB to 18 MiB (about 12x) on smooth simulated data. Real telemetry may compress worse.
- Writer: one database connection stores 7,000 to 9,000 rows/s, four connections about 15,000 rows/s. That is 7x to 9x headroom for the 1,000-system demo; the 10,000-system target needs several writers. These numbers are the database insert alone, measured by a benchmark; the full chain through MQTT and Kafka has not been load-tested yet.
- Backfill storm: 1,000 devices reconnecting after 6 hours offline upload 21.6 million rows. With one connection that drains in roughly 50 to 60 minutes next to live traffic. This is calculated from the insert speed, not yet measured end to end.

## Design principles

- **Pure core, thin shell.** Packages contain no I/O and are tested without any infrastructure. Services only wire them to MQTT, Kafka and Postgres.
- **Event time, never the wall clock.** Replaying stored data must give the same alarms.
- **Determinism.** The simulator takes a seed, so any run can be reproduced exactly.
- **Illegal states unrepresentable.** Discriminated unions and exhaustive `switch` make the compiler reject unhandled cases.
- **Acknowledge only what is stored.** A message is confirmed to its sender only after the next hop has it durably.

## Run it

Needs Node 24 (see `.nvmrc`), pnpm 12.9.1 and Docker.

```bash
nvm use
pnpm install
pnpm typecheck
pnpm test          # database tests are skipped unless TEST_DATABASE_URL is set
```

The database tests create and drop their own schema. To run them against the compose database:

```bash
docker compose up -d
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

### Run the pipeline

The MQTT broker allows anonymous connections. This is for local development only.

```bash
docker compose up -d
docker compose exec redpanda rpk topic create telemetry.raw -p 6   # "already exists" is fine
pnpm --filter @speicherlotse/writer migrate                        # creates the table, hypertable and policies

# one terminal each:
pnpm --filter @speicherlotse/writer start      # Kafka -> TimescaleDB
pnpm --filter @speicherlotse/ingest start      # MQTT -> Kafka
pnpm --filter @speicherlotse/publisher start   # 3 simulated homes, 1 sample/s each (SYSTEMS, TICK_MS, SECONDS are environment variables)
```

Stop with Ctrl+C in each terminal (writer first, so it commits what it has), then `docker compose stop`. `docker compose down -v` also deletes the stored data.

```bash
docker compose exec timescaledb psql -U postgres -d speicherlotse -c "select device_id, count(*) from telemetry group by 1;"
```

## Repository layout

```
packages/
  telemetry-model/   channels, Sample, balance check, battery and home simulator
  alarm-rules/       alarm state machine and rule layer
  wire/              MQTT topics and message format
services/
  publisher/         simulated homes -> MQTT
  ingest/            MQTT -> Kafka
  writer/            Kafka -> TimescaleDB (SQL migrations in sql/)
infra/mosquitto/     broker configuration for local development
docs/adr/            architecture decision records
```

## Roadmap

- [x] Scope, numbers and decision record
- [x] Shared telemetry model and one-home simulator
- [x] Alarm state machine and rule layer
- [x] CI
- [x] Walking skeleton: simulator, MQTT, ingest, Redpanda, writer, TimescaleDB, with outage tests
- [ ] Alarm engine as a second Kafka consumer, notifier, fault-to-alarm report
- [ ] Fleet simulator (up to 1,000 systems) with fault injection (dropouts, glitches, clock jumps, reboots)
- [ ] Load report v1 (rows/s through the whole chain, freshness, memory)
- [ ] NestJS API with multi-tenant row-level security, React dashboard
- [ ] Chaos and load report v2 (backfill storm, kill tests, scale-out)

## Known limits

- A device whose clock is unset (1970) has its samples rejected by the writer. A later change can fall back to the time the message was received.
- A message the writer cannot store for a non-transient reason stops the writer (it exits rather than skip data). A dead-letter topic for such messages is planned.
- Only the insert speed was measured; end-to-end throughput was not.

## Data sources (planned)

Real German open data will seed the simulator: the Marktstammdatenregister (installed PV and storage), HTW Berlin household load profiles, DWD weather via Bright Sky, and day-ahead prices from Energy-Charts.

## Licence

MIT, see `LICENSE`.