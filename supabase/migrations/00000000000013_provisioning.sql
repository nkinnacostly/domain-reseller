-- ─────────────────────────────────────────────────────────────────────────────
-- Provisioning (PRD §13.4 step 7, §13.6, FR-R1 – FR-R6, invariants I1 – I7).
--
-- A Postgres queue worked by the registrar gateway, the only process holding
-- supplier credentials. One job per paid line (register_domain) and at most
-- one open job per domain for a nameserver change (apply_nameservers).
--
-- Every state change is one of the functions below, so a job, its order line,
-- its domain and its order always move together. Nothing here is callable by
-- people: the gateway and our server use the secret key.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.job_kind as enum ('register_domain', 'apply_nameservers');

create type public.job_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  -- The outcome is unknown and retries are spent (I2). Never guessed either
  -- way: a person checks the registry and finishes or refunds it.
  'needs_attention'
);

create table public.jobs (
  id               uuid primary key default extensions.gen_random_uuid(),
  kind             public.job_kind not null,
  -- I4: a duplicate enqueue is a no-op.
  idempotency_key  text not null unique,
  domain_id        uuid not null references public.domains (id) on delete cascade,
  order_item_id    uuid references public.order_items (id) on delete cascade,
  -- Test payments are registered only in the supplier's sandbox (OTE), live
  -- payments only in production. A worker claims one side, never both.
  test_mode        boolean not null,
  status           public.job_status not null default 'queued',
  attempts         smallint not null default 0,
  run_after        timestamptz not null default now(),
  locked_by        text,
  locked_at        timestamptz,
  last_error_code  text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  check ((kind = 'register_domain') = (order_item_id is not null))
);

create index jobs_claim_idx on public.jobs (test_mode, run_after)
  where status in ('queued', 'running');
-- One open nameserver change per domain. A newer request waits in
-- domains.pending_nameservers and gets its own job when this one finishes.
create unique index jobs_one_open_nameserver_change on public.jobs (domain_id)
  where kind = 'apply_nameservers' and status in ('queued', 'running');

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- I7: every provisioning call to the supplier, recorded before its answer is
-- acted on. Identifiers and outcomes only — never contacts or auth codes
-- (N13). Searches are not recorded here: FR-S7 forbids logging them.
create table public.supplier_calls (
  id           bigserial primary key,
  job_id       uuid references public.jobs (id) on delete set null,
  environment  text not null check (environment in ('ote', 'production')),
  operation    text not null,
  domain_name  extensions.citext,
  outcome      text not null check (outcome in ('ok', 'not_found', 'rejected', 'blocked', 'unknown')),
  http_status  smallint,
  error_code   text,
  message      text,
  duration_ms  integer not null check (duration_ms >= 0),
  created_at   timestamptz not null default now()
);

create index supplier_calls_job_id_idx on public.supplier_calls (job_id);
create index supplier_calls_domain_idx on public.supplier_calls (domain_name, created_at desc);

alter table public.jobs           enable row level security;
alter table public.supplier_calls enable row level security;
-- No policies: nobody reads or writes these but the secret key.
revoke all on public.jobs, public.supplier_calls from anon, authenticated;

comment on column public.domains.test_mode is
  'Bought with Flutterwave test keys. Registered only in the supplier sandbox (OTE), never the live registry.';

-- ── One holder per name ──────────────────────────────────────────────────────
-- The old index covered pending rows too, so a second payment for a name —
-- or any payment for a name whose earlier registration failed — could not be
-- recorded at all. Now a name is unique only while we hold it; two pending
-- rows may race, and the loser fails as taken (FR-R2).
drop index public.domains_live_name_unique;
create unique index domains_held_name_unique
  on public.domains (domain_name, test_mode)
  where source <> 'demo'
    and local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification');

