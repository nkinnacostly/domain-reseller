-- Transfers in, registry-side settings, invoices, delegation checks, active
-- sessions and the public status page (24 Sept 2026).
--
-- Transfers in (PRD E9): a paid `transfer` line becomes a `transfer_domain`
-- job, worked by the gateway like a registration — the charge is confirmed
-- first, the registry is read before and after, and a timeout is settled by
-- reading, never by sending again (I2). The transfer code is kept apart from
-- anything a customer can read (`transfer_secrets`), and deleted as soon as
-- the registry has the request, or the line fails.
--
-- Registry-side settings (FR-DS1, FR-DS3, FR-DS4): transfer lock, privacy and
-- the registrant are asked for as a pending value on the domain and applied
-- by a job, exactly like nameservers (migration 13). The domain's own column
-- changes only when the registry confirms it.
--
-- Invoices (CMP-17/18): every paid order gets the next number from its own
-- sequence — live and test orders apart, so test orders never leave gaps in
-- the real series.

-- ── Columns and tables ─────────────────────────────────────────────────────
alter table public.domains
  add column pending_transfer_lock boolean,
  add column pending_privacy boolean,
  add column pending_registrant jsonb;

comment on column public.domains.pending_transfer_lock is
  'A transfer lock change asked for and not yet confirmed by the registry. Null: none.';
comment on column public.domains.pending_privacy is
  'A privacy change asked for and not yet confirmed by the registry. Null: none.';
comment on column public.domains.pending_registrant is
  'New registrant details asked for and not yet confirmed by the registry. Null: none.';

alter table public.orders
  add column invoice_number text unique,
  add column nameserver_preset_id uuid references public.nameserver_presets (id) on delete set null;

comment on column public.orders.invoice_number is
  'Assigned when the order is paid: INV-000001 for live orders, TEST-INV-000001 for test orders.';

alter table public.jobs
  add column submitted_at timestamptz;

comment on column public.jobs.submitted_at is
  'A transfer: when the registry accepted the request. The job then polls until it completes.';

alter table public.tlds
  add column min_chars smallint,
  add column max_chars smallint,
  add column is_transferable boolean;

comment on column public.tlds.min_chars is 'Shortest label the registry accepts, from the supplier catalogue. Null: unknown.';
comment on column public.tlds.max_chars is 'Longest label the registry accepts, from the supplier catalogue. Null: unknown.';
comment on column public.tlds.is_transferable is 'Whether the supplier accepts transfers in. Null: unknown.';

alter table public.order_items drop constraint order_items_item_type_check;
alter table public.order_items
  add constraint order_items_item_type_check check (item_type in ('register', 'renew', 'transfer'));

alter table public.jobs drop constraint jobs_check;
alter table public.jobs
  add constraint jobs_check
  check ((kind in ('register_domain', 'renew_domain', 'transfer_domain')) = (order_item_id is not null));

alter table public.refunds drop constraint refunds_check;
alter table public.refunds
  add constraint refunds_check
  check ((reason in ('registration_failed', 'renewal_failed', 'transfer_failed')) = (order_item_id is not null));

create unique index jobs_one_open_setting_change
  on public.jobs (domain_id, kind)
  where kind in ('set_transfer_lock', 'set_privacy', 'update_contacts')
    and status in ('queued', 'running');

-- The transfer code is the key to someone's domain: nobody but the service
-- reads it, and it lives only as long as the transfer needs it.
create table public.transfer_secrets (
  order_item_id uuid primary key references public.order_items (id) on delete cascade,
  auth_code     text not null check (char_length(auth_code) between 1 and 255),
  created_at    timestamptz not null default now()
);

comment on table public.transfer_secrets is
  'Transfer codes for paid transfer lines. Service only; deleted once the registry has the request or the line fails.';

alter table public.transfer_secrets enable row level security;
revoke all on public.transfer_secrets from anon, authenticated;

create sequence public.invoice_number_seq;
create sequence public.test_invoice_number_seq;
revoke all on sequence public.invoice_number_seq from anon, authenticated;
revoke all on sequence public.test_invoice_number_seq from anon, authenticated;

-- Orders paid before today get numbers in the order they were paid.
with paid as (
  select id, test_mode,
         row_number() over (partition by test_mode order by paid_at, created_at, id) as n
    from public.orders
   where paid_at is not null
)
update public.orders o
   set invoice_number = case when p.test_mode then 'TEST-INV-' else 'INV-' end || lpad(p.n::text, 6, '0')
  from paid p
 where p.id = o.id;

