-- ─────────────────────────────────────────────────────────────────────────────
-- Notification emails (migration 31), tried as the database owner. Each
-- check fails the script if it does not hold. Everything is rolled back, and
-- nothing is sent: sending is the gateway's, and these rows never reach it.
--
--   supabase db query --linked -f supabase/tests/notification_emails.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := extensions.gen_random_uuid();
  v_e2e      uuid := extensions.gen_random_uuid();
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_domain   uuid;
  v_demo     uuid;
  v_live     uuid;
  v_soon     uuid;
  v_gone     uuid;
  v_dark     uuid;
  v_old      uuid;
  v_order    uuid;
  v_payment  uuid;
  v_refund   uuid;
  v_email    uuid;
  v_row      public.email_outbox;
  v_count    integer;
  v_flag     boolean;
  v_worker   text := 'email-check-' || extensions.gen_random_uuid();
  v_passed   integer := 0;
begin
  if v_rate is null then
    raise exception 'needs one fx rate to build test rows';
  end if;
  -- One account at an address that could receive mail, one at example.com.
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'email-check-' || v_user || '@mydomainshub.com', now(), now()),
         (v_e2e, 'authenticated', 'authenticated', 'e2e-email-check-' || v_e2e || '@example.com', now(), now());

  -- 1. Reserved addresses are recognised; a real one is not.
  if not (public.is_reserved_email('a@example.com') and public.is_reserved_email('a@shop.test')
          and public.is_reserved_email('no-at-sign') and not public.is_reserved_email('ada@gmail.com')) then
    raise exception 'FAILED 1: reserved addresses';
  end if;
  v_passed := v_passed + 1;

  -- 2. The first device is remembered quietly; a second one is a security email; a return is not.
  if public.note_sign_in(v_user, 'Chrome on macOS') then
    raise exception 'FAILED 2: the first device raised an alarm';
  end if;
  if not public.note_sign_in(v_user, 'Safari on iOS') then
    raise exception 'FAILED 2: a new device went unnoticed';
  end if;
  if public.note_sign_in(v_user, 'Safari on iOS') then
    raise exception 'FAILED 2: a known device raised an alarm';
  end if;
  select * into v_row from public.email_outbox where user_id = v_user and kind = 'new_sign_in';
  if v_row.id is null or v_row.category <> 'security' or v_row.status <> 'pending'
     or v_row.data ->> 'device' <> 'Safari on iOS'
     or (select count(*) from public.email_outbox where user_id = v_user and kind = 'new_sign_in') <> 1 then
    raise exception 'FAILED 2: new-device email %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 3. Password and two-factor changes are queued; nothing else is accepted.
  perform public.queue_account_email(v_user, 'password_changed');
  perform public.queue_account_email(v_user, 'two_factor_on');
  begin
    perform public.queue_account_email(v_user, 'order_receipt');
    raise exception 'FAILED 3: queued an account email of the wrong kind';
  exception when invalid_parameter_value then null;
  end;
  if (select count(*) from public.email_outbox
       where user_id = v_user and kind in ('password_changed', 'two_factor_on') and category = 'security') <> 2 then
    raise exception 'FAILED 3: account emails not queued';
  end if;
  v_passed := v_passed + 1;

  -- 4. An example.com account's email is kept, but never sent.
  perform public.queue_account_email(v_e2e, 'password_changed');
  select * into v_row from public.email_outbox where user_id = v_e2e;
  if v_row.status <> 'skipped' or v_row.skip_reason <> 'reserved_address' then
    raise exception 'FAILED 4: an example.com address would be mailed: %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 5. Domain events: a registration, a failure, and security changes each queue one email.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, nameservers)
  values (v_user, 'email-check-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', true,
          array['ns1.example.net', 'ns2.example.net'])
  returning id into v_domain;
  insert into public.domain_events (domain_id, event_type, actor_type, payload, created_at)
  values (v_domain, 'registered', 'system', '{"expires_at": "2027-09-24T00:00:00Z"}', now() - interval '1 day');
  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_domain, 'nameservers_applied', 'system', '{"nameservers": ["ns1.vercel-dns.com"]}'),
         (v_domain, 'transfer_lock_applied', 'system', '{"transfer_lock": false}'),
         (v_domain, 'auth_code_revealed', 'user', '{}'),
         (v_domain, 'renewal_failed', 'system', '{"code": "DOMAIN_NOT_FOUND"}'),
         (v_domain, 'nameservers_requested', 'user', '{}');
  select count(*) into v_count from public.email_outbox where domain_id = v_domain;
  if v_count <> 5
     or not exists (select 1 from public.email_outbox where domain_id = v_domain and kind = 'domain_registered'
                      and category = 'transactional' and test_mode and data ->> 'domain' like 'email-check-%')
     or not exists (select 1 from public.email_outbox where domain_id = v_domain and kind = 'nameservers_changed'
                      and category = 'security' and data -> 'nameservers' ->> 0 = 'ns1.vercel-dns.com')
     or not exists (select 1 from public.email_outbox where domain_id = v_domain and kind = 'transfer_lock_changed'
                      and (data ->> 'locked')::boolean = false)
     or not exists (select 1 from public.email_outbox where domain_id = v_domain and kind = 'auth_code_revealed')
     or not exists (select 1 from public.email_outbox where domain_id = v_domain and kind = 'order_line_failed'
                      and data ->> 'action' = 'renewal' and data ->> 'code' = 'DOMAIN_NOT_FOUND') then
    raise exception 'FAILED 5: domain event emails (% queued)', v_count;
  end if;
  v_passed := v_passed + 1;

  -- 6. Nameservers set with the registration itself (same transaction) are not a "change";
  --    demo domains send nothing; a second registered event is not a second email.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_user, 'email-check-new-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', true)
  returning id into v_live;
  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_live, 'registered', 'system', '{}'),
         (v_live, 'nameservers_applied', 'system', '{"nameservers": ["ns1.vercel-dns.com"]}'),
         (v_live, 'registered', 'system', '{"recovered": true}');
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_user, 'email-check-demo-' || left(v_user::text, 8) || '.com', 'com', 'demo', 'active', false)
  returning id into v_demo;
  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (v_demo, 'registered', 'system', '{}'), (v_demo, 'auth_code_revealed', 'user', '{}');
  if (select count(*) from public.email_outbox where domain_id = v_live) <> 1
     or exists (select 1 from public.email_outbox where domain_id = v_demo) then
    raise exception 'FAILED 6: setup nameservers, demo domains or a repeated registration sent mail';
  end if;
  v_passed := v_passed + 1;

  -- 7. A receipt when the payment is recorded, with every line and its renewal price (N8) — once.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 1830000, 7.5, 137250, 1967250, v_rate, 'MDH-email-check', '{}', 'covered', true)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'email-check-receipt.com', 'com', 'register', 1, 1830000, 1860000, false, false);
  update public.orders set invoice_number = 'TEST-INV-email-check', paid_at = now() where id = v_order;
  update public.orders set invoice_number = 'TEST-INV-email-check-2' where id = v_order;
  select * into v_row from public.email_outbox where order_id = v_order and kind = 'order_receipt';
  if v_row.id is null
     or (select count(*) from public.email_outbox where order_id = v_order and kind = 'order_receipt') <> 1
     or v_row.data ->> 'invoice_number' <> 'TEST-INV-email-check'
     or (v_row.data -> 'lines' -> 0 ->> 'renewal_kobo')::bigint <> 1860000
     or (v_row.data ->> 'total_kobo')::bigint <> 1967250 then
    raise exception 'FAILED 7: receipt %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 8. A refund sent to Flutterwave queues one email with its amount and reason.
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_order, v_user, 'flutterwave', 'email-check', 'MDH-email-check', 1967250, 'NGN', 'successful', 'card', '{}')
  returning id into v_payment;
  insert into public.refunds (order_id, payment_id, user_id, reason, amount_kobo, test_mode)
  values (v_order, v_payment, v_user, 'duplicate_charge', 1967250, true)
  returning id into v_refund;
  update public.refunds set status = 'sending', locked_by = v_worker, locked_at = now() where id = v_refund;
  perform public.record_refund_submitted(v_refund, v_worker, 'rf-email-check', 'pending', 60);
  select * into v_row from public.email_outbox where kind = 'refund_sent' and order_id = v_order;
  if v_row.id is null or (v_row.data ->> 'amount_kobo')::bigint <> 1967250
     or v_row.data ->> 'reason' <> 'duplicate_charge' or v_row.data ->> 'order_number' is null then
    raise exception 'FAILED 8: refund email %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 9. ERRP (§7.4): a month before, a week before, just after — each once per expiry date.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, expires_at)
  values (v_user, 'email-check-30-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false, now() + interval '30 days')
  returning id into v_soon;
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, expires_at)
  values (v_user, 'email-check-7-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false, now() + interval '7 days')
  returning id into v_live;
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, expires_at)
  values (v_user, 'email-check-post-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'expired_grace', false, now() - interval '2 days')
  returning id into v_gone;
  perform public.enqueue_expiry_notices();
  perform public.enqueue_expiry_notices();
  if (select data ->> 'notice' from public.email_outbox where domain_id = v_soon and kind = 'expiry_notice') <> 'errp_pre_35'
     or (select data ->> 'notice' from public.email_outbox where domain_id = v_live and kind = 'expiry_notice') <> 'errp_pre_7'
     or (select data ->> 'notice' from public.email_outbox where domain_id = v_gone and kind = 'expiry_notice') <> 'errp_post'
     or (select count(*) from public.email_outbox where domain_id in (v_soon, v_live, v_gone)) <> 3
     or exists (select 1 from public.email_outbox where domain_id = v_soon and category <> 'compliance') then
    raise exception 'FAILED 9: expiry notices';
  end if;
  -- Renewed: a new expiry date is a new cycle.
  update public.domains set expires_at = now() + interval '28 days' where id = v_soon;
  perform public.enqueue_expiry_notices();
  if (select count(*) from public.email_outbox where domain_id = v_soon) <> 2 then
    raise exception 'FAILED 9: a new expiry date did not start a new cycle';
  end if;
  v_passed := v_passed + 1;

  -- 10. FR-D8: one nudge, three days after registration, for a domain still pointing nowhere.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode,
                              delegation_status, registered_at)
  values (v_user, 'email-check-dark-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false,
          'undelegated', now() - interval '4 days')
  returning id into v_dark;
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode,
                              delegation_status, registered_at)
  values (v_user, 'email-check-old-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false,
          'undelegated', now() - interval '60 days')
  returning id into v_old;
  perform public.enqueue_undelegated_nudges();
  perform public.enqueue_undelegated_nudges();
  if (select count(*) from public.email_outbox where domain_id = v_dark and kind = 'undelegated_nudge') <> 1
     or exists (select 1 from public.email_outbox where domain_id = v_old) then
    raise exception 'FAILED 10: undelegated nudge';
  end if;
  v_passed := v_passed + 1;

  -- 11. Claiming takes one side only; sending an ERRP notice enters it in the compliance log;
  --     a bounce raises a critical alert (FR-NT3).
  select count(*) into v_count from public.claim_emails(v_worker, false, 50) c where c.user_id = v_user;
  if v_count = 0 or exists (select 1 from public.email_outbox
                             where user_id = v_user and test_mode and status = 'sending') then
    raise exception 'FAILED 11: claimed the wrong side (% claimed)', v_count;
  end if;
  select id into v_email from public.email_outbox where domain_id = v_gone and kind = 'expiry_notice';
  if not public.mark_email_sent(v_email, v_worker, '<msg-email-check@smtp-relay.mailin.fr>', 'expiry_notice@1') then
    raise exception 'FAILED 11: could not mark sent';
  end if;
  if public.mark_email_sent(v_email, 'someone-else', 'x', 'x') then
    raise exception 'FAILED 11: marked sent twice, or by another worker';
  end if;
  if not exists (select 1 from public.compliance_notices
                  where email_id = v_email and notice_type = 'errp_post' and template_version = 'expiry_notice@1'
                    and recipient like 'email-check-%' and delivery_status = 'sent') then
    raise exception 'FAILED 11: no compliance record';
  end if;
  if not exists (select 1 from public.emails_for_delivery_check(200) d where d.id = v_email) then
    raise exception 'FAILED 11: not offered for a delivery check';
  end if;
  perform public.record_email_delivery(v_email, 'bounced');
  if (select delivery_status from public.compliance_notices where email_id = v_email) <> 'bounced'
     or not exists (select 1 from public.current_alert_conditions(false) a
                     where a.kind = 'compliance_notice_bounced' and a.severity = 'critical'
                       and a.summary like '%email-check-post-%') then
    raise exception 'FAILED 11: a bounced notice raised no alert';
  end if;
  v_passed := v_passed + 1;

  -- 12. Failures back off, then fail for good (an alert); waiting emails raise an alert.
  select id into v_email from public.email_outbox where domain_id = v_dark;
  perform public.mark_email_failed(v_email, v_worker, 'HTTP 503', false);
  select * into v_row from public.email_outbox where id = v_email;
  if v_row.status <> 'pending' or v_row.next_attempt_at <= now() then
    raise exception 'FAILED 12: a passing failure was not retried later';
  end if;
  update public.email_outbox set next_attempt_at = now() - interval '1 minute' where id = v_email;
  perform 1 from public.claim_emails(v_worker, false, 50);
  perform public.mark_email_failed(v_email, v_worker, 'invalid recipient', true);
  if (select status from public.email_outbox where id = v_email) <> 'failed'
     or not exists (select 1 from public.current_alert_conditions(false) a where a.key = 'email_failed:' || v_email) then
    raise exception 'FAILED 12: a permanent failure raised no alert';
  end if;
  update public.email_outbox set status = 'pending', created_at = now() - interval '2 hours'
   where user_id = v_user and kind = 'password_changed';
  if not exists (select 1 from public.current_alert_conditions(false) a where a.kind = 'emails_waiting') then
    raise exception 'FAILED 12: waiting emails raised no alert';
  end if;
  v_passed := v_passed + 1;

  -- 13. Only the server key may call the sending functions; nobody may call the queueing ones.
  if has_function_privilege('anon', 'public.claim_emails(text, boolean, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.note_sign_in(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.queue_account_email(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.queue_email(text, text, uuid, text, jsonb, uuid, uuid, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.enqueue_expiry_notices()', 'execute')
     or not has_function_privilege('service_role', 'public.claim_emails(text, boolean, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.note_sign_in(uuid, text)', 'execute')
     or has_table_privilege('authenticated', 'public.email_outbox', 'select')
     or has_table_privilege('service_role', 'public.email_outbox', 'insert')
     or has_table_privilege('service_role', 'public.compliance_notices', 'update') then
    raise exception 'FAILED 13: grants';
  end if;
  v_passed := v_passed + 1;

  -- 14. Housekeeping: outbox rows go after 90 days; the compliance log stays.
  update public.email_outbox set created_at = now() - interval '100 days' where user_id = v_user and status = 'sent';
  perform public.purge_email_records();
  if exists (select 1 from public.email_outbox where user_id = v_user and status = 'sent')
     or not exists (select 1 from public.compliance_notices where domain_id = v_gone) then
    raise exception 'FAILED 14: purge';
  end if;
  v_passed := v_passed + 1;

  raise notice 'notification emails: % checks passed', v_passed;
end;
$$;

rollback;
