# ADR-006: API and tenant isolation

- Status: accepted. Verified with tests against a real PostgreSQL 18 (plain, without TimescaleDB): the isolation rules, the token checks and the parameter checks each have tests, and five protections were switched off in turn to check that a test fails. *To verify:* the telemetry function on the TimescaleDB hypertable (including compressed chunks), and the API under concurrent load.
- Date: 2026-10-10

## Context

The data is in the database (ADR-002, ADR-004). The next piece is an API that a dashboard can call. The system is **multi-tenant**: several customers (for example energy companies or installers) each own a set of devices. One customer must never read another customer's devices, telemetry or alarms. This is the one mistake an API like this cannot afford, and it is easy to make: a single forgotten `WHERE tenant_id = ...` in one query is enough.

So the decision is where the tenant filter lives. If it lives in every query, safety depends on every developer remembering it in every query, forever. It should live in one place that cannot be forgotten.

## Decision

### 1. Ownership: a device belongs to one tenant

Two small tables: `tenant` and `device (device_id, tenant_id, name)`. `telemetry` and `alarm_event` stay as they are and carry only the device id.

Alternative rejected: a `tenant_id` column in `telemetry` and `alarm_event`. It would add 16 bytes to a 222-byte row (about 7 %), the writer would have to look up the tenant of every sample on the hot path, and moving a device to another tenant would mean rewriting its history. With the current design a move is one `UPDATE` on `device`.

There is deliberately **no foreign key** from `telemetry` or `alarm_event` to `device`: a device may send data before anybody registered it, and the write path must not depend on the API's tables. Data of a device that no tenant owns is stored and is visible to no tenant.

### 2. The database applies the tenant filter, not the query

For every request the API opens one transaction and, inside it:

1. `BEGIN READ ONLY`: a bug cannot write;
2. `SET LOCAL ROLE speicherlotse_app`: a role without superuser rights, without `BYPASSRLS`, owning nothing, with `SELECT` on three tables only;
3. `set_config('app.tenant_id', <tenant from the token>, true)`: the setting lives until the end of this transaction;
4. a statement timeout (default 5 s).

Row-level security policies on `tenant`, `device` and `alarm_event` compare against `current_tenant()`, which reads that setting. The queries in `src/queries.ts` **do not mention the tenant at all**, and the tests run exactly these queries, so a forgotten filter cannot leak: the database still filters.

Role and setting are *local to the transaction*, so a pooled connection that goes to the next request carries nothing over (tested with a pool of one connection). **Fail closed:** if no tenant is set, or an empty or unknown one, the policy compares with NULL and the request sees nothing (tested). The only way to the database is `TenantDb.withTenant`; controllers never get the connection pool.

Why `SET LOCAL ROLE` and not a separate login: PostgreSQL does not apply row-level security to superusers or table owners. In development the connection user is `postgres`, so the policies would be switched off without the role switch. In production the connection should be a login that is not a superuser and is a member of `speicherlotse_app`.

### 3. Telemetry: a function, not a policy

