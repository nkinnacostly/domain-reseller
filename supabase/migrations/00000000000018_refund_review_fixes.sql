-- ─────────────────────────────────────────────────────────────────────────────
-- Fixes from an adversarial review of refunds (migrations 15–17).
--
--  1. Fencing. Every worker call names the worker that claimed the refund, and
--     is refused if that claim has passed to another. Two gateways on one side
--     can no longer both send the same refund after a stall.
--  2. A retried refund never keeps a live Flutterwave reference. Retrying is
--     allowed only when Flutterwave said the earlier refund failed; its id is
--     kept in history and the new attempt gets its own.
--  3. record_manual_refund, for money a person returned in the dashboard —
--     so "refunded by hand" is recorded, not written off as "cancelled".
--  4. Retrying a failed registration cancels the line's pending refund first,
--     and refuses if money is already on its way; a registration that lands
--     over a refund raises an incident.
--  5. The payment sweeper's queue: unpaid orders to ask Flutterwave about,
--     so a charge whose webhook and redirect were both lost is still found.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.refunds
  add column failed_provider_refund_ids text[] not null default '{}';

alter table public.orders add column payment_checked_at timestamptz;

alter table public.payment_incidents drop constraint payment_incidents_kind_check;
alter table public.payment_incidents add constraint payment_incidents_kind_check check (kind in (
  'underpayment',
  'tx_ref_mismatch',
  'currency_mismatch',
  'unrecorded_payment',
  'refund_not_created',
  'mode_mismatch',            -- a test payment presented for a live order, or the reverse
  'registered_after_refund'   -- a line registered while its refund was on its way
));

-- ── The money rules, with the two new paths ──────────────────────────────────
create or replace function public.refunds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_payment  public.payments%rowtype;
  v_refunded bigint;
begin
  if tg_op = 'UPDATE' then
    if old.status = 'completed' then
      raise exception 'a completed refund is final';
    end if;
    if new.order_id <> old.order_id
       or new.payment_id <> old.payment_id
       or new.order_item_id is distinct from old.order_item_id
       or new.user_id <> old.user_id
       or new.reason <> old.reason
       or new.amount_kobo <> old.amount_kobo
       or new.test_mode <> old.test_mode then
      raise exception 'a refund''s amount and target never change';
    end if;
    if not (old.failed_provider_refund_ids <@ new.failed_provider_refund_ids) then
      raise exception 'a refund''s failed references are only ever added to';
    end if;
    -- A reference is kept, except that one Flutterwave reported failed may be
    -- set aside when a person retries (retry_refund keeps it in history).
    if old.provider_refund_id is not null
       and new.provider_refund_id is distinct from old.provider_refund_id
       and not (new.provider_refund_id is null
                and old.status = 'failed'
                and old.last_error_code = 'PROVIDER_REFUND_FAILED'
                and new.status = 'queued'
                and old.provider_refund_id = any (new.failed_provider_refund_ids)) then
      raise exception 'a refund keeps its provider reference';
    end if;
    if new.status = old.status then
      return new;
    end if;
    if not (
         (old.status = 'queued'          and new.status in ('held', 'sending', 'cancelled', 'completed'))
      or (old.status = 'held'            and new.status in ('queued', 'cancelled', 'completed'))
      or (old.status = 'sending'         and new.status in ('queued', 'submitted', 'completed', 'failed', 'needs_attention'))
      or (old.status = 'submitted'       and new.status in ('completed', 'failed', 'needs_attention'))
      or (old.status = 'failed'          and new.status in ('queued', 'cancelled', 'completed'))
      or (old.status = 'needs_attention' and new.status in ('queued', 'cancelled', 'completed'))
      or (old.status = 'cancelled'       and new.status in ('queued', 'completed'))
    ) then
      raise exception 'a refund cannot move from % to %', old.status, new.status;
    end if;
  end if;

  select * into v_payment from public.payments where id = new.payment_id for update;
  if not found or v_payment.order_id <> new.order_id then
    raise exception 'a refund goes back to a charge on its own order';
  end if;
  if v_payment.currency <> 'NGN' then
    raise exception 'only naira charges are refunded automatically';
  end if;

  if new.status <> 'cancelled' then
    select coalesce(sum(r.amount_kobo), 0) into v_refunded
      from public.refunds r
     where r.payment_id = new.payment_id
       and r.id <> new.id
       and r.status <> 'cancelled';
    if v_refunded + new.amount_kobo > v_payment.amount_kobo then
      raise exception 'refunds would exceed charge % (% + % > %)',
        v_payment.provider_reference, v_refunded, new.amount_kobo, v_payment.amount_kobo
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ── The worker's side, fenced by who holds the claim ─────────────────────────
drop function public.note_refund_provider_call(uuid);
drop function public.record_refund_submitted(uuid, text, text, integer);
drop function public.complete_refund(uuid, text, text);
drop function public.fail_refund(uuid, text, text, boolean);
drop function public.reschedule_refund(uuid, integer, text, text, boolean);