-- ── Paid orders enqueue their registrations (§13.4 step 7) ───────────────────
create or replace function public.record_order_payment(
  p_order_id           uuid,
  p_provider_reference text,
  p_amount_kobo        bigint,
  p_currency           text,
  p_method             text,
  p_raw                jsonb
)
returns public.order_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'successful', p_method, p_raw
  )
  on conflict (provider_reference) do nothing;

  if v_order.status in ('awaiting_payment', 'cancelled') then
    update public.orders set status = 'paid', paid_at = now() where id = v_order.id;

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

    -- Each paid line becomes a domain, waiting to be registered. Nameservers
    -- given at checkout (FR-C10) wait as the requested set.
    insert into public.domains (
      user_id, domain_name, tld, source, test_mode, order_item_id, local_status,
      auto_renew, privacy_enabled, pending_nameservers, registrant
    )
    select v_order.user_id, oi.domain, oi.tld, 'registration', v_order.test_mode, oi.id, 'pending',
           oi.auto_renew, oi.privacy, v_order.nameservers, v_order.registrant
      from public.order_items oi
     where oi.order_id = v_order.id
    on conflict (order_item_id) do nothing;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'order_paid', 'system', jsonb_build_object('order_number', v_order.order_number)
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id;

    -- FR-R1: one durable job per line, keyed so a replay adds nothing (I4).
    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select 'register_domain', 'register:' || d.order_item_id, d.id, d.order_item_id, d.test_mode
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id
    on conflict (idempotency_key) do nothing;

    return 'paid';
  end if;

  return v_order.status;
end;
$$;

-- ── Queue functions ──────────────────────────────────────────────────────────

/*
 * Settles an order once no line is still open (§13.4 step 8). A partial
 * success is a normal outcome, not an error (FR-R2).
 */
create or replace function public.settle_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open   integer;
  v_done   integer;
  v_failed integer;
begin
  select count(*) filter (where status in ('pending', 'provisioning')),
         count(*) filter (where status = 'completed'),
         count(*) filter (where status in ('failed', 'refunded'))
    into v_open, v_done, v_failed
    from public.order_items
   where order_id = p_order_id;

  if v_open > 0 then
    return;
  end if;

  update public.orders
     set status = case
           when v_failed = 0 then 'completed'::public.order_status
           when v_done = 0 then 'failed'::public.order_status
           else 'partially_failed'::public.order_status
         end
   where id = p_order_id
     and status in ('paid', 'provisioning');
end;
$$;

/*
 * Queues the domain's requested nameservers for the registry, unless a change
 * is already open. Demo domains and domains we do not hold are never sent.
 */