select setval('public.invoice_number_seq',
              greatest((select count(*) from public.orders where paid_at is not null and not test_mode), 1),
              (select count(*) from public.orders where paid_at is not null and not test_mode) > 0);
select setval('public.test_invoice_number_seq',
              greatest((select count(*) from public.orders where paid_at is not null and test_mode), 1),
              (select count(*) from public.orders where paid_at is not null and test_mode) > 0);

-- ── Payment: registrations, renewals and transfers ─────────────────────────
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
  v_order      public.orders%rowtype;
  v_payment_id uuid;
  v_owner      uuid;
  v_items      integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;
  if p_currency <> 'NGN' then
    raise exception 'order % is paid in naira only', v_order.order_number;
  end if;
  if p_amount_kobo < v_order.total_kobo then
    raise exception 'a charge below the total does not pay order %', v_order.order_number;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'successful', p_method, p_raw
  )
  on conflict (provider_reference) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    -- Seen before: the redirect and the webhook both arrive, in any order.
    select order_id into v_owner from public.payments where provider_reference = p_provider_reference;
    if v_owner <> v_order.id then
      raise exception 'charge % belongs to another order', p_provider_reference;
    end if;
    return v_order.status;
  end if;

  if v_order.status in ('awaiting_payment', 'cancelled') then
    -- CMP-17: the invoice number is taken with the payment, in one transaction.
    update public.orders
       set status = 'paid', paid_at = now(), payment_id = v_payment_id,
           invoice_number = coalesce(
             invoice_number,
             case when test_mode
               then 'TEST-INV-' || lpad(nextval('public.test_invoice_number_seq')::text, 6, '0')
               else 'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
             end)
     where id = v_order.id;

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

    -- A registration or a transfer brings a new domain onto the account. A
    -- transfer keeps the nameservers it has at the registry.
    insert into public.domains (
      user_id, domain_name, tld, source, test_mode, order_item_id, local_status,
      auto_renew, privacy_enabled, pending_nameservers, nameserver_preset_id, registrant
    )
    select v_order.user_id, oi.domain, oi.tld,
           case oi.item_type when 'transfer' then 'transfer' else 'registration' end,
           v_order.test_mode, oi.id,
           (case oi.item_type when 'transfer' then 'transfer_requested' else 'pending' end)::public.domain_status,
           oi.auto_renew, oi.privacy,
           case oi.item_type when 'transfer' then null else v_order.nameservers end,
           case oi.item_type when 'transfer' then null else v_order.nameserver_preset_id end,
           v_order.registrant
      from public.order_items oi
     where oi.order_id = v_order.id
       and oi.item_type in ('register', 'transfer')
    on conflict (order_item_id) do nothing;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'order_paid', 'system', jsonb_build_object('order_number', v_order.order_number)
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id;

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select (case oi.item_type when 'transfer' then 'transfer_domain' else 'register_domain' end)::public.job_kind,
           (case oi.item_type when 'transfer' then 'transfer:' else 'register:' end) || d.order_item_id,
           d.id, d.order_item_id, d.test_mode
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id
    on conflict (idempotency_key) do nothing;

    -- A renewal line renews the domain it names: the account's own, on the
    -- same side (test or live) as the order. Anything else is not renewed,
    -- and its line fails below so it is refunded.
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'renewal_paid', 'system',
           jsonb_build_object('order_number', v_order.order_number, 'years', oi.period_years)
      from public.order_items oi
      join public.domains d on d.id = oi.domain_id
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and d.user_id = v_order.user_id
       and d.test_mode = v_order.test_mode;

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select 'renew_domain', 'renew:' || oi.id, d.id, oi.id, d.test_mode
      from public.order_items oi
      join public.domains d on d.id = oi.domain_id
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and d.user_id = v_order.user_id
       and d.test_mode = v_order.test_mode
    on conflict (idempotency_key) do nothing;

    update public.order_items oi
       set status = 'failed', failure_code = 'NOT_RENEWABLE'
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and not exists (
         select 1 from public.domains d
          where d.id = oi.domain_id
            and d.user_id = v_order.user_id
            and d.test_mode = v_order.test_mode
       );

    -- Queue the refund of any renewal line that could not be queued.
    perform public.enqueue_line_refund(oi.id)
       from public.order_items oi
      where oi.order_id = v_order.id and oi.item_type = 'renew' and oi.status = 'failed';

    select count(*) into v_items from public.order_items where order_id = v_order.id;
    if v_items = 0 then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'empty_order', p_amount_kobo, 0);
      update public.orders set status = 'failed' where id = v_order.id;
      return 'failed';
    end if;
    if p_amount_kobo > v_order.total_kobo then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'overpayment',
                                    p_amount_kobo - v_order.total_kobo, 0);
    end if;
    return 'paid';
  end if;

  -- A second charge for an order already paid: every kobo of it goes back.
  perform public.enqueue_refund(v_order.id, v_payment_id, null, 'duplicate_charge', p_amount_kobo, 0);
  return v_order.status;
