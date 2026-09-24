-- ─────────────────────────────────────────────────────────────────────────────
-- The housekeeping jobs of migration 21, tried as the database owner. Each
-- check fails the script if it does not hold. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/scheduled_jobs.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user    uuid := (select id from public.profiles limit 1);
  v_rate    uuid := (select id from public.fx_rates limit 1);
  v_old     uuid;
  v_young   uuid;
  v_paid    uuid;
  v_stale   uuid;
  v_fresh   uuid;
  v_active  uuid;
  v_owned   uuid;
  v_passed  integer := 0;
begin
  if v_user is null or v_rate is null then
    raise exception 'needs at least one profile and one fx rate to build test rows';
  end if;

  -- Three test orders: unpaid for two days, unpaid for an hour, and paid long ago.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode, created_at)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-jobs-old', '{}', 'covered', true,
          now() - interval '2 days')
  returning id into v_old;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode, created_at)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-jobs-young', '{}', 'covered', true,
          now() - interval '1 hour')
  returning id into v_young;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode, created_at, status, paid_at)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-jobs-paid', '{}', 'covered', true,
          now() - interval '3 days', 'completed', now() - interval '3 days')
  returning id into v_paid;

  perform public.expire_unpaid_orders();

  -- 1. An order unpaid for a day closes; a younger one and a paid one do not.
  if (select status from public.orders where id = v_old) <> 'cancelled'
     or (select status from public.orders where id = v_young) <> 'awaiting_payment'
     or (select status from public.orders where id = v_paid) <> 'completed' then
    raise exception 'FAILED: unpaid orders closed wrongly';
  end if;
  v_passed := v_passed + 1;

  -- 2. However it is called, nothing younger than an hour is closed.
  perform public.expire_unpaid_orders(interval '0 seconds');
  if (select status from public.orders where id = v_young) <> 'awaiting_payment' then
    raise exception 'FAILED: an order an hour old was closed';
  end if;
  v_passed := v_passed + 1;

  -- 3. A payment arriving for a closed order is still applied.
  insert into public.order_items (order_id, domain, tld, period_years, privacy, auto_renew,
                                  price_kobo, renewal_kobo)
  values (v_old, 'jobs-late-payment-test.com', 'com', 1, false, true, 100000, 100000);
  if public.record_order_payment(v_old, 'jobs-late-payment', 107500, 'NGN', 'banktransfer', '{}')
     <> 'paid' then
    raise exception 'FAILED: a late payment for a closed order was not applied';
  end if;
  v_passed := v_passed + 1;

  -- Carts: anonymous and idle 70 days; anonymous but touched yesterday;
  -- anonymous, old, with a line added today; and an account's, idle for a year.
  insert into public.carts (anon_token_hash, created_at, updated_at)
  values (repeat('a', 64), now() - interval '70 days', now() - interval '70 days')
  returning id into v_stale;
  insert into public.carts (anon_token_hash, created_at, updated_at)
  values (repeat('b', 64), now() - interval '1 day', now() - interval '1 day')
  returning id into v_fresh;
  insert into public.carts (anon_token_hash, created_at, updated_at)
  values (repeat('c', 64), now() - interval '90 days', now() - interval '90 days')
  returning id into v_active;
  insert into public.cart_items (cart_id, domain, tld, quoted_total_kobo, quoted_renewal_kobo,
                                 quoted_fx_rate_id)
  values (v_active, 'jobs-cart-test.com', 'com', 100000, 100000, v_rate);
  insert into public.carts (user_id, created_at, updated_at)
  select v_user, now() - interval '1 year', now() - interval '1 year'
   where not exists (select 1 from public.carts where user_id = v_user)
  returning id into v_owned;

  perform public.purge_stale_carts();

  -- 4. An idle anonymous cart goes; a recent one stays; an account's cart is never touched.
  if exists (select 1 from public.carts where id = v_stale)
     or not exists (select 1 from public.carts where id = v_fresh)
     or (v_owned is not null and not exists (select 1 from public.carts where id = v_owned)) then
    raise exception 'FAILED: stale carts purged wrongly';
  end if;
  v_passed := v_passed + 1;

  -- 5. A line added recently keeps an old cart alive.
  if not exists (select 1 from public.carts where id = v_active) then
    raise exception 'FAILED: a cart with a recent line was purged';
  end if;
  v_passed := v_passed + 1;

  -- 6. However it is called, a cart idle for less than 60 days is kept.
  perform public.purge_stale_carts(interval '1 second');
  if not exists (select 1 from public.carts where id = v_fresh) then
    raise exception 'FAILED: a cart idle for a day was purged';
  end if;
  v_passed := v_passed + 1;

  -- 7. Both jobs are scheduled, and closed to the API's roles.
  if (select count(*) from cron.job
       where jobname in ('expire-unpaid-orders', 'purge-stale-carts')) <> 2 then
    raise exception 'FAILED: the housekeeping jobs are not scheduled';
  end if;
  if has_function_privilege('service_role', 'public.expire_unpaid_orders(interval)', 'execute')
     or has_function_privilege('anon', 'public.purge_stale_carts(interval)', 'execute')
     or has_function_privilege('authenticated', 'public.purge_stale_carts(interval)', 'execute') then
    raise exception 'FAILED: housekeeping reachable through the API';
  end if;
  v_passed := v_passed + 1;

  -- 8. Closing an unpaid transfer order deletes its transfer code (migration 28);
  --    a code on an order still awaiting payment stays.
  declare
    v_transfer_old   uuid;
    v_transfer_young uuid;
    v_line_old       uuid;
    v_line_young     uuid;
  begin
    insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                               tx_ref, registrant, float_check, test_mode, created_at)
    values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-jobs-transfer-old', '{}', 'covered', true,
            now() - interval '2 days')
    returning id into v_transfer_old;
    insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                               tx_ref, registrant, float_check, test_mode, created_at)
    values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-jobs-transfer-young', '{}', 'covered', true,
            now() - interval '1 hour')
    returning id into v_transfer_young;
    insert into public.order_items (order_id, item_type, domain, tld, period_years, privacy,
                                    auto_renew, price_kobo, renewal_kobo)
    values (v_transfer_old, 'transfer', 'jobscheck-old.com', 'com', 1, false, true, 100000, 100000)
    returning id into v_line_old;
    insert into public.order_items (order_id, item_type, domain, tld, period_years, privacy,
                                    auto_renew, price_kobo, renewal_kobo)
    values (v_transfer_young, 'transfer', 'jobscheck-young.com', 'com', 1, false, true, 100000, 100000)
    returning id into v_line_young;
    insert into public.transfer_secrets (order_item_id, auth_code)
    values (v_line_old, 'CHECK-OLD'), (v_line_young, 'CHECK-YOUNG');

    perform public.expire_unpaid_orders();

    if exists (select 1 from public.transfer_secrets where order_item_id = v_line_old)
       or not exists (select 1 from public.transfer_secrets where order_item_id = v_line_young) then
      raise exception 'FAILED: transfer codes kept or deleted wrongly when unpaid orders closed';
    end if;
  end;
  v_passed := v_passed + 1;

  raise notice 'scheduled jobs: % checks passed', v_passed;
end;
$$;

select 'scheduled jobs hold' as result;
rollback;