create or replace function public.enqueue_nameserver_change(p_domain_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.jobs (kind, idempotency_key, domain_id, test_mode)
  select 'apply_nameservers', 'nameservers:' || d.id || ':' || extensions.gen_random_uuid(),
         d.id, d.test_mode
    from public.domains d
   where d.id = p_domain_id
     and d.source <> 'demo'
     and d.local_status = 'active'
     and d.pending_nameservers is not null
  on conflict (domain_id) where kind = 'apply_nameservers' and status in ('queued', 'running')
  do nothing;
end;
$$;

/*
 * Claims the next due job for one side (test or live) with
 * FOR UPDATE SKIP LOCKED (§13.6), and returns what the worker needs.
 *
 * A running job whose lease has lapsed is claimable again: its worker died.
 * That is safe because every registration starts with a registry read (I1).
 * `p_job_id` claims one specific job — to run it now, or in tests.
 */
create or replace function public.claim_job(
  p_worker        text,
  p_test_mode     boolean,
  p_lease_seconds integer default 300,
  p_job_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.jobs%rowtype;
  v_context jsonb;
begin
  select * into v_job
    from public.jobs j
   where j.test_mode = p_test_mode
     and (p_job_id is null or j.id = p_job_id)
     and (
       (j.status = 'queued' and j.run_after <= now())
       or (j.status = 'running' and j.locked_at < now() - make_interval(secs => p_lease_seconds))
     )
   order by j.run_after
   limit 1
   for update skip locked;

  if not found then
    return null;
  end if;

  update public.jobs
     set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1
   where id = v_job.id
  returning * into v_job;

  if v_job.kind = 'register_domain' then
    update public.order_items set status = 'provisioning'
     where id = v_job.order_item_id and status = 'pending';
    update public.orders o set status = 'provisioning'
      from public.order_items oi
     where oi.id = v_job.order_item_id and o.id = oi.order_id and o.status = 'paid';
  end if;

  select jsonb_build_object(
           'id', v_job.id,
           'kind', v_job.kind,
           'attempts', v_job.attempts,
           'test_mode', v_job.test_mode,
           'domain_id', d.id,
           'domain_name', d.domain_name,
           'local_status', d.local_status,
           'privacy', d.privacy_enabled,
           'registrant', d.registrant,
           'pending_nameservers', d.pending_nameservers,
           'period_years', oi.period_years
         )
    into v_context
    from public.domains d
    left join public.order_items oi on oi.id = v_job.order_item_id
   where d.id = v_job.domain_id;

  return v_context;
end;
$$;

/* A transient problem: try again later. The line stays open. */
create or replace function public.reschedule_job(
  p_job_id        uuid,
  p_delay_seconds integer,
  p_code          text,
  p_message       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs
     set status = 'queued',
         run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
         last_error_code = p_code,
         last_error = left(p_message, 500),
         locked_by = null,
         locked_at = null
   where id = p_job_id
     and status = 'running';
end;
$$;

/*
 * Ends a job without success. `p_needs_attention` means we do not know what
 * happened (I2): the line stays open and the domain stays pending, so nothing
 * is refunded or retried until a person has looked at the registry.
 */
create or replace function public.fail_job(
  p_job_id          uuid,
  p_code            text,
  p_message         text,
  p_needs_attention boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.jobs%rowtype;
  v_order_id uuid;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  if p_needs_attention then
    update public.jobs
       set status = 'needs_attention', last_error_code = p_code, last_error = left(p_message, 500),
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id,
            case v_job.kind when 'register_domain' then 'registration_delayed' else 'nameservers_delayed' end,
            'system', jsonb_build_object('code', p_code));
    return;
  end if;

  update public.jobs
     set status = 'failed', finished_at = now(), last_error_code = p_code,
         last_error = left(p_message, 500), locked_by = null, locked_at = null
   where id = v_job.id;

  if v_job.kind = 'register_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    update public.domains set local_status = 'registration_failed', pending_nameservers = null
     where id = v_job.domain_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'registration_failed', 'system', jsonb_build_object('code', p_code));
    perform public.settle_order(v_order_id);
  else
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_not_applied', 'system', jsonb_build_object('code', p_code));
  end if;
end;
$$;

/*
 * A registration the registry confirmed (§13.4 step 7e). `p_recovered` means
 * the pre-flight read found it already registered — a call that timed out
 * but landed (I1). `p_nameserver_result` is what became of the checkout's
 * nameservers (FR-R5): applied, rejected, unknown (queued again) or none.
 * A delegation problem never fails the registration.
 */
create or replace function public.complete_registration(
  p_job_id            uuid,
  p_registered_at     timestamptz,
  p_expires_at        timestamptz,
  p_nameservers       text[],
  p_transfer_lock     boolean,
  p_privacy           boolean,
  p_recovered         boolean,
  p_nameserver_result text,
  p_nameserver_code   text default null
)
returns public.domain_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.jobs%rowtype;
  v_domain   public.domains%rowtype;
  v_order_id uuid;
begin
  if p_nameserver_result not in ('applied', 'rejected', 'unknown', 'none') then
    raise exception 'unknown nameserver result %', p_nameserver_result;
  end if;

  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'register_domain' then
    raise exception 'job % is not a registration', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return 'active';
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'job % is %', p_job_id, v_job.status;
  end if;

  select * into v_domain from public.domains where id = v_job.domain_id for update;

  -- Another account here already holds the name, so the registry's answer
  -- is theirs: this line lost the race (FR-R2).
  if exists (
    select 1 from public.domains d
     where d.domain_name = v_domain.domain_name
       and d.test_mode = v_domain.test_mode
       and d.id <> v_domain.id
       and d.source <> 'demo'
       and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')
  ) then
    perform public.fail_job(p_job_id, 'DOMAIN_TAKEN', 'Held by another account here', false);
    return 'registration_failed';
  end if;

  update public.domains
     set local_status = 'active',
         registered_at = coalesce(p_registered_at, now()),
         expires_at = p_expires_at,
         transfer_lock = p_transfer_lock,
         privacy_enabled = p_privacy,
         nameservers = p_nameservers,
         pending_nameservers = case
           when p_nameserver_result in ('applied', 'rejected') then null
           else pending_nameservers
         end,
         delegation_status = case
           when p_nameserver_result = 'applied' then 'pending'::public.delegation_status
           else 'undelegated'::public.delegation_status
         end,
         delegation_checked_at = null
   where id = v_domain.id;

  update public.order_items set status = 'completed', failure_code = null
   where id = v_job.order_item_id
  returning order_id into v_order_id;

  update public.jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null
   where id = v_job.id;

  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_domain.id, 'registered', 'system',
          jsonb_build_object('expires_at', p_expires_at, 'recovered', p_recovered,
                             'sandbox', v_domain.test_mode));

  if p_nameserver_result = 'applied' then
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_domain.id, 'nameservers_applied', 'system',
            jsonb_build_object('nameservers', p_nameservers));
  elsif p_nameserver_result = 'rejected' then
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_domain.id, 'nameservers_rejected', 'system',
            jsonb_build_object('code', p_nameserver_code, 'requested', v_domain.pending_nameservers));
  elsif p_nameserver_result = 'unknown' then
    perform public.enqueue_nameserver_change(v_domain.id);
  end if;

  perform public.settle_order(v_order_id);
  return 'active';
