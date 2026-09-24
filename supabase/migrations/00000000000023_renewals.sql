-- ─────────────────────────────────────────────────────────────────────────────
-- Renewals (PRD E8): FR-RN1 manual renewal, FR-RN5 renewal during the grace
-- period. Built like registrations: a paid order line queues a job, the
-- gateway confirms the charge with Flutterwave, renews at the registry and
-- reads the new expiry back; a line that fails is refunded.
--
-- Renew has no idempotency key (I2, N3). Before its first Renew call a job
-- records the registry's expiry as its baseline; every later attempt, and the
-- refund worker, compare the registry with baseline + years to know whether
-- the renewal happened — never by calling Renew again blind. The baseline is
-- read at run time, not at payment, so two renewals paid for the same domain
-- each add their years.
--
-- order_items.domain_id links a renewal line to its domain without a foreign
-- key: domains.order_item_id already links the two tables, and a second link
-- would make the API refuse every embed between them (see migration 17).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.order_items drop constraint order_items_item_type_check;
alter table public.order_items add constraint order_items_item_type_check
  check (item_type in ('register', 'renew'));
alter table public.order_items add column domain_id uuid;
alter table public.order_items add constraint order_items_renewal_names_domain
  check ((item_type = 'renew') = (domain_id is not null));
comment on column public.order_items.domain_id is
  'For a renewal line, the domain it renews. No foreign key: domains.order_item_id is the link the API embeds.';

alter table public.jobs add column baseline_expiry timestamptz;
comment on column public.jobs.baseline_expiry is
  'Renewals only: the registry''s expiry just before the first Renew call.';

alter table public.refunds drop constraint refunds_check;
alter table public.refunds add constraint refunds_check
  check ((reason in ('registration_failed', 'renewal_failed')) = (order_item_id is not null));


/* As in migration 15, plus renewal lines: each queues a renewal of the account's own domain. */
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
    update public.orders
       set status = 'paid', paid_at = now(), payment_id = v_payment_id
     where id = v_order.id;

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

    insert into public.domains (
      user_id, domain_name, tld, source, test_mode, order_item_id, local_status,
      auto_renew, privacy_enabled, pending_nameservers, registrant
    )
    select v_order.user_id, oi.domain, oi.tld, 'registration', v_order.test_mode, oi.id, 'pending',
           oi.auto_renew, oi.privacy, v_order.nameservers, v_order.registrant
      from public.order_items oi
     where oi.order_id = v_order.id
       and oi.item_type = 'register'
    on conflict (order_item_id) do nothing;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'order_paid', 'system', jsonb_build_object('order_number', v_order.order_number)
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id;

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select 'register_domain', 'register:' || d.order_item_id, d.id, d.order_item_id, d.test_mode
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

