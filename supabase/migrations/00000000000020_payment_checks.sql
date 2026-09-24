-- ─────────────────────────────────────────────────────────────────────────────
-- Three payment safeguards, from the L15/L16 security review.
--
--  1. The registration worker is told which charge paid for a line, so it can
--     confirm it with Flutterwave before registering. A payment row alone —
--     which anyone holding the service key could write through
--     record_order_payment — no longer buys a domain on our float.
--  2. payments.raw keeps only the charge: ids, amounts, status and type.
--     Flutterwave's answer also carries the customer's name, email, phone, IP,
--     device fingerprint, card digits and a reusable card token. A trigger
--     strips every new row, whoever writes it, and existing rows are scrubbed
--     once, below.
--  3. The payment sweeper also looks at orders paid in the last three days,
--     and is told which charges each order already has — so a second charge
--     whose webhook and redirect were both lost is found and refunded.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 2. What of a Flutterwave transaction we keep ────────────────────────────
/* The same allowlist as transactionRecord() in @dr/shared/payments. */
create or replace function public.payment_record(p_raw jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(
           e.key,
           case when jsonb_typeof(e.value) = 'string' then to_jsonb(left(e.value #>> '{}', 200))
                else e.value end
         ), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_raw) = 'object' then p_raw else '{}'::jsonb end) e
   where e.key in ('id', 'tx_ref', 'flw_ref', 'amount', 'charged_amount', 'app_fee',
                   'merchant_fee', 'currency', 'status', 'payment_type', 'created_at')
     and jsonb_typeof(e.value) in ('string', 'number')
$$;

create or replace function public.payments_keep_record_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.raw := public.payment_record(new.raw);
  return new;
end;
$$;

create trigger payments_keep_record_only
  before insert on public.payments
  for each row execute function public.payments_keep_record_only();

-- The one sanctioned rewrite of payment rows: raw only, down to the allowlist.
-- Amounts, references and status are untouched, and the guard is back on
-- before this transaction commits.
alter table public.payments disable trigger payments_are_final;
update public.payments
   set raw = public.payment_record(raw)
 where raw is distinct from public.payment_record(raw);
alter table public.payments enable trigger payments_are_final;

-- ── 1. The charge behind a registration ──────────────────────────────────────
/* As in migration 13, plus the paying charge for a registration. */
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
           'period_years', oi.period_years,
           -- Confirmed with Flutterwave before anything is registered.
           'payment', case when v_job.kind = 'register_domain' then jsonb_build_object(
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

-- ── 3. The sweeper looks at recently paid orders too ─────────────────────────
drop function public.orders_to_check(boolean, integer);

/*
 * Orders to ask Flutterwave about, each at most every half hour, never one in
 * its first ten minutes (the redirect and the webhook usually settle those):
 * unpaid orders from the last three days, for a payment nobody reported, and
 * orders paid in the last three days, for a second charge nobody reported.
 * Returns the charges each already has, and marks what it returns.
 */
create or replace function public.orders_to_check(p_test_mode boolean, p_limit integer)
returns table (
  id               uuid,
  tx_ref           text,
  total_kobo       bigint,
  order_number     text,
  created_at       timestamptz,
  known_references text[]
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select o.id
      from public.orders o
     where o.test_mode = p_test_mode
       and o.created_at < now() - interval '10 minutes'
       and (
         (o.status in ('awaiting_payment', 'cancelled') and o.created_at > now() - interval '72 hours')
         or o.paid_at > now() - interval '72 hours'
       )
       and (o.payment_checked_at is null or o.payment_checked_at < now() - interval '30 minutes')
     order by o.payment_checked_at nulls first, o.created_at
     limit least(greatest(p_limit, 1), 100)
     for update skip locked
  ),
  marked as (
    update public.orders o
       set payment_checked_at = now()
      from due
     where o.id = due.id
    returning o.id, o.tx_ref, o.total_kobo, o.order_number, o.created_at
  )
  select m.id, m.tx_ref, m.total_kobo, m.order_number, m.created_at,
         coalesce((select array_agg(p.provider_reference order by p.created_at)
                     from public.payments p where p.order_id = m.id), '{}')
    from marked m
$$;

revoke all on function public.payment_record(jsonb) from public, anon, authenticated;
revoke all on function public.orders_to_check(boolean, integer) from public, anon, authenticated;
grant execute on function public.orders_to_check(boolean, integer) to service_role;
