-- Tenants, device ownership and the rules that keep one tenant away from another's data (ADR-006).
-- Plain PostgreSQL: this file works with and without TimescaleDB.
-- Needs the tables telemetry (writer) and alarm_event (alarms) to exist first; migrate-cli.ts checks that.
-- File names must be unique across services: all services share the schema_migrations table.

-- Who owns what -------------------------------------------------------------------------------------------

create table if not exists tenant (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- A device belongs to exactly one tenant. telemetry and alarm_event have no foreign key to this table on purpose:
-- a device may send data before anybody registered it, and the write path must never wait for the API's tables.
-- Data of a device that is not in this table belongs to nobody and is visible to no tenant.
create table if not exists device (
  device_id  integer primary key,
  tenant_id  uuid not null references tenant (id),
  name       text not null,
  created_at timestamptz not null default now()
);

create index if not exists device_tenant_idx on device (tenant_id);

-- The role the API works as -------------------------------------------------------------------------------
-- The API connects with whatever user it is given, then switches to this role inside every request
-- (SET LOCAL ROLE). The role owns nothing, is no superuser and has no BYPASSRLS, so the policies below
-- always apply to it. (Superusers and table owners skip row-level security, which is why the switch is needed.)
-- The advisory lock keeps two migrations that start at the same moment from both trying to create the role.
do $$
begin
  perform pg_advisory_xact_lock(hashtext('speicherlotse_app role'));
  if not exists (select from pg_roles where rolname = 'speicherlotse_app') then
    create role speicherlotse_app nologin nosuperuser nobypassrls;
  end if;
  -- so that a connection user that is not a superuser may switch to it
  execute format('grant speicherlotse_app to %I', current_user);
  execute format('grant usage on schema %I to speicherlotse_app', current_schema());
end
$$;

-- Which tenant is this request for? The API sets the setting app.tenant_id for the length of one transaction.
-- Not set, empty or reset -> NULL, and "tenant_id = NULL" is never true: the default is to see nothing.
create or replace function current_tenant() returns uuid
language sql stable
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Row-level security: tables the role may read ------------------------------------------------------------
-- The role gets SELECT only. It has no privilege at all on telemetry, alarm_state, alarm_device or the outbox.
-- "(select current_tenant())" instead of "current_tenant()" makes PostgreSQL evaluate it once per query, not once per row.

alter table tenant      enable row level security;
alter table device      enable row level security;
alter table alarm_event enable row level security;

create policy tenant_own on tenant for select to speicherlotse_app
  using (id = (select current_tenant()));

create policy device_own on device for select to speicherlotse_app
  using (tenant_id = (select current_tenant()));

create policy alarm_event_own on alarm_event for select to speicherlotse_app
  using (device_id in (select device_id from device where tenant_id = (select current_tenant())));

grant select on tenant, device, alarm_event to speicherlotse_app;

-- Telemetry: a function instead of row-level security --------------------------------------------------------
-- telemetry is a TimescaleDB hypertable. A policy on a hypertable is not copied to its chunks (the tables that hold
-- the rows), and a role that can read the hypertable can read the chunks (timescaledb issue 7830). So the role gets
-- no access to telemetry at all, and reaches it only through this function. It runs with the rights of its owner,
-- therefore it must check the ownership itself, and it does: no device of the current tenant, no rows.
-- The cap of 1,000 rows per call protects the database from an unbounded request.
create or replace function api_telemetry(p_device_id integer, p_from timestamptz, p_to timestamptz, p_limit integer)
returns setof telemetry
language sql stable security definer
as $$
  select t.*
  from telemetry t
  where t.device_id = p_device_id
    and t.ts >= p_from and t.ts < p_to
    and exists (select 1 from device d where d.device_id = p_device_id and d.tenant_id = current_tenant())
  order by t.ts desc, t.boot_id desc, t.seq desc
  limit least(greatest(p_limit, 0), 1000)
$$;

-- A function that runs with its owner's rights must not look names up in a search path the caller can change.
do $$
begin
  execute format(
    'alter function api_telemetry(integer, timestamptz, timestamptz, integer) set search_path = %I, pg_temp',
    current_schema());
end
$$;

revoke all on function api_telemetry(integer, timestamptz, timestamptz, integer) from public;
grant execute on function api_telemetry(integer, timestamptz, timestamptz, integer) to speicherlotse_app;