end;
$$;

/*
 * The result of a nameserver change (FR-N1). `p_applied` is the set the
 * registry accepted, or null when it refused `p_attempted`. Only the request
 * that was sent is cleared: one made meanwhile gets its own job.
 */
create or replace function public.record_nameserver_change(
  p_job_id    uuid,
  p_attempted text[],
  p_applied   text[],
  p_code      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.jobs%rowtype;
  v_still text[];
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'apply_nameservers' then
    raise exception 'job % is not a nameserver change', p_job_id;
  end if;
  if v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  if p_applied is not null then
    update public.domains
       set nameservers = p_applied,
           pending_nameservers = case
             when pending_nameservers = p_attempted then null else pending_nameservers
           end,
           delegation_status = 'pending',
           delegation_checked_at = null
     where id = v_job.domain_id
    returning pending_nameservers into v_still;

    update public.jobs
       set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_applied', 'system', jsonb_build_object('nameservers', p_applied));
  else
    update public.domains
       set pending_nameservers = case
             when pending_nameservers = p_attempted then null else pending_nameservers
           end
     where id = v_job.domain_id
    returning pending_nameservers into v_still;

    update public.jobs
       set status = 'failed', finished_at = now(), last_error_code = p_code,
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_rejected', 'system',
            jsonb_build_object('code', p_code, 'requested', p_attempted));
  end if;

  if v_still is not null then
    perform public.enqueue_nameserver_change(v_job.domain_id);
  end if;
end;
$$;

/* Puts a job back in the queue after a person has looked at it. */
create or replace function public.retry_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs
     set status = 'queued', run_after = now(), attempts = 0, locked_by = null, locked_at = null
   where id = p_job_id
     and status in ('needs_attention', 'failed');
end;
$$;

-- Registrations already paid for before this migration join the queue.
insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
select 'register_domain', 'register:' || d.order_item_id, d.id, d.order_item_id, d.test_mode
  from public.domains d
 where d.source = 'registration'
   and d.local_status = 'pending'
   and d.order_item_id is not null
on conflict (idempotency_key) do nothing;

-- ── Only our server may call any of this ─────────────────────────────────────
revoke all on function public.record_order_payment(uuid, text, bigint, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_order_payment(uuid, text, bigint, text, text, jsonb)
  to service_role;

revoke all on function public.settle_order(uuid) from public, anon, authenticated;
revoke all on function public.enqueue_nameserver_change(uuid) from public, anon, authenticated;
revoke all on function public.claim_job(text, boolean, integer, uuid) from public, anon, authenticated;
revoke all on function public.reschedule_job(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.complete_registration(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.record_nameserver_change(uuid, text[], text[], text) from public, anon, authenticated;
revoke all on function public.retry_job(uuid) from public, anon, authenticated;

grant execute on function public.settle_order(uuid) to service_role;
grant execute on function public.enqueue_nameserver_change(uuid) to service_role;
grant execute on function public.claim_job(text, boolean, integer, uuid) to service_role;
grant execute on function public.reschedule_job(uuid, integer, text, text) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
grant execute on function public.complete_registration(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, text, text)
  to service_role;
grant execute on function public.record_nameserver_change(uuid, text[], text[], text) to service_role;
grant execute on function public.retry_job(uuid) to service_role;
