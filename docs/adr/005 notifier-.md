# ADR-005: Notifier

- Status: accepted. Verified with tests against a real PostgreSQL (the trigger, retries, giving up, ordering, a crash between "sent" and "marked") and a fake receiver; *to verify:* a real alerting service, behaviour with many alarms at once.
- Date: 2026-10-10

## Context

The alarm engine (ADR-004) writes every `fired` and `resolved` to the table `alarm_event`. Nobody is told yet. The notifier has to turn each event into a message to the outside world, **at least once and in a sensible order**, while the receiver (a webhook) may be slow, down or refusing messages. The sending must not slow the alarm engine down or be able to lose or invent an event.

## Decision

### 1. An outbox, filled by the database

A new table `notification_outbox` has one row per alarm event, with its state: `attempts`, `next_attempt_at`, `sent_at`, `gave_up_at`, `last_error`. A **trigger on `alarm_event`** inserts the row. It runs inside the transaction that writes the event, so:

- an event is queued if and only if it was stored (a rolled-back batch queues nothing; a repeated event, skipped by `ON CONFLICT DO NOTHING`, queues nothing);
- the alarm engine does not know the notifier exists, and its code and tests did not change.

The notifier only reads this table and updates its rows. A partial index covers only the unfinished rows, so reading stays fast however many were sent.

Alternatives that were rejected:

| Alternative | Why not |
|---|---|
| The notifier polls `alarm_event` and remembers the last event it saw | Transactions commit out of order, so a late-committing older event can be skipped for good |
| The alarm engine writes the outbox row itself | Same guarantee, but it couples the engine to the notifier and changes working code. The trigger can be replaced by this later without changing the notifier |
| A Kafka topic of alarm events | Fits other consumers later; needs a second write that can fail separately from the database transaction |

### 2. At-least-once delivery, with an idempotency key

A notification is marked as sent only **after** the receiver accepted it. If the program crashes in between, the notification is sent again after the restart. A receiver cannot be told "exactly once" across a network, so every attempt carries the same id (`deviceId:ruleId:atMs:event`, the key of `alarm_event`) in the JSON body and in the `Idempotency-Key` header. A receiver that remembers the ids it has seen can drop the duplicate. A test crashes the notifier between the two steps and checks that the second attempt carries the same id; `services/notifier/src/dev-receiver.ts` shows the receiving side.

### 3. Retries, and when to give up

- A failure that may pass (no connection, timeout, HTTP 5xx, 408, 425, 429) is retried with exponential waiting: 2 s, 4 s, 8 s ... capped at 5 minutes, spread over 50..100 % so that notifications that failed together do not return together.
- A refusal of the message itself (other 4xx, a redirect) is **permanent**: it is not retried.
- After `MAX_ATTEMPTS` (default 8) failed attempts the notification is abandoned.
- An abandoned notification stays in the table with its last error and a line is logged. Nothing replays it automatically; a person looks at the cause and re-queues it (see Consequences).

### 4. Order within one alarm

A notification waits while an **earlier** one of the same alarm (same device and rule) is still unfinished. So a receiver never gets "resolved" before "fired" of the same alarm, even when the first delivery failed and had to be retried. Different alarms do not wait for each other: a refusing receiver for one rule does not hold back the others. If the earlier notification is abandoned, the later one is released.

### 5. Senders

A `Sender` takes one message and either returns or throws a `SendError` that says whether waiting can help. Two exist: `log` (prints; the default without `WEBHOOK_URL`) and `webhook` (JSON POST, 5 s timeout, redirects not followed). More channels (email, chat) are new `Sender`s; the rest of the notifier does not change.

## Consequences and limits

- **Duplicates are possible** (crash between "accepted" and "marked"). The receiver must deduplicate by id.
- **Order across alarms is not kept**, and order within an alarm is lost if the earlier notification was abandoned: a receiver can then see "resolved" without "fired".
- **One instance.** Two notifiers would both send the same row. That is allowed by at-least-once but wasteful. Scaling out needs `SELECT ... FOR UPDATE SKIP LOCKED`.
- **The outbox is filled whether or not a notifier runs.** A notifier started after a long stop sends everything that waited, including a `fired` for an alarm that has long since resolved. Receivers should look at the event time (`at`).
- **Rows are never deleted.** Sent and abandoned rows stay (a few dozen bytes each). A cleanup of old rows is a later task.
- **Replaying an abandoned notification is manual:**
  ```sql
  update notification_outbox set gave_up_at = null, attempts = 0, next_attempt_at = '-infinity'
  where device_id = 2 and rule_id = 'battery-temp-high' and event = 'fired' and gave_up_at is not null;
  ```
- **No grouping or rate limit.** An alarm storm sends one message per event.
- **Clocks.** The retry time is computed with the notifier's clock and compared with it, so a clock difference to the database does not matter; a wrong clock on the notifier host delays retries.
- **The migration depends on the alarms service**: it adds a trigger to `alarm_event`, so `alarms migrate` must run first (the notifier's migrate command checks this and says so).

## Still to measure

| Item | How |
|---|---|
| Time from the `fired` row to the receiver (notification latency) | local receiver; compare `at`/`created_at` with the receive time |
| Cost of the trigger per alarm event | fleet simulator with many alarms; `pg_stat_statements` |
| Behaviour in an alarm storm (1,000 devices firing at once) | fleet simulator with fault injection |