/* As in migration 20, plus renewals: claimed like registrations, with their baseline. */
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

  if v_job.kind in ('register_domain', 'renew_domain') then
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
           'period_years', oi.period_years,
           'expires_at', d.expires_at,
           -- A renewal's registry expiry, read just before its first Renew call (migration 23).
           'baseline_expiry', v_job.baseline_expiry,
           -- Confirmed with Flutterwave before anything is registered or renewed.
           'payment', case when v_job.kind in ('register_domain', 'renew_domain') then jsonb_build_object(
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
   where d.id = v_job.domain_id;

  return v_context;
end;
$$;

/* As in migration 15, plus renewals: a failed renewal leaves the domain alone and refunds its line. */
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
  else
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_not_applied', 'system', jsonb_build_object('code', p_code));
  end if;
end;
$$;

/* As in migration 18, plus renewals. */
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

/* As in migration 18; the refund's reason follows the line. */
create or replace function public.enqueue_line_refund(p_order_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
                                 else 'registration_failed'
                               end::public.refund_reason,
                               v_amount, null);
end;
$$;

/* As in migration 18, plus what the renewal refund check needs. */
create or replace function public.claim_refund(
  p_worker        text,
  p_test_mode     boolean,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
  v_action text;
  v_hold   text;
  v_lapsed timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 3600 then
    raise exception 'a refund lease is between one minute and an hour';
  end if;
  if coalesce(trim(p_worker), '') = '' then
    raise exception 'a refund is claimed by a named worker';
  end if;
  v_lapsed := now() - make_interval(secs => p_lease_seconds);

  for i in 1..25 loop
    select * into v_refund
      from public.refunds r
     where r.test_mode = p_test_mode
       and (
         (r.status = 'queued' and r.run_after <= now())
         or (r.status in ('sending', 'submitted')
             and ((r.locked_at is null and r.run_after <= now()) or r.locked_at < v_lapsed))
       )
     order by r.run_after
     limit 1
     for update skip locked;

    if not found then
      return null;
    end if;

    if v_refund.status = 'queued' then
      if v_refund.approved_at is null then
        v_hold := public.refund_hold_reason(v_refund.amount_kobo, v_refund.test_mode, v_refund.id);
        if v_hold is not null then
          update public.refunds set status = 'held', last_error_code = upper(v_hold)
           where id = v_refund.id;
          insert into public.refund_events (refund_id, event, detail)
          values (v_refund.id, 'held', jsonb_build_object('why', v_hold));
          continue;
        end if;
      end if;
      v_action := 'send';
      update public.refunds
         set status = 'sending', attempts = attempts + 1, locked_by = p_worker, locked_at = now(),
             provider_called_at = null
       where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'sending', jsonb_build_object('attempt', v_refund.attempts + 1));
    elsif v_refund.status = 'sending' then
      v_action := 'recover';
      update public.refunds
         set attempts = attempts + 1, locked_by = p_worker, locked_at = now()
       where id = v_refund.id;
    else
      v_action := 'poll';
      update public.refunds set locked_by = p_worker, locked_at = now() where id = v_refund.id;
    end if;

    return (
      select jsonb_build_object(
               'id', r.id,
               'action', v_action,
               'reason', r.reason,
               'amount_kobo', r.amount_kobo,
               'attempts', r.attempts,
               'test_mode', r.test_mode,
               'provider_refund_id', r.provider_refund_id,
               'provider_called_at', r.provider_called_at,
               'submitted_at', r.submitted_at,
               'transaction_id', p.provider_reference,
               'flw_ref', p.raw ->> 'flw_ref',
               'charged_kobo', p.amount_kobo,
               'charged_at', p.created_at,
               -- The charge is checked at Flutterwave against this before money goes back.
               'order_tx_ref', o.tx_ref,
               'order_number', o.order_number,
               'domain_name', oi.domain,
               -- For a renewal refund: where the registry's expiry stood before
               -- our Renew call, and for how many years — or null if it never
               -- reached the registry.
               'renewal_baseline', (
                 select j.baseline_expiry from public.jobs j
                  where j.order_item_id = r.order_item_id and j.kind = 'renew_domain'
                  limit 1
               ),
               'renewal_years', oi.period_years,
               -- Another account here holds the name: the registry "has it", but not for this line.
               'held_by_other_account', coalesce((
                 select true
                   from public.domains d
                  where oi.domain is not null
                    and d.domain_name = oi.domain
                    and d.test_mode = r.test_mode
                    and d.order_item_id is distinct from r.order_item_id
                    and d.source <> 'demo'
                    and d.local_status in ('active', 'expired_grace', 'redemption',
                                           'pending_delete', 'pending_verification')
                  limit 1
               ), false),
               -- Every Flutterwave refund on this charge some row of ours accounts for,
               -- failed ones included.
               'known_provider_refund_ids', (
                 select coalesce(jsonb_agg(distinct x.ref), '[]'::jsonb)
                   from public.refunds r2
                  cross join lateral unnest(
                    r2.failed_provider_refund_ids
                    || case when r2.id <> r.id and r2.provider_refund_id is not null
                            then array[r2.provider_refund_id] else '{}'::text[] end
                  ) as x(ref)
                  where r2.payment_id = r.payment_id
               ),
               'other_refunds_kobo', (
                 select coalesce(sum(r2.amount_kobo), 0)
                   from public.refunds r2
                  where r2.payment_id = r.payment_id
                    and r2.id <> r.id
                    and r2.status <> 'cancelled'
               )
             )
        from public.refunds r
        join public.payments p on p.id = r.payment_id
        join public.orders o on o.id = r.order_id
        left join public.order_items oi on oi.id = r.order_item_id
       where r.id = v_refund.id
    );
  end loop;
  return null;
end;
$$;

/* As in migration 15, naming renewals as renewals. */
create or replace function public.current_alert_conditions(p_test_mode boolean)
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
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

/* Records the registry's expiry before a renewal's first Renew call. Set once. */
create or replace function public.note_renewal_baseline(p_job_id uuid, p_expires_at timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  if p_expires_at is null then
    raise exception 'a renewal baseline needs the registry''s expiry';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'renew_domain' then
    raise exception 'job % is not a renewal', p_job_id;
  end if;
  if v_job.status <> 'running' then
    raise exception 'job % is %', p_job_id, v_job.status;
  end if;
  if v_job.baseline_expiry is null then
    update public.jobs set baseline_expiry = p_expires_at where id = p_job_id;
    return p_expires_at;
  end if;
  return v_job.baseline_expiry;
end;
$$;

/*
 * The registry has the domain renewed: record its new expiry, bring a domain
 * in its grace period back to active, and settle the order. A line that
 * renews after all takes back a refund still pending, as registrations do.
 */
create or replace function public.complete_renewal(
  p_job_id     uuid,
  p_expires_at timestamptz,
  p_recovered  boolean
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
  v_years    integer;
  v_refund   public.refunds%rowtype;
begin
  if p_expires_at is null then
    raise exception 'a renewal is recorded with the registry''s new expiry';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'renew_domain' then
    raise exception 'job % is not a renewal', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'job % is %', p_job_id, v_job.status;
  end if;

  select * into v_domain from public.domains where id = v_job.domain_id for update;

  update public.domains
     set expires_at = p_expires_at,
         local_status = case when local_status = 'expired_grace' then 'active' else local_status end
   where id = v_domain.id;

  update public.order_items set status = 'completed', failure_code = null
   where id = v_job.order_item_id
  returning order_id, period_years into v_order_id, v_years;

  update public.jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null
   where id = v_job.id;

  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_domain.id, 'renewed', 'system',
          jsonb_build_object('years', v_years, 'from', v_job.baseline_expiry, 'to', p_expires_at,
                             'recovered', p_recovered, 'sandbox', v_domain.test_mode));

  select * into v_refund from public.refunds
   where order_item_id = v_job.order_item_id and status <> 'cancelled'
   for update;
  if found then
    if v_refund.status in ('queued', 'held', 'failed', 'needs_attention')
       and v_refund.provider_refund_id is null then
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'renewed after all'));
    else
      insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
      values (v_domain.test_mode, 'registered_after_refund', v_order_id, v_refund.id::text,
              jsonb_build_object('refund_status', v_refund.status, 'amount_kobo', v_refund.amount_kobo,
                                 'renewal', true))
      on conflict do nothing;
    end if;
  end if;

  perform public.settle_order(v_order_id);
end;
$$;

revoke all on function public.note_renewal_baseline(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_renewal(uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.note_renewal_baseline(uuid, timestamptz) to service_role;
grant execute on function public.complete_renewal(uuid, timestamptz, boolean) to service_role;
