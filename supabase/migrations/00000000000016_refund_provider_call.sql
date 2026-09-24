-- ─────────────────────────────────────────────────────────────────────────────
-- When a refund worker dies mid-send, did the refund reach Flutterwave?
--
-- Flutterwave's v3 refund call has no idempotency key, so after a crash or a
-- timeout the worker reads the charge's refunds back instead of sending again
-- (I2). That read cannot tell "never sent" from "sent, not yet listed", so
-- the worker notes the moment it calls Flutterwave. No note on this attempt
-- means the call never happened, and the refund is simply sent again — only a
-- noted call that cannot be found at Flutterwave needs a person.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.refunds add column provider_called_at timestamptz;

/* Called immediately before the refund request goes to Flutterwave. */
create or replace function public.note_refund_provider_call(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.refunds set provider_called_at = now()
   where id = p_refund_id and status = 'sending';
  if not found then
    raise exception 'refund % is not being sent', p_refund_id;
  end if;
  insert into public.refund_events (refund_id, event) values (p_refund_id, 'provider_call');
end;
$$;

/* As in migration 15, plus: a new send clears the note, and the claim reports it. */
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
  v_lapsed timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
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
               'order_number', o.order_number,
               'domain_name', oi.domain,
               'known_provider_refund_ids', (
                 select coalesce(jsonb_agg(r2.provider_refund_id), '[]'::jsonb)
                   from public.refunds r2
                  where r2.payment_id = r.payment_id
                    and r2.id <> r.id
                    and r2.provider_refund_id is not null
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

/* As in migration 15, plus: "never sent" is refused once Flutterwave was called. */
create or replace function public.reschedule_refund(
  p_refund_id     uuid,
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
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('sending', 'submitted') then
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

revoke all on function public.note_refund_provider_call(uuid) from public, anon, authenticated;
grant execute on function public.note_refund_provider_call(uuid) to service_role;
