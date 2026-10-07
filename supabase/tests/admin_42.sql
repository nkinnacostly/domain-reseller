-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 42, tried as the database owner: the follow-ups the B packages
-- needed from SQL (docs/ADMIN-SPEC.md §9). Every fixture is on the test side
-- or global and inside the transaction; each check raises on failure, and
-- everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/admin_42.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.act42(p_uid uuid, p_sid uuid, p_totp_age interval default interval '1 minute')
returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_totp_age)::bigint)))::text, true);
end $f$;

-- A wrapper's answer must carry exactly this code (NULL never passes, CLAUDE.md §15).
create function pg_temp.code42(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.ok42(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- Runs a statement that must raise; its message must match.
create function pg_temp.raises42(p_sql text, p_like text) returns void language plpgsql as $f$
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

-- A paid test order with one register line, inserted directly: the invoice
-- sequence does not roll back, so nothing here goes through record_order_payment.
create function pg_temp.paid42(p_user uuid, p_domain text, p_status text, p_ref text, p_paid timestamptz default now())
returns table (o_order uuid, o_payment uuid, o_item uuid) language plpgsql as $f$
declare
  v_order uuid;
  v_pay   uuid;
  v_item  uuid;
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (p_user, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f where f.status = 'active' limit 1),
          'MDH-m42-' || p_ref, '{}', 'covered', true, 'provisioning', p_paid)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status)
  values (v_order, p_domain, 'com', 'register', 1, 100000, 100000, false, false, p_status::public.order_item_status)
  returning id into v_item;
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo, currency,
                               status, method, raw)
  values (v_order, p_user, 'flutterwave', 'm42-' || p_ref, 'MDH-m42-' || p_ref, 107500, 'NGN', 'successful', 'card', '{}')
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
  v_name    text;
  v_other   text;
  v_before  jsonb;
  v_after   jsonb;
  v_j       jsonb;
  v_sql     text;
  v_ord     record;
  v_domain  uuid;
  v_job     uuid;
  v_cert    uuid;
  v_ssl_job uuid;
  v_rank    integer;
  v_key     uuid;
  v_minutes integer;
  v_cents   bigint;
  v_row     record;
  v_expected jsonb;
  v_want    text;
  v_n       integer := 0;
  v_passed  integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin42-o-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin42-t-' || v_tag || '@example.com', now(), now()),
    (u_none, 'authenticated', 'authenticated', 'e2e-admin42-n-' || v_tag || '@example.com', now(), now()),
    (u_real, 'authenticated', 'authenticated', 'm42-real-' || v_tag || '@mydomainshub.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_owner, u_owner, 'm42', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm42', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_owner, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, 'm42-owner-' || v_tag, 'owner', array[f_owner], 'm42-check');
  perform public.grant_test_admin(u_test);

  -- ── 1. The overview counts paid lines over 7, 30 and 90 days, as it counts sales.
  perform pg_temp.act42(u_owner, s_owner);
  v_before := public.admin_overview(true) -> 'lines';
  select * into v_ord from pg_temp.paid42(u_none, 'm42-l3-' || v_tag || '.com', 'completed', 'l3' || v_tag, now() - interval '3 days');
  select * into v_ord from pg_temp.paid42(u_none, 'm42-l20-' || v_tag || '.com', 'completed', 'l20' || v_tag, now() - interval '20 days');
  select * into v_ord from pg_temp.paid42(u_none, 'm42-l60-' || v_tag || '.com', 'completed', 'l60' || v_tag, now() - interval '60 days');
  select * into v_ord from pg_temp.paid42(u_none, 'm42-l100-' || v_tag || '.com', 'completed', 'l100' || v_tag, now() - interval '100 days');
  v_after := public.admin_overview(true) -> 'lines';
  if (select array_agg(k order by k) from jsonb_object_keys(v_after) k) is distinct from array['d30', 'd7', 'd90'] then
    raise exception 'FAILED 1: line windows %', v_after;
  end if;
  if (v_after #>> '{d7,register}')::int - (v_before #>> '{d7,register}')::int is distinct from 1
     or (v_after #>> '{d30,register}')::int - (v_before #>> '{d30,register}')::int is distinct from 2
     or (v_after #>> '{d90,register}')::int - (v_before #>> '{d90,register}')::int is distinct from 3
     or (v_after #>> '{d7,renew}') is distinct from (v_before #>> '{d7,renew}')
     or (v_after #>> '{d90,ssl}') is distinct from (v_before #>> '{d90,ssl}')
     or (v_after #>> '{d30,transfer}') is distinct from (v_before #>> '{d30,transfer}') then
    raise exception 'FAILED 1: lines by period, before % after %', v_before, v_after;
  end if;
  -- The windows are the sales windows: 7 ⊆ 30 ⊆ 90, and orders paid move with them.
  v_j := public.admin_overview(true);
  if (v_j #>> '{lines,d7,register}')::int > (v_j #>> '{lines,d30,register}')::int
     or (v_j #>> '{lines,d30,register}')::int > (v_j #>> '{lines,d90,register}')::int
     or (v_j #>> '{sales,d7,ordersPaid}') is null or (v_j #>> '{sales,d90,ordersPaid}') is null then
    raise exception 'FAILED 1: windows out of order %', v_j -> 'lines';
  end if;
  perform pg_temp.act42(u_test, s_test);
  if jsonb_typeof(public.admin_overview(true) #> '{lines,d90}') is distinct from 'object' then
    raise exception 'FAILED 1: a test admin''s overview has no 90-day lines';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Customers by id: exactly those asked for, none for an empty list, a
  -- refusal for anything that is not a list of uuids; a test admin's still e2e only.
  perform pg_temp.act42(u_owner, s_owner);
  if (select array_agg(c.user_id order by c.user_id)
        from public.admin_customers(true, 'joined', 'desc', 0, 100, jsonb_build_object('userIds', jsonb_build_array(u_none, u_real))) c)
     is distinct from (select array_agg(x order by x) from unnest(array[u_none, u_real]) x)
     or (select max(c.total_count) from public.admin_customers(true, 'joined', 'desc', 0, 100,
                                                               jsonb_build_object('userIds', jsonb_build_array(u_none, u_real))) c) is distinct from 2 then
    raise exception 'FAILED 2: the owner''s lookup by id';
  end if;
  if exists (select 1 from public.admin_customers(true, 'joined', 'desc', 0, 100, '{"userIds": []}')) then
    raise exception 'FAILED 2: an empty id list matched someone';
  end if;
  if (select c.masked_email from public.admin_customers(true, 'joined', 'desc', 0, 100,
                                                        jsonb_build_object('userIds', jsonb_build_array(u_none))) c)
     is distinct from public.admin_mask_email('e2e-admin42-n-' || v_tag || '@example.com') then
    raise exception 'FAILED 2: a looked-up buyer is not masked';
  end if;
  -- Other filters still apply alongside the ids.
  if exists (select 1 from public.admin_customers(true, 'joined', 'desc', 0, 100,
                                                  jsonb_build_object('userIds', jsonb_build_array(u_none), 'hasTotp', true))) then
    raise exception 'FAILED 2: the ids dropped the other filters';
  end if;
  perform pg_temp.raises42('select * from public.admin_customers(true, ''joined'', ''desc'', 0, 10, ''{"userIds": "x"}'')',
                           'admin:bad_filter');
  perform pg_temp.raises42('select * from public.admin_customers(true, ''joined'', ''desc'', 0, 10, ''{"userIds": {"a": 1}}'')',
                           'admin:bad_filter');
  perform pg_temp.raises42('select * from public.admin_customers(true, ''joined'', ''desc'', 0, 10, ''{"userIds": ["not-a-uuid"]}'')',
                           '%invalid input syntax for type uuid%');
  perform pg_temp.act42(u_test, s_test);
  if (select array_agg(c.user_id)
        from public.admin_customers(true, 'joined', 'desc', 0, 100, jsonb_build_object('userIds', jsonb_build_array(u_none, u_real))) c)
     is distinct from array[u_none] then
    raise exception 'FAILED 2: a test admin looked up a real customer by id';
  end if;
  perform pg_temp.raises42(format('select * from public.admin_customers(false, ''joined'', ''desc'', 0, 10, %L)',
                                  jsonb_build_object('userIds', jsonb_build_array(u_none))), 'admin:test_admin');
  v_passed := v_passed + 1;

  -- ── 3. The stuck-order threshold, for any admin, a test admin included.
  select s.stuck_order_minutes into v_minutes from public.ops_settings s where s.id;
  perform pg_temp.act42(u_owner, s_owner);
  if public.admin_stuck_order_minutes() is distinct from v_minutes then
    raise exception 'FAILED 3: the owner''s threshold';
  end if;
  perform pg_temp.act42(u_test, s_test);
  if public.admin_stuck_order_minutes() is distinct from v_minutes then
    raise exception 'FAILED 3: a test admin''s threshold';
  end if;
  -- A stale code is refused by the read itself.
  perform pg_temp.act42(u_test, s_test, interval '13 hours');
  perform pg_temp.raises42('select public.admin_stuck_order_minutes()', 'admin:needs_code');
  v_passed := v_passed + 1;

  -- ── 4. The example extension in whole cents, or null when not cent-exact.
  perform pg_temp.act42(u_test, s_test);
  v_j := public.admin_pricing_status();
  select case when t.register_usd * 100 = trunc(t.register_usd * 100) then (t.register_usd * 100)::bigint end
    into v_cents from public.tlds t where t.name = 'com';
  if v_j #>> '{example,name}' is distinct from 'com'
     or (v_j #>> '{example,registerCents}')::bigint is distinct from v_cents
     or (v_j #>> '{example,renewCents}')::bigint is distinct from
          (select case when t.renew_usd * 100 = trunc(t.renew_usd * 100) then (t.renew_usd * 100)::bigint end
             from public.tlds t where t.name = 'com')
     or jsonb_typeof(v_j #> '{example,isSellable}') is distinct from 'boolean'
     or jsonb_typeof(v_j #> '{example,minPeriod}') is distinct from 'number'
     or not (v_j ? 'tlds' and v_j ? 'ssl' and v_j ? 'fx' and v_j ? 'settings') then
    raise exception 'FAILED 4: the example %', v_j -> 'example';
  end if;
  update public.tlds set register_usd = 10.1234, renew_usd = 12.5 where name = 'com';
  v_j := public.admin_pricing_status();
  if v_j #> '{example,registerCents}' is distinct from 'null'::jsonb
     or (v_j #>> '{example,renewCents}')::bigint is distinct from 1250 then
    raise exception 'FAILED 4: a cost not cent-exact %', v_j -> 'example';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. A job's ledger check: the charges admin_fail_job tests, counted, and
  -- the last read; side-filtered.
  perform public.record_heartbeat('supplier_ledger:ote', true,
    jsonb_build_object('outcome', 'ok', 'readAt', now() - interval '10 minutes'));
  v_name := 'm42-j-' || v_tag || '.com';
  select * into v_ord from pg_temp.paid42(u_none, v_name, 'provisioning', 'j' || v_tag, now() - interval '2 hours');
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, v_name, 'com', 'registration', true, 'pending', v_ord.o_item) returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status, last_error_code, created_at)
  values ('register_domain', 'm42-j:' || v_tag, v_domain, v_ord.o_item, true, 'needs_attention', 'SUPPLIER_TIMEOUT',
          now() - interval '1 hour')
  returning id into v_job;
  insert into public.supplier_ledger_entries (test_mode, trace_id, occurred_at, type, status, charge_type, product_type,
                                              description, old_balance_cents, balance_cents) values
    -- Before the job, a certificate, a credit and another name: none counts.
    (true, gen_random_uuid(), now() - interval '90 minutes', 1, 1, 1, 1, v_name, 900, 800),
    (true, gen_random_uuid(), now() - interval '30 minutes', 1, 1, 1, 2, v_name, 800, 700),
    (true, gen_random_uuid(), now() - interval '30 minutes', 5, 1, 0, 1, v_name, 700, 900),
    (true, gen_random_uuid(), now() - interval '30 minutes', 1, 1, 1, 1, 'm42-other-' || v_tag || '.com', 900, 800);
  perform pg_temp.act42(u_owner, s_owner);
  v_j := public.admin_job_ledger(true, v_job);
  if (v_j ->> 'charges')::int is distinct from 0
     or (v_j ->> 'jobId')::uuid is distinct from v_job
     or (v_j ->> 'since')::timestamptz is distinct from (select j.created_at from public.jobs j where j.id = v_job)
     or (v_j ->> 'readAt')::timestamptz is null
     or abs(extract(epoch from (v_j ->> 'readAt')::timestamptz - (now() - interval '10 minutes'))) > 1
     or v_j ->> 'outcome' is distinct from 'ok'
     or (v_j ->> 'syncedAt')::timestamptz is null then
    raise exception 'FAILED 5: no charge yet %', v_j;
  end if;
  -- A debit naming it after the job started counts, and admin_fail_job agrees.
  insert into public.supplier_ledger_entries (test_mode, trace_id, occurred_at, type, status, charge_type, product_type,
                                              description, old_balance_cents, balance_cents)
  values (true, gen_random_uuid(), now() - interval '20 minutes', 1, 1, 1, 1, 'Registration of ' || upper(v_name), 800, 669);
  if (public.admin_job_ledger(true, v_job) ->> 'charges')::int is distinct from 1 then
    raise exception 'FAILED 5: a charge naming the domain was not counted';
  end if;
  insert into public.supplier_calls (job_id, environment, operation, domain_name, outcome, duration_ms, created_at) values
    (v_job, 'ote', 'RegisterWithContactInfo', v_name, 'unknown', 30000, now() - interval '50 minutes'),
    (null, 'ote', 'AdminGetDetails', v_name, 'not_found', 300, now() - interval '1 minute');
  perform pg_temp.code42(public.admin_fail_job(v_job, 'the registry has no record of it', gen_random_uuid()),
                         'LEDGER_SHOWS_CHARGE', 'FAILED 5: admin_fail_job and the count disagree');
  -- A failed sync: the last good read stands.
  perform public.record_heartbeat('supplier_ledger:ote', true,
    jsonb_build_object('outcome', 'failed', 'lastOkReadAt', now() - interval '3 hours'));
  v_j := public.admin_job_ledger(true, v_job);
  if v_j ->> 'outcome' is distinct from 'failed'
     or abs(extract(epoch from (v_j ->> 'readAt')::timestamptz - (now() - interval '3 hours'))) > 1 then
    raise exception 'FAILED 5: a failed sync %', v_j;
  end if;
  -- Side-filtered: the test job is not on the live side; a missing job is null.
  if public.admin_job_ledger(false, v_job) is not null or public.admin_job_ledger(true, gen_random_uuid()) is not null then
    raise exception 'FAILED 5: the side filter';
  end if;
  perform pg_temp.act42(u_test, s_test);
  if (public.admin_job_ledger(true, v_job) ->> 'charges')::int is distinct from 1 then
    raise exception 'FAILED 5: a test admin on the test side';
  end if;
  perform pg_temp.raises42(format('select public.admin_job_ledger(false, %L)', v_job), 'admin:test_admin');
  v_passed := v_passed + 1;

  -- ── 6. A certificate job's name and line, and nothing more of the certificate.
  insert into public.ssl_products (product_code, name, vendor, validation_type, is_wildcard, is_multi_domain, included_names)
  values ('M42' || upper(left(v_tag, 4)), 'M42 test certificate', 'M42', 'DV', false, false, 1);
  select * into v_ord from pg_temp.paid42(u_none, 'm42-s-' || v_tag || '.com', 'provisioning', 's' || v_tag);
  update public.order_items set item_type = 'ssl', ssl_product_code = 'M42' || upper(left(v_tag, 4)) where id = v_ord.o_item;
  insert into public.ssl_certificates (user_id, order_item_id, product_code, product_name, common_name, test_mode)
  values (u_none, v_ord.o_item, 'M42' || upper(left(v_tag, 4)), 'M42 test certificate', 'm42-s-' || v_tag || '.com', true)
  returning id into v_cert;
  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode, status, last_error_code)
  values ('ssl_initialize', 'm42-s:' || v_tag, v_cert, true, 'needs_attention', 'SUPPLIER_TIMEOUT')
  returning id into v_ssl_job;
  perform pg_temp.act42(u_owner, s_owner);
  v_j := public.admin_ssl_job_certificate(true, v_ssl_job);
  if v_j is distinct from jsonb_build_object('commonName', 'm42-s-' || v_tag || '.com', 'orderItemId', v_ord.o_item) then
    raise exception 'FAILED 6: the certificate %', v_j;
  end if;
  if public.admin_ssl_job_certificate(false, v_ssl_job) is not null
     or public.admin_ssl_job_certificate(true, gen_random_uuid()) is not null
     or public.admin_ssl_job_certificate(true, v_job) is not null then
    raise exception 'FAILED 6: the side filter';
  end if;
  perform pg_temp.act42(u_test, s_test);
  if public.admin_ssl_job_certificate(true, v_ssl_job) ->> 'orderItemId' is distinct from v_ord.o_item::text then
    raise exception 'FAILED 6: a test admin on the test side';
  end if;
  perform pg_temp.raises42(format('select public.admin_ssl_job_certificate(false, %L)', v_ssl_job), 'admin:test_admin');
  v_passed := v_passed + 1;

  -- ── 7. A featured rank another extension holds: refused RANK_TAKEN, recorded,
  -- nothing changed; the refusal frees its key for a rank that is free.
  select min(r) into v_rank from generate_series(1, 50) r
   where not exists (select 1 from public.tlds t where t.featured_rank = r);
  select t.name into v_name from public.tlds t where not t.is_paused and t.featured_rank is null order by t.name limit 1;
  select t.name into v_other from public.tlds t
   where not t.is_paused and t.featured_rank is null and t.name <> v_name order by t.name limit 1;
  update public.tlds set featured_rank = v_rank where name = v_other;
  perform pg_temp.act42(u_owner, s_owner);
  v_key := gen_random_uuid();
  v_j := public.admin_set_tld_flags(v_name, null, null, v_rank, null, 'feature it on the home page', v_key);
  perform pg_temp.code42(v_j, 'RANK_TAKEN', 'FAILED 7: a rank already held');
  if (v_j ->> 'ok')::boolean is not false
     or (select t.featured_rank from public.tlds t where t.name = v_name) is not null
     or (select t.featured_rank from public.tlds t where t.name = v_other) is distinct from v_rank then
    raise exception 'FAILED 7: a refused rank changed something %', v_j;
  end if;
  if not exists (select 1 from public.admin_audit_log a
                  where a.id = (v_j ->> 'auditId')::bigint and a.action = 'extension.flags' and a.outcome = 'refused'
                    and a.error_code = 'RANK_TAKEN' and a.target_id = v_name and a.request_key = v_key
                    and a.detail ->> 'rank_held_by' = v_other and (a.detail #>> '{asked,featured_rank}')::int = v_rank) then
    raise exception 'FAILED 7: the refusal was not recorded %', v_j;
  end if;
  select min(r) into v_rank from generate_series(1, 50) r
   where not exists (select 1 from public.tlds t where t.featured_rank = r);
  perform pg_temp.ok42(public.admin_set_tld_flags(v_name, null, null, v_rank, null, 'feature it on the home page', v_key),
                       'FAILED 7: the same key with a free rank');
  if (select t.featured_rank from public.tlds t where t.name = v_name) is distinct from v_rank then
    raise exception 'FAILED 7: a free rank was not set';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. Strangers: every function here refuses a non-admin.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_none, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  foreach v_sql in array array[
    'select public.admin_overview(true)',
    'select * from public.admin_customers(true, ''joined'', ''desc'', 0, 10, ''{"userIds": []}'')',
    'select public.admin_stuck_order_minutes()',
    'select public.admin_pricing_status()',
    format('select public.admin_job_ledger(true, %L)', v_job),
    format('select public.admin_ssl_job_certificate(true, %L)', v_ssl_job),
    format('select public.admin_set_tld_flags(%L, null, null, 0, null, ''un-feature it for now'', gen_random_uuid())', v_name)
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 8: % ran for a non-admin', v_sql;
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'admin:not_admin' then raise exception 'FAILED 8: % said % (a missing grant?)', v_sql, sqlerrm; end if;
    end;
  end loop;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 9. Grants (§3.0): the loop over every admin_* function, migrations 40–42 and Mail's (51).
  v_expected := '{
    "admins_factor_is_theirs":"none", "admins_log_change":"none", "admin_changes_final":"none",
    "admin_audit_is_final":"none", "append_only_final":"none", "admin_tier":"none", "admin_session":"none",
    "admin_gate":"none", "admin_replay":"none", "admin_record":"none", "admin_reason_problem":"none",
    "purge_test_admin_audit":"none", "admin_flw_check_done":"none", "admin_json_number":"none",
    "admin_url_host":"none", "admin_lookup_rate_limited":"none", "admin_e2e_email":"none",
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
    "admin_stuck_order_minutes":"authenticated", "admin_job_ledger":"authenticated",
    "admin_ssl_job_certificate":"authenticated",
    "record_supplier_ledger":"service_role", "bump_funnel":"service_role", "seed_test_failed_email":"service_role",
    "hold_test_refund":"service_role", "purge_test_ledger_entries":"service_role",
    "current_alert_conditions":"service_role", "activate_fx_rate":"service_role",
    "admin_mail_approve_account":"authenticated", "admin_mail_reject_account":"authenticated",
    "admin_mail_pause_account":"authenticated", "admin_mail_resume_account":"authenticated",
    "admin_mail_override_caps":"authenticated", "admin_mail_overview":"authenticated",
    "admin_mail_review_queue":"authenticated", "admin_mail_accounts":"authenticated",
    "admin_mail_account":"authenticated", "admin_mail_domains":"authenticated",
    "admin_mail_ses_health":"authenticated", "admin_mail_audit":"authenticated",
    "admin_mail_billing_incidents":"authenticated"
  }';
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and (p.proname like 'admin\_%' or v_expected ? p.proname) loop
    v_want := v_expected ->> v_row.proname;
    if v_want is null then raise exception 'FAILED 9: function % has no expected grant', v_row.proname; end if;
    if has_function_privilege('anon', v_row.oid, 'execute') then raise exception 'FAILED 9: % is anon-executable', v_row.proname; end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 9: % has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 9: an expected function is missing (% of %)', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  -- Each function migration 42 creates or re-creates: one signature, granted to authenticated only.
  foreach v_sql in array array['admin_overview(boolean)', 'admin_customers(boolean, text, text, integer, integer, jsonb)',
                               'admin_stuck_order_minutes()', 'admin_pricing_status()', 'admin_job_ledger(boolean, uuid)',
                               'admin_ssl_job_certificate(boolean, uuid)',
                               'admin_set_tld_flags(text, boolean, text, integer, text, text, uuid)'] loop
    if has_function_privilege('public', ('public.' || v_sql)::regprocedure, 'execute')
       or has_function_privilege('anon', ('public.' || v_sql)::regprocedure, 'execute')
       or has_function_privilege('service_role', ('public.' || v_sql)::regprocedure, 'execute')
       or not has_function_privilege('authenticated', ('public.' || v_sql)::regprocedure, 'execute') then
      raise exception 'FAILED 9: % grants', v_sql;
    end if;
    if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.proname = split_part(v_sql, '(', 1)) is distinct from 1::bigint then
      raise exception 'FAILED 9: % has a second signature', v_sql;
    end if;
  end loop;
  v_passed := v_passed + 1;

  raise notice 'migration 42: % checks passed', v_passed;
end;
$$;

rollback;
