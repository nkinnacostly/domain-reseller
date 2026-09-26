-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 32, tried as the database owner (and, for labels and bulk
-- results, as a signed-in user). Each check fails the script if it does not
-- hold. Everything is rolled back — no order takes an invoice number here.
--
--   supabase db query --linked -f supabase/tests/limits_presets_bulk.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := extensions.gen_random_uuid();
  v_other    uuid := extensions.gen_random_uuid();
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_order    uuid;
  v_allow    jsonb;
  v_preset   uuid;
  v_manual   uuid;
  v_stale    uuid;
  v_live     uuid;
  v_demo     uuid;
  v_pending  uuid;
  v_theirs   uuid;
  v_cc       uuid;
  v_label    uuid;
  v_their_label uuid;
  v_op       uuid;
  v_state    text;
  v_count    integer;
  v_passed   integer := 0;
begin
  if v_rate is null then
    raise exception 'needs one fx rate to build test rows';
  end if;
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'e2e-sql-m32-' || v_user || '@example.com', now(), now()),
         (v_other, 'authenticated', 'authenticated', 'e2e-sql-m32-' || v_other || '@example.com', now(), now());

  -- 1. SEC-11: a new account with no paid order is on the lowest tier.
  v_allow := public.account_domain_allowance(v_user);
  if v_allow ->> 'tier' <> 'new' or (v_allow ->> 'max')::integer <> 5 or (v_allow ->> 'ordered')::integer <> 0 then
    raise exception 'FAILED 1: new account allowance %', v_allow;
  end if;
  -- Registrations and transfers count; renewals and cancelled orders do not; test orders count only on their side.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-m32-1', '{}', 'covered', false)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'm32-a.com', 'com', 'register', 1, 100000, 100000, false, false),
         (v_order, 'm32-b.com', 'com', 'transfer', 1, 100000, 100000, false, false);
  -- A renewal line names a domain the account holds.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_user, 'm32-c-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false)
  returning id into v_cc;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew, domain_id)
  values (v_order, 'm32-c-' || left(v_user::text, 8) || '.com', 'com', 'renew', 1, 100000, 100000, false, false, v_cc);
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode, status)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-m32-2', '{}', 'covered', false, 'cancelled')
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'm32-d.com', 'com', 'register', 1, 100000, 100000, false, false);
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-m32-3', '{}', 'covered', true)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'm32-e.com', 'com', 'register', 1, 100000, 100000, false, false);
  if (public.account_domain_allowance(v_user) ->> 'ordered')::integer <> 2 then
    raise exception 'FAILED 1: counted % live domains, not 2', public.account_domain_allowance(v_user) ->> 'ordered';
  end if;
  v_allow := public.account_domain_allowance(v_user, true);
  if v_allow ->> 'tier' <> 'trusted' or (v_allow ->> 'ordered')::integer <> 1 then
    raise exception 'FAILED 1: test side allowance %', v_allow;
  end if;
  v_passed := v_passed + 1;

  -- 2. A paid order, or a week's age, lifts it to standard; a month and three paid orders to trusted.
  update public.orders set paid_at = now() where tx_ref = 'MDH-m32-1';
  if public.account_domain_allowance(v_user) ->> 'tier' <> 'standard'
     or (public.account_domain_allowance(v_user) ->> 'max')::integer
        <> (select max_domains_per_account_day from public.ops_settings) then
    raise exception 'FAILED 2: a paid order did not lift the tier';
  end if;
  update public.profiles set created_at = now() - interval '40 days' where id = v_user;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode, paid_at, created_at)
  values (v_user, 1, 0, 0, 1, v_rate, 'MDH-m32-4', '{}', 'covered', false, now() - interval '20 days', now() - interval '20 days'),
         (v_user, 1, 0, 0, 1, v_rate, 'MDH-m32-5', '{}', 'covered', false, now() - interval '10 days', now() - interval '10 days');
  v_allow := public.account_domain_allowance(v_user);
  if v_allow ->> 'tier' <> 'trusted' or (v_allow ->> 'max')::integer <> 100
     or (v_allow ->> 'paid_orders')::integer <> 3 or (v_allow ->> 'account_days')::integer < 39 then
    raise exception 'FAILED 2: trusted allowance %', v_allow;
  end if;
  v_passed := v_passed + 1;

  -- 3. FR-D2: a failing preset warns, is hidden after a day, and comes back when it resolves.
  insert into public.nameserver_presets (provider, nameservers, source_url, verified_at)
  values ('M32 Host', array['ns1.m32host.test', 'ns2.m32host.test'], 'https://example.com/docs', now())
  returning id into v_preset;
  insert into public.nameserver_presets (provider, nameservers, source_url, verified_at, is_hidden)
  values ('M32 Retired', array['ns1.m32old.test', 'ns2.m32old.test'], 'https://example.com/docs', now(), true)
  returning id into v_manual;
  if not exists (select 1 from public.presets_for_check() p where p.preset_id = v_preset)
     or exists (select 1 from public.presets_for_check() p where p.preset_id = v_manual) then
    raise exception 'FAILED 3: the wrong presets are due a check';
  end if;
  v_state := public.record_preset_check(v_preset, false, '{"unresolved": ["ns1.m32host.test"]}');
  if v_state <> 'failing'
     or not exists (select 1 from public.current_alert_conditions(false) a where a.key = 'preset_failing:' || v_preset) then
    raise exception 'FAILED 3: first failure %', v_state;
  end if;
  update public.nameserver_presets set check_failed_since = now() - interval '25 hours' where id = v_preset;
  v_state := public.record_preset_check(v_preset, false, '{}');
  if v_state <> 'hidden' or not (select is_hidden from public.nameserver_presets where id = v_preset)
     or not exists (select 1 from public.current_alert_conditions(false) a
                     where a.key = 'preset_hidden:' || v_preset and a.severity = 'critical')
     or not exists (select 1 from public.presets_for_check() p where p.preset_id = v_preset) then
    raise exception 'FAILED 3: a day of failures did not hide it (%)', v_state;
  end if;
  v_state := public.record_preset_check(v_preset, true, '{}');
  if v_state <> 'restored' or (select is_hidden from public.nameserver_presets where id = v_preset) then
    raise exception 'FAILED 3: a resolving preset stayed hidden';
  end if;
  -- One a person hid stays hidden whatever a check says.
  perform public.record_preset_check(v_manual, true, '{}');
  if not (select is_hidden from public.nameserver_presets where id = v_manual) then
    raise exception 'FAILED 3: a check showed a preset a person hid';
  end if;
  v_passed := v_passed + 1;

  -- 4. The quarterly re-verification.
  insert into public.nameserver_presets (provider, nameservers, source_url, verified_at)
  values ('M32 Stale', array['ns1.m32stale.test', 'ns2.m32stale.test'], 'https://example.com/docs',
          now() - interval '100 days')
  returning id into v_stale;
  if not exists (select 1 from public.current_alert_conditions(false) a where a.key = 'preset_stale:' || v_stale)
     or exists (select 1 from public.current_alert_conditions(true) a where a.key like 'preset_%') then
    raise exception 'FAILED 4: stale preset alert';
  end if;
  v_passed := v_passed + 1;

  -- 5. §13.5 deep sync: a never-read live domain is due; a reading corrects it and stamps it; a change makes it due again.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, nameservers)
  values (v_user, 'm32-live-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'active', false,
          array['ns1.old.test', 'ns2.old.test'])
  returning id into v_live;
  if not exists (select 1 from public.domains_for_deep_sync(false, 200) d where d.domain_id = v_live) then
    raise exception 'FAILED 5: a never-read domain is not due';
  end if;
  perform public.record_deep_sync(v_live, false,
    '{"registry_status": "Active", "nameservers": ["ns1.new.test", "ns2.new.test"],
      "events": [{"type": "nameservers_synced", "payload": {"from": ["ns1.old.test"]}}]}',
    '[{"kind": "status_mismatch", "detail": {"registry": "ClientHold"}}]');
  if not public.same_nameservers((select nameservers from public.domains where id = v_live),
                                 array['ns2.new.test', 'NS1.NEW.TEST.'])
     or (select deep_checked_at from public.domains where id = v_live) is null
     or not exists (select 1 from public.domain_events where domain_id = v_live and event_type = 'nameservers_synced')
     or not exists (select 1 from public.registry_drift where domain_id = v_live and kind = 'status_mismatch' and resolved_at is null)
     or exists (select 1 from public.domains_for_deep_sync(false, 200) d where d.domain_id = v_live) then
    raise exception 'FAILED 5: deep sync did not apply its reading';
  end if;
  insert into public.domain_events (domain_id, event_type, actor_type, payload, created_at)
  values (v_live, 'transfer_lock_applied', 'system', '{"transfer_lock": false}', now() + interval '1 second');
  if not exists (select 1 from public.domains_for_deep_sync(false, 200) d where d.domain_id = v_live) then
    raise exception 'FAILED 5: a changed domain is not due again';
  end if;
  v_passed := v_passed + 1;

  -- 6. FR-N5: every real nameserver change is kept, with the set to revert to.
  if (select previous_nameservers from public.domains where id = v_live) <> array['ns1.old.test', 'ns2.old.test']
     or (select count(*) from public.domain_nameserver_history where domain_id = v_live) <> 1 then
    raise exception 'FAILED 6: history of the synced change';
  end if;
  -- Reordered only (migration 36 keeps every stored name lower-case, so case cannot differ).
  update public.domains set nameservers = array['ns2.new.test', 'ns1.new.test'] where id = v_live;
  if (select count(*) from public.domain_nameserver_history where domain_id = v_live) <> 1 then
    raise exception 'FAILED 6: the same set reordered counted as a change';
  end if;
  v_passed := v_passed + 1;

  -- 7. Bulk nameservers: one line per own domain — queued with its job, done where no registry is involved.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_user, 'm32-demo-' || left(v_user::text, 8) || '.com', 'com', 'demo', 'active', false)
  returning id into v_demo;
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_user, 'm32-pending-' || left(v_user::text, 8) || '.com', 'com', 'registration', 'pending', true)
  returning id into v_pending;
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode)
  values (v_other, 'm32-theirs-' || left(v_other::text, 8) || '.com', 'com', 'registration', 'active', false)
  returning id into v_theirs;
  v_op := public.start_bulk_change(v_user, array[v_live, v_demo, v_pending, v_theirs], 'nameservers',
                                   '{"nameservers": ["ns1.vercel-dns.com", "ns2.vercel-dns.com"], "preset_id": null}');
  if (select count(*) from public.bulk_operation_items where operation_id = v_op) <> 3
     or exists (select 1 from public.bulk_operation_items where operation_id = v_op and domain_id = v_theirs)
     or not exists (select 1 from public.bulk_operation_items i join public.jobs j on j.id = i.job_id
                     where i.operation_id = v_op and i.domain_id = v_live and i.outcome = 'queued'
                       and j.kind = 'apply_nameservers')
     or (select outcome from public.bulk_operation_items where operation_id = v_op and domain_id = v_demo) <> 'done'
     or (select outcome from public.bulk_operation_items where operation_id = v_op and domain_id = v_pending) <> 'done'
     or (select pending_nameservers from public.domains where id = v_pending) <> array['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
     or (select pending_nameservers from public.domains where id = v_theirs) is not null
     or not exists (select 1 from public.domain_events where domain_id = v_live and event_type = 'nameservers_requested'
                      and actor_id = v_user and (payload ->> 'bulk_operation')::uuid = v_op) then
    raise exception 'FAILED 7: bulk nameservers';
  end if;
  v_op := public.start_bulk_change(v_user, array[v_live], 'nameservers',
                                   '{"nameservers": ["NS2.vercel-dns.com.", "ns1.vercel-dns.com"]}');
  if (select reason from public.bulk_operation_items where operation_id = v_op) <> 'unchanged' then
    raise exception 'FAILED 7: the same set again was not "unchanged"';
  end if;
  v_passed := v_passed + 1;

  -- 8. Bulk lock and privacy follow the one-domain rules; auto-renew and labels apply at once.
  insert into public.domains (user_id, domain_name, tld, source, local_status, test_mode, transfer_lock)
  values (v_user, 'm32-cc-' || left(v_user::text, 8) || '.co', 'co', 'registration', 'active', false, true)
  returning id into v_cc;
  update public.domains set transfer_lock = true where id = v_live;
  v_op := public.start_bulk_change(v_user, array[v_live, v_demo, v_pending, v_cc], 'transfer_lock', '{"locked": false}');
  if (select outcome from public.bulk_operation_items where operation_id = v_op and domain_id = v_live) <> 'queued'
     or (select pending_transfer_lock from public.domains where id = v_live) is distinct from false
     or (select reason from public.bulk_operation_items where operation_id = v_op and domain_id = v_demo) <> 'demo'
     or (select reason from public.bulk_operation_items where operation_id = v_op and domain_id = v_pending) <> 'registering'
     or (select outcome from public.bulk_operation_items where operation_id = v_op and domain_id = v_cc) <> 'queued' then
    raise exception 'FAILED 8: bulk transfer lock';
  end if;
  v_op := public.start_bulk_change(v_user, array[v_live, v_cc], 'privacy', '{"enabled": true}');
  if (select reason from public.bulk_operation_items where operation_id = v_op and domain_id = v_cc) <> 'not_offered'
     or (select outcome from public.bulk_operation_items where operation_id = v_op and domain_id = v_live) <> 'queued' then
    raise exception 'FAILED 8: bulk privacy';
  end if;
  update public.domains set auto_renew = false where id in (v_live, v_demo);
  v_op := public.start_bulk_change(v_user, array[v_live, v_demo], 'auto_renew', '{"enabled": true}');
  update public.domains set auto_renew = true where id = v_cc;
  if (select count(*) from public.bulk_operation_items where operation_id = v_op and outcome = 'done') <> 2
     or not (select auto_renew from public.domains where id = v_demo) then
    raise exception 'FAILED 8: bulk auto-renew';
  end if;
  begin
    perform public.start_bulk_change(v_user, array[v_live], 'transfer_lock', '{}');
    raise exception 'FAILED 8: a bulk lock without a value was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.start_bulk_change(v_user, array[v_live], 'delete_everything', '{}');
    raise exception 'FAILED 8: an unknown bulk action was accepted';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- 9. Labels: own only; bulk label and unlabel; 50 at most.
  insert into public.domain_labels (user_id, name, color) values (v_user, 'Clients', 'green') returning id into v_label;
  insert into public.domain_labels (user_id, name, color) values (v_other, 'Theirs', 'red') returning id into v_their_label;
  v_op := public.start_bulk_change(v_user, array[v_live, v_demo], 'label', jsonb_build_object('label_id', v_label));
  if (select count(*) from public.domain_label_links where label_id = v_label) <> 2 then
    raise exception 'FAILED 9: bulk label';
  end if;
  v_op := public.start_bulk_change(v_user, array[v_live], 'unlabel', jsonb_build_object('label_id', v_label));
  if (select count(*) from public.domain_label_links where label_id = v_label) <> 1 then
    raise exception 'FAILED 9: bulk unlabel';
  end if;
  begin
    perform public.start_bulk_change(v_user, array[v_live], 'label', jsonb_build_object('label_id', v_their_label));
    raise exception 'FAILED 9: labelled with someone else''s label';
  exception when invalid_parameter_value then null;
  end;
  begin
    insert into public.domain_labels (user_id, name) values (v_user, 'clients');
    raise exception 'FAILED 9: two labels with one name';
  exception when unique_violation then null;
  end;
  insert into public.domain_labels (user_id, name)
  select v_user, 'Label ' || n from generate_series(1, 49) n;
  begin
    insert into public.domain_labels (user_id, name) values (v_user, 'One too many');
    raise exception 'FAILED 9: a 51st label was allowed';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- 10. As the signed-in user: their labels, links and bulk results — nobody else's.
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  if exists (select 1 from public.domain_labels where id = v_their_label)
     or (select count(*) from public.domain_labels) <> 50
     or (select count(*) from public.bulk_operations) < 7
     or not exists (select 1 from public.my_bulk_operation(v_op)) then
    raise exception 'FAILED 10: what the user can read';
  end if;
  begin
    insert into public.domain_label_links (label_id, domain_id) values (v_label, v_theirs);
    raise exception 'FAILED 10: labelled someone else''s domain';
  exception when insufficient_privilege then null;
  end;
  insert into public.domain_label_links (label_id, domain_id) values (v_label, v_cc);
  if not exists (select 1 from public.domain_nameserver_history where domain_id = v_live) then
    raise exception 'FAILED 10: cannot read own nameserver history';
  end if;
  begin
    perform public.start_bulk_change(v_user, array[v_live], 'auto_renew', '{"enabled": false}');
    raise exception 'FAILED 10: a signed-in user called start_bulk_change';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- 11. Grants, and supplier call retention.
  if has_function_privilege('authenticated', 'public.account_domain_allowance(uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.record_preset_check(uuid, boolean, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.purge_supplier_calls()', 'execute')
     or not has_function_privilege('service_role', 'public.start_bulk_change(uuid, uuid[], text, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.domains_for_deep_sync(boolean, integer)', 'execute')
     or has_table_privilege('authenticated', 'public.bulk_operations', 'insert') then
    raise exception 'FAILED 11: grants';
  end if;
  insert into public.supplier_calls (environment, operation, outcome, duration_ms, created_at)
  values ('ote', 'GetDetails', 'ok', 5, now() - interval '14 months'),
         ('ote', 'GetDetails', 'ok', 5, now() - interval '11 months');
  perform public.purge_supplier_calls();
  if exists (select 1 from public.supplier_calls where created_at < now() - interval '13 months')
     or not exists (select 1 from public.supplier_calls where created_at < now() - interval '10 months') then
    raise exception 'FAILED 11: supplier call retention';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 32: % checks passed', v_passed;
end;
$$;

rollback;
