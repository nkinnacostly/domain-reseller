-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 41, tried as the database owner (docs/ADMIN-SPEC.md §3.3): the
-- supplier ledger mirror and its matching, top-ups, the funnel and the daily
-- rollup, the read functions, the float, and the new alert families.
--
-- The side-wide checks (balance chain, float) run on the test side, cleared
-- inside the transaction first: that briefly locks the two ledger tables
-- while it runs. Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/admin_data.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.act_data(p_uid uuid, p_sid uuid, p_totp_age interval default interval '1 minute')
returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_totp_age)::bigint)))::text, true);
end $f$;

-- One ledger row as the gateway sends it.
create function pg_temp.lrow(p_trace text, p_at timestamptz, p_type int, p_status int, p_charge int, p_product int,
                             p_description text, p_old bigint, p_balance bigint)
returns jsonb language sql as $f$
  select jsonb_build_object(
    'traceId', p_trace,
    'occurredAt', to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'type', p_type, 'status', p_status, 'chargeType', p_charge, 'productType', p_product,
    'productId', null, 'description', p_description, 'period', 1,
    'oldBalanceCents', p_old, 'balanceCents', p_balance)
$f$;

-- A fresh GUID-shaped trace from a seed: lower-case, version 4.
create function pg_temp.trace(p_seed text) returns text language sql as $f$
  select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3)
         || '-' || substr(h, 21, 12)
    from (select md5(p_seed) as h) x
$f$;

create function pg_temp.state(p_test boolean, p_trace text) returns text language sql as $f$
  select e.match_state from public.supplier_ledger_entries e where e.test_mode = p_test and e.trace_id = lower(p_trace)::uuid
$f$;

create function pg_temp.has_key(p_test boolean, p_key text) returns boolean language sql as $f$
  select exists (select 1 from public.current_alert_conditions(p_test) c where c.key = p_key)
$f$;

-- A wrapper's answer must carry exactly this code. `v_j ->> 'code' <> 'X'` is
-- NULL when the wrapper wrongly succeeds, and NULL never raises (CLAUDE.md
-- §15, "NULL never passes a money guard"): every refusal goes through here.
create or replace function pg_temp.expect_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

-- A wrapper's answer must be ok.
create or replace function pg_temp.expect_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

create function pg_temp.paid_line(p_user uuid, p_test boolean, p_domain text, p_status text, p_ref text,
                                  p_paid timestamptz default now())
returns table (o_order uuid, o_payment uuid, o_item uuid) language plpgsql as $f$
declare
  v_order uuid;
  v_pay   uuid;
  v_item  uuid;
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (p_user, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f where f.status = 'active' limit 1),
          'MDH-m41-' || p_ref, '{}', 'covered', p_test, 'provisioning', p_paid)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status)
  values (v_order, p_domain, 'com', 'register', 1, 100000, 100000, false, false, p_status::public.order_item_status)
  returning id into v_item;
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo, currency,
                               status, method, raw)
  values (v_order, p_user, 'flutterwave', 'm41-' || p_ref, 'MDH-m41-' || p_ref, 107500, 'NGN', 'successful', 'card', '{}')
  returning id into v_pay;
  update public.orders set payment_id = v_pay where id = v_order;
  return query select v_order, v_pay, v_item;
end $f$;

