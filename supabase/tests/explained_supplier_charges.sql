-- ─────────────────────────────────────────────────────────────────────────────
-- Migrations 69–70, tried as the database owner: a supplier charge explained
-- by hand. An unexplained debit alerts until an owner explains it; the
-- wrapper refuses a test admin, a stale code, a short reason and anything
-- with nothing to explain; an explanation closes the alert, survives the
-- matcher and is never rewritten. A matched debit charged unlike its recorded
-- cost warns until explained too, and keeps its match. Each check raises on
-- failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/explained_supplier_charges.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.act(p_uid uuid, p_sid uuid, p_totp_age interval default interval '1 minute')
returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_totp_age)::bigint)))::text, true);
end $f$;

-- One ledger row as the gateway sends it.
create function pg_temp.lrow(p_trace text, p_at timestamptz, p_type int, p_charge int, p_product int,
                             p_description text, p_old bigint, p_balance bigint)
returns jsonb language sql as $f$
  select jsonb_build_object(
    'traceId', p_trace,
    'occurredAt', to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'type', p_type, 'status', 1, 'chargeType', p_charge, 'productType', p_product,
    'productId', null, 'description', p_description, 'period', 1,
    'oldBalanceCents', p_old, 'balanceCents', p_balance)
$f$;

create function pg_temp.trace(p_seed text) returns text language sql as $f$
  select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3)
         || '-' || substr(h, 21, 12)
    from (select md5(p_seed) as h) x
$f$;

create function pg_temp.entry(p_trace text) returns public.supplier_ledger_entries language sql as $f$
  select e from public.supplier_ledger_entries e where not e.test_mode and e.trace_id = p_trace::uuid
$f$;

create function pg_temp.alerting(p_trace text) returns boolean language sql as $f$
  select exists (select 1 from public.current_alert_conditions(false) c where c.key = 'ledger_unexplained:' || p_trace)
$f$;

-- NULL never passes a guard (CLAUDE.md §15): a refusal is checked by its exact code.
create function pg_temp.expect_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.expect_raise(p_sql text, p_like text) returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected "%" from %, got "%"', p_like, p_sql, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected "%" from %, but it ran', p_like, p_sql;
end $f$;

-- A paid test order line (as admin_data.sql's), registered: its job and call.
create function pg_temp.registered_line(p_user uuid, p_domain text, p_ref text, p_at timestamptz)
returns uuid language plpgsql as $f$
declare
  v_order  uuid;
  v_item   uuid;
  v_domain uuid;
  v_job    uuid;
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (p_user, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f where f.status = 'active' limit 1),
          'MDH-m70-' || p_ref, '{}', 'covered', true, 'provisioning', p_at)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status)
  values (v_order, p_domain, 'com', 'register', 1, 100000, 100000, false, false, 'completed')
  returning id into v_item;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (p_user, p_domain, 'com', 'registration', true, 'active', v_item) returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('register_domain', 'm70:' || p_ref, v_domain, v_item, true, 'succeeded') returning id into v_job;
  insert into public.supplier_calls (job_id, environment, operation, domain_name, outcome, duration_ms, created_at)
  values (v_job, 'ote', 'RegisterWithContactInfo', p_domain, 'ok', 2400, p_at);
  return v_item;
end $f$;

create function pg_temp.test_entry(p_trace text) returns public.supplier_ledger_entries language sql as $f$
  select e from public.supplier_ledger_entries e where e.test_mode and e.trace_id = p_trace::uuid
$f$;

create function pg_temp.price_warning(p_trace text) returns boolean language sql as $f$
  select exists (select 1 from public.current_alert_conditions(true) c where c.key = 'ledger_price:' || p_trace)