`telemetry` is a TimescaleDB hypertable. A policy on a hypertable is not copied to its chunks, and a role that may read the hypertable may read the chunks directly ([timescaledb issue 7830](https://github.com/timescale/timescaledb/issues/7830), reported for 2.14.2; I did not check whether 2.29.2 still behaves this way). I also found nothing about row-level security together with columnstore compression, and could not test TimescaleDB in the sandbox where this was built.

So the role has **no privilege on `telemetry` at all** (a test checks that a direct `SELECT` is refused). It reads through `api_telemetry(device, from, to, limit)`, a `SECURITY DEFINER` function: it runs with its owner's rights, therefore it checks the ownership itself (`exists (select 1 from device where device_id = ... and tenant_id = current_tenant())`), caps one call at 1,000 rows and pins its `search_path` (a function with its owner's rights must not trust the caller's). A device of another tenant gives an empty result without reading a single telemetry row.

Cost, measured on plain PostgreSQL 18 with 1 million rows and 100 devices in the sandbox: the newest 100 rows of a device take 1.16 ms through the function and 1.21 ms with a direct query that has no tenant check, so the check is free next to the query itself. This says nothing about TimescaleDB or about compressed chunks.

### 4. Another tenant's device looks like a device that does not exist

`GET /v1/devices/3/telemetry` answers `404 device not found` for a device of another tenant, for a device nobody owns and for a device that does not exist, with the same body. A caller cannot probe which ids exist.

### 5. Tokens

A request carries `Authorization: Bearer <JWT>`. The token must be signed with HS256 (any other algorithm, including "none", is refused), have issuer `speicherlotse-dev` and audience `speicherlotse-api`, an expiry, a subject and a `tenant` claim that is a UUID. Every failure gives the same `401 missing or invalid token`; the reason goes to the log only. The shared secret must be at least 32 characters and has no default: the server does not start without it.

`node services/api/src/token-cli.ts alpha` makes a token for a demo tenant. These are **development tokens**: one shared secret, no users, no login, no refresh and no revocation. A real deployment would verify tokens issued by an identity provider (OIDC); only `verifyToken` would change.

### 6. NestJS, and what it costs in this repository

The services run as plain TypeScript (`node src/main.ts`, Node strips the types). NestJS cannot: it is built on decorators, which Node cannot run (`SyntaxError`, tried). The API therefore starts through [`tsx`](https://tsx.is) (`node --import tsx src/main.ts`), and the shared `tsconfig.base.json` got `experimentalDecorators`. Consequences:

- Nest normally reads constructor types from emitted metadata (`emitDecoratorMetadata`); `tsx` cannot emit it. Every dependency is therefore injected with an explicit `@Inject(Token)`. This is also why request parameters are checked by small plain functions (`src/params.ts`) and not by `class-validator`, which depends on that metadata.
- `tsx` contains esbuild, which has an install script; pnpm 12 stops the install unless it is allowed (`allowBuilds` in `pnpm-workspace.yaml`).
- `pnpm test` now runs every test file through `tsx` (`node --import tsx --test`). The other services still *start* natively; their code is type-checked with `erasableSyntaxOnly`, which keeps it runnable by plain Node.

Express (Nest's default adapter) is used. There is no body parser: every route is a GET.

### 7. Surface

| Route | Returns |
|---|---|
| `GET /health` | `{status:"ok"}`, or 503 if the database is not reachable. No token. |
| `GET /v1/devices` | the caller's devices |
| `GET /v1/devices/:id/telemetry?from&to&limit` | samples of one device, newest first. `from` inclusive, `to` exclusive, ISO 8601 **with** a time zone, `limit` 1 to 1,000 (default 100) |
| `GET /v1/alarms/events?deviceId&from&to&limit` | alarm events of the caller's devices, newest first, `limit` 1 to 500 (default 50) |

Invalid parameters give `400` with the reason: not a number, a limit that is too large (an error, not a silent cut), a date without a zone, 31 February, `from` after `to`, a parameter given twice, and **an unknown parameter**, so that a typo such as `?device_id=2` cannot silently return unfiltered data. The API is read-only. Tenants and devices are created by `seed-cli.ts`, which runs as the database owner.

## Consequences and limits

- **This protects against mistakes, not against someone who can run arbitrary SQL as the API's role.** The tenant is a setting, and any session can set a setting. All queries here are parameterised and the role is read-only, so there is no known way for a caller to inject SQL, but if such a hole appeared, the attacker could choose the tenant. Stronger designs exist (a database role per tenant, or a tenant context the database can verify); they cost more than this project needs now.
- **The connection user must not be used for tenant data directly.** `TenantDb.ping()` runs `select 1` as the connection user; nothing else does. Code that bypasses `TenantDb` would bypass the policies.
- **`alarm_event` now has row-level security switched on.** The alarm engine and the notifier connect as the table owner, which the policies do not apply to, and a test checks that they still read and write everything and that the outbox trigger still fires. If one of them is ever run as a different, non-owner role, it needs its own policy or it will see nothing.
- **Role creation is part of the migration and is cluster-wide.** It needs a user with `CREATEROLE` (or a superuser). The role stays when a schema or even a database is dropped, which is harmless: it owns nothing.
- **Telemetry through a function is untested on TimescaleDB.** Plan-wise it should behave like the plain query (an index scan backward on the primary key); on compressed chunks, reading is slower and has not been measured.
- **`ts` is the device clock.** Samples are ordered and filtered by it (ADR-002). A device with a wrong clock appears at the wrong time.
- **No paging cursor.** Pages are time windows plus `limit`. `GET /v1/devices` returns all devices of the tenant: fine for hundreds, not for tens of thousands.
- **A database timeout is a 500.** The statement timeout cancels a slow query; the caller sees the generic `500`, not "too slow".
- **Not there yet:** rate limiting, CORS (the dashboard step needs it), TLS (the API listens on `127.0.0.1` by default; put a proxy in front of it), request logging with a request id, an OpenAPI description, and a way for a customer to create their own users.
- **Tokens last as long as they say** (default 12 hours from the CLI). There is no way to revoke one before it expires.

## Still to measure

| Item | How |
|---|---|
| Telemetry reads on the hypertable, also from compressed chunks | `compress_chunk` on the dev database, then the same requests; compare with plain PostgreSQL |
| Latency and pool size under many concurrent tenants | load script with several tokens; watch `pg_stat_activity` |
| Cost of the four statements around each request (begin, role, setting, commit) | compare with one statement per request; if it matters, send them in one round trip |
