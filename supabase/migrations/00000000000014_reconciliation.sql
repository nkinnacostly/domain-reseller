-- ─────────────────────────────────────────────────────────────────────────────
-- Reconciliation (PRD §13.5): our records against the registry's.
--
-- The supplier sends no webhooks and registers every domain with its own
-- auto-renew on (backlog L18), so the gateway reads the whole portfolio on a
-- schedule and records what differs. The registry is the truth for expiry,
-- nameservers, lock and privacy; anything that needs a person — a renewal we
-- did not make, a domain missing at the registry, one we hold but do not
-- know — becomes an open drift row until it goes away.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.domains
  add column registry_status       text,
  -- The supplier's own renewal setting. "AutoRenew" means the supplier may
  -- renew from our balance at expiry, whatever the customer chose.
  add column registry_renewal_mode text,
  add column registry_checked_at   timestamptz;

create table public.reconcile_runs (
  id            uuid primary key default extensions.gen_random_uuid(),
  test_mode     boolean not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  domains_seen  integer,
  findings      integer,
  error         text
);
create index reconcile_runs_recent_idx on public.reconcile_runs (test_mode, started_at desc);

create table public.registry_drift (
  id             bigserial primary key,
  test_mode      boolean not null,
  domain_id      uuid references public.domains (id) on delete cascade,
  domain_name    extensions.citext not null,
  kind           text not null check (kind in (
                   'supplier_renewed',          -- expiry moved later without a renewal of ours
                   'expiry_moved_earlier',
                   'status_mismatch',           -- we hold it; the registry says otherwise
                   'missing_at_registry',       -- we hold it; the registry has no record
                   'unknown_domain',            -- the registry has it; we have no record
                   'registered_but_failed',     -- we failed the line; the registry has it
                   'supplier_may_renew'         -- customer auto-renew off, supplier's on, expiry near
                 )),
  detail         jsonb not null default '{}',
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  last_run_id    uuid references public.reconcile_runs (id) on delete set null,
  resolved_at    timestamptz
);
-- One open row per name and kind; seeing it again updates it.
create unique index registry_drift_open_unique
  on public.registry_drift (test_mode, domain_name, kind) where resolved_at is null;

alter table public.reconcile_runs enable row level security;
alter table public.registry_drift enable row level security;
revoke all on public.reconcile_runs, public.registry_drift from anon, authenticated;

/*
 * Starts a run for one side unless one finished successfully within
 * `p_min_interval_seconds`, or one is still going (started in the last 15
 * minutes). Returns null when there is nothing to do — so restarts and
 * several gateways never pile runs on the supplier's two request slots.
 */
create or replace function public.begin_reconcile(p_test_mode boolean, p_min_interval_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('reconcile:' || p_test_mode::text));

  if exists (
    select 1 from public.reconcile_runs r
     where r.test_mode = p_test_mode
       and (
         (r.finished_at is not null and r.error is null
            and r.started_at > now() - make_interval(secs => p_min_interval_seconds))
         or (r.finished_at is null and r.started_at > now() - interval '15 minutes')
       )
  ) then
    return null;
  end if;

  insert into public.reconcile_runs (test_mode) values (p_test_mode) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.fail_reconcile(p_run_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.reconcile_runs
     set finished_at = now(), error = left(p_error, 500)
   where id = p_run_id and finished_at is null;
$$;

/*
 * Records one run's decisions (made and tested in the gateway):
 *   p_updates  [{domain_id, registry_status, renewal_mode, expires_at?,
 *                nameservers?, transfer_lock?, privacy?, events: [{type, payload}]}]
 *   p_findings [{domain_id?, domain_name, kind, detail}]
 * When the listing was complete, open drift the run did not see again is
 * resolved. Demo domains are never touched.
 */
create or replace function public.record_reconciliation(
  p_run_id       uuid,
  p_updates      jsonb,
  p_findings     jsonb,
  p_complete     boolean,
  p_domains_seen integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run      public.reconcile_runs%rowtype;
  v_findings integer;
begin
  select * into v_run from public.reconcile_runs where id = p_run_id for update;
  if not found or v_run.finished_at is not null then
    raise exception 'reconcile run % is not open', p_run_id;
  end if;

  update public.domains d
     set registry_status       = u.registry_status,
         registry_renewal_mode = u.renewal_mode,
         registry_checked_at   = now(),
         expires_at            = coalesce(u.expires_at, d.expires_at),
         nameservers           = coalesce(u.nameservers, d.nameservers),
         transfer_lock         = coalesce(u.transfer_lock, d.transfer_lock),
         privacy_enabled       = coalesce(u.privacy, d.privacy_enabled)
    from jsonb_to_recordset(p_updates) as u(
           domain_id uuid, registry_status text, renewal_mode text, expires_at timestamptz,
           nameservers text[], transfer_lock boolean, privacy boolean)
   where d.id = u.domain_id
     and d.test_mode = v_run.test_mode
     and d.source <> 'demo';

  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  select (u ->> 'domain_id')::uuid, e ->> 'type', 'system', coalesce(e -> 'payload', '{}'::jsonb)
    from jsonb_array_elements(p_updates) as u
    cross join lateral jsonb_array_elements(coalesce(u -> 'events', '[]'::jsonb)) as e
    join public.domains d on d.id = (u ->> 'domain_id')::uuid
   where d.test_mode = v_run.test_mode and d.source <> 'demo';

  insert into public.registry_drift (test_mode, domain_id, domain_name, kind, detail, last_run_id)
  select v_run.test_mode, f.domain_id, f.domain_name, f.kind, coalesce(f.detail, '{}'), p_run_id
    from jsonb_to_recordset(p_findings) as f(domain_id uuid, domain_name text, kind text, detail jsonb)
  on conflict (test_mode, domain_name, kind) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail,
                domain_id = coalesce(excluded.domain_id, public.registry_drift.domain_id),
                last_run_id = p_run_id;
  get diagnostics v_findings = row_count;

  if p_complete then
    update public.registry_drift
       set resolved_at = now()
     where test_mode = v_run.test_mode
       and resolved_at is null
       and last_run_id is distinct from p_run_id;
  end if;

  update public.reconcile_runs
     set finished_at = now(), domains_seen = p_domains_seen, findings = v_findings
   where id = p_run_id;

  return v_findings;
end;
$$;

revoke all on function public.begin_reconcile(boolean, integer) from public, anon, authenticated;
revoke all on function public.fail_reconcile(uuid, text) from public, anon, authenticated;
revoke all on function public.record_reconciliation(uuid, jsonb, jsonb, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.begin_reconcile(boolean, integer) to service_role;
grant execute on function public.fail_reconcile(uuid, text) to service_role;
grant execute on function public.record_reconciliation(uuid, jsonb, jsonb, boolean, integer)
  to service_role;