$f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner  uuid := gen_random_uuid();
  u_test   uuid := gen_random_uuid();
  f_owner  uuid := gen_random_uuid();
  f_test   uuid := gen_random_uuid();
  s_owner  uuid := gen_random_uuid();
  s_test   uuid := gen_random_uuid();
  l_owner  text := 'm69-owner-' || v_tag;
  t_charge text := pg_temp.trace('charge' || v_tag);
  t_topup  text := pg_temp.trace('topup' || v_tag);
  v_key    uuid := gen_random_uuid();
  v_note   text := 'Bought by hand in the supplier panel for a client';
  v_j      jsonb;
  v_j2     jsonb;
  v_e      public.supplier_ledger_entries;
  v_item   uuid;
  v_item2  uuid;
  t_drift  text := pg_temp.trace('drift' || v_tag);
  t_exact  text := pg_temp.trace('exact' || v_tag);
  v_price  text := 'DomainNameAPI raised .com before our price sync caught it';
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin69-o-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin69-t-' || v_tag || '@example.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_owner, u_owner, 'm69', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm69', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_owner, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, l_owner, 'owner', array[f_owner], 'm69-check');
  perform public.grant_test_admin(u_test);

  -- A live ledger read just now, holding a domain debit three hours old that
  -- no call explains, and a top-up.
  perform public.record_heartbeat('supplier_ledger:production', false,
    jsonb_build_object('outcome', 'ok', 'readAt', now()));
  perform public.record_supplier_ledger(false, jsonb_build_array(
    pg_temp.lrow(t_charge, now() - interval '3 hours', 1, 1, 1, 'm69-' || v_tag || '.org', 4409, 3410),
    pg_temp.lrow(t_topup, now() - interval '4 hours', 5, 0, 3, 'Ziraat Payment (Order: m69)', 0, 4409)));

  -- ── 1. An unexplained debit alerts.
  if (pg_temp.entry(t_charge)).match_state is distinct from 'unexplained' or not pg_temp.alerting(t_charge) then
    raise exception 'FAILED 1: the debit is % and alerting is %', (pg_temp.entry(t_charge)).match_state, pg_temp.alerting(t_charge);
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Refused: a test admin, a code over 5 minutes old, a short reason, a top-up, an unknown trace.
  perform pg_temp.act(u_test, s_test);
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, t_charge::uuid, v_note, gen_random_uuid()),
                              'TEST_ADMIN', 'FAILED 2: a test admin explained a live charge');
  perform pg_temp.act(u_owner, s_owner, interval '6 minutes');
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, t_charge::uuid, v_note, gen_random_uuid()),
                              'NEEDS_CODE', 'FAILED 2: a 6-minute code explained a charge');
  perform pg_temp.act(u_owner, s_owner);
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, t_charge::uuid, 'mine', gen_random_uuid()),
                              'REASON', 'FAILED 2: a 4-character explanation');
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, t_topup::uuid, v_note, gen_random_uuid()),
                              'NOT_UNEXPLAINED', 'FAILED 2: a top-up explained');
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, gen_random_uuid(), v_note, gen_random_uuid()),
                              'NOT_FOUND', 'FAILED 2: an unknown trace');
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(true, t_charge::uuid, v_note, gen_random_uuid()),
                              'NOT_FOUND', 'FAILED 2: a live trace explained on the test side');
  if (pg_temp.entry(t_charge)).match_state is distinct from 'unexplained' then
    raise exception 'FAILED 2: a refusal changed the entry';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Explained: the words, who and when kept, the alert gone, an audit row.
  v_j := public.admin_explain_supplier_charge(false, t_charge::uuid, '  ' || v_note || '  ', v_key);
  v_e := pg_temp.entry(t_charge);
  if (v_j ->> 'ok')::boolean is not true or v_e.match_state is distinct from 'explained'
     or v_e.explained_note is distinct from v_note or v_e.explained_by is distinct from l_owner
     or v_e.explained_at is null or pg_temp.alerting(t_charge) then
    raise exception 'FAILED 3: explain % → % %', v_j, v_e.match_state, v_e.explained_note;
  end if;
  if not exists (select 1 from public.admin_audit_log a
                  where a.id = (v_j ->> 'auditId')::bigint and a.action = 'supplier.explain_charge'
                    and a.outcome = 'ok' and a.target_type = 'ledger' and a.target_id = t_charge
                    and a.reason = v_note and a.detail ->> 'usd_cents' = '999') then
    raise exception 'FAILED 3: no audit row for %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 4. The same request again is answered from the log; a new one is refused.
  v_j2 := public.admin_explain_supplier_charge(false, t_charge::uuid, v_note, v_key);
  if v_j2 ->> 'auditId' is distinct from v_j ->> 'auditId' then
    raise exception 'FAILED 4: a replay % was not the first answer %', v_j2, v_j;
  end if;
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(false, t_charge::uuid, v_note, gen_random_uuid()),
                              'NOT_UNEXPLAINED', 'FAILED 4: explained twice');
  v_passed := v_passed + 1;

  -- ── 5. The matcher and a status re-read leave it explained.
  perform public.match_supplier_ledger(false);
  perform public.record_supplier_ledger(false, jsonb_build_array(
    pg_temp.lrow(t_charge, now() - interval '3 hours', 1, 1, 1, 'm69-' || v_tag || '.org', 4409, 3410)));
  if (pg_temp.entry(t_charge)).match_state is distinct from 'explained' or pg_temp.alerting(t_charge) then
    raise exception 'FAILED 5: the matcher changed an explained entry to %', (pg_temp.entry(t_charge)).match_state;
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Final, even for the owner: no rewrite, no undo, no explaining outside the wrapper.
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set explained_note = %L where not test_mode and trace_id = %L',
    'Something else entirely', t_charge), '%never rewritten%');
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set match_state = %L, explained_note = null, explained_by = null, explained_at = null where not test_mode and trace_id = %L',
    'unexplained', t_charge), '%never rewritten%');
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set match_state = %L, explained_note = %L, explained_by = %L, explained_at = now() where not test_mode and trace_id = %L',
    'explained', v_note, 'someone', t_topup), '%only through admin_explain_supplier_charge%');
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set match_state = %L where not test_mode and trace_id = %L',
    'explained', t_topup), '%explained_whole%');
  v_passed := v_passed + 1;

  -- ── 7. Grants: authenticated only.
  if has_function_privilege('anon', 'public.admin_explain_supplier_charge(boolean, uuid, text, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.admin_explain_supplier_charge(boolean, uuid, text, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_explain_supplier_charge(boolean, uuid, text, uuid)', 'execute') then
    raise exception 'FAILED 7: admin_explain_supplier_charge has the wrong grants';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. Migration 70: a matched debit charged $11.99 against $11.31 recorded
  -- at checkout warns; one charged as recorded does not.
  perform public.record_heartbeat('supplier_ledger:ote', true, jsonb_build_object('outcome', 'ok', 'readAt', now()));
  v_item := pg_temp.registered_line(u_test, 'm70-d-' || v_tag || '.com', 'd' || v_tag, now() - interval '3 hours');
  v_item2 := pg_temp.registered_line(u_test, 'm70-e-' || v_tag || '.com', 'e' || v_tag, now() - interval '3 hours');
  insert into public.order_item_costs (order_item_id, supplier_cost_cents, icann_fee_cents)
  values (v_item, 1131, 20), (v_item2, 1131, 20);
  perform public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t_drift, now() - interval '3 hours' + interval '20 seconds', 1, 1, 1, 'm70-d-' || v_tag || '.com', 5000, 3801),
    pg_temp.lrow(t_exact, now() - interval '3 hours' + interval '30 seconds', 1, 1, 1, 'm70-e-' || v_tag || '.com', 3801, 2670)));
  if (pg_temp.test_entry(t_drift)).match_state is distinct from 'matched'
     or (pg_temp.test_entry(t_drift)).match_order_item_id is distinct from v_item
     or not pg_temp.price_warning(t_drift) or pg_temp.price_warning(t_exact) then
    raise exception 'FAILED 8: the drifted debit is % and warning is %, the exact one warning is %',
      (pg_temp.test_entry(t_drift)).match_state, pg_temp.price_warning(t_drift), pg_temp.price_warning(t_exact);
  end if;
  v_passed := v_passed + 1;

  -- ── 9. Explained: still matched, the note kept, the warning gone; nothing to explain on the exact one.
  perform pg_temp.act(u_owner, s_owner);
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(true, t_exact::uuid, v_price, gen_random_uuid()),
                              'NOT_UNEXPLAINED', 'FAILED 9: a charge that matches its cost was explained');
  v_j := public.admin_explain_supplier_charge(true, t_drift::uuid, v_price, gen_random_uuid());
  v_e := pg_temp.test_entry(t_drift);
  if (v_j ->> 'ok')::boolean is not true or v_e.match_state is distinct from 'matched'
     or v_e.match_order_item_id is distinct from v_item or v_e.price_note is distinct from v_price
     or v_e.price_noted_by is distinct from l_owner or v_e.explained_at is not null
     or pg_temp.price_warning(t_drift) then
    raise exception 'FAILED 9: explain a price % → % %', v_j, v_e.match_state, v_e.price_note;
  end if;
  if not exists (select 1 from public.admin_audit_log a
                  where a.id = (v_j ->> 'auditId')::bigint and a.detail ->> 'kind' = 'price'
                    and a.detail ->> 'recorded_cost_cents' = '1131' and a.detail ->> 'usd_cents' = '1199') then
    raise exception 'FAILED 9: the audit row does not say what was explained %', v_j;
  end if;
  perform pg_temp.expect_code(public.admin_explain_supplier_charge(true, t_drift::uuid, v_price, gen_random_uuid()),
                              'NOT_UNEXPLAINED', 'FAILED 9: a price explained twice');
  v_passed := v_passed + 1;

  -- ── 10. Final, and given only through the wrapper.
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set price_note = %L where test_mode and trace_id = %L',
    'Something else entirely', t_drift), '%never rewritten%');
  perform pg_temp.expect_raise(format(
    'update public.supplier_ledger_entries set price_note = %L, price_noted_by = %L, price_noted_at = now() where test_mode and trace_id = %L',
    v_price, 'someone', t_exact), '%only through admin_explain_supplier_charge%');
  v_passed := v_passed + 1;

  raise notice 'migrations 69–70: % checks passed', v_passed;
end;
$$;

rollback;
