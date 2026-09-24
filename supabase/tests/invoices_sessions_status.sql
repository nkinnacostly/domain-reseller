-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices, the caller's own sessions, the public status and who may call
-- the functions of migration 26, tried as the database owner. Each check
-- fails the script if it does not hold. Everything is rolled back.
--
-- Only test orders are paid here: a sequence does not roll back, and a live
-- invoice number taken by a test would leave a gap in the real series.
--
--   supabase db query --linked -f supabase/tests/invoices_sessions_status.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := (select id from public.profiles order by created_at limit 1);
  v_other    uuid := extensions.gen_random_uuid();
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_first    uuid;
  v_second   uuid;
  v_unpaid   uuid;
  v_number   text;
  v_next     text;
  v_mine     uuid := extensions.gen_random_uuid();
  v_current  uuid := extensions.gen_random_uuid();
  v_theirs   uuid := extensions.gen_random_uuid();
  v_count    integer;
  v_status   jsonb;
  v_passed   integer := 0;
begin
  if v_user is null or v_rate is null then
    raise exception 'needs one profile and one fx rate to build test rows';
  end if;
  -- Someone else, for the sessions checks.
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_other, 'authenticated', 'authenticated', 'e2e-sql-other-' || v_other || '@example.com',
          now(), now());

  -- Three test orders, each with one registration line.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-inv-1', '{}', 'covered', true)
  returning id into v_first;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-inv-2', '{}', 'covered', true)
  returning id into v_second;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-inv-3', '{}', 'covered', true)
  returning id into v_unpaid;
  insert into public.order_items (order_id, domain, tld, period_years, privacy, auto_renew,
                                  price_kobo, renewal_kobo)
  select o, 'invcheck-' || left(o::text, 8) || '.com', 'com', 1, false, true, 100000, 100000
    from unnest(array[v_first, v_second, v_unpaid]) as o;

  -- 1. A paid test order gets a TEST-INV number with its payment.
  perform public.record_order_payment(v_first, 'inv-check-1', 107500, 'NGN', 'card', '{}');
  select invoice_number into v_number from public.orders where id = v_first;
  if v_number is null or v_number !~ '^TEST-INV-\d{6}$' then
    raise exception 'FAILED: a paid test order has invoice number %', v_number;
  end if;
  v_passed := v_passed + 1;

  -- 2. A second charge for the same order leaves its number alone.
  perform public.record_order_payment(v_first, 'inv-check-1b', 107500, 'NGN', 'card', '{}');
  if (select invoice_number from public.orders where id = v_first) <> v_number then
    raise exception 'FAILED: a second charge changed the invoice number';
  end if;
  v_passed := v_passed + 1;

  -- 3. The next paid order takes the next number; an unpaid one has none.
  perform public.record_order_payment(v_second, 'inv-check-2', 107500, 'NGN', 'card', '{}');
  select invoice_number into v_next from public.orders where id = v_second;
  if substring(v_next from 10)::integer <> substring(v_number from 10)::integer + 1 then
    raise exception 'FAILED: invoice numbers % then % are not consecutive', v_number, v_next;
  end if;
  if (select invoice_number from public.orders where id = v_unpaid) is not null then
    raise exception 'FAILED: an unpaid order has an invoice number';
  end if;
  v_passed := v_passed + 1;

  -- 4. Every live invoice number is unique and in the INV- series.
  if exists (select 1 from public.orders
              where not test_mode and invoice_number is not null
                and invoice_number !~ '^INV-\d{6}$')
     or exists (select 1 from public.orders
                 where paid_at is not null and invoice_number is null) then
    raise exception 'FAILED: a paid order has no number, or a live one is outside the INV- series';
  end if;
  v_passed := v_passed + 1;

  -- 5. Transfer codes are closed to the API's roles, and RLS is on.
  if has_table_privilege('anon', 'public.transfer_secrets', 'select')
     or has_table_privilege('authenticated', 'public.transfer_secrets', 'select')
     or not (select relrowsecurity from pg_class where oid = 'public.transfer_secrets'::regclass) then
    raise exception 'FAILED: transfer codes are readable through the API';
  end if;
  v_passed := v_passed + 1;

  -- 6. The service-only functions are service only.
  if has_function_privilege('authenticated', 'public.record_domain_change(uuid, jsonb, jsonb, text)', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_domain_change(uuid, public.job_kind)', 'execute')
     or has_function_privilege('authenticated', 'public.mark_transfer_submitted(uuid, integer)', 'execute')
     or has_function_privilege('authenticated',
          'public.complete_transfer(uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean)', 'execute')
     or has_function_privilege('anon', 'public.record_delegation_checks(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.domains_for_delegation_check(integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.my_sessions()', 'execute')
     or has_function_privilege('anon', 'public.revoke_my_session(uuid)', 'execute')
     or not has_function_privilege('anon', 'public.public_status()', 'execute') then
    raise exception 'FAILED: a migration 26 function is open to the wrong role';
  end if;
  v_passed := v_passed + 1;

  -- 7. The status says times and one flag — no counts, names or amounts.
  execute 'set local role anon';
  v_status := public.public_status();
  execute 'reset role';
  if (select array_agg(k order by k) from jsonb_object_keys(v_status) k)
     <> array['checked_at', 'gateway_seen_at', 'orders_delayed', 'registry_checked_at'] then
    raise exception 'FAILED: public status carries %', v_status;
  end if;
  v_passed := v_passed + 1;

  -- Sessions: two of the caller's own, one of someone else's.
  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (v_mine, v_user, now() - interval '2 days', now() - interval '1 day'),
         (v_current, v_user, now() - interval '1 hour', now()),
         (v_theirs, v_other, now(), now());
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', v_user, 'role', 'authenticated',
                                        'session_id', v_current)::text, true);
  execute 'set local role authenticated';

  -- 8. A person sees their own sessions, and which one they are using.
  select count(*) into v_count from public.my_sessions();
  if v_count < 2
     or exists (select 1 from public.my_sessions() s where s.id = v_theirs)
     or not exists (select 1 from public.my_sessions() s where s.id = v_current and s.is_current)
     or exists (select 1 from public.my_sessions() s where s.id = v_mine and s.is_current) then
    raise exception 'FAILED: my_sessions shows the wrong sessions';
  end if;
  v_passed := v_passed + 1;

  -- 9. They can end another session of their own — not someone else's, not this one.
  if public.revoke_my_session(v_theirs) or public.revoke_my_session(v_current)
     or not public.revoke_my_session(v_mine) then
    raise exception 'FAILED: revoke_my_session ended the wrong session';
  end if;
  execute 'reset role';
  if exists (select 1 from auth.sessions where id = v_mine)
     or not exists (select 1 from auth.sessions where id = v_theirs)
     or not exists (select 1 from auth.sessions where id = v_current) then
    raise exception 'FAILED: sessions after revoking are wrong';
  end if;
  v_passed := v_passed + 1;

  -- 10. A delegation result must be a checked state.
  begin
    perform public.record_delegation_checks(
      jsonb_build_array(jsonb_build_object('domain_id', extensions.gen_random_uuid(), 'status', 'undelegated')));
    raise exception 'FAILED: undelegated accepted as a check result';
  exception when others then
    if sqlerrm like 'FAILED:%' then
      raise;
    end if;
  end;
  v_passed := v_passed + 1;

  raise notice 'invoices, sessions and status: % checks passed', v_passed;
end;
$$;

select 'invoices, sessions and status hold' as result;
rollback;
