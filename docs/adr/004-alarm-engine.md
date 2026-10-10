# ADR-004: Alarm engine

- Status: accepted. Verified with fake messages against a real PostgreSQL (restart, redelivery, failed transaction); *to verify:* end to end against Redpanda and TimescaleDB, alarm latency, behaviour at 1,000 devices.
- Date: 2026-10-10

## Context

The alarm rules (`packages/alarm-rules`) are pure functions: `evaluate(state, sample, rules)` returns the new alarm state and the events. This ADR fixes how they run on the live stream: where the state lives, what happens after a crash or a redelivery, and where the events go.

## Decision

### 1. A second consumer of `telemetry.raw`

The alarm engine reads the same topic as the writer, in its **own consumer group** (`speicherlotse-alarms`). Each group has its own offsets, so the alarm engine can be slow, stopped or replayed without touching the writer. This is the reason Kafka sits in the middle instead of the writer feeding the alarm engine.

### 2. Three tables, one transaction per batch

| Table | Content | Size |
|---|---|---|
| `alarm_device` | per device: `last_wall_ms`, the newest sample time processed (the watermark) | one row per device |
| `alarm_state` | per device and rule: the state if it is not normal (pending, firing, clearing) | only active alarms |
| `alarm_event` | every `fired` and `resolved`, with the rule, severity and event time | grows with alarms, not with samples |

A batch is processed in memory first (`run`, a pure function), then watermark, states and events are written in **one transaction**, and only then is the Kafka offset committed. After a crash the three tables are either all new or all old, never mixed.

### 3. Redelivery is harmless because of the watermark

Delivery is at-least-once, so after a crash the same messages arrive again. A repeated sample would not break the state machine in most cases, but an OLD sample can: a cool reading from 5 minutes ago would push a firing alarm into "clearing". Rule: **a sample whose event time is not newer than the device's watermark is skipped and counted.** The property test replays random streams with random rewinds and requires exactly the same events as a single pass; with the watermark removed, that test fails.

### 4. State after a restart

The engine keeps the records of all devices it has seen in memory. A device it has not seen since starting is read from the two tables first. So after a restart a pending alarm still fires at the right time (a test starts a second engine halfway through the 10 seconds).

### 5. What the engine refuses to remember

A sample is ignored (and counted) when its device clock is outside 2000..2100 (the same check the writer uses, from the `wire` package) or its device id does not fit an `integer` column. Otherwise one device with an unset clock could move its watermark to the year 2090 and be silent until then. Fractional milliseconds are rounded once, so the watermark, the rules and the events use the same whole number.

### 6. Events go to a table

`alarm_event` is the interface to everything that comes later: the notifier, the API and the dashboard read it. Writing it in the same transaction as the state means that an event can neither be lost nor invented. The engine also prints one `ALARM ...` line per event to the console. A Kafka topic of alarm events, for other consumers, can be added later by reading this table.

## Consequences and limits

- **One instance.** Two engines in the same group during a rebalance could write the same device's rows at the same time. For now exactly one process runs. Scaling out needs the state to follow partition ownership (one device always belongs to one partition).
- **The watermark assumes device time moves forward.** A device whose clock jumps backwards (a wrong clock corrected by time sync) has its samples ignored by the alarm engine until its clock passes the old watermark, by up to the size of the jump. The writer still stores the data. Fault injection (clock jumps) will test this and decide whether a new `boot_id` should reset the watermark.
- **Event time is the device clock.** A device whose clock is wrong but plausible produces alarms with wrong times.
- **Rules are code** (`DEFAULT_RULES`). Changing a threshold needs a restart. Rules as stored data are a later step. State of a rule that was removed stays in the table and is ignored.
- **Write cost.** Every batch updates one `alarm_device` row per device in it (`fillfactor 70` leaves room for in-place updates). With 1,000 devices and 1 sample per second that is about 1,000 row updates per second; not measured yet.
- **Memory** is a few dozen bytes per device (estimated, not measured).
- **No notifier yet.** Nobody is told except the console.

## Still to measure

| Item | How |
|---|---|
| Time from the sample to the `fired` row (alarm latency) | publisher with a hot battery; compare event time with `now()` at insert |
| Cost of the watermark updates at 1,000 devices | fleet simulator, `pg_stat_user_tables` for `alarm_device` |
| Memory per device | heap snapshot with 10,000 simulated devices |
| Behaviour with clock jumps and reboots | fault injection in the fleet simulator |