do $$
declare
  v_tag     text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner   uuid := gen_random_uuid();
  u_test    uuid := gen_random_uuid();
  u_none    uuid := gen_random_uuid();
  u_real    uuid := gen_random_uuid();
  f_owner   uuid := gen_random_uuid();
  f_test    uuid := gen_random_uuid();
  s_owner   uuid := gen_random_uuid();
  s_test    uuid := gen_random_uuid();
  l_owner   text := 'm41-owner-' || v_tag;
  l_test    text;
  t1        text;
  t2        text;
  v_j       jsonb;
  v_sql     text;
  v_text    text;
  v_count   integer;
  v_count2  integer;
  v_ord     record;
  v_ord2    record;
  v_ord3    record;
  v_ord4    record;
  v_domain  uuid;
  v_job     uuid;
  v_call    bigint;
  v_topup   bigint;
  v_cert    uuid;
  v_row     record;
  v_expected jsonb;
  v_want    text;
  v_n       integer := 0;
  v_passed  integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin41-o-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin41-t-' || v_tag || '@example.com', now(), now()),
    (u_none, 'authenticated', 'authenticated', 'e2e-admin41-n-' || v_tag || '@example.com', now(), now()),
    (u_real, 'authenticated', 'authenticated', 'm41-real-' || v_tag || '@mydomainshub.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_owner, u_owner, 'm41', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm41', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_owner, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, l_owner, 'owner', array[f_owner], 'm41-check');
  l_test := public.grant_test_admin(u_test);

  -- Both sides have a ledger sync, read just now.
  perform public.record_heartbeat('supplier_ledger:production', false,
    jsonb_build_object('outcome', 'ok', 'readAt', now()));
  perform public.record_heartbeat('supplier_ledger:ote', true,
    jsonb_build_object('outcome', 'ok', 'readAt', now() - interval '1 hour'));

  -- The test side, cleared for the side-wide checks (all rolled back).
  alter table public.supplier_ledger_entries disable trigger supplier_ledger_is_final;
  alter table public.supplier_ledger_revisions disable trigger supplier_ledger_revisions_final;
  delete from public.supplier_ledger_revisions where test_mode;
  delete from public.supplier_ledger_entries where test_mode;
  alter table public.supplier_ledger_entries enable trigger supplier_ledger_is_final;
  alter table public.supplier_ledger_revisions enable trigger supplier_ledger_revisions_final;
  delete from public.supplier_balance_snapshots where test_mode;
  update public.jobs set status = 'succeeded' where test_mode and status in ('queued', 'running', 'needs_attention');
  update public.ssl_jobs set status = 'succeeded' where test_mode and status in ('queued', 'running', 'needs_attention');

  -- ── 1. Idempotent; a new status updates and re-classifies; another changed
  -- fact is a revision, the facts kept, and alerted.
  t1 := pg_temp.trace('one' || v_tag);
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t1, now() - interval '20 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-1)', 0, 1500)));
  if (v_j ->> 'inserted')::int is distinct from 1 or pg_temp.state(true, t1) is distinct from 'topup' then
    raise exception 'FAILED 1: first read % %', v_j, pg_temp.state(true, t1);
  end if;
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t1, now() - interval '20 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-1)', 0, 1500)));
  if v_j is distinct from '{"inserted": 0, "revised": 0, "statusChanged": 0}'::jsonb then
    raise exception 'FAILED 1: a re-read was not idempotent %', v_j;
  end if;
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t1, now() - interval '20 days', 5, 2, 0, 3, 'Ziraat Payment (Order: m41-1)', 0, 1500)));
  if (v_j ->> 'statusChanged')::int is distinct from 1 or pg_temp.state(true, t1) is distinct from 'unclassified'
     or (select e.status from public.supplier_ledger_entries e where e.test_mode and e.trace_id = t1::uuid) is distinct from 2
     or not exists (select 1 from public.supplier_ledger_revisions r where r.test_mode and r.trace_id = t1::uuid and r.applied) then
    raise exception 'FAILED 1: a status change %', v_j;
  end if;
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t1, now() - interval '20 days', 5, 2, 0, 3, 'Ziraat Payment (Order: m41-1)', 0, 1600)));
  if (v_j ->> 'revised')::int is distinct from 1
     or (select e.balance_cents from public.supplier_ledger_entries e where e.test_mode and e.trace_id = t1::uuid) is distinct from 1500
     or not exists (select 1 from public.ledger_alert_conditions(true) c where c.key = 'ledger_changed:' || t1) then
    raise exception 'FAILED 1: a changed balance %', v_j;
  end if;
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t1, now() - interval '20 days', 5, 2, 0, 3, 'Ziraat Payment (Order: m41-1)', 0, 1600)));
  if (v_j ->> 'revised')::int is distinct from 0 then raise exception 'FAILED 1: the same difference twice %', v_j; end if;
  v_passed := v_passed + 1;

  -- ── 2. The facts are never rewritten; only e2e rows are ever deleted.
  begin
    update public.supplier_ledger_entries set description = 'edited' where test_mode and trace_id = t1::uuid;
    raise exception 'FAILED 2: a fact was rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.supplier_ledger_entries set status = 1 where test_mode and trace_id = t1::uuid;
    raise exception 'FAILED 2: a status moved outside record_supplier_ledger';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    delete from public.supplier_ledger_entries where test_mode and trace_id = t1::uuid;
    raise exception 'FAILED 2: a non-e2e row was deleted';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  begin
    update public.supplier_ledger_revisions set applied = true where test_mode and trace_id = t1::uuid;
    raise exception 'FAILED 2: a revision was rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;
  v_passed := v_passed + 1;

  -- ── 3. A GUID that is not RFC 9562 (version b, variant 7), and an upper-case one.
  t2 := 'abcdef01-2345-b789-7bcd-' || substr(md5(v_tag), 1, 12);
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(t2, now() - interval '19 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-3)', 1500, 3000),
    pg_temp.lrow(upper(pg_temp.trace('upper' || v_tag)), now() - interval '18 days', 5, 1, 0, 3,
                 'Ziraat Payment (Order: m41-4)', 3000, 4500)));
  if (v_j ->> 'inserted')::int is distinct from 2
     or pg_temp.state(true, t2) is distinct from 'topup'
     or (select e.trace_id::text from public.supplier_ledger_entries e
          where e.test_mode and e.trace_id = pg_temp.trace('upper' || v_tag)::uuid) is distinct from pg_temp.trace('upper' || v_tag) then
    raise exception 'FAILED 3: GUID shapes %', v_j;
  end if;
  begin
    perform public.record_supplier_ledger(true, jsonb_build_array(
      pg_temp.lrow('not-a-guid', now(), 5, 1, 0, 3, 'x', 0, 1)));
    raise exception 'FAILED 3: a bad trace was stored';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.record_supplier_ledger(true, jsonb_build_array(
      pg_temp.lrow(pg_temp.trace('zone' || v_tag), now(), 5, 1, 0, 3, 'x', 0, 1) || '{"occurredAt": "2026-10-02T10:00:00"}'));
    raise exception 'FAILED 3: a zoneless time was stored';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- ── 4. Matching.
  select * into v_ord from pg_temp.paid_line(u_none, true, 'm41-m-' || v_tag || '.com', 'completed', 'm' || v_tag);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm41-m-' || v_tag || '.com', 'com', 'registration', true, 'active', v_ord.o_item) returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('register_domain', 'm41-m:' || v_tag, v_domain, v_ord.o_item, true, 'succeeded') returning id into v_job;
  insert into public.supplier_calls (job_id, environment, operation, domain_name, outcome, duration_ms, created_at)
  values (v_job, 'ote', 'RegisterWithContactInfo', 'm41-m-' || v_tag || '.com', 'ok', 2400, now() - interval '1 hour')
  returning id into v_call;
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('match' || v_tag), now() - interval '1 hour' + interval '30 seconds', 1, 1, 1, 1,
                 'm41-m-' || v_tag || '.com', 4500, 3369),
    pg_temp.lrow(pg_temp.trace('other' || v_tag), now() - interval '3 hours', 1, 1, 1, 1,
                 'Renewal of m41-o-' || v_tag || '.com for 1 year', 3369, 3000),
    pg_temp.lrow(pg_temp.trace('unset' || v_tag), now() - interval '3 hours', 1, 2, 1, 1,
                 'm41-u-' || v_tag || '.com', 3000, 2900)));
  if pg_temp.state(true, pg_temp.trace('match' || v_tag)) is distinct from 'matched'
     or (select e.match_order_item_id from public.supplier_ledger_entries e
          where e.test_mode and e.trace_id = pg_temp.trace('match' || v_tag)::uuid) is distinct from v_ord.o_item
     or (select e.match_call_id from public.supplier_ledger_entries e
          where e.test_mode and e.trace_id = pg_temp.trace('match' || v_tag)::uuid) is distinct from v_call
     or pg_temp.state(true, pg_temp.trace('other' || v_tag)) is distinct from 'unclassified'
     or pg_temp.state(true, pg_temp.trace('unset' || v_tag)) is distinct from 'unclassified' then
    raise exception 'FAILED 4: matching on the test side';
  end if;
  -- A registration-shaped debit nobody made, on the live side: critical.
  v_j := public.record_supplier_ledger(false, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('ghost' || v_tag), now() - interval '3 hours', 1, 1, 1, 1,
                 'm41-ghost-' || v_tag || '.com', 900000, 898869),
    pg_temp.lrow(pg_temp.trace('fresh' || v_tag), now() - interval '30 minutes', 1, 1, 1, 1,
                 'm41-fresh-' || v_tag || '.com', 898869, 897738)));
  if pg_temp.state(false, pg_temp.trace('ghost' || v_tag)) is distinct from 'unexplained'
     or pg_temp.state(false, pg_temp.trace('fresh' || v_tag)) is distinct from 'pending'
     or not pg_temp.has_key(false, 'ledger_unexplained:' || pg_temp.trace('ghost' || v_tag))
     or not exists (select 1 from public.current_alert_conditions(false) c
                     where c.key = 'ledger_unexplained:' || pg_temp.trace('ghost' || v_tag) and c.severity = 'critical') then
    raise exception 'FAILED 4: an unexplained live charge';
  end if;
  -- Anyone can register an e2e-* name: on the live side such a debit is a
  -- real one and alerts; only the test side's seeded e2e- rows are ignored.
  v_j := public.record_supplier_ledger(false, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('livee2e' || v_tag), now() - interval '3 hours', 1, 1, 1, 1,
                 'e2e-m41-live-' || v_tag || '.com', 897738, 896607)));
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('teste2e' || v_tag), now() - interval '3 hours', 1, 1, 1, 1,
                 'e2e-m41-test-' || v_tag || '.com', 1769, 638)));
  if pg_temp.state(false, pg_temp.trace('livee2e' || v_tag)) is distinct from 'unexplained'
     or not exists (select 1 from public.current_alert_conditions(false) c
                     where c.key = 'ledger_unexplained:' || pg_temp.trace('livee2e' || v_tag) and c.severity = 'critical')
     or exists (select 1 from public.ledger_alert_conditions(true) c
                 where c.key like '%' || pg_temp.trace('teste2e' || v_tag)) then
    raise exception 'FAILED 4: an e2e-named live charge was ignored, or a seeded test one alerted';
  end if;
  perform pg_temp.act_data(u_owner, s_owner);
  if (public.admin_attention_counts(false) ->> 'ledgerUnexplained')::integer < 2 then
    raise exception 'FAILED 4: the live e2e-named charge is not counted %', public.admin_attention_counts(false);
  end if;
  v_passed := v_passed + 1;

  -- ── 5. Two debits on one call.
  v_j := public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('double' || v_tag), now() - interval '1 hour' + interval '40 seconds', 1, 1, 1, 1,
                 'm41-m-' || v_tag || '.com', 2900, 1769)));
  if pg_temp.state(true, pg_temp.trace('double' || v_tag)) is distinct from 'matched'
     or not exists (select 1 from public.ledger_alert_conditions(true) c
                     where c.key = 'ledger_double:' || pg_temp.trace('double' || v_tag) and c.severity = 'critical') then
    raise exception 'FAILED 5: a double charge';
  end if;
  v_passed := v_passed + 1;

  -- ── 6. The balance chain and the snapshots between the last entry and the last read.
  alter table public.supplier_ledger_entries disable trigger supplier_ledger_is_final;
  alter table public.supplier_ledger_revisions disable trigger supplier_ledger_revisions_final;
  delete from public.supplier_ledger_revisions where test_mode;
  delete from public.supplier_ledger_entries where test_mode;
  alter table public.supplier_ledger_entries enable trigger supplier_ledger_is_final;
  alter table public.supplier_ledger_revisions enable trigger supplier_ledger_revisions_final;
  perform public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('ga' || v_tag), now() - interval '10 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-g)', 0, 1000),
    pg_temp.lrow(pg_temp.trace('gb' || v_tag), now() - interval '2 hours', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-h)', 1000, 500)));
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at)
  values (true, 5.00, now() - interval '90 minutes'), (true, 3.00, now() - interval '30 minutes');
  if pg_temp.has_key(true, 'ledger_gap:test') then
    raise exception 'FAILED 6: a gap where the chain holds and the later snapshot is after the read';
  end if;
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at) values (true, 4.00, now() - interval '75 minutes');
  if not pg_temp.has_key(true, 'ledger_gap:test') then
    raise exception 'FAILED 6: a disagreeing snapshot inside the window';
  end if;
  delete from public.supplier_balance_snapshots where test_mode and balance_usd = 4.00;
  perform public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('gc' || v_tag), now() - interval '20 minutes', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-i)', 400, 600)));
  if not pg_temp.has_key(true, 'ledger_gap:test') then
    raise exception 'FAILED 6: a broken chain';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. Top-up costs: credits only, once, then corrected once.
  perform public.record_supplier_ledger(false, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('topup' || v_tag), now() - interval '2 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-t)', 897738, 901338)));
  perform pg_temp.act_data(u_owner, s_owner);
  if public.admin_record_float_topup(pg_temp.trace('ghost' || v_tag)::uuid, 5000000, 'GTB-1', 'paid from GTBank today', gen_random_uuid()) ->> 'code' is distinct from 'NOT_TOPUP' then
    raise exception 'FAILED 7: a debit recorded as a top-up';
  end if;
  v_j := public.admin_record_float_topup(pg_temp.trace('topup' || v_tag)::uuid, 5500000, 'GTB-1', 'paid from GTBank today', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or (select t.usd_cents from public.float_topups t where t.trace_id = pg_temp.trace('topup' || v_tag)::uuid) is distinct from 3600 then
    raise exception 'FAILED 7: record %', v_j;
  end if;
  if public.admin_record_float_topup(pg_temp.trace('topup' || v_tag)::uuid, 5500000, 'GTB-1', 'paid from GTBank today', gen_random_uuid()) ->> 'code' is distinct from 'ALREADY_RECORDED' then
    raise exception 'FAILED 7: a duplicate';
  end if;
  select t.id into v_topup from public.float_topups t where t.trace_id = pg_temp.trace('topup' || v_tag)::uuid;
  v_j := public.admin_correct_float_topup(v_topup, 5600000, 'GTB-1b', 'the bank fee was missed', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true then raise exception 'FAILED 7: correct %', v_j; end if;
  if public.admin_correct_float_topup(v_topup, 5700000, 'GTB-1c', 'the bank fee was missed', gen_random_uuid()) ->> 'code' is distinct from 'NOT_CURRENT' then
    raise exception 'FAILED 7: a second correction of the same row';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. The funnel counts; the rollup is idempotent.
  select coalesce(sum(f.count), 0) into v_count from public.funnel_daily f
   where f.test_mode and f.event = 'cart_add' and f.day = (now() at time zone 'Africa/Lagos')::date;
  perform public.bump_funnel('cart_add', true);
  perform public.bump_funnel('cart_add', true);
  if (select f.count from public.funnel_daily f
       where f.test_mode and f.event = 'cart_add' and f.day = (now() at time zone 'Africa/Lagos')::date) is distinct from v_count + 2 then
    raise exception 'FAILED 8: bump_funnel';
  end if;
  perform public.record_metrics_daily((now() at time zone 'Africa/Lagos')::date);
  select count(*), sum(m.value) into v_count, v_count2 from public.metrics_daily m
   where m.day = (now() at time zone 'Africa/Lagos')::date;
  perform public.record_metrics_daily((now() at time zone 'Africa/Lagos')::date);
  if (select count(*) from public.metrics_daily m where m.day = (now() at time zone 'Africa/Lagos')::date) is distinct from v_count
     or (select sum(m.value) from public.metrics_daily m where m.day = (now() at time zone 'Africa/Lagos')::date) is distinct from v_count2
     or v_count < 30 then
    raise exception 'FAILED 8: record_metrics_daily is not idempotent (% rows)', v_count;
  end if;
  v_passed := v_passed + 1;

  -- ── 9. Reads: admins only; a test admin on the test side, reserved profiles,
  -- its own admin row.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_none, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  foreach v_sql in array array[
    'select public.admin_attention_counts(true)', 'select public.admin_overview(true)',
    'select * from public.admin_revenue(true, ''day'', current_date - 7, current_date)',
    'select * from public.admin_margin(true, current_date - 7, current_date)',
    'select public.admin_funnel(true, current_date - 7, current_date)',
    'select public.admin_provisioning(true, current_date - 7, current_date)',
    'select public.admin_refund_stats(true)', 'select public.admin_float(true)',
    'select * from public.admin_ledger_daily(true, current_date - 7, current_date)',
    'select public.admin_customer_stats()',
    'select * from public.admin_customers(true, ''joined'', ''desc'', 0, 10, ''{}'')',
    'select public.admin_customer(gen_random_uuid(), true)', 'select public.admin_domain_stats(true)',
    'select * from public.admin_tld_held_counts(true)', 'select * from public.admin_preset_usage(true)',
    'select public.admin_email_stats(true, 30)', 'select public.admin_alert_stats(true, 30)',
    'select public.admin_pricing_status()', 'select public.admin_ssl_stats(true)',
    'select * from public.admin_list_admins()',
    'select public.admin_record_float_topup(gen_random_uuid(), 1, ''x'', ''a reason of ten'', gen_random_uuid())',
    'select public.admin_correct_float_topup(1, 1, ''x'', ''a reason of ten'', gen_random_uuid())'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 9: % ran for a non-admin', v_sql;
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'admin:not_admin' then raise exception 'FAILED 9: % said % (a missing grant?)', v_sql, sqlerrm; end if;
    end;
  end loop;
  execute 'reset role';
  perform pg_temp.act_data(u_test, s_test);
  -- Every read that takes a side, asked for the live side by a test admin.
  v_count := 0;
  foreach v_sql in array array[
    'select public.admin_attention_counts(false)', 'select public.admin_overview(false)',
    'select * from public.admin_revenue(false, ''day'', current_date - 7, current_date)',
    'select * from public.admin_margin(false, current_date - 7, current_date)',
    'select public.admin_funnel(false, current_date - 7, current_date)',
    'select public.admin_provisioning(false, current_date - 7, current_date)',
    'select public.admin_refund_stats(false)', 'select public.admin_float(false)',
    'select * from public.admin_ledger_daily(false, current_date - 7, current_date)',
    'select * from public.admin_customers(false, ''joined'', ''desc'', 0, 10, ''{}'')',
    format('select public.admin_customer(%L, false)', u_none), 'select public.admin_domain_stats(false)',
    'select * from public.admin_tld_held_counts(false)', 'select * from public.admin_preset_usage(false)',
    'select public.admin_email_stats(false, 30)', 'select public.admin_alert_stats(false, 30)',
    'select public.admin_ssl_stats(false)'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 9: % ran for a test admin on the live side', v_sql;
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'admin:test_admin' then raise exception 'FAILED 9: % said %', v_sql, sqlerrm; end if;
    end;
    v_count := v_count + 1;
  end loop;
  -- The list above is every granted read with a side: a new one must join it.
  if v_count is distinct from (select count(*)::integer from pg_proc p
                                where p.pronamespace = 'public'::regnamespace and p.proname like 'admin\_%'
                                  and 'p_test_mode' = any (p.proargnames)
                                  and has_function_privilege('authenticated', p.oid, 'execute')) then
    raise exception 'FAILED 9: a read with a side is missing from the test-admin loop';
  end if;
  begin
    perform public.admin_customer_stats();
    raise exception 'FAILED 9: a test admin read the customer stats';
  exception when insufficient_privilege then
    if sqlerrm is distinct from 'admin:test_admin' then raise exception 'FAILED 9: admin_customer_stats said %', sqlerrm; end if;
  end;
  v_j := public.admin_overview(true);
  if v_j #> '{health,cron}' is not null or v_j -> 'float' ->> 'side' is distinct from 'test' then
    raise exception 'FAILED 9: a test admin''s overview %', v_j -> 'health';
  end if;
  if exists (select 1 from public.admin_customers(true, 'joined', 'desc', 0, 100, '{}') c
              where not public.is_reserved_email(c.masked_email))
     or not exists (select 1 from public.admin_customers(true, 'joined', 'desc', 0, 100, '{}') c where c.user_id = u_none) then
    raise exception 'FAILED 9: a test admin''s customer list';
  end if;
  if (select count(*) from public.admin_list_admins()) is distinct from 1
     or (select a.label from public.admin_list_admins() a) is distinct from l_test then
    raise exception 'FAILED 9: a test admin saw other admins';
  end if;
  begin
    perform public.admin_customer(u_real, true);
    raise exception 'FAILED 9: a test admin read a real customer';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.act_data(u_owner, s_owner);
  if (public.admin_overview(false) #> '{health,cron}') is null
     or jsonb_typeof(public.admin_attention_counts(false)) is distinct from 'object'
     or (select count(*) from public.admin_list_admins()) < 2 then
    raise exception 'FAILED 9: the owner''s reads';
  end if;
  v_passed := v_passed + 1;

  -- ── 10. Margin from real costs only, at the rate charged.
  select * into v_ord from pg_temp.paid_line(u_none, true, 'm41-ledger-' || v_tag || '.com', 'completed', 'ml' || v_tag, '2020-03-10');
  select * into v_ord2 from pg_temp.paid_line(u_none, true, 'm41-checkout-' || v_tag || '.com', 'completed', 'mc' || v_tag, '2020-03-11');
  select * into v_ord3 from pg_temp.paid_line(u_none, true, 'm41-none-' || v_tag || '.com', 'completed', 'mn' || v_tag, '2020-03-12');
  select * into v_ord4 from pg_temp.paid_line(u_none, true, 'm41-lost-' || v_tag || '.com', 'failed', 'mf' || v_tag, '2020-03-13');
  insert into public.supplier_ledger_entries (test_mode, trace_id, occurred_at, type, status, charge_type, product_type,
                                              description, old_balance_cents, balance_cents, match_state,
                                              match_order_item_id, matched_at)
  values (true, pg_temp.trace('ml' || v_tag)::uuid, '2020-03-10', 1, 1, 1, 1, 'e2e-m41-ledger', 5000, 3869, 'matched', v_ord.o_item, now()),
         (true, pg_temp.trace('mf' || v_tag)::uuid, '2020-03-13', 1, 1, 1, 1, 'e2e-m41-lost', 3869, 2738, 'matched', v_ord4.o_item, now());
  insert into public.order_item_costs (order_item_id, supplier_cost_cents, icann_fee_cents)
  values (v_ord2.o_item, 1131, 20);
  select count(*) into v_count from public.admin_margin(true, '2020-03-01', '2020-03-31') m
   where (m.row_kind = 'sold' and m.cost_source = 'ledger' and m.lines = 1 and m.costed_lines = 1
          and m.cost_kobo = round(1131 * (select f.costing_rate from public.fx_rates f join public.orders o on o.fx_rate_id = f.id where o.id = v_ord.o_order)))
      or (m.row_kind = 'sold' and m.cost_source = 'checkout' and m.lines = 1 and m.costed_lines = 1)
      or (m.row_kind = 'sold' and m.cost_source = 'none' and m.lines = 1 and m.costed_lines = 0 and m.cost_kobo is null and m.margin_kobo is null)
      or (m.row_kind = 'lost' and m.cost_source = 'ledger' and m.lines = 1 and m.revenue_kobo = 0 and m.margin_kobo < 0);
  if v_count is distinct from 4 then
    raise exception 'FAILED 10: margin rows %', (select jsonb_agg(to_jsonb(m)) from public.admin_margin(true, '2020-03-01', '2020-03-31') m);
  end if;
  v_passed := v_passed + 1;

  -- ── 11. The float: zero burn, stale reads, short-by, and cover alerts.
  alter table public.supplier_ledger_entries disable trigger supplier_ledger_is_final;
  delete from public.supplier_ledger_entries where test_mode;
  alter table public.supplier_ledger_entries enable trigger supplier_ledger_is_final;
  delete from public.supplier_balance_snapshots where test_mode;
  perform public.record_heartbeat('supplier_ledger:ote', true, jsonb_build_object('outcome', 'ok', 'readAt', now()));
  perform public.record_supplier_ledger(true, jsonb_build_array(
    pg_temp.lrow(pg_temp.trace('f1' || v_tag), now() - interval '10 days', 5, 1, 0, 3, 'Ziraat Payment (Order: m41-f)', 0, 10000)));
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at) values (true, 100.00, now());
  v_j := public.float_runway(true);
  if v_j ->> 'burnState' is distinct from 'known' or v_j -> 'runwayDays' is distinct from 'null'::jsonb or (v_j ->> 'burn7dCents')::bigint is distinct from 0 then
    raise exception 'FAILED 11: zero burn %', v_j;
  end if;
  -- 7 days at $1 a day; balance $9 over nothing committed → 9 days: a warning.
  perform public.record_supplier_ledger(true, (
    select jsonb_agg(pg_temp.lrow(pg_temp.trace('d' || g || v_tag), now() - make_interval(days => g) + interval '1 hour',
                                  1, 1, 1, 1, 'm41-burn-' || g || '.com', 10000 - (g - 1) * 100, 10000 - g * 100))
      from generate_series(1, 7) g));
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at) values (true, 9.00, now() + interval '1 second');
  v_j := public.float_runway(true);
  if (v_j ->> 'burn7dCents')::bigint is distinct from 700 or (v_j ->> 'runwayDays')::numeric is distinct from 9
     or (v_j ->> 'target21dCents')::bigint is distinct from 2100 or (v_j ->> 'topUpToTargetCents')::bigint is distinct from 1200
     or not exists (select 1 from public.ledger_alert_conditions(true) c
                     where c.key = 'float_cover:test' and c.severity = 'warning') then
    raise exception 'FAILED 11: nine days %', v_j;
  end if;
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at) values (true, 2.00, now() + interval '2 seconds');
  if not exists (select 1 from public.ledger_alert_conditions(true) c
                  where c.key = 'float_cover:test' and c.severity = 'critical') then
    raise exception 'FAILED 11: two days is not critical %', public.float_runway(true);
  end if;
  -- Committed work above the balance: short by the difference.
  select * into v_ord from pg_temp.paid_line(u_none, true, 'm41-c-' || v_tag || '.com', 'provisioning', 'fc' || v_tag);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm41-c-' || v_tag || '.com', 'com', 'registration', true, 'pending', v_ord.o_item) returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('register_domain', 'm41-c:' || v_tag, v_domain, v_ord.o_item, true, 'queued');
  insert into public.order_item_costs (order_item_id, supplier_cost_cents, icann_fee_cents) values (v_ord.o_item, 1131, 20);
  v_j := public.float_runway(true);
  if (v_j ->> 'committedCents')::bigint is distinct from 1151 or (v_j ->> 'shortByCents')::bigint is distinct from 951
     or (v_j ->> 'uncostedLines')::int is distinct from 0 then
    raise exception 'FAILED 11: short by %', v_j;
  end if;
  -- A stale read: unknown now, with the last known runway.
  perform public.record_heartbeat('supplier_ledger:ote', true,
    jsonb_build_object('outcome', 'failed', 'reason', 'timeout', 'lastOkReadAt', now() - interval '4 hours'));
  update public.service_heartbeats set beat_at = now() - interval '4 hours' where name = 'supplier_ledger:ote';
  v_j := public.float_runway(true);
  if v_j ->> 'burnState' is distinct from 'stale' or v_j -> 'runwayDays' is distinct from 'null'::jsonb or v_j -> 'lastKnownRunway' is null
     or v_j -> 'lastKnownRunway' = 'null'::jsonb
     or exists (select 1 from public.ledger_alert_conditions(true) c where c.key = 'float_cover:test')
     or not exists (select 1 from public.ledger_alert_conditions(true) c where c.key = 'ledger_stale:test') then
    raise exception 'FAILED 11: a stale ledger %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Every existing alert family still fires (one fixture each, test side).
  select * into v_ord from pg_temp.paid_line(u_none, true, 'm41-a1-' || v_tag || '.com', 'pending', 'a1' || v_tag,
                                             now() - interval '2 hours');
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm41-a1-' || v_tag || '.com', 'com', 'registration', true, 'pending', v_ord.o_item) returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status, last_error_code)
  values ('register_domain', 'm41-a1:' || v_tag, v_domain, v_ord.o_item, true, 'needs_attention', 'SUPPLIER_TIMEOUT')
  returning id into v_job;
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status)
  values (v_ord.o_order, v_ord.o_payment, v_ord.o_item, u_none, 'registration_failed', 107500, true, 'held');
  select * into v_ord2 from pg_temp.paid_line(u_none, true, 'm41-a2-' || v_tag || '.com', 'failed', 'a2' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status, run_after)
  values (v_ord2.o_order, v_ord2.o_payment, v_ord2.o_item, u_none, 'registration_failed', 107500, true, 'queued',
          now() - interval '1 hour');
  select * into v_ord3 from pg_temp.paid_line(u_none, true, 'm41-a3-' || v_tag || '.com', 'failed', 'a3' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status,
                              provider_refund_id, submitted_at)
  values (v_ord3.o_order, v_ord3.o_payment, v_ord3.o_item, u_none, 'registration_failed', 107500, true, 'submitted',
          'm41-flw-' || v_tag, now() - interval '11 days');
  insert into public.ssl_products (product_code, name, vendor, validation_type, is_wildcard, is_multi_domain, included_names)
  values ('M41' || upper(left(v_tag, 4)), 'M41 test certificate', 'M41', 'DV', false, false, 1);
  select * into v_ord4 from pg_temp.paid_line(u_none, true, 'm41-a4-' || v_tag || '.com', 'completed', 'a4' || v_tag);
  update public.order_items set item_type = 'ssl', ssl_product_code = 'M41' || upper(left(v_tag, 4)) where id = v_ord4.o_item;
  insert into public.ssl_certificates (user_id, order_item_id, product_code, product_name, common_name, test_mode,
                                       status, supplier_status, status_unrecognised_since)
  values (u_none, v_ord4.o_item, 'M41' || upper(left(v_tag, 4)), 'M41 test certificate', 'm41-a4-' || v_tag || '.com', true,
          'awaiting_validation', 'mystery', now() - interval '2 days')
  returning id into v_cert;
  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode, status)
  values ('ssl_configure', 'm41-a4:' || v_tag, v_cert, true, 'needs_attention');
  insert into public.payment_incidents (test_mode, kind, order_id) values (true, 'tx_ref_mismatch', v_ord.o_order);
  insert into public.registry_drift (test_mode, domain_id, domain_name, kind)
  values (true, v_domain, 'm41-a1-' || v_tag || '.com', 'missing_at_registry');
  insert into public.reconcile_runs (test_mode, started_at) values (true, now() - interval '1 day');
  insert into public.supplier_balance_snapshots (test_mode, balance_usd, taken_at) values (true, 0.01, now() + interval '3 seconds');
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, updated_at, created_at)
  values ('order_receipt', 'transactional', u_none, 'e2e-x@example.com', 'm41-failed:' || v_tag, true, 'failed', now(), now()),
         ('order_receipt', 'transactional', u_none, 'e2e-x@example.com', 'm41-waiting:' || v_tag, true, 'pending', now(), now() - interval '1 hour');
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, sent_at, data)
  values ('expiry_notice', 'compliance', u_none, 'e2e-x@example.com', 'm41-unconfirmed:' || v_tag, true, 'sent',
          now() - interval '25 hours', '{}');
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, sent_at, complained_at)
  values ('order_receipt', 'transactional', u_none, 'e2e-x@example.com', 'm41-complaint:' || v_tag, true, 'sent',
          now() - interval '2 hours', now() - interval '1 hour');
  insert into public.compliance_notices (email_id, domain_id, user_id, domain_name, notice_type, expires_at, recipient,
                                         template_version, sent_at, delivery_status, delivery_checked_at)
  values ((select e.id from public.email_outbox e where e.dedupe_key = 'm41-unconfirmed:' || v_tag), v_domain, u_none,
          'm41-a1-' || v_tag || '.com', 'errp_pre_35', now() + interval '30 days', 'e2e-x@example.com', 'expiry_notice@1',
          now() - interval '25 hours', 'bounced', now() - interval '1 hour');
  foreach v_text in array array['job:', 'ssl_job:', 'ssl_status:', 'order_stuck:', 'refund:', 'refund_overdue:',
                                'refund_slow:', 'incident:', 'drift:', 'reconcile_stale:', 'float_low:',
                                'notice_bounced:', 'email_failed:', 'emails_waiting:', 'email_unconfirmed:',
                                'email_complaint:'] loop
    if not exists (select 1 from public.current_alert_conditions(true) c where c.key like v_text || '%') then
      raise exception 'FAILED 12: no % alert any more', v_text;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.current_alert_conditions(boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.current_alert_conditions(boolean)', 'execute')
     or has_function_privilege('anon', 'public.current_alert_conditions(boolean)', 'execute') then
    raise exception 'FAILED 12: current_alert_conditions grants changed';
  end if;
  v_passed := v_passed + 1;

  -- ── 13. pg_cron: the ERRP job not succeeding for 26 hours, and a failed run.
  delete from cron.job_run_details d using cron.job j where j.jobid = d.jobid and j.jobname = 'email-notices';
  insert into cron.job_run_details (jobid, runid, status, start_time, end_time)
  values ((select j.jobid from cron.job j where j.jobname = 'email-notices'), -4141, 'failed',
          now() - interval '27 hours', now() - interval '27 hours');
  if not pg_temp.has_key(false, 'cron_stale:email-notices')
     or not pg_temp.has_key(false, 'cron_failed:email-notices')
     or exists (select 1 from public.cron_alert_conditions(true)) then
    raise exception 'FAILED 13: cron alerts';
  end if;
  v_passed := v_passed + 1;

  -- ── 14. Grants: the loop, the views, and the cost table (§3.0).
  v_expected := '{
    "admins_factor_is_theirs":"none", "admins_log_change":"none", "admin_changes_final":"none",
    "admin_audit_is_final":"none", "append_only_final":"none", "admin_tier":"none", "admin_session":"none",
    "admin_gate":"none", "admin_replay":"none", "admin_record":"none", "admin_reason_problem":"none",
    "purge_test_admin_audit":"none", "admin_flw_check_done":"none", "admin_json_number":"none",
    "admin_url_host":"none", "admin_lookup_rate_limited":"none",
    "admin_status":"authenticated", "admin_whoami":"authenticated", "admin_note":"authenticated",
    "admin_redact_reason":"authenticated", "admin_approve_refund":"authenticated",
    "admin_retry_refund":"authenticated", "admin_cancel_refund":"authenticated",
    "admin_record_manual_refund":"authenticated", "admin_resolve_payment_incident":"authenticated",
    "admin_retry_job":"authenticated", "admin_retry_ssl_job":"authenticated", "admin_fail_job":"authenticated",
    "admin_fail_ssl_job":"authenticated", "admin_activate_fx_rate":"authenticated",
    "admin_reject_fx_rate":"authenticated", "admin_update_pricing_settings":"authenticated",
    "admin_update_ops_settings":"authenticated", "admin_set_tld_flags":"authenticated",
    "admin_set_ssl_sellable":"authenticated", "admin_save_preset_draft":"authenticated",
    "admin_publish_preset_draft":"authenticated", "admin_discard_preset_draft":"authenticated",
    "admin_set_preset_hidden":"authenticated", "admin_requeue_email":"authenticated",
    "admin_queue_deep_sync":"authenticated", "admin_find_customers":"authenticated",
    "admin_reveal_customer":"authenticated", "admin_reveal_registrant":"authenticated",
    "admin_claim_note":"service_role", "admin_note_result":"service_role", "grant_test_admin":"service_role",
    "record_flw_refund_check":"service_role", "preset_drafts_for_check":"service_role",
    "record_preset_draft_check":"service_role", "admin_mask_email":"service_role",
    "supplier_ledger_is_final":"none", "ledger_int":"none", "ledger_guid":"none", "match_supplier_ledger":"none",
    "order_item_costs_final":"none", "record_metrics_daily":"none", "try_timestamptz":"none",
    "float_runway":"none", "ledger_alert_conditions":"none", "admin_alert_conditions":"none",
    "cron_alert_conditions":"none", "admin_read_gate":"none", "admin_sales_since":"none",
    "admin_record_float_topup":"authenticated", "admin_correct_float_topup":"authenticated",
    "admin_attention_counts":"authenticated", "admin_overview":"authenticated", "admin_revenue":"authenticated",
    "admin_margin":"authenticated", "admin_funnel":"authenticated", "admin_provisioning":"authenticated",
    "admin_refund_stats":"authenticated", "admin_float":"authenticated", "admin_ledger_daily":"authenticated",
    "admin_customer_stats":"authenticated", "admin_customers":"authenticated", "admin_customer":"authenticated",
    "admin_domain_stats":"authenticated", "admin_tld_held_counts":"authenticated",
    "admin_preset_usage":"authenticated", "admin_email_stats":"authenticated", "admin_alert_stats":"authenticated",
    "admin_pricing_status":"authenticated", "admin_ssl_stats":"authenticated", "admin_list_admins":"authenticated",
    "record_supplier_ledger":"service_role", "bump_funnel":"service_role", "seed_test_failed_email":"service_role",
    "hold_test_refund":"service_role", "purge_test_ledger_entries":"service_role",
    "current_alert_conditions":"service_role", "activate_fx_rate":"service_role"
  }';
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and (p.proname like 'admin\_%' or v_expected ? p.proname) loop
    v_want := v_expected ->> v_row.proname;
    if v_want is null then raise exception 'FAILED 14: function % has no expected grant', v_row.proname; end if;
    if has_function_privilege('anon', v_row.oid, 'execute') then raise exception 'FAILED 14: % is anon-executable', v_row.proname; end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 14: % has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 14: an expected function is missing';
  end if;
  foreach v_text in array array['admin_payments_v', 'admin_email_outbox_v', 'admin_compliance_notices_v',
                                'admin_ssl_certificates_v', 'admin_domains_v', 'admin_orders_v'] loop
    if has_table_privilege('anon', 'public.' || v_text, 'select')
       or has_table_privilege('authenticated', 'public.' || v_text, 'select')
       or not has_table_privilege('service_role', 'public.' || v_text, 'select') then
      raise exception 'FAILED 14: view % grants', v_text;
    end if;
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = v_text and c.column_name = 'test_mode') then
      raise exception 'FAILED 14: view % has no test_mode for the side filter', v_text;
    end if;
  end loop;
  if exists (select 1 from information_schema.columns c
              where c.table_schema = 'public' and c.table_name like 'admin\_%\_v'
                and c.column_name in ('raw', 'to_email', 'recipient', 'csr', 'contact', 'approver_email',
                                      'registrant', 'contacts', 'pending_registrant', 'pending_contacts', 'data',
                                      'contact_profile_id', 'email', 'phone', 'full_name', 'business_name')) then
    raise exception 'FAILED 14: a masked view exposes a sensitive column';
  end if;
  if has_table_privilege('authenticated', 'public.order_item_costs', 'select')
     or not has_table_privilege('service_role', 'public.order_item_costs', 'select, insert') then
    raise exception 'FAILED 14: order_item_costs grants';
  end if;
  -- The masked views mask: an address in an error becomes [address].
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, last_error)
  values ('order_receipt', 'transactional', u_none, 'e2e-x@example.com', 'm41-mask:' || v_tag, true, 'failed',
          'rejected e2e-x@example.com by policy');
  if (select v.last_error_safe from public.admin_email_outbox_v v
       join public.email_outbox e on e.id = v.id where e.dedupe_key = 'm41-mask:' || v_tag) is distinct from 'rejected [address] by policy'
     or (select v.masked_to from public.admin_email_outbox_v v
          join public.email_outbox e on e.id = v.id where e.dedupe_key = 'm41-mask:' || v_tag) is distinct from 'e•••@example.com' then
    raise exception 'FAILED 14: the outbox view does not mask';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 41: % checks passed', v_passed;
end;
$$;

rollback;
