-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 62: record_order_payment refunds, rather than registers, a live
-- order paid after its grace (late_payment) or a cancelled live order paid
-- past the account's daily limit (over_limit): the payment is kept, the
-- whole amount refunded, the order failed, an incident opened, nothing
-- registered and no invoice number taken. A test-mode order is not held back.
-- Only the refused paths are tried for live orders, so no live invoice number
-- is ever taken (CLAUDE.md §15). Made-up users. Rolled back.
--
--   supabase db query --linked -f supabase/tests/order_payment_guards.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- A cancelled order of n register lines, placed p_age ago.
create function pg_temp.og_order(p_user uuid, p_test boolean, p_age interval, p_lines integer) returns uuid
language plpgsql as $f$
declare
  v_id   uuid;
  v_rate uuid := (select id from public.fx_rates order by created_at desc limit 1);
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, created_at)
  values (p_user, 100000 * p_lines, 7.5, 7500 * p_lines, 107500 * p_lines, v_rate,
          'MDH-og-' || replace(gen_random_uuid()::text, '-', ''), '{}'::jsonb, 'covered', p_test, 'cancelled',
          now() - p_age)
  returning id into v_id;
  for i in 1..p_lines loop
    insert into public.order_items (order_id, domain, tld, period_years, privacy, auto_renew, price_kobo, renewal_kobo,
                                    item_type)
    values (v_id, 'og-' || i || '-' || left(replace(v_id::text, '-', ''), 10) || '.com', 'com', 1, false, false,
            100000, 100000, 'register');
  end loop;
  return v_id;
end $f$;

create function pg_temp.og_pay(p_order uuid) returns text language plpgsql as $f$
begin
  return public.record_order_payment(p_order, 'flw-og-' || replace(gen_random_uuid()::text, '-', ''),
                                     (select total_kobo from public.orders where id = p_order), 'NGN', 'card',
                                     '{}'::jsonb)::text;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u        uuid := gen_random_uuid();
  v_max    integer;
  o_late   uuid;
  o_over   uuid;
  o_test   uuid;
  v_s      text;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u, 'authenticated', 'authenticated', 'e2e-og-' || v_tag || '@example.com', now(), now(), now());
  v_max := (public.account_domain_allowance(u, false) ->> 'max')::integer;

  -- ── 1. Paid three days after it was placed: refunded whole, nothing registered.
  o_late := pg_temp.og_order(u, false, interval '3 days', 1);
  v_s := pg_temp.og_pay(o_late);
  if v_s <> 'failed'
     or (select status::text || '/' || coalesce(invoice_number, '-') from public.orders where id = o_late) <> 'failed/-'
     or not exists (select 1 from public.refunds r where r.order_id = o_late and r.reason = 'late_payment'
                     and r.amount_kobo = 107500)
     or not exists (select 1 from public.payment_incidents i where i.order_id = o_late and i.kind = 'late_payment')
     or exists (select 1 from public.domains d join public.order_items oi on oi.id = d.order_item_id
                 where oi.order_id = o_late) then
    raise exception 'FAILED 1: a late payment answered % and was not refused whole', v_s;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A cancelled order paid past the daily limit: refunded whole.
  o_over := pg_temp.og_order(u, false, interval '10 minutes', v_max + 1);
  v_s := pg_temp.og_pay(o_over);
  if v_s <> 'failed'
     or not exists (select 1 from public.refunds r where r.order_id = o_over and r.reason = 'over_limit')
     or not exists (select 1 from public.payment_incidents i where i.order_id = o_over and i.kind = 'over_limit')
     or exists (select 1 from public.jobs j join public.order_items oi on oi.id = j.order_item_id
                 where oi.order_id = o_over) then
    raise exception 'FAILED 2: a cancelled order past the limit answered % and was not refused', v_s;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. A test-mode order is never held back by either rule.
  o_test := pg_temp.og_order(u, true, interval '3 days', v_max + 1);
  v_s := pg_temp.og_pay(o_test);
  if v_s = 'failed'
     or exists (select 1 from public.refunds r where r.order_id = o_test and r.reason in ('late_payment', 'over_limit')) then
    raise exception 'FAILED 3: a test order was held back (%)', v_s;
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 62, order payment guards: % checks passed', v_passed;
end;
$$;

rollback;