end;
$$;

-- ── The queue ──────────────────────────────────────────────────────────────
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

  if v_job.kind in ('register_domain', 'renew_domain', 'transfer_domain') then
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
           'source', d.source,
           'local_status', d.local_status,
           'privacy', d.privacy_enabled,
           'transfer_lock', d.transfer_lock,
           'registrant', d.registrant,
           'pending_nameservers', d.pending_nameservers,
           'pending_transfer_lock', d.pending_transfer_lock,
           'pending_privacy', d.pending_privacy,
           'pending_registrant', d.pending_registrant,
           'period_years', oi.period_years,
           'registered_at', d.registered_at,
           'expires_at', d.expires_at,
           -- A renewal's registry expiry, read just before its first Renew call (migration 23).
           'baseline_expiry', v_job.baseline_expiry,
           -- A transfer: when the registry accepted the request (migration 26).
           'submitted_at', v_job.submitted_at,
           -- Only a transfer job carries the code, and only until it is submitted.
           'auth_code', case when v_job.kind = 'transfer_domain' then ts.auth_code end,
           -- Confirmed with Flutterwave before anything is registered, renewed or transferred.
           'payment', case when v_job.kind in ('register_domain', 'renew_domain', 'transfer_domain')
             then jsonb_build_object(
               'order_tx_ref', o.tx_ref,
               'order_total_kobo', o.total_kobo,
               'reference', p.provider_reference,
               'amount_kobo', p.amount_kobo,
               'currency', p.currency,
               'status', p.status
             ) end
         )
    into v_context
    from public.domains d
    left join public.order_items oi on oi.id = v_job.order_item_id
    left join public.orders o on o.id = oi.order_id
    left join public.payments p on p.id = o.payment_id
    left join public.transfer_secrets ts on ts.order_item_id = v_job.order_item_id
   where d.id = v_job.domain_id;

  return v_context;
end;
$$;

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
            case v_job.kind
              when 'register_domain' then 'registration_delayed'
              when 'renew_domain' then 'renewal_delayed'
              when 'transfer_domain' then 'transfer_delayed'
              when 'set_transfer_lock' then 'transfer_lock_delayed'
              when 'set_privacy' then 'privacy_delayed'
              when 'update_contacts' then 'contacts_delayed'
              else 'nameservers_delayed'
            end,
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
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind = 'renew_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'renewal_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind = 'transfer_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    -- Refused before the registry had it: cancelled. Refused after: rejected.
    update public.domains
       set local_status = case when local_status = 'transfer_pending'
                            then 'transfer_rejected'::public.domain_status
                            else 'transfer_cancelled'::public.domain_status end
     where id = v_job.domain_id
       and local_status in ('transfer_requested', 'transfer_pending');
    delete from public.transfer_secrets where order_item_id = v_job.order_item_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'transfer_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    -- Given up: the domain stops saying a change is on its way.
    update public.domains
       set pending_transfer_lock = case when v_job.kind = 'set_transfer_lock' then null else pending_transfer_lock end,
           pending_privacy = case when v_job.kind = 'set_privacy' then null else pending_privacy end,
           pending_registrant = case when v_job.kind = 'update_contacts' then null else pending_registrant end
     where id = v_job.domain_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id,
            case v_job.kind
              when 'set_transfer_lock' then 'transfer_lock_not_applied'
              when 'set_privacy' then 'privacy_not_applied'
              else 'contacts_not_applied'
            end,
            'system', jsonb_build_object('code', p_code));
  else
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_not_applied', 'system', jsonb_build_object('code', p_code));
  end if;
end;
$$;

