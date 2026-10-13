# Speicherlotse

![CI](https://github.com/MostafaQabbari/speicherlotse/actions/workflows/ci.yml/badge.svg)

A monitoring and energy-management cloud for home storage systems (PV, battery, wallbox), built as a portfolio project. Simulated homes send telemetry; the cloud ingests it, stores it, raises alarms and shows it.

**Status: in progress.** The path from a simulated home to the database works end to end and is tested, including database outages. Alarms are raised from the same stream and announced by a notifier (webhook), with crash and redelivery handling. A read-only API serves devices, telemetry and alarm events to several tenants, and the database itself keeps one tenant away from another's data. An Angular dashboard shows a tenant's devices, latest values, one channel over time and alarm events; it was driven in a real browser against the real API, but it has no automated browser tests yet. This README says which is which.

## What exists today

| Piece | What it does |
|---|---|
| `packages/telemetry-model` | The shared data contract: 16 channels with units and plausible ranges, the `Sample` type with three clocks, a power-balance check, a battery model, and a seeded simulator of one home (solar, house load, wallbox, self-consumption controller with backup reserve) |
| `packages/alarm-rules` | A pure alarm state machine (normal, pending, firing, clearing) driven by event time, plus a rule layer: rules are plain data (a threshold on one channel, or the spread between two). A missing or implausible reading leaves an alarm unchanged. Four default rules ship (battery temperature at two levels, grid frequency, cell imbalance) |
| `packages/wire` | The MQTT wire format: topics, versioned JSON envelope, encode and decode. Decoding never throws and rejects broken input with a reason |
| `services/publisher` | Simulated homes publishing telemetry to MQTT (QoS 1, batches of 5 samples) |
| `services/ingest` | Subscribes to MQTT, validates, writes to Kafka topic `telemetry.raw` (key = device id) and acknowledges the MQTT message only after Kafka confirmed the write |
| `packages/service-kit` | What the Kafka services share: a batching pipeline (commit only after the work is durable, retry of transient errors), the Kafka source, SQL migrations |
| `services/writer` | Kafka consumer group to TimescaleDB: batched, idempotent insert; offsets committed only after the rows are stored; waits out database outages with backoff |
| `services/alarms` | A second consumer group on `telemetry.raw`: runs the alarm rules per device and stores watermark, alarm state and alarm events in one transaction per batch, so a restart or a redelivery changes nothing (ADR-004) |
| `services/notifier` | Sends each alarm event to a webhook (or the console): a database trigger queues it, delivery is at least once with an idempotency key, retries with backoff, order kept within one alarm (ADR-005) |
| `services/api` | NestJS HTTP API, read-only: a tenant's devices, telemetry and alarm events. The queries never mention the tenant; row-level security and a tenant-checking function in the database do (ADR-006). Development tokens (JWT) carry the tenant. Browsers may call it only from origins listed in `CORS_ORIGINS`. It describes itself as OpenAPI 3.1 (`GET /openapi.json`, committed as `services/api/openapi.json`); tests fail if the description, the routes, the real responses or the page sizes disagree |
| `apps/dashboard` | Angular 22 page for one tenant: connect with a token (kept in memory), pick a device, latest values, a chart of one channel with a table alternative, alarm events. The API client is generated from `openapi.json`; the filters use Reactive Forms; accessibility is built in and scanned with axe in the tests (ADR-007) |
| Nx | Task runner and project graph over the pnpm workspace; caches the dashboard's typecheck, test and build. CI runs them through it |
| `docs/adr/` | Decision records: scope and numbers (001), storage schema (002), write path (003), alarm engine (004), notifier (005), API and tenant isolation (006), dashboard (007) |
| CI | Typecheck and all tests on every push, with a real PostgreSQL for the database tests; the dashboard is typechecked, tested and built too |

The API was tried by hand against the TimescaleDB hypertable too: each demo tenant saw only its own devices, a foreign device gave the same 404 as an unknown one, and the restricted database role could not read the telemetry table directly.

## Architecture

```mermaid
flowchart LR
  sim[Simulated homes] --> mqtt[MQTT broker]
  mqtt --> ingest[Ingest]
  ingest --> log[Kafka log]
  log --> writer[TSDB writer]
  writer --> db[(PostgreSQL + TimescaleDB)]
  log --> alarms[Alarm engine]
  alarms --> adb[(alarm_event + outbox)]
  adb --> notifier[Notifier]
  notifier --> hook[Webhook receiver]
  db --> api[API]
  adb --> api
  api --> ui[Dashboard]
```

All arrows exist. Delivery is at-least-once at every hop. The final insert is idempotent, so a redelivered message adds no rows (see [ADR-003](docs/adr/003-write-path.md)); the alarm engine skips samples it has already seen (a per-device watermark, [ADR-004](docs/adr/004-alarm-engine.md)); and every notification carries a stable id in an `Idempotency-Key` header so the receiver can drop duplicates ([ADR-005](docs/adr/005-notifier.md)). The API reads through a database role that row-level security restricts to one tenant per request ([ADR-006](docs/adr/006-api-and-tenant-isolation.md)). The dashboard talks to the API only ([ADR-007](docs/adr/007-dashboard-angular-nx.md)).

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
- **Queue in the same transaction.** An alarm event and its notification are written together by the database, so one cannot exist without the other.
- **Isolation in the database, not in the query.** The API's queries do not mention the tenant. The database decides what a request may see, so a forgotten `WHERE` cannot leak another customer's data.
- **One description of the API.** The OpenAPI file is checked against the routes and the real answers by tests, and the dashboard's client is generated from it, so the API and its caller cannot drift apart unnoticed.

## Run it

Needs Node 24 (see `.nvmrc`; the dashboard needs 24.15 or later), pnpm 12.9.1 and Docker. The services run as plain TypeScript. Only the API starts through [`tsx`](https://tsx.is), because NestJS needs decorators, which Node cannot run (ADR-006); `pnpm test` runs all tests through `tsx`.

```bash
nvm use
pnpm install
pnpm typecheck
pnpm test          # database tests are skipped unless TEST_DATABASE_URL is set
```

The database tests create and drop their own schema. To run them against the compose database (Windows PowerShell first, then bash):

```powershell
docker compose up -d
$env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres"
pnpm test
```

```bash
docker compose up -d
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

The dashboard is checked on its own, through Nx (it has its own TypeScript version, see `apps/dashboard/README.md`):

```bash
pnpm exec nx run-many -t typecheck test build -p @speicherlotse/dashboard --parallel=1
```

### Run the pipeline

The MQTT broker allows anonymous connections. This is for local development only.

```bash
docker compose up -d
docker compose exec redpanda rpk topic create telemetry.raw -p 6   # "already exists" is fine
pnpm --filter @speicherlotse/writer migrate                        # creates the table, hypertable and policies

pnpm --filter @speicherlotse/alarms migrate                        # alarm tables
pnpm --filter @speicherlotse/notifier migrate                      # notification outbox (run after the alarms migration)

# one terminal each:
pnpm --filter @speicherlotse/writer start      # Kafka -> TimescaleDB
pnpm --filter @speicherlotse/alarms start      # Kafka -> alarm tables
pnpm --filter @speicherlotse/notifier start    # outbox -> console, or a webhook if WEBHOOK_URL is set
pnpm --filter @speicherlotse/ingest start      # MQTT -> Kafka
pnpm --filter @speicherlotse/publisher start   # 3 simulated homes, 1 sample/s each (SYSTEMS, TICK_MS, SECONDS are environment variables)
```

To see an alarm, let one battery overheat for a while (simulated time runs five times faster here):

```powershell
$env:HOT_DEVICE = 2; $env:HOT_FROM_S = 20; $env:HOT_FOR_S = 90; $env:TICK_MS = 200; $env:SECONDS = 60
pnpm --filter @speicherlotse/publisher start
```

The alarm engine prints four `ALARM` lines (critical and high fired, then both resolved) and so does the notifier. To send them to a webhook instead, start a small receiver (`pnpm --filter @speicherlotse/notifier receiver`, `FAIL_FIRST=2` makes it refuse the first two requests so you can watch the retries) and start the notifier with `WEBHOOK_URL=http://localhost:8099/hook`.

### Run the API

Needs the writer and alarms migrations first (the API's migration adds rules to their tables). Windows PowerShell:

```powershell
pnpm --filter @speicherlotse/api migrate   # tenants, the restricted role, row-level security
pnpm --filter @speicherlotse/api seed      # two demo tenants: alpha owns devices 1 and 2, beta owns device 3

$env:JWT_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$env:CORS_ORIGINS = "http://localhost:4200"   # only needed for the dashboard; leave it out and no web page may call the API
pnpm --filter @speicherlotse/api start     # http://127.0.0.1:3000
```

In a second terminal, with the same secret (`$env:JWT_SECRET = "<the value from the first terminal>"`):

```powershell
$alpha = node services/api/src/token-cli.ts alpha
$beta  = node services/api/src/token-cli.ts beta
curl.exe -s -H "Authorization: Bearer $alpha" http://127.0.0.1:3000/v1/devices
curl.exe -s -H "Authorization: Bearer $alpha" "http://127.0.0.1:3000/v1/devices/1/telemetry?limit=3"
curl.exe -s -H "Authorization: Bearer $alpha" http://127.0.0.1:3000/v1/devices/3/telemetry     # beta's device: 404, like a device that does not exist
curl.exe -s -H "Authorization: Bearer $beta"  http://127.0.0.1:3000/v1/alarms/events
```

Routes: `GET /health`, `GET /openapi.json`, `GET /v1/devices`, `GET /v1/devices/:id/telemetry?from&to&limit`, `GET /v1/alarms/events?deviceId&from&to&limit` (ADR-006 has the rules for the parameters).

`CORS_ORIGINS` is a comma-separated list of exact origins (for example `http://localhost:4200`). There is no wildcard; if it is empty, no other web page may call the API. Only `GET` and the `Authorization` header are allowed. After changing a route or a response, regenerate the committed description with `pnpm --filter @speicherlotse/api openapi`; a test fails if it is out of date.

### Run the dashboard

With the services and the API running as above (the API started with `CORS_ORIGINS` set), Windows PowerShell:

```powershell
# a token: same JWT_SECRET as the API window
$env:JWT_SECRET = "<the value from the API window>"
node services/api/src/token-cli.ts alpha        # prints the token; copy it

# the dashboard, in a third window
cd apps/dashboard
pnpm start                                      # http://localhost:4200
```

Open <http://localhost:4200> (not `127.0.0.1:4200`: that is another origin and the API refuses it), paste the token, press Connect. Alpha shows devices 1 and 2; a token for `beta` shows device 3. More in `apps/dashboard/README.md`.

Stop with Ctrl+C in each terminal (the services first, so they finish what they hold), then `docker compose stop`. `docker compose down -v` also deletes the stored data.

```bash
docker compose exec timescaledb psql -U postgres -d speicherlotse -c "select device_id, count(*) from telemetry group by 1;"
docker compose exec timescaledb psql -U postgres -d speicherlotse -c "select device_id, rule_id, event, at from alarm_event order by at_ms;"
docker compose exec timescaledb psql -U postgres -d speicherlotse -c "select rule_id, event, attempts, sent_at, last_error from notification_outbox order by at_ms;"
```

## Repository layout

```
packages/
  telemetry-model/   channels, Sample, balance check, battery and home simulator
  alarm-rules/       alarm state machine and rule layer
  wire/              MQTT topics and message format
  service-kit/       batching pipeline, retry, Kafka source and SQL migrations shared by the Kafka services
services/
  publisher/         simulated homes -> MQTT
  ingest/            MQTT -> Kafka
  writer/            Kafka -> TimescaleDB (SQL migrations in sql/)
  alarms/            Kafka -> alarm rules -> alarm tables (SQL migrations in sql/)
  notifier/          alarm events -> webhook, with retries (SQL migrations in sql/; dev-receiver.ts for trying it)
  api/               NestJS HTTP API with tenant isolation by row-level security (SQL migrations in sql/; openapi.json is its description)
apps/
  dashboard/         Angular page; its API client is generated from services/api/openapi.json
infra/mosquitto/     broker configuration for local development
docs/adr/            architecture decision records
nx.json              Nx: caching of the dashboard's targets
```

## Roadmap

- [x] Scope, numbers and decision record
- [x] Shared telemetry model and one-home simulator
- [x] Alarm state machine and rule layer
- [x] CI
- [x] Walking skeleton: simulator, MQTT, ingest, Redpanda, writer, TimescaleDB, with outage tests
- [x] Alarm engine as a second Kafka consumer with persistent state
- [x] Notifier: outbox, webhook, retries, order within an alarm
- [ ] Fault-to-alarm report (needs the fleet simulator)
- [ ] Fleet simulator (up to 1,000 systems) with fault injection (dropouts, glitches, clock jumps, reboots)
- [ ] Load report v1 (rows/s through the whole chain, freshness, memory)
- [x] NestJS API with multi-tenant row-level security (read-only, development tokens)
- [x] CORS allow-list and a checked OpenAPI description of the API
- [x] Angular dashboard (read-only), client generated from the API description, Nx as task runner
- [ ] Storybook and automated browser tests for the dashboard
- [ ] Chaos and load report v2 (backfill storm, kill tests, scale-out)

## Known limits

- A device whose clock is unset (1970) has its samples rejected by the writer. A later change can fall back to the time the message was received.
- A message the writer cannot store for a non-transient reason stops the writer (it exits rather than skip data). A dead-letter topic for such messages is planned.
- Only the insert speed was measured; end-to-end throughput was not. The cost of the alarm engine's writes and the notification latency were not measured either.
- Alarm engine and notifier each run as a single instance. If a device's clock jumps backwards, its alarms are silent until the clock catches up (ADR-004).
- Notifications are delivered at least once: a crash at the wrong moment sends one twice, so the receiver has to drop duplicates by id. A notification that keeps failing is abandoned after 8 attempts and stays in the table for a person to look at; nothing replays it automatically (ADR-005).
- Only a webhook and the console exist as notification channels. Old notifications are never deleted.
- The API protects against mistakes in queries, not against someone who can run arbitrary SQL as its database role: the tenant is a session setting (ADR-006). Tokens are development tokens: one shared secret, no users, no revocation. There is no rate limit and no TLS yet, CORS is off unless `CORS_ORIGINS` is set, and lists have no paging cursor.
- The API's telemetry function was tried by hand on an uncompressed TimescaleDB hypertable. Compressed chunks, and the API under load, are not tested yet.
- The dashboard only reads, takes a pasted development token, shows the newest rows (no paging) and does not refresh by itself. It was driven by hand in Chromium (keyboard use, a wrong token, a foreign origin, phone width) against the API on a PostgreSQL without TimescaleDB; there are no automated browser tests yet.
- Angular needs TypeScript 6.0, the rest of the repository uses TypeScript 7, so `apps/dashboard` carries its own version (ADR-007).

## Data sources (planned)

Real German open data will seed the simulator: the Marktstammdatenregister (installed PV and storage), HTW Berlin household load profiles, DWD weather via Bright Sky, and day-ahead prices from Energy-Charts.

## Licence

MIT, see `LICENSE`.
