# Speicherlotse

![CI](https://github.com/MostafaQabbari/speicherlotse/actions/workflows/ci.yml/badge.svg)

A monitoring and energy-management cloud for home storage systems (PV, battery, wallbox), built as a portfolio project. Simulated homes send telemetry; the cloud ingests it, stores it, raises alarms and shows it live.

**Status: in progress.** The foundations exist and are tested. The data pipeline, API and dashboard are planned and not built yet. This README says which is which.

## What exists today

| Piece | What it does |
|---|---|
| `packages/telemetry-model` | The shared data contract: 16 channels with units and plausible ranges, the `Sample` type with three clocks, a power-balance check, a battery model, and a seeded simulator of one home (solar, house load, wallbox, self-consumption controller with backup reserve) |
| `packages/alarm-rules` | A pure alarm state machine (normal, pending, firing, clearing) that ignores short blips and absorbs flapping, driven by event time , plus a rule layer: rules are plain data (a threshold on one channel, or the spread between two), and evaluate turns a sample into alarm events. A missing or implausible reading leaves an alarm unchanged. Four default rules ship (battery temperature at two levels, grid frequency, cell imbalance)|
| `docs/adr/001-scope-and-numbers.md` | The scope and the capacity numbers the design is built on |
| CI | Typecheck and tests on every push |

Everything above is pure code with no I/O, covered by example tests and property-based tests (random inputs checked against rules such as "a battery never creates energy" and "alarms strictly alternate between fired and resolved").

## Planned architecture

```mermaid
flowchart LR
  sim[Simulated homes] --> mqtt[MQTT broker]
  mqtt --> ingest[Ingest]
  ingest --> log[Kafka log]
  log --> writer[TSDB writer]
  writer --> db[(PostgreSQL + TimescaleDB)]
  log --> alarms[Alarm engine]
  alarms --> notifier[Notifier]
  db --> api[API]
  api --> ui[Dashboard]
```

Of this, only the home model (the simulator's core) and the alarm rules exist so far.

## Design targets

From [ADR-001](docs/adr/001-scope-and-numbers.md). Row size, compression and writer speed are assumptions that will be measured and revised.

| Quantity | 1,000 systems (demo) | 10,000 systems (design target) |
|---|---|---|
| Rows per day (1 sample/s each) | 86.4 million | 864 million |
| Raw size per day (about 150 B/row) | 13 GB | 130 GB |
| MQTT messages per second (5 s batches) | 200 | 2,000 |

Backfill storm: 1,000 devices reconnecting after 6 hours offline upload 21.6 million rows. If a writer sustains 50,000 rows/s, the backlog drains in about 9 minutes next to live traffic. At 15,000 rows/s it takes 72 minutes, so writer throughput is the first number to measure.

## Design principles

- **Pure core, thin shell.** Packages contain no I/O and are tested without any infrastructure. Services will only wire them to MQTT, Kafka and Postgres.
- **Event time, never the wall clock.** Replaying stored data must give the same alarms.
- **Determinism.** The simulator takes a seed, so any run can be reproduced exactly.
- **Illegal states unrepresentable.** Discriminated unions and exhaustive `switch` make the compiler reject unhandled cases.

## Run it

Needs Node 24 (see `.nvmrc`) and pnpm 12.9.1.

```bash
nvm use
pnpm install
pnpm test
pnpm typecheck
node packages/telemetry-model/examples/day.ts   # hourly summary of one simulated day
```

## Repository layout

```
packages/
  telemetry-model/   channels, Sample, balance check, battery and home simulator
  alarm-rules/       alarm state machine
docs/adr/            architecture decision records
```

## Roadmap

- [x] Scope, numbers and decision record
- [x] Shared telemetry model and one-home simulator
- [x] Alarm state machine
- [x] CI
- [x] Rule layer: "battery above 55 °C for 60 s" evaluated on samples
- [ ] Fleet simulator and walking skeleton: MQTT, ingest, Redpanda, writer, TimescaleDB
- [ ] Load report v1 (rows/s per writer, freshness, memory)
- [ ] NestJS API with multi-tenant row-level security, React dashboard
- [ ] Alarm engine and notifier, fault-to-alarm report
- [ ] Chaos and load report v2 (backfill storm, kill tests, scale-out)

## Data sources (planned)

Real German open data will seed the simulator: the Marktstammdatenregister (installed PV and storage), HTW Berlin household load profiles, DWD weather via Bright Sky, and day-ahead prices from Energy-Charts.

## Licence

MIT, see `LICENSE`.