create or replace function public.retry_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job    public.jobs%rowtype;
  v_refund public.refunds%rowtype;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status not in ('needs_attention', 'failed') then
    return;
  end if;

  if v_job.kind = 'transfer_domain' and v_job.status = 'failed' then
    -- Its code was deleted with the failure: the customer starts a new transfer.
    raise exception 'a failed transfer cannot be retried: its transfer code is gone';
  end if;

  if v_job.kind in ('register_domain', 'renew_domain') and v_job.status = 'failed' then
    select * into v_refund from public.refunds
     where order_item_id = v_job.order_item_id and status <> 'cancelled'
     for update;
    if found then
      if v_refund.status in ('sending', 'submitted', 'completed') or v_refund.provider_refund_id is not null then
        raise exception 'the refund for this line has reached Flutterwave (%): settle it before registering again',
          v_refund.status;
      end if;
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'registration retried'));
    end if;

    update public.order_items set status = 'pending', failure_code = null
     where id = v_job.order_item_id and status = 'failed';
    if v_job.kind = 'register_domain' then
      update public.domains set local_status = 'pending'
       where id = v_job.domain_id and local_status = 'registration_failed';
    end if;
    update public.orders o set status = 'provisioning'
      from public.order_items oi
     where oi.id = v_job.order_item_id and o.id = oi.order_id
       and o.status in ('failed', 'partially_failed');
  end if;

  update public.jobs
     set status = 'queued', run_after = now(), attempts = 0, locked_by = null, locked_at = null
   where id = p_job_id;
end;
$$;

-- ── Transfers in ───────────────────────────────────────────────────────────
-- The registry has the request: the code is no longer needed, and the job
-- comes back to poll until the transfer completes or is refused.
create or replace function public.mark_transfer_submitted(
  p_job_id             uuid,
  p_poll_after_seconds integer default 3600
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'transfer_domain' then
    raise exception 'job % is not a transfer', p_job_id;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'job % is %', p_job_id, v_job.status;
  end if;

  update public.domains set local_status = 'transfer_pending'
   where id = v_job.domain_id and local_status = 'transfer_requested';
  if found then
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'transfer_submitted', 'system', '{}');
  end if;

  delete from public.transfer_secrets where order_item_id = v_job.order_item_id;

  update public.jobs
     set status = 'queued',
         submitted_at = coalesce(submitted_at, now()),
         run_after = now() + make_interval(secs => greatest(p_poll_after_seconds, 60)),
         last_error_code = 'TRANSFER_PENDING', last_error = null,
         locked_by = null, locked_at = null
   where id = v_job.id;
end;
$$;

create or replace function public.complete_transfer(
  p_job_id        uuid,
  p_registered_at timestamptz,
  p_expires_at    timestamptz,
  p_nameservers   text[],
  p_transfer_lock boolean,
  p_privacy       boolean,
  p_recovered     boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.jobs%rowtype;
  v_domain   public.domains%rowtype;
  v_order_id uuid;
  v_refund   public.refunds%rowtype;
begin
  if p_expires_at is null then
    raise exception 'a transfer is recorded with the registry''s expiry';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'transfer_domain' then
    raise exception 'job % is not a transfer', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'job % is %', p_job_id, v_job.status;
  end if;

  select * into v_domain from public.domains where id = v_job.domain_id for update;

  update public.domains
     set local_status = 'active',
         registered_at = coalesce(p_registered_at, registered_at),
         expires_at = p_expires_at,
         nameservers = coalesce(p_nameservers, nameservers),
         transfer_lock = coalesce(p_transfer_lock, transfer_lock),
         privacy_enabled = coalesce(p_privacy, privacy_enabled),
         delegation_status = 'pending',
         delegation_checked_at = null
   where id = v_domain.id;

  update public.order_items set status = 'completed', failure_code = null
   where id = v_job.order_item_id
  returning order_id into v_order_id;

  update public.jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null,
         last_error_code = null, last_error = null
   where id = v_job.id;

  delete from public.transfer_secrets where order_item_id = v_job.order_item_id;

  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_domain.id, 'transferred_in', 'system',
          jsonb_build_object('expires_at', p_expires_at, 'recovered', p_recovered,
                             'sandbox', v_domain.test_mode));

  select * into v_refund from public.refunds
   where order_item_id = v_job.order_item_id and status <> 'cancelled'
   for update;
  if found then
    if v_refund.status in ('queued', 'held', 'failed', 'needs_attention')
       and v_refund.provider_refund_id is null then
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'transferred after all'));
    else
      insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
      values (v_domain.test_mode, 'registered_after_refund', v_order_id, v_refund.id::text,
              jsonb_build_object('refund_status', v_refund.status, 'amount_kobo', v_refund.amount_kobo,
                                 'transfer', true))
      on conflict do nothing;
    end if;
  end if;

  perform public.settle_order(v_order_id);
