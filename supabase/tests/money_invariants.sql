-- ─────────────────────────────────────────────────────────────────────────────
-- The money rules of migrations 15, 16 and 18–20, tried as the database owner — who
-- bypasses the grants the service key is held to, so only the triggers stand
-- in the way. Each check tries something forbidden and fails the script if it
-- is allowed. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/money_invariants.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := (select id from public.profiles limit 1);
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_order    uuid;
  v_live     uuid;
  v_payment  uuid;
  v_livepay  uuid;
  v_refund   uuid;
  v_second   uuid;
  v_order2   uuid;
  v_pay2     uuid;
  v_r2       uuid;
  v_r3       uuid;
  v_r4       uuid;
  v_item1    uuid;
  v_item2    uuid;
  v_dom1     uuid;
  v_dom2     uuid;
  v_job1     uuid;
  v_job2     uuid;
  v_line1    uuid;
  v_line2    uuid;
  v_passed   integer := 0;

begin
  if v_user is null or v_rate is null then
    raise exception 'needs at least one profile and one fx rate to build test rows';
  end if;

  -- A test order and a live one, each paid ₦20,000 exactly.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 1860465, 7.5, 139535, 2000000, v_rate, 'MDH-invariants-test', '{}', 'covered', true)
  returning id into v_order;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 1860465, 7.5, 139535, 2000000, v_rate, 'MDH-invariants-live', '{}', 'covered', false)
  returning id into v_live;

  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_order, v_user, 'flutterwave', 'invariants-test', 'MDH-invariants-test', 2000000,
          'NGN', 'successful', 'card', '{}')
  returning id into v_payment;
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_live, v_user, 'flutterwave', 'invariants-live', 'MDH-invariants-live', 2000000,
          'NGN', 'successful', 'card', '{}')
  returning id into v_livepay;

  -- 1. Refunds up to the charge are fine…
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order, v_payment, v_user, 'duplicate_charge', 1500000, true)
  returning id into v_refund;
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order, v_payment, v_user, 'overpayment', 500000, true)
  returning id into v_second;
  v_passed := v_passed + 1;

  -- 2. …but not one kobo more.
  begin
    insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
    values (v_order, v_payment, v_user, 'underpayment', 1, true);
    raise exception 'FAILED: refunds exceeded the charge';
  exception when check_violation then v_passed := v_passed + 1;
  end;

  -- 3. A refund goes back to a charge on its own order.
  begin
    insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
    values (v_live, v_payment, v_user, 'empty_order', 1, false);
    raise exception 'FAILED: refund pointed at another order''s charge';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 4. Its amount never changes.
  begin
    update public.refunds set amount_kobo = 1400000 where id = v_refund;
    raise exception 'FAILED: refund amount changed';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 5. Status moves only along the allowed paths.
  begin
    update public.refunds set status = 'completed' where id = v_refund;
    raise exception 'FAILED: queued jumped to completed';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 6. A cancelled refund frees its share of the charge; re-opening it counts again.
  update public.refunds set status = 'cancelled' where id = v_second;
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order, v_payment, v_user, 'underpayment', 500000, true);
  begin
    update public.refunds set status = 'queued' where id = v_second;
    raise exception 'FAILED: re-opened refund was not counted';
  exception when check_violation then v_passed := v_passed + 1;
  end;

  -- 7. A completed refund is final.
  update public.refunds set status = 'sending' where id = v_refund;
  update public.refunds set status = 'completed', provider_refund_id = 'inv-1' where id = v_refund;
  begin
    update public.refunds set last_error = 'tamper' where id = v_refund;
    raise exception 'FAILED: completed refund was edited';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 8. Live payments are never rewritten or deleted.
  begin
    update public.payments set amount_kobo = 1 where id = v_livepay;
    raise exception 'FAILED: live payment rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;
  begin
    delete from public.payments where id = v_livepay;
    raise exception 'FAILED: live payment deleted';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 9. Nor are live refunds, or any refund's history.
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_live, v_livepay, v_user, 'duplicate_charge', 100000, false)
  returning id into v_second;
  begin
    delete from public.refunds where id = v_second;
    raise exception 'FAILED: live refund deleted';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;
  insert into public.refund_events (refund_id, event) values (v_refund, 'invariants');
  begin
    update public.refund_events set event = 'tampered' where refund_id = v_refund;
    raise exception 'FAILED: refund history rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 10. The purge refuses an account with live orders.
  begin
    perform public.purge_test_orders(v_user);
    raise exception 'FAILED: purge ran over live orders';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- ── Migration 18 ───────────────────────────────────────────────────────────
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 1860465, 7.5, 139535, 2000000, v_rate, 'MDH-invariants-retry', '{}', 'covered', true)
  returning id into v_order2;
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_order2, v_user, 'flutterwave', 'invariants-retry', 'MDH-invariants-retry', 2000000,
          'NGN', 'successful', 'card', '{}')
  returning id into v_pay2;
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order2, v_pay2, v_user, 'duplicate_charge', 1000000, true)
  returning id into v_r2;
  update public.refunds set status = 'sending', locked_by = 'worker-a', locked_at = now()
   where id = v_r2;

  -- 12. A worker acts only on a refund it still holds.
  begin
    perform public.note_refund_provider_call(v_r2, 'worker-b');
    raise exception 'FAILED: a worker acted on another''s claim';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 13. Retrying a refund Flutterwave reported failed sets its reference
  --     aside, so the new attempt gets its own and the old one is known.
  perform public.note_refund_provider_call(v_r2, 'worker-a');
  perform public.record_refund_submitted(v_r2, 'worker-a', 'inv-flw-A', 'completed', 600);
  update public.refunds set locked_by = 'worker-a', locked_at = now() where id = v_r2;
  perform public.fail_refund(v_r2, 'worker-a', 'PROVIDER_REFUND_FAILED', 'disbursement failed', false);
  perform public.retry_refund(v_r2, 'invariants');
  if not exists (
    select 1 from public.refunds
     where id = v_r2 and status = 'queued' and provider_refund_id is null
       and failed_provider_refund_ids = array['inv-flw-A']
  ) then
    raise exception 'FAILED: retry did not set the failed reference aside';
  end if;
  v_passed := v_passed + 1;

  -- 14. That history is only ever added to.
  begin
    update public.refunds set failed_provider_refund_ids = '{}' where id = v_r2;
    raise exception 'FAILED: failed references were erased';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 15. A refund that reached Flutterwave any other way is never retried…
  update public.refunds set status = 'sending', locked_by = 'worker-a', locked_at = now()
   where id = v_r2;
  perform public.fail_refund(v_r2, 'worker-a', 'AMOUNT_MISMATCH', 'short', true, 'inv-flw-B');
  begin
    perform public.retry_refund(v_r2, 'invariants');
    raise exception 'FAILED: a refund with money at Flutterwave was retried';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 16. …and its reference cannot be dropped by hand.
  begin
    update public.refunds set provider_refund_id = null, status = 'queued' where id = v_r2;
    raise exception 'FAILED: provider reference dropped';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 17. Money returned by hand is recorded under its own reference only.
  begin
    perform public.record_manual_refund(v_r2, 'inv-flw-C', 'invariants');
    raise exception 'FAILED: manual refund recorded under another reference';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;
  perform public.record_manual_refund(v_r2, 'inv-flw-B', 'invariants');
  if not exists (select 1 from public.refunds where id = v_r2 and status = 'completed') then
    raise exception 'FAILED: manual refund not recorded';
  end if;
  v_passed := v_passed + 1;

  -- 18. A claim's lease is between a minute and an hour.
  begin
    perform public.claim_refund('invariants', true, 5);
    raise exception 'FAILED: a five-second lease was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 20. A missing error code never counts as "Flutterwave said it failed".
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order2, v_pay2, v_user, 'overpayment', 500000, true)
  returning id into v_r3;
  update public.refunds set status = 'sending', locked_by = 'worker-a', locked_at = now()
   where id = v_r3;
  perform public.note_refund_provider_call(v_r3, 'worker-a');
  perform public.fail_refund(v_r3, 'worker-a', null, 'no code', false, 'inv-flw-D');
  begin
    perform public.retry_refund(v_r3, 'invariants');
    raise exception 'FAILED: a refund with no error code was retried past its reference';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;
  begin
    update public.refunds
       set failed_provider_refund_ids = array_append(failed_provider_refund_ids, provider_refund_id),
           provider_refund_id = null, status = 'queued'
     where id = v_r3;
    raise exception 'FAILED: the trigger let a NULL code drop a reference';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  -- 21. An unknown "was it sent?" counts as sent: the refund stays in flight.
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order2, v_pay2, v_user, 'empty_order', 100000, true)
  returning id into v_r4;
  update public.refunds set status = 'sending', locked_by = 'worker-a', locked_at = now()
   where id = v_r4;
  perform public.reschedule_refund(v_r4, 'worker-a', 0, 'X', 'X', null);
  if not exists (select 1 from public.refunds where id = v_r4 and status = 'sending') then
    raise exception 'FAILED: a NULL "sent" put the refund back in the queue';
  end if;
  v_passed := v_passed + 1;

  -- 22. A line is never both registered and refunded.
  insert into public.order_items (order_id, domain, tld, period_years, privacy, auto_renew,
                                  price_kobo, renewal_kobo, status)
  values (v_order2, 'invariants-line-one.com', 'com', 1, false, true, 150000, 150000, 'failed')
  returning id into v_item1;
  insert into public.order_items (order_id, domain, tld, period_years, privacy, auto_renew,
                                  price_kobo, renewal_kobo, status)
  values (v_order2, 'invariants-line-two.com', 'com', 1, false, true, 150000, 150000, 'provisioning')
  returning id into v_item2;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, order_item_id, local_status)
  values (v_user, 'invariants-line-one.com', 'com', 'registration', true, v_item1, 'registration_failed')
  returning id into v_dom1;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, order_item_id, local_status)
  values (v_user, 'invariants-line-two.com', 'com', 'registration', true, v_item2, 'pending')
  returning id into v_dom2;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('register_domain', 'invariants:' || v_item1, v_dom1, v_item1, true, 'failed')
  returning id into v_job1;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('register_domain', 'invariants:' || v_item2, v_dom2, v_item2, true, 'running')
  returning id into v_job2;
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode)
  values (v_order2, v_pay2, v_item1, v_user, 'registration_failed', 150000, true)
  returning id into v_line1;
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode)
  values (v_order2, v_pay2, v_item2, v_user, 'registration_failed', 150000, true)
  returning id into v_line2;

  --     Retrying the registration takes back its pending refund…
  perform public.retry_job(v_job1);
  if not exists (select 1 from public.refunds where id = v_line1 and status = 'cancelled')
     or not exists (select 1 from public.order_items where id = v_item1 and status = 'pending') then
    raise exception 'FAILED: a retried registration kept its refund';
  end if;
  --     …and failing again brings the same refund back, needing approval afresh.
  update public.jobs set status = 'running' where id = v_job1;
  perform public.fail_job(v_job1, 'DOMAIN_TAKEN', 'still taken', false);
  if not exists (select 1 from public.refunds
                  where id = v_line1 and status = 'queued' and approved_at is null) then
    raise exception 'FAILED: a line that failed again was not refunded';
  end if;
  v_passed := v_passed + 1;

  --     Once the refund may have reached Flutterwave, the registration is not retried.
  update public.refunds set status = 'sending' where id = v_line1;
  begin
    perform public.retry_job(v_job1);
    raise exception 'FAILED: registration retried with its refund in flight';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
    v_passed := v_passed + 1;
  end;

  --     A line that registers after all takes back a refund that has not left…
  perform public.complete_registration(v_job2, now(), now() + interval '1 year', '{}',
                                       true, false, false, 'none');
  if not exists (select 1 from public.refunds where id = v_line2 and status = 'cancelled') then
    raise exception 'FAILED: a registered line kept its pending refund';
  end if;
  --     …and one that has left is an incident for a person.
  update public.jobs set status = 'running' where id = v_job1;
  perform public.complete_registration(v_job1, now(), now() + interval '1 year', '{}',
                                       true, false, false, 'none');
  if not exists (select 1 from public.payment_incidents
                  where order_id = v_order2 and kind = 'registered_after_refund'
                    and provider_reference = v_line1::text) then
    raise exception 'FAILED: registered-after-refund raised no incident';
  end if;
  v_passed := v_passed + 1;

  -- 23. A payment keeps no customer or card details, whoever writes it.
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_order2, v_user, 'flutterwave', 'invariants-pii', 'MDH-invariants-retry', 100,
          'NGN', 'underpaid', 'card',
          '{"id": 1, "status": "successful", "customer": {"email": "a@b.co"}, "card": {"token": "t"}, "ip": "1.2.3.4"}');
  if (select raw from public.payments where provider_reference = 'invariants-pii')
     is distinct from '{"id": 1, "status": "successful"}'::jsonb then
    raise exception 'FAILED: a payment kept customer or card details';
  end if;
  v_passed := v_passed + 1;

  -- 19. The service key cannot record a manual refund or skip the fencing.
  if has_function_privilege('service_role', 'public.record_manual_refund(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.claimed_refund(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.finish_refund(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.orders_to_check(boolean, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.orders_to_check(boolean, integer)', 'execute') then
    raise exception 'FAILED: refund internals reachable beyond the worker';
  end if;
  if not has_function_privilege('service_role', 'public.complete_refund(uuid, text, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.orders_to_check(boolean, integer)', 'execute') then
    raise exception 'FAILED: the worker cannot reach its own functions';
  end if;
  v_passed := v_passed + 1;

  -- 11. The service key cannot approve, retry or cancel refunds.
  if has_function_privilege('service_role', 'public.approve_refund(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.retry_refund(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.cancel_refund(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.enqueue_refund(uuid, uuid, uuid, public.refund_reason, bigint, integer)', 'execute') then
    raise exception 'FAILED: the service key can decide refunds';
  end if;
  if has_table_privilege('service_role', 'public.refunds', 'insert')
     or has_table_privilege('service_role', 'public.payments', 'update')
     or has_table_privilege('service_role', 'public.ops_settings', 'update') then
    raise exception 'FAILED: the service key can write money rows';
  end if;
  if has_function_privilege('anon', 'public.my_order_refunds(uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.refunds', 'select') then
    raise exception 'FAILED: refunds readable beyond their owner''s view';
  end if;
  v_passed := v_passed + 1;

  raise notice 'money invariants: % checks passed', v_passed;
end;
$$;

select 'money invariants hold' as result;
rollback;