/* The refund, locked, if `p_worker` still holds its claim. Otherwise refused. */
create or replace function public.claimed_refund(p_refund_id uuid, p_worker text)
returns public.refunds
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund % not found', p_refund_id;
  end if;
  if v_refund.locked_by is distinct from p_worker then
    raise exception 'refund % is not claimed by %', p_refund_id, p_worker;
  end if;
  return v_refund;
end;
$$;

create or replace function public.note_refund_provider_call(p_refund_id uuid, p_worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype := public.claimed_refund(p_refund_id, p_worker);
begin
  if v_refund.status <> 'sending' then
    raise exception 'refund % is not being sent', p_refund_id;
  end if;
  update public.refunds set provider_called_at = now() where id = p_refund_id;
  insert into public.refund_events (refund_id, event) values (p_refund_id, 'provider_call');
end;
$$;

create or replace function public.record_refund_submitted(
  p_refund_id           uuid,
  p_worker              text,
  p_provider_refund_id  text,
  p_provider_status     text,
  p_check_after_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype := public.claimed_refund(p_refund_id, p_worker);
begin
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;
  update public.refunds
     set status = 'submitted',
         provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         provider_status = left(p_provider_status, 40),
         submitted_at = coalesce(submitted_at, now()),
         run_after = now() + make_interval(secs => greatest(p_check_after_seconds, 30)),
         locked_by = null, locked_at = null,
         last_error_code = null, last_error = null
   where id = v_refund.id;
  if v_refund.status = 'sending' then
    insert into public.refund_events (refund_id, event, detail)
    values (v_refund.id, 'submitted',
            jsonb_build_object('provider_refund_id', p_provider_refund_id, 'status', p_provider_status));
  end if;
end;
$$;

/* The money is back with the customer. A refunded line is marked so. Final. */
create or replace function public.finish_refund(
  p_refund_id          uuid,
  p_provider_refund_id text,
  p_provider_status    text,
  p_actor              text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id;
  update public.refunds
     set status = 'completed',
         provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         provider_status = left(p_provider_status, 40),
         submitted_at = coalesce(submitted_at, now()),
         completed_at = now(),
         locked_by = null, locked_at = null,
         last_error_code = null, last_error = null
   where id = p_refund_id;

  insert into public.refund_events (refund_id, event, actor, detail)
  values (p_refund_id, 'completed', p_actor,
          jsonb_build_object('provider_refund_id', coalesce(v_refund.provider_refund_id, p_provider_refund_id),
                             'status', p_provider_status));

  if v_refund.order_item_id is not null then
    update public.order_items set status = 'refunded'
     where id = v_refund.order_item_id and status = 'failed';
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'refunded', 'system',
           jsonb_build_object('amount_kobo', v_refund.amount_kobo, 'sandbox', v_refund.test_mode)
      from public.domains d
     where d.order_item_id = v_refund.order_item_id;
  end if;
end;
$$;

create or replace function public.complete_refund(
  p_refund_id          uuid,
  p_worker             text,
  p_provider_refund_id text,
  p_provider_status    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype := public.claimed_refund(p_refund_id, p_worker);
begin
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is %', p_refund_id, v_refund.status;
  end if;
  perform public.finish_refund(p_refund_id, p_provider_refund_id, p_provider_status, 'system');
end;
$$;

/*
 * Stops a refund for a person. `p_provider_refund_id` keeps Flutterwave's
 * reference when money did move (an amount that differs, say), in the same
 * statement — a crash cannot separate the two.
 */
create or replace function public.fail_refund(
  p_refund_id          uuid,
  p_worker             text,
  p_code               text,
  p_message            text,
  p_needs_attention    boolean,
  p_provider_refund_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype := public.claimed_refund(p_refund_id, p_worker);
  v_status public.refund_status := case when p_needs_attention
                                        then 'needs_attention' else 'failed' end;
begin
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;
  update public.refunds
     set status = v_status,
         provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         submitted_at = case when p_provider_refund_id is not null
                             then coalesce(submitted_at, now()) else submitted_at end,
         last_error_code = left(p_code, 60), last_error = left(p_message, 500),
         locked_by = null, locked_at = null
   where id = v_refund.id;
  insert into public.refund_events (refund_id, event, detail)
  values (v_refund.id, v_status::text,
          jsonb_strip_nulls(jsonb_build_object('code', p_code, 'provider_refund_id', p_provider_refund_id)));
end;
$$;

create or replace function public.reschedule_refund(
  p_refund_id     uuid,
  p_worker        text,
  p_delay_seconds integer,
  p_code          text,
  p_message       text,
  p_sent          boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype := public.claimed_refund(p_refund_id, p_worker);
begin
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;
  if not p_sent and (v_refund.status <> 'sending' or v_refund.provider_called_at is not null) then
    raise exception 'refund % may have reached Flutterwave', p_refund_id;
  end if;
  update public.refunds
     set status = case when p_sent then v_refund.status else 'queued' end,
         run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
         last_error_code = left(p_code, 60), last_error = left(p_message, 500),
         locked_by = null, locked_at = null
   where id = v_refund.id;
end;
$$;

/* As in migration 16, plus: a sane lease, and what the new checks need. */
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

-- ── A person's side ──────────────────────────────────────────────────────────

/*
 * Tries again. A refund that reached Flutterwave may be retried only when
 * Flutterwave reported it failed — no money moved — and its reference is set
 * aside so the new attempt gets its own. Anything else that reached
 * Flutterwave is settled with record_manual_refund or cancel_refund.
 */
create or replace function public.retry_refund(p_refund_id uuid, p_by text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  if coalesce(trim(p_by), '') = '' then
    raise exception 'say who retried it';
  end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('failed', 'needs_attention', 'cancelled') then
    raise exception 'refund % cannot be retried from its current state', p_refund_id;
  end if;

  if v_refund.provider_refund_id is not null then
    if not (v_refund.status = 'failed' and v_refund.last_error_code = 'PROVIDER_REFUND_FAILED') then
      raise exception 'refund % reached Flutterwave as %: check the dashboard, then use record_manual_refund or cancel_refund',
        p_refund_id, v_refund.provider_refund_id;
    end if;
    update public.refunds
       set failed_provider_refund_ids = array_append(failed_provider_refund_ids, provider_refund_id),
           provider_refund_id = null, provider_status = null, submitted_at = null,
           status = 'queued', attempts = 0, run_after = now(),
           approved_by = coalesce(approved_by, p_by), approved_at = coalesce(approved_at, now())
     where id = p_refund_id;
  else
    update public.refunds
       set status = 'queued', attempts = 0, run_after = now(),
           approved_by = coalesce(approved_by, p_by), approved_at = coalesce(approved_at, now())
     where id = p_refund_id;
  end if;
  insert into public.refund_events (refund_id, event, actor) values (p_refund_id, 'retried', p_by);
end;
$$;

/* Money a person returned through the Flutterwave dashboard. */
create or replace function public.record_manual_refund(
  p_refund_id          uuid,
  p_provider_refund_id text,
  p_by                 text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  if coalesce(trim(p_by), '') = '' or coalesce(trim(p_provider_refund_id), '') = '' then
    raise exception 'say who refunded it, and give Flutterwave''s refund id';
  end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('queued', 'held', 'failed', 'needs_attention', 'cancelled') then
    raise exception 'refund % cannot be recorded from its current state', p_refund_id;
  end if;
  if v_refund.provider_refund_id is not null and v_refund.provider_refund_id <> p_provider_refund_id then
    raise exception 'refund % already has Flutterwave reference %', p_refund_id, v_refund.provider_refund_id;
  end if;
  perform public.finish_refund(p_refund_id, p_provider_refund_id, 'manual', p_by);
end;
$$;

-- ── Registrations and refunds never both ─────────────────────────────────────
/*
 * As in migration 15, plus: a line whose refund was cancelled when its
 * registration was retried, and which has now failed again, gets that refund
 * back. Without this the one-refund-per-line index would swallow the new one
 * and the customer would be owed money nobody is sending. Limits apply again:
 * an earlier approval does not carry over.
 */
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
                               'registration_failed', v_amount, null);
end;
$$;

/*
 * As in migration 13, plus: retrying a failed registration first cancels its
 * line's pending refund — and refuses if that refund has reached Flutterwave
 * — then reopens the line and the order so they settle again.
 */
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

  if v_job.kind = 'register_domain' and v_job.status = 'failed' then
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
    update public.domains set local_status = 'pending'
     where id = v_job.domain_id and local_status = 'registration_failed';
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

/*
 * As in migration 13, plus: a line that registers after all takes back its
 * pending refund, and if the refund had already reached Flutterwave, that is
 * an incident — the customer may now have both.
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
  v_refund   public.refunds%rowtype;
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

  select * into v_refund from public.refunds
   where order_item_id = v_job.order_item_id and status <> 'cancelled'
   for update;
  if found then
    if v_refund.status in ('queued', 'held', 'failed', 'needs_attention')
       and v_refund.provider_refund_id is null then
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'registered after all'));
    else
      insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
      values (v_domain.test_mode, 'registered_after_refund', v_order_id, v_refund.id::text,
              jsonb_build_object('refund_status', v_refund.status, 'amount_kobo', v_refund.amount_kobo))
      on conflict do nothing;
    end if;
  end if;

  perform public.settle_order(v_order_id);
  return 'active';
end;
$$;

-- ── The payment sweeper's queue ──────────────────────────────────────────────
/*
 * Unpaid orders from the last three days to ask Flutterwave about, each at
 * most every half hour, never one still in its first ten minutes (the
 * redirect and the webhook usually settle those). Marks what it returns.
 */
create or replace function public.orders_to_check(p_test_mode boolean, p_limit integer)
returns table (id uuid, tx_ref text, total_kobo bigint, order_number text)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select o.id
      from public.orders o
     where o.test_mode = p_test_mode
       and o.status in ('awaiting_payment', 'cancelled')
       and o.created_at > now() - interval '72 hours'
       and o.created_at < now() - interval '10 minutes'
       and (o.payment_checked_at is null or o.payment_checked_at < now() - interval '30 minutes')
     order by o.payment_checked_at nulls first, o.created_at
     limit least(greatest(p_limit, 1), 100)
     for update skip locked
  )
  update public.orders o
     set payment_checked_at = now()
    from due
   where o.id = due.id
  returning o.id, o.tx_ref, o.total_kobo, o.order_number
$$;

-- ── Who may do what ──────────────────────────────────────────────────────────
revoke all on function public.claimed_refund(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_refund(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.record_manual_refund(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.retry_refund(uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.note_refund_provider_call(uuid, text) from public, anon, authenticated;
revoke all on function public.record_refund_submitted(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.complete_refund(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_refund(uuid, text, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.reschedule_refund(uuid, text, integer, text, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_refund(text, boolean, integer) from public, anon, authenticated;
revoke all on function public.retry_job(uuid) from public, anon, authenticated;
revoke all on function public.complete_registration(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.orders_to_check(boolean, integer) from public, anon, authenticated;

grant execute on function public.note_refund_provider_call(uuid, text) to service_role;
grant execute on function public.record_refund_submitted(uuid, text, text, text, integer) to service_role;
grant execute on function public.complete_refund(uuid, text, text, text) to service_role;
grant execute on function public.fail_refund(uuid, text, text, text, boolean, text) to service_role;
grant execute on function public.reschedule_refund(uuid, text, integer, text, text, boolean) to service_role;
grant execute on function public.claim_refund(text, boolean, integer) to service_role;
grant execute on function public.retry_job(uuid) to service_role;
grant execute on function public.complete_registration(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, text, text)
  to service_role;
grant execute on function public.orders_to_check(boolean, integer) to service_role;