end;
$$;

-- ── Registry-side settings ─────────────────────────────────────────────────
create or replace function public.enqueue_domain_change(p_domain_id uuid, p_kind public.job_kind)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    raise exception '% is not a domain setting', p_kind;
  end if;

  insert into public.jobs (kind, idempotency_key, domain_id, test_mode)
  select p_kind, p_kind::text || ':' || d.id || ':' || extensions.gen_random_uuid(), d.id, d.test_mode
    from public.domains d
   where d.id = p_domain_id
     and d.source <> 'demo'
     and d.local_status in ('active', 'expired_grace')
     and case p_kind
           when 'set_transfer_lock' then d.pending_transfer_lock is not null
           when 'set_privacy' then d.pending_privacy is not null
           else d.pending_registrant is not null
         end
  on conflict (domain_id, kind)
     where kind in ('set_transfer_lock', 'set_privacy', 'update_contacts')
       and status in ('queued', 'running')
  do nothing;
end;
$$;

-- The registry's answer to a settings job. `p_applied` is what the registry
-- now holds ({"transfer_lock": …}, {"privacy": …} or {"registrant": {…}}),
-- read back after the write; null means it refused, with `p_code`.
create or replace function public.record_domain_change(
  p_job_id    uuid,
  p_attempted jsonb,
  p_applied   jsonb,
  p_code      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.jobs%rowtype;
  v_setting text;
  v_domain  public.domains%rowtype;
  v_still   boolean;
begin
  if p_attempted is null then
    raise exception 'a settings change is recorded with what was asked for';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind not in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    raise exception 'job % is not a settings change', p_job_id;
  end if;
  if v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  v_setting := case v_job.kind
                 when 'set_transfer_lock' then 'transfer_lock'
                 when 'set_privacy' then 'privacy'
                 else 'contacts'
               end;

  if p_applied is not null then
    if v_job.kind = 'set_transfer_lock' then
      if jsonb_typeof(p_applied -> 'transfer_lock') <> 'boolean' then
        raise exception 'the registry''s transfer lock is recorded as true or false';
      end if;
      update public.domains
         set transfer_lock = (p_applied ->> 'transfer_lock')::boolean,
             pending_transfer_lock = case
               when pending_transfer_lock is not distinct from (p_attempted ->> 'transfer_lock')::boolean
               then null else pending_transfer_lock end
       where id = v_job.domain_id;
    elsif v_job.kind = 'set_privacy' then
      if jsonb_typeof(p_applied -> 'privacy') <> 'boolean' then
        raise exception 'the registry''s privacy is recorded as true or false';
      end if;
      update public.domains
         set privacy_enabled = (p_applied ->> 'privacy')::boolean,
             pending_privacy = case
               when pending_privacy is not distinct from (p_attempted ->> 'privacy')::boolean
               then null else pending_privacy end
       where id = v_job.domain_id;
    else
      if jsonb_typeof(p_applied -> 'registrant') <> 'object' then
        raise exception 'the registry''s registrant is recorded as an object';
      end if;
      update public.domains
         set registrant = p_applied -> 'registrant',
             pending_registrant = case
               when pending_registrant is not distinct from (p_attempted -> 'registrant')
               then null else pending_registrant end
       where id = v_job.domain_id;
    end if;

    update public.jobs
       set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, v_setting || '_applied', 'system',
            -- Contact details stay out of the activity log (N13).
            case when v_job.kind = 'update_contacts' then '{}'::jsonb else p_applied end);
  else
    update public.domains
       set pending_transfer_lock = case
             when v_job.kind = 'set_transfer_lock'
              and pending_transfer_lock is not distinct from (p_attempted ->> 'transfer_lock')::boolean
             then null else pending_transfer_lock end,
           pending_privacy = case
             when v_job.kind = 'set_privacy'
              and pending_privacy is not distinct from (p_attempted ->> 'privacy')::boolean
             then null else pending_privacy end,
           pending_registrant = case
             when v_job.kind = 'update_contacts'
              and pending_registrant is not distinct from (p_attempted -> 'registrant')
             then null else pending_registrant end
     where id = v_job.domain_id;

    update public.jobs
       set status = 'failed', finished_at = now(), last_error_code = p_code,
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, v_setting || '_rejected', 'system', jsonb_build_object('code', p_code));
  end if;

  -- Asked again while this one ran: send the newer value.
  select * into v_domain from public.domains where id = v_job.domain_id;
  v_still := case v_job.kind
               when 'set_transfer_lock' then v_domain.pending_transfer_lock is not null
               when 'set_privacy' then v_domain.pending_privacy is not null
               else v_domain.pending_registrant is not null
             end;
  if v_still then
    perform public.enqueue_domain_change(v_job.domain_id, v_job.kind);
  end if;
