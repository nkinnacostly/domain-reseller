-- ─────────────────────────────────────────────────────────────────────────────
-- Tightening migration 18.
--
--  1. A refund reaches `completed` from a stopped state only through
--     record_manual_refund. Migration 18 let queued, held, failed,
--     needs_attention and cancelled refunds move straight to completed so a
--     person could record money returned in the Flutterwave dashboard — which
--     also let any plain UPDATE do it. Now the trigger allows it only while
--     record_manual_refund has marked that one refund, inside its own
--     transaction.
--  2. No money check can be skipped by a NULL. In SQL a comparison with NULL
--     is neither true nor false, and `if not (… NULL …)` does not raise. Every
--     nullable input to a guard is now given an explicit, safe value: an
--     unknown "was it sent?" counts as sent; an unknown "needs a person?"
--     counts as yes; a missing error code never counts as "Flutterwave said
--     it failed".
-- ─────────────────────────────────────────────────────────────────────────────

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
                and coalesce(old.last_error_code, '') = 'PROVIDER_REFUND_FAILED'
                and new.status = 'queued'
                and old.provider_refund_id = any (new.failed_provider_refund_ids)) then
      raise exception 'a refund keeps its provider reference';
    end if;
    if new.status = old.status then
      return new;
    end if;
    if not (
         (old.status = 'queued'          and new.status in ('held', 'sending', 'cancelled'))
      or (old.status = 'held'            and new.status in ('queued', 'cancelled'))
      or (old.status = 'sending'         and new.status in ('queued', 'submitted', 'completed', 'failed', 'needs_attention'))
      or (old.status = 'submitted'       and new.status in ('completed', 'failed', 'needs_attention'))
      or (old.status = 'failed'          and new.status in ('queued', 'cancelled'))
      or (old.status = 'needs_attention' and new.status in ('queued', 'cancelled'))
      or (old.status = 'cancelled'       and new.status in ('queued'))
      -- Money a person returned by hand: only through record_manual_refund.
      or (new.status = 'completed'
          and old.status in ('queued', 'held', 'failed', 'needs_attention', 'cancelled')
          and coalesce(current_setting('app.manual_refund', true), '') = new.id::text)
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
  v_status public.refund_status := case when coalesce(p_needs_attention, true)
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
  v_sent   boolean := coalesce(p_sent, true);
begin
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;
  if not v_sent and (v_refund.status <> 'sending' or v_refund.provider_called_at is not null) then
    raise exception 'refund % may have reached Flutterwave', p_refund_id;
  end if;
  update public.refunds
     set status = case when v_sent then v_refund.status else 'queued' end,
         run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
         last_error_code = left(p_code, 60), last_error = left(p_message, 500),
         locked_by = null, locked_at = null
   where id = v_refund.id;
end;
$$;

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
    if not (v_refund.status = 'failed'
            and coalesce(v_refund.last_error_code, '') = 'PROVIDER_REFUND_FAILED') then
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
  perform set_config('app.manual_refund', p_refund_id::text, true);
  perform public.finish_refund(p_refund_id, p_provider_refund_id, 'manual', p_by);
  perform set_config('app.manual_refund', '', true);
end;
$$;

revoke all on function public.record_manual_refund(uuid, text, text) from public, anon, authenticated, service_role;