end;
$$;

-- ── Delegation checks (FR-D5) ──────────────────────────────────────────────
-- Live domains only: sandbox names are not in public DNS.
create or replace function public.domains_for_delegation_check(
  p_limit       integer default 50,
  p_every_hours integer default 6
)
returns table (domain_id uuid, domain_name text, nameservers text[], delegation_status public.delegation_status)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.domain_name::text, d.nameservers, d.delegation_status
    from public.domains d
   where d.test_mode = false
     and d.source <> 'demo'
     and d.local_status in ('active', 'expired_grace')
     and d.nameservers is not null
     and cardinality(d.nameservers) > 0
     and (d.delegation_checked_at is null
          or d.delegation_checked_at < now() - make_interval(hours => greatest(p_every_hours, 1)))
   order by d.delegation_checked_at nulls first, d.id
   limit greatest(1, least(p_limit, 500));
$$;

-- `p_results`: [{"domain_id": …, "status": "verified" | "failed" | "pending", "observed": [...]}].
create or replace function public.record_delegation_checks(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     jsonb;
  v_old     public.delegation_status;
  v_new     public.delegation_status;
  v_count   integer := 0;
begin
  if jsonb_typeof(coalesce(p_results, '[]'::jsonb)) <> 'array' then
    raise exception 'delegation results are a list';
  end if;
  for v_row in select value from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_new := (v_row ->> 'status')::public.delegation_status;
    if v_new = 'undelegated' then
      raise exception 'a checked domain is verified, failed or pending';
    end if;

    select delegation_status into v_old
      from public.domains
     where id = (v_row ->> 'domain_id')::uuid
       and test_mode = false and source <> 'demo'
     for update;
    if not found then
      continue;
    end if;

    update public.domains
       set delegation_status = v_new, delegation_checked_at = now()
     where id = (v_row ->> 'domain_id')::uuid;
    v_count := v_count + 1;

    if v_old is distinct from v_new and v_new in ('verified', 'failed') then
      insert into public.domain_events (domain_id, event_type, actor_type, payload)
      values ((v_row ->> 'domain_id')::uuid,
              case v_new when 'verified' then 'delegation_verified' else 'delegation_failed' end,
              'system',
              jsonb_build_object('observed', coalesce(v_row -> 'observed', '[]'::jsonb)));
    end if;
  end loop;
  return v_count;
end;
$$;

-- ── Active sessions (FR-A5) ────────────────────────────────────────────────
create or replace function public.my_sessions()
returns table (
  id           uuid,
  created_at   timestamptz,
  last_used_at timestamptz,
  user_agent   text,
  ip           text,
  aal          text,
  is_current   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id,
         s.created_at,
         coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
         s.user_agent,
         host(s.ip),
         s.aal::text,
         s.id::text = (auth.jwt() ->> 'session_id')
    from auth.sessions s
   where s.user_id = auth.uid()
     and (s.not_after is null or s.not_after > now())
   order by 3 desc;
$$;

-- Signs out another of the caller's own sessions. Its refresh tokens go with
-- it; an access token already issued lasts until it expires (at most an hour).
create or replace function public.revoke_my_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  delete from auth.sessions s
   where s.id = p_session_id
     and s.user_id = auth.uid()
     and s.id::text is distinct from (auth.jwt() ->> 'session_id');
  return found;
end;
$$;

-- ── Public status (the /status page) ───────────────────────────────────────
-- Times only: no counts, names or amounts. The page decides what is healthy.
create or replace function public.public_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'checked_at', now(),
    'gateway_seen_at',
      (select max(h.beat_at) from public.service_heartbeats h
        where h.test_mode = false and h.name like 'gateway:%'),
    'registry_checked_at',
      (select max(r.finished_at) from public.reconcile_runs r
        where r.test_mode = false and r.error is null and r.finished_at is not null),
    'orders_delayed',
      exists (
        select 1
          from public.orders o
          cross join public.ops_settings s
         where o.test_mode = false
           and o.status in ('paid', 'provisioning')
           and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
           -- A transfer waits days for the other registrar; that is not a delay.
           and exists (
             select 1 from public.order_items oi
              where oi.order_id = o.id
                and oi.status in ('pending', 'provisioning')
                and not (oi.item_type = 'transfer' and exists (
                  select 1 from public.domains d
                   where d.order_item_id = oi.id and d.local_status = 'transfer_pending'))
           )
      )
  );
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────
revoke all on function public.mark_transfer_submitted(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_transfer(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.enqueue_domain_change(uuid, public.job_kind) from public, anon, authenticated;
revoke all on function public.record_domain_change(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.domains_for_delegation_check(integer, integer) from public, anon, authenticated;
revoke all on function public.record_delegation_checks(jsonb) from public, anon, authenticated;
revoke all on function public.my_sessions() from public, anon;
revoke all on function public.revoke_my_session(uuid) from public, anon;
revoke all on function public.public_status() from public;

grant execute on function public.mark_transfer_submitted(uuid, integer) to service_role;
grant execute on function public.complete_transfer(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean) to service_role;
grant execute on function public.enqueue_domain_change(uuid, public.job_kind) to service_role;
grant execute on function public.record_domain_change(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.domains_for_delegation_check(integer, integer) to service_role;
grant execute on function public.record_delegation_checks(jsonb) to service_role;
grant execute on function public.my_sessions() to authenticated;
grant execute on function public.revoke_my_session(uuid) to authenticated;
grant execute on function public.public_status() to anon, authenticated, service_role;

-- ── Refund reason and alert labels for the new kinds ───────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_line_refund(p_order_item_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_item     public.order_items%rowtype;
  v_order    public.orders%rowtype;
  v_existing public.refunds%rowtype;
  v_settings public.ops_settings%rowtype;
  v_sum      bigint;
  v_amount   bigint;
begin
  select * into v_item from public.order_items where id = p_order_item_id;
  if not found or v_item.status <> 'failed' then
    return null;
  end if;
  select * into v_order from public.orders where id = v_item.order_id;

  select * into v_existing from public.refunds where order_item_id = p_order_item_id for update;
  if found then
    if v_existing.status <> 'cancelled' or v_existing.provider_refund_id is not null then
      return v_existing.id;
    end if;
    select * into v_settings from public.ops_settings;
    begin
      update public.refunds
         set status = 'queued', attempts = 0, approved_by = null, approved_at = null,
             run_after = now() + make_interval(mins => v_settings.refund_delay_minutes),
             last_error_code = null, last_error = null
       where id = v_existing.id;
    exception when others then
      insert into public.payment_incidents (test_mode, kind, order_id, detail)
      values (v_order.test_mode, 'refund_not_created', v_order.id,
              jsonb_build_object('reason', 'registration_failed', 'refund_id', v_existing.id,
                                 'error', left(sqlerrm, 300)))
      on conflict do nothing;
      return null;
    end;
    insert into public.refund_events (refund_id, event, detail)
    values (v_existing.id, 'queued', jsonb_build_object('why', 'registration failed again'));
    return v_existing.id;
  end if;

  if v_order.payment_id is null then
    insert into public.payment_incidents (test_mode, kind, order_id, detail)
    values (v_order.test_mode, 'refund_not_created', v_order.id,
            jsonb_build_object('why', 'order has no recorded payment'))
    on conflict do nothing;
    return null;
  end if;

  select sum(price_kobo) into v_sum from public.order_items where order_id = v_order.id;
  if v_sum is distinct from v_order.subtotal_kobo then
    insert into public.payment_incidents (test_mode, kind, order_id, detail)
    values (v_order.test_mode, 'refund_not_created', v_order.id,
            jsonb_build_object('why', 'lines do not add up to the subtotal',
                               'lines_kobo', v_sum, 'subtotal_kobo', v_order.subtotal_kobo))
    on conflict do nothing;
    return null;
  end if;

  with lines as (
    select id, price_kobo,
           sum(price_kobo) over (order by created_at, id
                                 rows between unbounded preceding and current row) as upto
      from public.order_items
     where order_id = v_order.id
  )
  select l.price_kobo
         + (floor(v_order.vat_kobo::numeric * l.upto / v_order.subtotal_kobo)
            - floor(v_order.vat_kobo::numeric * (l.upto - l.price_kobo) / v_order.subtotal_kobo))::bigint
    into v_amount
    from lines l
   where l.id = p_order_item_id;

  return public.enqueue_refund(v_order.id, v_order.payment_id, v_item.id,
                               case v_item.item_type
                                 when 'renew' then 'renewal_failed'
                                 when 'transfer' then 'transfer_failed'
                                 else 'registration_failed'
                               end::public.refund_reason,
                               v_amount, null);
end;
$$;

CREATE OR REPLACE FUNCTION public.current_alert_conditions(p_test_mode boolean)
 RETURNS TABLE(key text, severity text, kind text, summary text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
                  when 'transfer_domain' then 'Transfer'
                  when 'set_transfer_lock' then 'Transfer lock change'
                  when 'set_privacy' then 'Privacy change'
                  when 'update_contacts' then 'Contact change'
                  else 'Nameserver change'
                end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- I5: paid, and not settled in time.
  select 'order_stuck:' || o.id,
         'critical',
         'order_stuck',
         format('Order %s was paid %s minutes ago and is still %s',
                o.order_number, floor(extract(epoch from now() - o.paid_at) / 60), o.status)
    from public.orders o
    cross join public.ops_settings s
   where o.test_mode = p_test_mode
     and o.status in ('paid', 'provisioning')
     and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
     -- A transfer waits days for the other registrar; only other lines are late (migration 26).
     and exists (
       select 1 from public.order_items oi2
        where oi2.order_id = o.id
          and oi2.status in ('pending', 'provisioning')
          and not (oi2.item_type = 'transfer' and exists (
            select 1 from public.domains d2
             where d2.order_item_id = oi2.id and d2.local_status = 'transfer_pending'))
     )

  union all
  -- Refunds a person must look at, or approve.
  select 'refund:' || r.id,
         case when r.status = 'held' then 'warning' else 'critical' end,
         'refund_' || r.status,
         format('Refund of ₦%s for order %s%s is %s%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number,
                coalesce(' (' || oi.domain || ')', ''),
                replace(r.status::text, '_', ' '),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')

  union all
  -- A refund that should have gone out 30 minutes ago: is the worker running?
  select 'refund_overdue:' || r.id,
         'critical',
         'refund_overdue',
         format('Refund of ₦%s for order %s has waited %s minutes to be sent%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.run_after) / 60),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status in ('queued', 'sending')
     and r.run_after < now() - interval '30 minutes'

  union all
  -- Accepted by Flutterwave but not completed after ten days.
  select 'refund_slow:' || r.id,
         'warning',
         'refund_slow',
         format('Refund of ₦%s for order %s was sent %s days ago and has not completed',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.submitted_at) / 86400))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status = 'submitted'
     and r.submitted_at < now() - interval '10 days'

  union all
  -- Money that arrived but could not be applied, or a refund that could not be queued.
  select 'incident:' || i.id,
         'critical',
         'payment_' || i.kind,
         format('Payment incident: %s%s',
                replace(i.kind, '_', ' '),
                coalesce(', order ' || o.order_number, ''))
    from public.payment_incidents i
    left join public.orders o on o.id = i.order_id
   where i.test_mode = p_test_mode and i.resolved_at is null

  union all
  -- The registry disagrees with us (§13.5).
  select 'drift:' || g.id,
         case when g.kind in ('supplier_may_renew', 'unknown_domain') then 'warning' else 'critical' end,
         'drift_' || g.kind,
         format('Registry check: %s — %s', g.domain_name, replace(g.kind, '_', ' '))
    from public.registry_drift g
   where g.test_mode = p_test_mode and g.resolved_at is null

  union all
  -- The registry has not been read successfully for three hours.
  select 'reconcile_stale:' || p_test_mode::text,
         'warning',
         'reconcile_stale',
         'The registry has not been reconciled successfully for over three hours'
   where exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode and r.started_at > now() - interval '7 days'
         )
     and not exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode
              and r.finished_at > now() - interval '3 hours'
              and r.error is null
         )

  union all
  -- FR-FLOAT-2, simplified: checkout refuses orders the float cannot cover.
  select 'float_low:' || p_test_mode::text,
         'warning',
         'float_low',
         format('Supplier balance is $%s, below the $%s alert level. Checkout refuses orders it cannot cover.',
                to_char(b.balance_usd, 'FM999,999,990.00'), to_char(s.float_alert_usd, 'FM999,990.00'))
    from (
      select balance_usd, taken_at from public.supplier_balance_snapshots
       where test_mode = p_test_mode order by taken_at desc limit 1
    ) b
    cross join public.ops_settings s
   where b.taken_at > now() - interval '2 hours'
     and b.balance_usd < s.float_alert_usd
$$;
