-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 40, tried as the database owner and, where the grant is the
-- point, as `authenticated` and `service_role` (docs/ADMIN-SPEC.md §3.3).
-- Admins, factors, sessions and claims are made up inside the transaction;
-- live payments and refunds are inserted directly, never through
-- record_order_payment, because the invoice sequence does not roll back.
-- Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/admin.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Claims for a session: who, which session, how fresh the code is, how they signed in.
create function pg_temp.act(p_uid uuid, p_sid uuid, p_totp_age interval default interval '1 minute',
                            p_aal text default 'aal2', p_methods text[] default array['password'])
returns void language plpgsql as $f$
declare
  v_amr jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'timestamp',
                    extract(epoch from now() - interval '2 hours')::bigint)), '[]'::jsonb)
    into v_amr from unnest(p_methods) m;
  if p_totp_age is not null then
    v_amr := v_amr || jsonb_build_array(jsonb_build_object('method', 'totp',
               'timestamp', extract(epoch from now() - p_totp_age)::bigint));
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_sid, 'amr', v_amr)::text, true);
end $f$;

-- A paid order with one register line, its payment recorded directly.
create function pg_temp.paid_order(p_user uuid, p_test boolean, p_domain text, p_line_status text, p_ref text)
returns table (o_order uuid, o_payment uuid, o_item uuid) language plpgsql as $f$
declare
  v_order uuid;
  v_pay   uuid;
  v_item  uuid;
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (p_user, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f order by f.created_at limit 1),
          'MDH-m40-' || p_ref, '{}', 'covered', p_test, 'provisioning', now())
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status)
  values (v_order, p_domain, 'com', 'register', 1, 100000, 100000, false, false,
          p_line_status::public.order_item_status)
  returning id into v_item;
  insert into public.payments (order_id, user_id, provider, provider_reference, tx_ref, amount_kobo,
                               currency, status, method, raw)
  values (v_order, p_user, 'flutterwave', 'm40-' || p_ref, 'MDH-m40-' || p_ref, 107500, 'NGN', 'successful',
          'card', '{}')
  returning id into v_pay;
  update public.orders set payment_id = v_pay where id = v_order;
  return query select v_order, v_pay, v_item;
end $f$;

-- Runs a statement that must raise; its message must match.
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

create function pg_temp.audit_count(p_label text, p_action text, p_outcome text, p_code text default null)
returns integer language sql as $f$
  select count(*)::integer from public.admin_audit_log a
   where a.admin_label = p_label and a.action = p_action and a.outcome = p_outcome
     and (p_code is null or a.error_code = p_code)
$f$;

do $$
declare
  v_tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner    uuid := gen_random_uuid();
  u_op       uuid := gen_random_uuid();
  u_view     uuid := gen_random_uuid();
  u_test     uuid := gen_random_uuid();
  u_none     uuid := gen_random_uuid();
  u_rev      uuid := gen_random_uuid();
  u_real     uuid := gen_random_uuid();
  u_resv     uuid := gen_random_uuid();   -- a reserved address, but not an e2e user's
  u_nofactor uuid := gen_random_uuid();
  f_o1       uuid := gen_random_uuid();
  f_o2       uuid := gen_random_uuid();
  f_o3       uuid := gen_random_uuid();   -- verified, never pinned
  f_op       uuid := gen_random_uuid();
  f_view     uuid := gen_random_uuid();
  f_test     uuid := gen_random_uuid();
  f_none     uuid := gen_random_uuid();
  f_rev      uuid := gen_random_uuid();
  f_real     uuid := gen_random_uuid();
  s_owner    uuid := gen_random_uuid();
  s_op       uuid := gen_random_uuid();
  s_view     uuid := gen_random_uuid();
  s_test     uuid := gen_random_uuid();
  s_none     uuid := gen_random_uuid();
  s_rev      uuid := gen_random_uuid();
  l_owner    text := 'm40-owner-' || v_tag;
  l_op       text := 'm40-op-' || v_tag;
  l_view     text := 'm40-view-' || v_tag;
  l_test     text;
  v_j        jsonb;
  v_text     text;
  v_count    integer;
  v_key      uuid;
  v_key2     uuid;
  v_ord      record;
  v_ord2     record;
  v_refund   uuid;
  v_refund2  uuid;
  v_domain   uuid;
  v_job      uuid;
  v_job2     uuid;
  v_cert     uuid;
  v_ssl_job  uuid;
  v_check    bigint;
  v_note     bigint;
  v_note2    bigint;
  v_rate     uuid;
  v_rate2    uuid;
  v_rate3    uuid;
  v_preset   uuid;
  v_draft    uuid;
  v_incident bigint;
  v_audit    bigint;
  v_sql      text;
  v_expected jsonb;
  v_row      record;
  v_want     text;
  v_n        integer := 0;
  v_rank     integer;
  v_email_id uuid;
  v_lock     bigint;
  v_detail   jsonb;
  v_passed   integer := 0;
begin
  -- ── People: an owner with two pinned devices, an operator, a viewer, a test
  -- admin, a revoked admin, a stranger, a real address, a reserved address
  -- that is not an e2e user's, and one with no factor.
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin-o-' || v_tag || '@example.com', now(), now()),
    (u_op, 'authenticated', 'authenticated', 'e2e-admin-p-' || v_tag || '@example.com', now(), now()),
    (u_view, 'authenticated', 'authenticated', 'e2e-admin-v-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin-t-' || v_tag || '@example.com', now(), now()),
    (u_none, 'authenticated', 'authenticated', 'e2e-admin-n-' || v_tag || '@example.com', now(), now()),
    (u_rev, 'authenticated', 'authenticated', 'e2e-admin-r-' || v_tag || '@example.com', now(), now()),
    (u_real, 'authenticated', 'authenticated', 'm40-real-' || v_tag || '@mydomainshub.com', now(), now()),
    (u_resv, 'authenticated', 'authenticated', 'm40-resv-' || v_tag || '@example.com', now(), now()),
    (u_nofactor, 'authenticated', 'authenticated', 'e2e-admin-x-' || v_tag || '@example.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_o1, u_owner, 'm40 phone', 'totp', 'verified', now() - interval '2 days', now(), 'x'),
    (f_o2, u_owner, 'm40 backup', 'totp', 'verified', now() - interval '1 day', now(), 'x'),
    (f_o3, u_owner, 'm40 spare', 'totp', 'verified', now(), now(), 'x'),
    (f_op, u_op, 'm40', 'totp', 'verified', now(), now(), 'x'),
    (f_view, u_view, 'm40', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm40', 'totp', 'verified', now(), now(), 'x'),
    (f_none, u_none, 'm40', 'totp', 'verified', now(), now(), 'x'),
    (f_rev, u_rev, 'm40', 'totp', 'verified', now(), now(), 'x'),
    (f_real, u_real, 'm40', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_o2, 'aal2'),
    (s_op, u_op, now(), now(), f_op, 'aal2'),
    (s_view, u_view, now(), now(), f_view, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2'),
    (s_none, u_none, now(), now(), f_none, 'aal2'),
    (s_rev, u_rev, now(), now(), f_rev, 'aal2');
  insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
  select gen_random_uuid(), s, now(), now(), m
    from unnest(array[s_owner, s_op, s_view, s_test, s_none, s_rev]) s, unnest(array['password', 'totp']) m;

  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by) values
    (u_owner, l_owner, 'owner', array[f_o1, f_o2], 'm40-check'),
    (u_op, l_op, 'operator', array[f_op], 'm40-check'),
    (u_view, l_view, 'viewer', array[f_view], 'm40-check'),
    (u_rev, 'm40-rev-' || v_tag, 'operator', array[f_rev], 'm40-check');
  l_test := public.grant_test_admin(u_test);

  -- ── 1. A stranger: not_admin, and no wrapper or note runs, as `authenticated`.
  perform pg_temp.act(u_none, s_none);
  execute 'set local role authenticated';
  if public.admin_status() is distinct from 'not_admin' then
    raise exception 'FAILED 1: a non-admin''s status is %', public.admin_status();
  end if;
  foreach v_sql in array array[
    'select public.admin_whoami(null)',
    'select public.admin_note(''supplier.balance'', ''live'', ''side'', ''live'')',
    'select public.admin_redact_reason(1, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_approve_refund(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_retry_refund(gen_random_uuid(), true, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_cancel_refund(gen_random_uuid(), true, true, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_record_manual_refund(gen_random_uuid(), 1, ''abc'', true, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_resolve_payment_incident(1, null, null, null, false, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_retry_job(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_retry_ssl_job(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_fail_job(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_fail_ssl_job(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_activate_fx_rate(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_reject_fx_rate(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_update_pricing_settings(''{}'', ''a reason of ten'', gen_random_uuid())',
    'select public.admin_update_ops_settings(''{}'', ''a reason of ten'', gen_random_uuid())',
    'select public.admin_set_tld_flags(''com'', false, null, null, null, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_set_ssl_sellable(''x'', false, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_save_preset_draft(null, ''x'', ''{}'', ''https://x.test'', null, false, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_publish_preset_draft(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_discard_preset_draft(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_set_preset_hidden(gen_random_uuid(), true, ''a reason of ten'', gen_random_uuid())',
    'select public.admin_requeue_email(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_queue_deep_sync(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
    'select public.admin_find_customers(''someone@example.com'')',
    'select public.admin_reveal_customer(gen_random_uuid(), null, gen_random_uuid())',
    'select public.admin_reveal_registrant(gen_random_uuid(), null, gen_random_uuid())'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 1: % ran for a non-admin', v_sql;
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'admin:not_admin' then
        raise exception 'FAILED 1: % said % (a missing grant?)', v_sql, sqlerrm;
      end if;
    end;
  end loop;
  execute 'reset role';
  if exists (select 1 from public.admin_audit_log a where a.admin_id = u_none) then
    raise exception 'FAILED 1: a stranger left audit rows';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. aal1 claims: needs_code.
  perform pg_temp.act(u_owner, s_owner, interval '1 minute', 'aal1');
  if public.admin_status() is distinct from 'needs_code' then
    raise exception 'FAILED 2: aal1 status %', public.admin_status();
  end if;
  v_passed := v_passed + 1;

  -- ── 3. A code 13 hours old is too old to view; 20 minutes old views, but not money.
  perform pg_temp.act(u_owner, s_owner, interval '13 hours');
  perform pg_temp.expect_raise('select public.admin_whoami(null)', 'admin:needs_code');
  -- The view window's edge (D8): 12 hours, a minute either side.
  perform pg_temp.act(u_owner, s_owner, interval '11 hours 59 minutes');
  if public.admin_status() is distinct from 'ok' then
    raise exception 'FAILED 3: a code 11 h 59 min old could not view (%)', public.admin_status();
  end if;
  perform public.admin_whoami(null);
  perform pg_temp.act(u_owner, s_owner, interval '12 hours 1 minute');
  if public.admin_status() is distinct from 'needs_code' then
    raise exception 'FAILED 3: a code 12 h 1 min old could view (%)', public.admin_status();
  end if;
  perform pg_temp.expect_raise('select public.admin_whoami(null)', 'admin:needs_code');
  perform pg_temp.act(u_owner, s_owner, interval '20 minutes');
  v_j := public.admin_whoami(null);
  if v_j ->> 'label' is distinct from l_owner or v_j ->> 'role' is distinct from 'owner' or (v_j ->> 'factorId')::uuid is distinct from f_o2
     or (v_j ->> 'testOnly')::boolean is not false or char_length(v_j ->> 'sessionHash') is distinct from 64 then
    raise exception 'FAILED 3: whoami %', v_j;
  end if;
  perform pg_temp.expect_raise('select public.admin_whoami(5)', 'admin:needs_code');
  v_j := public.admin_update_ops_settings('{"stuck_order_minutes": 20}', 'a reason of ten words', gen_random_uuid());
  if v_j ->> 'code' is distinct from 'NEEDS_CODE' or pg_temp.audit_count(l_owner, 'settings.update', 'refused', 'NEEDS_CODE') is distinct from 1 then
    raise exception 'FAILED 3: a 20-minute code passed a money wrapper (%)', v_j;
  end if;
  -- The money tier's edge (D6): a code 4 minutes old passes the gate (the
  -- refusal is the wrapper's own, UNKNOWN_KEY); 6 minutes old does not. And
  -- just either side of 5 minutes: 4 min 59 s passes, 5 min 1 s does not.
  foreach v_text in array array['4 minutes', '4 minutes 59 seconds'] loop
    perform pg_temp.act(u_owner, s_owner, v_text::interval);
    perform public.admin_whoami(5);
    perform pg_temp.expect_code(public.admin_update_ops_settings('{"nope": 1}', 'a reason of ten words', gen_random_uuid()),
                                'UNKNOWN_KEY', 'FAILED 3: a code ' || v_text || ' old was refused by a money wrapper');
  end loop;
  foreach v_text in array array['5 minutes 1 second', '6 minutes'] loop
    perform pg_temp.act(u_owner, s_owner, v_text::interval);
    perform pg_temp.expect_raise('select public.admin_whoami(5)', 'admin:needs_code');
    perform pg_temp.expect_code(public.admin_update_ops_settings('{"nope": 1}', 'a reason of ten words', gen_random_uuid()),
                                'NEEDS_CODE', 'FAILED 3: a code ' || v_text || ' old passed a money wrapper');
  end loop;
  v_passed := v_passed + 1;

  -- ── 4. Factor pinning: the second device passes; an unpinned or unverified one,
  -- or a session that is gone, does not.
  perform pg_temp.act(u_owner, s_owner);
  if public.admin_status() is distinct from 'ok' then raise exception 'FAILED 4: the second pinned device %', public.admin_status(); end if;
  update auth.sessions set factor_id = f_o3 where id = s_owner;
  if public.admin_status() is distinct from 'factor_mismatch' then raise exception 'FAILED 4: an unpinned device passed'; end if;
  update auth.sessions set factor_id = f_o2 where id = s_owner;
  update auth.mfa_factors set status = 'unverified' where id = f_o2;
  if public.admin_status() is distinct from 'factor_mismatch' then raise exception 'FAILED 4: an unverified pinned device passed'; end if;
  update auth.mfa_factors set status = 'verified' where id = f_o2;
  delete from auth.sessions where id = s_owner;
  if public.admin_status() is distinct from 'needs_code' then raise exception 'FAILED 4: a deleted session %', public.admin_status(); end if;
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal)
  values (s_owner, u_owner, now(), now(), f_o2, 'aal2');
  if public.admin_status() is distinct from 'ok' then raise exception 'FAILED 4: restored session'; end if;
  v_passed := v_passed + 1;

  -- ── 5. An email-link sign-in (otp) plus a code is not a strong sign-in.
  perform pg_temp.act(u_owner, s_owner, interval '1 minute', 'aal2', array['otp']);
  if public.admin_status() is distinct from 'weak_sign_in' then
    raise exception 'FAILED 5: otp+totp status %', public.admin_status();
  end if;
  v_passed := v_passed + 1;

  -- ── 6. A password reset in the last day holds money actions, not viewing.
  update public.profiles set password_reset_at = now() - interval '1 hour' where id = u_owner;
  perform pg_temp.act(u_owner, s_owner);
  perform public.admin_whoami(null);
  v_j := public.admin_update_ops_settings('{"stuck_order_minutes": 20}', 'a reason of ten words', gen_random_uuid());
  if v_j ->> 'code' is distinct from 'HELD' or pg_temp.audit_count(l_owner, 'settings.update', 'refused', 'HELD') is distinct from 1 then
    raise exception 'FAILED 6: a held account %', v_j;
  end if;
  update public.profiles set password_reset_at = null where id = u_owner;
  v_passed := v_passed + 1;

  -- ── 7. Revoked is not an admin: no status, wrapper or note, and a note written
  -- just before the revocation is refused at the claim (REVOKED). A viewer is
  -- refused operator and owner work, recorded.
  perform pg_temp.act(u_rev, s_rev);
  v_j := public.admin_note('supplier.balance', 'test', 'side', 'test', '{}');
  perform pg_temp.expect_ok(v_j, 'FAILED 7: a note before the revocation');
  v_note := (v_j ->> 'auditId')::bigint;
  update public.admins set revoked_at = now() where user_id = u_rev;
  if public.admin_status() is distinct from 'not_admin' then raise exception 'FAILED 7: a revoked admin %', public.admin_status(); end if;
  perform pg_temp.expect_raise('select public.admin_approve_refund(gen_random_uuid(), ''a reason of ten'', gen_random_uuid())',
                               'admin:not_admin');
  perform pg_temp.expect_raise('select public.admin_note(''supplier.balance'', ''test'', ''side'', ''test'')',
                               'admin:not_admin');
  perform pg_temp.expect_code(public.admin_claim_note(v_note, 'supplier.balance', 'm40-rev-' || v_tag, 'test', 'test'),
                              'REVOKED', 'FAILED 7: a note claimed after the revocation');
  perform pg_temp.act(u_view, s_view);
  v_j := public.admin_queue_deep_sync((select d.id from public.domains d limit 1), null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'ROLE' or pg_temp.audit_count(l_view, 'domain.deep_sync', 'refused', 'ROLE') is distinct from 1 then
    raise exception 'FAILED 7: a viewer on an operator wrapper %', v_j;
  end if;
  v_j := public.admin_note('supplier.catalogue_apply', 'global', 'catalogue', null);
  if v_j ->> 'code' is distinct from 'ROLE' or (v_j ->> 'ok')::boolean is not false then
    raise exception 'FAILED 7: a viewer noted a catalogue apply %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 8. The secret key cannot act as an admin or write the record.
  execute 'set local role service_role';
  begin
    perform public.admin_approve_refund(gen_random_uuid(), 'a reason of ten words', gen_random_uuid());
    raise exception 'FAILED 8: service_role ran an admin wrapper';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
    values (u_none, 'm40-sneak', 'owner', array[f_none], 'key');
    raise exception 'FAILED 8: service_role wrote admins';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.admin_audit_log (admin_id, admin_label, admin_role, test_actor, action, outcome)
    values (u_none, 'm40-sneak', 'owner', false, 'refund.approve', 'ok');
    raise exception 'FAILED 8: service_role wrote the audit log';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  if has_function_privilege('service_role', 'public.approve_refund(uuid, text)', 'execute') then
    raise exception 'FAILED 8: approve_refund is granted to service_role';
  end if;
  v_passed := v_passed + 1;

  -- ── 9. Replay: one approval per request key, refused keys free again.
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-a-' || v_tag || '.com', 'failed', 'a' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status, last_error_code)
  values (v_ord.o_order, v_ord.o_payment, v_ord.o_item, u_none, 'registration_failed', 107500, true, 'held', 'OVER_SINGLE_LIMIT')
  returning id into v_refund;
  perform pg_temp.act(u_owner, s_owner);
  v_key := gen_random_uuid();
  execute 'set local role authenticated';
  v_j := public.admin_approve_refund(v_refund, 'customer confirmed by phone', v_key);
  execute 'reset role';
  if (v_j ->> 'ok')::boolean is not true
     or (select r.status::text from public.refunds r where r.id = v_refund) is distinct from 'queued'
     or (select r.approved_by from public.refunds r where r.id = v_refund) is distinct from l_owner
     or pg_temp.audit_count(l_owner, 'refund.approve', 'ok') is distinct from 1 then
    raise exception 'FAILED 9: approve %', v_j;
  end if;
  v_j := public.admin_approve_refund(v_refund, 'customer confirmed by phone', v_key);
  if not coalesce((v_j ->> 'replayed')::boolean, false)
     or (select count(*) from public.admin_audit_log a where a.request_key = v_key) is distinct from 1 then
    raise exception 'FAILED 9: a replay wrote again %', v_j;
  end if;
  select * into v_ord2 from pg_temp.paid_order(u_none, true, 'm40-b-' || v_tag || '.com', 'failed', 'b' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status)
  values (v_ord2.o_order, v_ord2.o_payment, v_ord2.o_item, u_none, 'registration_failed', 107500, true, 'queued')
  returning id into v_refund2;
  perform pg_temp.expect_raise(format('select public.admin_approve_refund(%L, %L, %L)', v_refund2,
                                      'customer confirmed by phone', v_key), 'admin:request_key_mismatch');
  v_key2 := gen_random_uuid();
  v_j := public.admin_approve_refund(v_refund2, 'customer confirmed by phone', v_key2);
  -- ── 10. Approving a refund that is not held: refused, and recorded.
  if v_j ->> 'code' is distinct from 'NOT_HELD' or pg_temp.audit_count(l_owner, 'refund.approve', 'refused', 'NOT_HELD') is distinct from 1 then
    raise exception 'FAILED 10: approve a queued refund %', v_j;
  end if;
  update public.refunds set status = 'held' where id = v_refund2;
  v_j := public.admin_approve_refund(v_refund2, 'customer confirmed by phone', v_key2);
  if (v_j ->> 'ok')::boolean is not true then
    raise exception 'FAILED 9: a refused key did not run again once fixed %', v_j;
  end if;
  v_passed := v_passed + 2;

  -- ── 11. A test admin: never a live refund, never settings.
  select * into v_ord from pg_temp.paid_order(u_none, false, 'm40-c-' || v_tag || '.com', 'failed', 'c' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status)
  values (v_ord.o_order, v_ord.o_payment, v_ord.o_item, u_none, 'registration_failed', 107500, false, 'held')
  returning id into v_refund;
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_approve_refund(v_refund, 'customer confirmed by phone', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'TEST_ADMIN', 'FAILED 11: test admin on a live refund');
  v_j := public.admin_update_ops_settings('{"stuck_order_minutes": 20}', 'a reason of ten words', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'TEST_ADMIN', 'FAILED 11: test admin on settings');
  -- §1: a test admin's refusals are recorded like anyone's.
  if pg_temp.audit_count(l_test, 'refund.approve', 'refused', 'TEST_ADMIN') is distinct from 1
     or pg_temp.audit_count(l_test, 'settings.update', 'refused', 'TEST_ADMIN') is distinct from 1 then
    raise exception 'FAILED 11: a test admin''s refusals were not recorded';
  end if;
  if (select r.status::text from public.refunds r where r.id = v_refund) is distinct from 'held' then
    raise exception 'FAILED 11: the live refund moved';
  end if;
  -- D15: a test admin reads its own rows, so a refusal on a live target keeps
  -- none of its facts — not even a stale-code refusal, which the gate gives
  -- before TEST_ADMIN.
  perform pg_temp.act(u_test, s_test, interval '20 minutes');
  perform pg_temp.expect_code(public.admin_approve_refund(v_refund, 'customer confirmed by phone', gen_random_uuid()),
                              'NEEDS_CODE', 'FAILED 11: a test admin''s stale code on a live refund');
  if exists (select 1 from public.admin_audit_log a
              where a.admin_label = l_test and a.outcome = 'refused' and a.detail <> '{}'::jsonb) then
    raise exception 'FAILED 11: a test admin''s refusal kept a live refund''s facts';
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Retry: only failed or waiting jobs; never a failed transfer.
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status)
  values (u_none, 'm40-q-' || v_tag || '.com', 'com', 'registration', true, 'active')
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, test_mode, status)
  values ('set_privacy', 'm40-q:' || v_tag, v_domain, true, 'queued') returning id into v_job;
  perform pg_temp.act(u_op, s_op);
  v_j := public.admin_retry_job(v_job, 'the registry is back now', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'NOT_RETRYABLE', 'FAILED 12: retry a queued job');
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-t-' || v_tag || '.com', 'failed', 't' || v_tag);
  update public.order_items set item_type = 'transfer' where id = v_ord.o_item;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm40-t-' || v_tag || '.com', 'com', 'transfer', true, 'transfer_cancelled', v_ord.o_item)
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('transfer_domain', 'm40-t:' || v_tag, v_domain, v_ord.o_item, true, 'failed') returning id into v_job;
  v_j := public.admin_retry_job(v_job, 'the registry is back now', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'TRANSFER_CODE_GONE', 'FAILED 12: retry a failed transfer');
  v_passed := v_passed + 1;

  -- ── 13. Fail a registration only on fresh evidence that nothing was bought.
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-r-' || v_tag || '.com', 'provisioning', 'r' || v_tag);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm40-r-' || v_tag || '.com', 'com', 'registration', true, 'pending', v_ord.o_item)
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status, last_error_code, created_at)
  values ('register_domain', 'm40-r:' || v_tag, v_domain, v_ord.o_item, true, 'needs_attention', 'SUPPLIER_TIMEOUT',
          now() - interval '30 minutes')
  returning id into v_job;
  v_j := public.admin_fail_job(v_job, 'registry shows nothing at all', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'READ_REGISTRY_FIRST', 'FAILED 13: fail with no read');
  insert into public.supplier_calls (job_id, environment, operation, domain_name, outcome, duration_ms, created_at)
  values (v_job, 'ote', 'RegisterWithContactInfo', 'm40-r-' || v_tag || '.com', 'unknown', 5000, now() - interval '5 minutes'),
         (null, 'ote', 'GetDetails', 'm40-r-' || v_tag || '.com', 'not_found', 300, now() - interval '10 minutes');
  v_j := public.admin_fail_job(v_job, 'registry shows nothing at all', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'READ_REGISTRY_FIRST', 'FAILED 13: a read older than the attempt');
  insert into public.supplier_calls (job_id, environment, operation, domain_name, outcome, duration_ms, created_at)
  values (null, 'ote', 'AdminGetDetails', 'm40-r-' || v_tag || '.com', 'not_found', 300, now() - interval '1 minute');
  insert into public.supplier_ledger_entries (test_mode, trace_id, occurred_at, type, status, charge_type, product_type,
                                              description, old_balance_cents, balance_cents)
  values (true, gen_random_uuid(), now() - interval '20 minutes', 1, 1, 1, 1, 'e2e-m40-r-' || v_tag || '.com', 5000, 3869);
  v_j := public.admin_fail_job(v_job, 'registry shows nothing at all', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'LEDGER_SHOWS_CHARGE', 'FAILED 13: a supplier charge was ignored');
  delete from public.supplier_ledger_entries where test_mode and description = 'e2e-m40-r-' || v_tag || '.com';
  v_j := public.admin_fail_job(v_job, 'registry shows nothing at all', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or (select j.status::text from public.jobs j where j.id = v_job) is distinct from 'failed'
     or (select j.last_error_code from public.jobs j where j.id = v_job) is distinct from 'NOT_AT_REGISTRY'
     or (select oi.status::text from public.order_items oi where oi.id = v_ord.o_item) is distinct from 'failed'
     or not exists (select 1 from public.refunds r where r.order_item_id = v_ord.o_item and r.status in ('queued', 'held')) then
    raise exception 'FAILED 13: a fail with fresh evidence %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 16 (on 13's line). A line retried and then registered: its cancelled
  -- refund cannot be retried or recorded as paid.
  select r.id into v_refund from public.refunds r where r.order_item_id = v_ord.o_item;
  perform public.retry_job(v_job);
  update public.jobs set status = 'running' where id = v_job;
  perform public.complete_registration(v_job, now(), now() + interval '1 year', '{}', true, false, false, 'none');
  if (select r.status::text from public.refunds r where r.id = v_refund) is distinct from 'cancelled'
     or (select oi.status::text from public.order_items oi where oi.id = v_ord.o_item) is distinct from 'completed' then
    raise exception 'FAILED 16: setting up a retried, registered line';
  end if;
  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_retry_refund(v_refund, true, 'send it to the customer again', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'LINE_NOT_FAILED', 'FAILED 16: owner retry');
  v_j := public.admin_record_manual_refund(v_refund, null, 'flw-123', true, 'paid back by hand today', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'LINE_NOT_FAILED', 'FAILED 16: record manual');
  perform pg_temp.act(u_op, s_op);
  v_j := public.admin_retry_refund(v_refund, true, 'send it to the customer again', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'OWNER_ONLY', 'FAILED 16: operator retry of a cancelled refund');
  v_passed := v_passed + 1;

  -- ── 14. A charge that could not be confirmed is never failed from the dashboard.
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-p-' || v_tag || '.com', 'provisioning', 'p' || v_tag);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm40-p-' || v_tag || '.com', 'com', 'registration', true, 'pending', v_ord.o_item)
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status, last_error_code)
  values ('register_domain', 'm40-p:' || v_tag, v_domain, v_ord.o_item, true, 'needs_attention', 'PAYMENT_NOT_VERIFIED')
  returning id into v_job2;
  v_j := public.admin_fail_job(v_job2, 'registry shows nothing at all', gen_random_uuid());
  if v_j ->> 'code' is distinct from 'PAYMENT_NOT_VERIFIED' or exists (select 1 from public.refunds r where r.order_item_id = v_ord.o_item) then
    raise exception 'FAILED 14: fail an unverified charge %', v_j;
  end if;
  insert into public.ssl_products (product_code, name, vendor, validation_type, is_wildcard, is_multi_domain,
                                   included_names, create_usd, is_sellable)
  values ('M40' || upper(left(v_tag, 4)), 'M40 test certificate', 'M40', 'DV', false, false, 1, null, false);
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (u_none, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f order by f.created_at limit 1),
          'MDH-m40-s' || v_tag, '{}', 'covered', true, 'provisioning', now())
  returning id into v_ord2.o_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, ssl_product_code)
  values (v_ord2.o_order, 'm40-s-' || v_tag || '.com', 'com', 'ssl', 1, 100000, 100000, false, false,
          'M40' || upper(left(v_tag, 4)))
  returning id into v_ord2.o_item;
  insert into public.ssl_certificates (user_id, order_item_id, product_code, product_name, common_name, test_mode)
  values (u_none, v_ord2.o_item, 'M40' || upper(left(v_tag, 4)), 'M40 test certificate', 'm40-s-' || v_tag || '.com', true)
  returning id into v_cert;
  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode, status, last_error_code)
  values ('ssl_initialize', 'm40-s:' || v_tag, v_cert, true, 'needs_attention', 'PAYMENT_NOT_VERIFIED')
  returning id into v_ssl_job;
  v_j := public.admin_fail_ssl_job(v_ssl_job, 'nothing was ordered at all', gen_random_uuid());
  if v_j ->> 'code' is distinct from 'PAYMENT_NOT_VERIFIED' or exists (select 1 from public.refunds r where r.order_item_id = v_ord2.o_item) then
    raise exception 'FAILED 14: fail an unverified certificate charge %', v_j;
  end if;
  update public.ssl_jobs set last_error_code = 'SUPPLIER_TIMEOUT', sent_at = now() where id = v_ssl_job;
  v_j := public.admin_fail_ssl_job(v_ssl_job, 'nothing was ordered at all', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'ALREADY_SENT', 'FAILED 14: fail a sent certificate order');
  v_passed := v_passed + 1;

  -- ── 15. N14 and half-recorded changes: an unlock, nameservers, and a
  -- transfer without a fresh refused-transfer read.
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, pending_transfer_lock)
  values (u_none, 'm40-u-' || v_tag || '.com', 'com', 'registration', true, 'active', false)
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, test_mode, status)
  values ('set_transfer_lock', 'm40-u:' || v_tag, v_domain, true, 'needs_attention') returning id into v_job;
  v_j := public.admin_fail_job(v_job, 'stop it, the customer asked', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'TRANSFER_OUT_PROTECTED', 'FAILED 15: fail an unlock');
  insert into public.jobs (kind, idempotency_key, domain_id, test_mode, status)
  values ('apply_nameservers', 'm40-n:' || v_tag, v_domain, true, 'needs_attention') returning id into v_job;
  v_j := public.admin_fail_job(v_job, 'stop it, the customer asked', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'USE_RETRY', 'FAILED 15: fail a nameserver change');
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-x-' || v_tag || '.com', 'provisioning', 'x' || v_tag);
  update public.order_items set item_type = 'transfer' where id = v_ord.o_item;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, order_item_id)
  values (u_none, 'm40-x-' || v_tag || '.com', 'com', 'transfer', true, 'transfer_pending', v_ord.o_item)
  returning id into v_domain;
  insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode, status)
  values ('transfer_domain', 'm40-x:' || v_tag, v_domain, v_ord.o_item, true, 'needs_attention') returning id into v_job;
  v_j := public.admin_fail_job(v_job, 'the registry refused the move', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'READ_TRANSFER_FIRST', 'FAILED 15: fail a transfer unread');
  insert into public.supplier_calls (environment, operation, domain_name, outcome, message, duration_ms, created_at)
  values ('ote', 'AdminTransferQuery', 'm40-x-' || v_tag || '.com', 'ok', 'rejected', 200, now() - interval '1 minute');
  v_j := public.admin_fail_job(v_job, 'the registry refused the move', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true or (select j.last_error_code from public.jobs j where j.id = v_job) is distinct from 'TRANSFER_REFUSED' then
    raise exception 'FAILED 15: fail a refused transfer %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 17. Cancel is the owner's, and needs the Flutterwave check once a call was made.
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-k-' || v_tag || '.com', 'failed', 'k' || v_tag);
  insert into public.refunds (order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode, status,
                              provider_called_at, last_error_code)
  values (v_ord.o_order, v_ord.o_payment, v_ord.o_item, u_none, 'registration_failed', 107500, true, 'failed',
          now() - interval '1 hour', 'PROVIDER_ERROR')
  returning id into v_refund;
  perform pg_temp.act(u_op, s_op);
  v_j := public.admin_cancel_refund(v_refund, true, false, 'the bank reversed the charge', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'ROLE', 'FAILED 17: an operator cancelled');
  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_cancel_refund(v_refund, true, false, 'the bank reversed the charge', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'CHECK_PROVIDER', 'FAILED 17: cancel without the check');
  v_passed := v_passed + 1;

  -- ── 18. Recording a Flutterwave refund needs a matching, fresh, completed read.
  v_j := public.admin_record_manual_refund(v_refund, null, 'flw-777', true, 'paid back from the dashboard', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'FLW_NOT_VERIFIED', 'FAILED 18: no check');
  foreach v_sql in array array['wrong amount', 'wrong tx', 'bare completed', 'too old'] loop
    insert into public.flw_refund_checks (test_mode, target_type, target_id, flw_refund_id, tx_id, amount_kobo,
                                          currency, status, disburse_status, state, created_at)
    values (true, 'refund', v_refund::text, 'flw-777',
            case when v_sql = 'wrong tx' then 'm40-other' else 'm40-k' || v_tag end,
            case when v_sql = 'wrong amount' then 100 else 107500 end,
            'NGN', case when v_sql = 'bare completed' then 'completed' else 'completed-successful' end, null,
            case when v_sql = 'bare completed' then 'pending' else 'done' end,
            case when v_sql = 'too old' then now() - interval '16 minutes' else now() end)
    returning id into v_check;
    v_j := public.admin_record_manual_refund(v_refund, v_check, 'flw-777', true, 'paid back from the dashboard', gen_random_uuid());
    if v_j ->> 'code' is distinct from 'FLW_NOT_VERIFIED' then raise exception 'FAILED 18: a bad check (%) passed: %', v_sql, v_j; end if;
  end loop;
  insert into public.flw_refund_checks (test_mode, target_type, target_id, flw_refund_id, tx_id, amount_kobo,
                                        currency, status, state)
  values (true, 'refund', v_refund::text, 'flw-777', 'm40-k' || v_tag, 107500, 'NGN', 'completed-successful', 'done')
  returning id into v_check;
  v_j := public.admin_record_manual_refund(v_refund, v_check, 'flw-777', true, 'paid back from the dashboard', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or (select r.status::text from public.refunds r where r.id = v_refund) is distinct from 'completed'
     or (select oi.status::text from public.order_items oi where oi.id = v_ord.o_item) is distinct from 'refunded' then
    raise exception 'FAILED 18: a matching check %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 19. FX: too old, not pending, older than the active rate.
  update public.fx_rates set quoted_at = now() - interval '1 hour'
   where status = 'active' and base = 'USD' and quote = 'NGN';
  insert into public.fx_rates (source, buy_rate, sell_rate, costing_rate, status, quoted_at) values
    ('manual', 1500, 1500, 1520, 'pending_review', now() - interval '3 days'),
    ('manual', 1500, 1500, 1520, 'superseded', now() - interval '10 minutes'),
    ('manual', 1500, 1500, 1520, 'pending_review', now() - interval '2 hours');
  select f.id into v_rate from public.fx_rates f where f.status = 'pending_review' and f.quoted_at = now() - interval '3 days' limit 1;
  select f.id into v_rate2 from public.fx_rates f where f.status = 'superseded' and f.quoted_at = now() - interval '10 minutes' limit 1;
  select f.id into v_rate3 from public.fx_rates f where f.status = 'pending_review' and f.quoted_at = now() - interval '2 hours' limit 1;
  if public.admin_activate_fx_rate(v_rate, 'the daily job held this rate', gen_random_uuid()) ->> 'code' is distinct from 'RATE_TOO_OLD'
     or public.admin_activate_fx_rate(v_rate2, 'the daily job held this rate', gen_random_uuid()) ->> 'code' is distinct from 'NOT_PENDING'
     or public.admin_activate_fx_rate(v_rate3, 'the daily job held this rate', gen_random_uuid()) ->> 'code' is distinct from 'NEWER_RATE_ACTIVE' then
    raise exception 'FAILED 19: FX guards';
  end if;
  v_passed := v_passed + 1;

  -- ── 20. Limits within their ceilings; a raise is its own action. Pricing keys.
  if public.admin_update_ops_settings('{"auto_refund_max_kobo": 200000000}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE'
     or public.admin_update_ops_settings('{"auto_refund_daily_max_kobo": 1000}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE'
     or public.admin_update_ops_settings('{"refund_delay_minutes": 0}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE'
     or public.admin_update_ops_settings('{"stuck_order_minutes": 12.5}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE'
     or public.admin_update_ops_settings('{"nope": 1}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'UNKNOWN_KEY' then
    raise exception 'FAILED 20: ops settings bounds';
  end if;
  v_j := public.admin_update_ops_settings(
    jsonb_build_object('auto_refund_max_kobo', (select s.auto_refund_max_kobo + 100 from public.ops_settings s)),
    'a larger refund this week', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true or pg_temp.audit_count(l_owner, 'settings.refund_limit_raise', 'ok') is distinct from 1 then
    raise exception 'FAILED 20: a raise %', v_j;
  end if;
  if public.admin_update_pricing_settings('{"vat_pct": 10}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'UNKNOWN_KEY'
     or public.admin_update_pricing_settings('{"margin_ngn": 500}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE'
     or public.admin_update_pricing_settings('{"fx_buffer_pct": 1.234}', 'a reason of ten words', gen_random_uuid()) ->> 'code' is distinct from 'OUT_OF_RANGE' then
    raise exception 'FAILED 20: pricing keys';
  end if;
  v_j := public.admin_update_pricing_settings('{"icann_fee_cents": 20}', 'the fee is unchanged here', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true or (select p.icann_fee_usd from public.pricing_settings p) is distinct from 0.20 then
    raise exception 'FAILED 20: icann fee in cents %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 21. A certificate with no price cannot be sold.
  v_j := public.admin_set_ssl_sellable('M40' || upper(left(v_tag, 4)), true, 'start selling this one now', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'NO_PRICE', 'FAILED 21:');
  v_passed := v_passed + 1;

  -- ── 22. Presets are drafts: an allowlisted source, a passing check, then publish.
  select p.id into v_preset from public.nameserver_presets p where p.provider = 'Vercel';
  v_j := public.admin_save_preset_draft(v_preset, null, array['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
                                        'https://example.com/vercel', null, false, 'vercel changed its docs', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'SOURCE_NOT_ALLOWED', 'FAILED 22: a foreign source');
  v_j := public.admin_save_preset_draft(v_preset, null, array['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
                                        'https://user@vercel.com/docs', null, false, 'vercel changed its docs', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'SOURCE_NOT_ALLOWED', 'FAILED 22: a source with a user part');
  insert into public.nameserver_preset_sources (provider, host) values ('M40 Host ' || v_tag, 'docs.m40host.test');
  v_j := public.admin_save_preset_draft(null, 'M40 Host ' || v_tag, array['NS1.m40host.test', 'ns2.m40host.test'],
                                        'https://docs.m40host.test/nameservers', 'from their docs', false,
                                        'a new host customers asked for', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true then raise exception 'FAILED 22: save a draft %', v_j; end if;
  select d.id into v_draft from public.nameserver_preset_drafts d where d.provider = 'M40 Host ' || v_tag;
  if (select d.nameservers from public.nameserver_preset_drafts d where d.id = v_draft) is distinct from array['ns1.m40host.test', 'ns2.m40host.test']
     or exists (select 1 from public.nameserver_presets p where p.provider = 'M40 Host ' || v_tag) then
    raise exception 'FAILED 22: a draft changed the live presets';
  end if;
  update public.nameserver_preset_drafts set saved_at = now() - interval '1 minute' where id = v_draft;
  v_j := public.admin_publish_preset_draft(v_draft, 'checked and ready to go', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'NOT_CHECKED', 'FAILED 22: publish unchecked');
  perform public.record_preset_draft_check(v_draft, true, '{"hosts": []}');
  v_j := public.admin_publish_preset_draft(v_draft, 'checked and ready to go', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or not exists (select 1 from public.nameserver_presets p
                     where p.provider = 'M40 Host ' || v_tag and not p.is_hidden and p.verified_at is not null)
     or pg_temp.audit_count(l_owner, 'preset.publish', 'ok') is distinct from 1 then
    raise exception 'FAILED 22: publish %', v_j;
  end if;
  select a.id into v_audit from public.admin_audit_log a where a.admin_label = l_owner and a.action = 'preset.publish' and a.outcome = 'ok';
  if not exists (select 1 from public.admin_alert_conditions(false) c where c.key = 'admin_preset_changed:' || v_audit) then
    raise exception 'FAILED 22: no preset-changed alert';
  end if;
  v_passed := v_passed + 1;

  -- ── 23. Incidents: an owed kind needs an outcome; handled outside is the owner's.
  select * into v_ord from pg_temp.paid_order(u_none, true, 'm40-i-' || v_tag || '.com', 'completed', 'i' || v_tag);
  insert into public.payment_incidents (test_mode, kind, order_id, provider_reference)
  values (true, 'unrecorded_payment', v_ord.o_order, 'm40-inc-' || v_tag) returning id into v_incident;
  perform pg_temp.act(u_op, s_op);
  if public.admin_resolve_payment_incident(v_incident, null, null, null, false, 'looked at it closely', gen_random_uuid()) ->> 'code' is distinct from 'OUTCOME_REQUIRED'
     or public.admin_resolve_payment_incident(v_incident, 'handled_outside', null, null, true, 'looked at it closely', gen_random_uuid()) ->> 'code' is distinct from 'ROLE' then
    raise exception 'FAILED 23: incident guards';
  end if;
  v_passed := v_passed + 1;

  -- ── 24. A deep sync only for a live, syncable domain.
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status)
  values (u_none, 'm40-d-' || v_tag || '.com', 'com', 'registration', true, 'pending') returning id into v_domain;
  v_j := public.admin_queue_deep_sync(v_domain, null, gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'NOT_SYNCABLE', 'FAILED 24:');
  v_passed := v_passed + 1;

  -- ── 25. The gateway's claim on a note.
  v_j := public.admin_note('supplier.balance', 'test', 'side', 'test', '{}');
  v_note := (v_j ->> 'auditId')::bigint;
  if (v_j ->> 'ok')::boolean is not true then raise exception 'FAILED 25: note %', v_j; end if;
  execute 'set local role service_role';
  if public.admin_claim_note(v_note, 'supplier.domain_lookup', l_op, 'test', 'test') ->> 'code' is distinct from 'ACTION_MISMATCH'
     or public.admin_claim_note(v_note, 'supplier.balance', l_op, 'test', 'other') ->> 'code' is distinct from 'TARGET_MISMATCH'
     or public.admin_claim_note(v_note, 'supplier.balance', l_owner, 'test', 'test') ->> 'code' is distinct from 'LABEL_MISMATCH'
     or public.admin_claim_note(v_note, 'supplier.balance', l_op, 'live', 'test') ->> 'code' is distinct from 'SIDE_MISMATCH'
     or (public.admin_claim_note(v_note, 'supplier.balance', l_op, 'test', 'test') ->> 'ok')::boolean is not true
     or public.admin_claim_note(v_note, 'supplier.balance', l_op, 'test', 'test') ->> 'code' is distinct from 'USED' then
    raise exception 'FAILED 25: claims';
  end if;
  perform public.admin_note_result(v_note, 'ok', null, '{"cents": 4338}');
  execute 'reset role';
  perform pg_temp.expect_raise(format('select public.admin_note_result(%s, ''ok'', null, ''{}'')', v_note), '%duplicate key%');
  insert into public.admin_audit_log (created_at, admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (now() - interval '61 seconds', u_op, l_op, 'operator', false, 'supplier.balance', 'test', 'test', 'intent')
  returning id into v_note2;
  if public.admin_claim_note(v_note2, 'supplier.balance', l_op, 'test', 'test') ->> 'code' is distinct from 'EXPIRED' then
    raise exception 'FAILED 25: an old note was claimed';
  end if;
  -- No such note; a refused row and an ok row are not intents.
  perform pg_temp.expect_code(public.admin_claim_note(-1, 'supplier.balance', l_op, 'test', 'test'),
                              'NOT_FOUND', 'FAILED 25: a note that does not exist');
  select a.id into v_note2 from public.admin_audit_log a
   where a.admin_label = l_view and a.action = 'domain.deep_sync' and a.outcome = 'refused';
  perform pg_temp.expect_code(public.admin_claim_note(v_note2, 'domain.deep_sync', l_view, null, null),
                              'NOT_INTENT', 'FAILED 25: a refused row');
  select a.id into v_note2 from public.admin_audit_log a
   where a.admin_label = l_owner and a.action = 'refund.approve' and a.outcome = 'ok' limit 1;
  perform pg_temp.expect_code(public.admin_claim_note(v_note2, 'refund.approve', l_owner, 'test', v_note2::text),
                              'NOT_INTENT', 'FAILED 25: an ok row');
  -- Defensive: a test admin's intent on the live side never exists (admin_note
  -- refuses it), and the claim refuses one all the same.
  insert into public.admin_audit_log (admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (u_test, l_test, 'operator', true, 'supplier.balance', 'live', 'live', 'intent')
  returning id into v_note2;
  perform pg_temp.expect_code(public.admin_claim_note(v_note2, 'supplier.balance', l_test, 'live', 'live'),
                              'TEST_ADMIN', 'FAILED 25: a test admin''s live note');
  -- Nor on the global side (the catalogue, prices), which a test admin never reads.
  insert into public.admin_audit_log (admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (u_test, l_test, 'operator', true, 'supplier.catalogue_preview', 'global', 'catalogue', 'intent')
  returning id into v_note2;
  perform pg_temp.expect_code(public.admin_claim_note(v_note2, 'supplier.catalogue_preview', l_test, 'global', 'catalogue'),
                              'TEST_ADMIN', 'FAILED 25: a test admin''s global note');
  if exists (select 1 from public.admin_note_claims c where c.audit_id = v_note2) then
    raise exception 'FAILED 25: a refused claim was recorded as claimed';
  end if;
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_note('supplier.balance', 'live', 'side', 'live', '{}');
  perform pg_temp.expect_code(v_j, 'TEST_ADMIN', 'FAILED 25: a test admin noted the live side');
  v_j := public.admin_note('supplier.balance', 'test', 'side', 'test', '{}');
  if (v_j ->> 'ok')::boolean is not true
     or (public.admin_claim_note((v_j ->> 'auditId')::bigint, 'supplier.balance', l_test, 'test', 'test') ->> 'ok')::boolean is not true then
    raise exception 'FAILED 25: a test admin on the test side %', v_j;
  end if;
  -- D23: a Flutterwave check is evidence only for the refund its note names,
  -- under that note's Flutterwave id, once, within two minutes of the claim.
  perform pg_temp.act(u_op, s_op);
  v_j := public.admin_note('refund.flw_check', 'test', 'flw_refund', 'flw-d23-' || v_tag,
                           jsonb_build_object('refund_id', v_refund::text));
  perform pg_temp.expect_ok(v_j, 'FAILED 25: a refund.flw_check note');
  v_note := (v_j ->> 'auditId')::bigint;
  execute 'set local role service_role';
  if (public.admin_claim_note(v_note, 'refund.flw_check', l_op, 'test', 'flw-d23-' || v_tag) #>> '{detail,refund_id}')
     is distinct from v_refund::text then
    raise exception 'FAILED 25: the claim does not hand back the note''s refund';
  end if;
  execute 'reset role';
  v_sql := 'select public.record_flw_refund_check(%s, %L, %L, %L, %L, ''m40-k'', 107500, ''NGN'', ''completed-successful'', '''', ''done'')';
  perform pg_temp.expect_raise(format(v_sql, v_note, true, 'refund', v_refund, 'flw-other'), '%target_mismatch%');
  perform pg_temp.expect_raise(format(v_sql, v_note, true, 'refund', gen_random_uuid(), 'flw-d23-' || v_tag), '%target_mismatch%');
  perform pg_temp.expect_raise(format(v_sql, v_note, true, 'incident', v_refund, 'flw-d23-' || v_tag), '%target_mismatch%');
  perform pg_temp.expect_raise(format(v_sql, v_note, false, 'refund', v_refund, 'flw-d23-' || v_tag), '%not_claimed%');
  v_check := public.record_flw_refund_check(v_note, true, 'refund', v_refund::text, 'flw-d23-' || v_tag, 'm40-k',
                                            107500, 'NGN', 'completed-successful', '', 'done');
  if v_check is null then raise exception 'FAILED 25: a matching check was not recorded'; end if;
  perform pg_temp.expect_raise(format(v_sql, v_note, true, 'refund', v_refund, 'flw-d23-' || v_tag), '%check_recorded%');
  -- A note claimed three minutes ago is no longer evidence for anything.
  v_j := public.admin_note('refund.flw_check', 'test', 'flw_refund', 'flw-old-' || v_tag,
                           jsonb_build_object('refund_id', v_refund::text));
  v_note2 := (v_j ->> 'auditId')::bigint;
  insert into public.admin_note_claims (audit_id, claimed_at) values (v_note2, now() - interval '3 minutes');
  perform pg_temp.expect_raise(format(v_sql, v_note2, true, 'refund', v_refund, 'flw-old-' || v_tag), '%not_claimed%');
  -- A note never claimed is not evidence either.
  v_j := public.admin_note('refund.flw_check', 'test', 'flw_refund', 'flw-new-' || v_tag,
                           jsonb_build_object('refund_id', v_refund::text));
  perform pg_temp.expect_raise(format(v_sql, (v_j ->> 'auditId')::bigint, true, 'refund', v_refund, 'flw-new-' || v_tag),
                               '%not_claimed%');
  v_passed := v_passed + 1;

  -- ── 26. The record is final: no edits, no early deletes; redaction is narrow.
  select a.id into v_audit from public.admin_audit_log a
   where a.admin_label = l_owner and a.action = 'refund.approve' and a.outcome = 'ok';
  perform pg_temp.expect_raise(format('update public.admin_audit_log set outcome = ''refused'' where id = %s', v_audit), '%never rewritten%');
  perform pg_temp.expect_raise(format('delete from public.admin_audit_log where id = %s', v_audit), '%never rewritten%');
  perform pg_temp.expect_raise(format('delete from public.admin_audit_log where test_actor and admin_label = %L', l_test), '%never rewritten%');
  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_redact_reason(v_audit, 'it named the customer', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or (select a.reason from public.admin_audit_log a where a.id = v_audit) is not null
     or (select a.redacted_at from public.admin_audit_log a where a.id = v_audit) is null
     or (select a.outcome from public.admin_audit_log a where a.id = v_audit) is distinct from 'ok'
     or pg_temp.audit_count(l_owner, 'audit.redact', 'ok') is distinct from 1 then
    raise exception 'FAILED 26: redact %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 27. Test admins only for e2e users with a verified authenticator and no
  -- real admin row; their audit rows go after 30 days, with their claims,
  -- and nobody else's ever do.
  perform pg_temp.expect_raise(format('select public.grant_test_admin(%L)', u_real), '%only an e2e%');
  perform pg_temp.expect_raise(format('select public.grant_test_admin(%L)', u_nofactor), '%verified authenticator%');
  perform pg_temp.expect_raise(format('select public.grant_test_admin(%L)', u_owner), '%is a real admin%');
  if (select a.test_only from public.admins a where a.user_id = u_owner) is not false then
    raise exception 'FAILED 27: grant_test_admin touched a real admin';
  end if;
  insert into public.admin_audit_log (created_at, admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (now() - interval '31 days', u_test, l_test, 'operator', true, 'supplier.balance', 'test', 'test', 'intent')
  returning id into v_note;
  insert into public.admin_note_claims (audit_id, claimed_at) values (v_note, now() - interval '31 days');
  insert into public.admin_audit_log (created_at, admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (now() - interval '29 days', u_test, l_test, 'operator', true, 'supplier.balance', 'test', 'test', 'intent')
  returning id into v_note2;
  insert into public.admin_audit_log (created_at, admin_id, admin_label, admin_role, test_actor, action, side, target_id, outcome)
  values (now() - interval '31 days', u_op, l_op, 'operator', false, 'supplier.balance', 'live', 'live', 'intent')
  returning id into v_audit;
  v_count := public.purge_test_admin_audit();
  if v_count < 1
     or exists (select 1 from public.admin_audit_log a where a.id = v_note)
     or exists (select 1 from public.admin_note_claims c where c.audit_id = v_note)
     or not exists (select 1 from public.admin_audit_log a where a.id = v_note2)
     or not exists (select 1 from public.admin_audit_log a where a.id = v_audit) then
    raise exception 'FAILED 27: the purge (% rows)', v_count;
  end if;
  v_passed := v_passed + 1;

  -- ── 28. Pins are the user's own; every change is logged and alerted.
  perform pg_temp.expect_raise(
    format('insert into public.admins (user_id, label, role, mfa_factor_ids, added_by) values (%L, %L, ''viewer'', array[%L]::uuid[], ''x'')',
           u_none, 'm40-wrong-' || v_tag, f_op),
    '%verified authenticator of that user%');
  select count(*) into v_count from public.admin_changes c where c.label = l_owner;
  update public.admins set role = 'owner', mfa_factor_ids = array[f_o1, f_o2, f_o3] where user_id = u_owner;
  if (select count(*) from public.admin_changes c where c.label = l_owner) is distinct from v_count + 1 then
    raise exception 'FAILED 28: an update was not logged';
  end if;
  if not exists (select 1 from public.admin_alert_conditions(false) c
                  where c.key like 'admin_changed:%' and c.severity = 'critical' and c.summary like '%' || l_owner || '%')
     or exists (select 1 from public.admin_alert_conditions(false) c where c.summary like '%' || l_test || '%') then
    raise exception 'FAILED 28: the change alert';
  end if;
  if exists (select 1 from public.admin_changes c, jsonb_each_text(to_jsonb(c)) kv
              where c.label = l_owner and (kv.value like '%' || f_o1::text || '%' or kv.value like '%@%')) then
    raise exception 'FAILED 28: the change log holds a factor id or an email';
  end if;
  update auth.mfa_factors set status = 'unverified' where id = f_o3;
  if not exists (select 1 from public.admin_alert_conditions(false) c
                  where c.key = 'admin_factor_missing:' || l_owner and c.severity = 'warning') then
    raise exception 'FAILED 28: a removed device was not alerted';
  end if;
  update auth.mfa_factors set status = 'verified' where id = f_o3;
  v_passed := v_passed + 1;

  -- ── 29. A repeated reveal key shows nothing (D4): details come only through
  -- the gate, the limit and a new audit row, so a key kept from before a
  -- demotion replays bare. Thirty lookups an hour; a test admin sees e2e
  -- users' profiles only.
  perform pg_temp.act(u_op, s_op);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, registrant)
  values (u_none, 'm40-v-' || v_tag || '.com', 'com', 'registration', true, 'active',
          jsonb_build_object('name', 'E2E Registrant', 'country', 'NG'))
  returning id into v_domain;
  v_key := gen_random_uuid();
  v_key2 := gen_random_uuid();
  v_j := public.admin_reveal_customer(u_none, null, v_key);
  if (v_j ->> 'ok')::boolean is not true or v_j #>> '{contact,email}' is null then
    raise exception 'FAILED 29: an operator''s reveal %', v_j;
  end if;
  v_j := public.admin_reveal_registrant(v_domain, null, v_key2);
  if (v_j ->> 'ok')::boolean is not true or v_j #>> '{registrant,name}' is distinct from 'E2E Registrant' then
    raise exception 'FAILED 29: an operator''s registrant reveal %', v_j;
  end if;
  update public.admins set role = 'viewer' where user_id = u_op;
  perform pg_temp.expect_code(public.admin_reveal_customer(u_none, null, gen_random_uuid()), 'ROLE',
                              'FAILED 29: a viewer revealed a customer');
  v_count := (select count(*) from public.admin_audit_log a where a.admin_id = u_op);
  v_j := public.admin_reveal_customer(u_none, null, v_key);
  if (v_j ->> 'replayed')::boolean is not true or v_j ? 'contact' then
    raise exception 'FAILED 29: a replayed reveal showed details after a demotion %', v_j;
  end if;
  v_j := public.admin_reveal_registrant(v_domain, null, v_key2);
  if (v_j ->> 'replayed')::boolean is not true or v_j ? 'registrant' or v_j ? 'contacts' then
    raise exception 'FAILED 29: a replayed registrant reveal showed details after a demotion %', v_j;
  end if;
  if (select count(*) from public.admin_audit_log a where a.admin_id = u_op) is distinct from v_count then
    raise exception 'FAILED 29: a replay wrote an audit row';
  end if;
  update public.admins set role = 'operator' where user_id = u_op;
  insert into public.admin_audit_log (created_at, admin_id, admin_label, admin_role, test_actor, action, side, outcome)
  select now() - interval '10 minutes', u_op, l_op, 'operator', false, 'customer.search', 'global', 'ok'
    from generate_series(1, 30);
  perform pg_temp.act(u_op, s_op);
  v_j := public.admin_find_customers('e2e-admin-o-' || v_tag || '@example.com');
  perform pg_temp.expect_code(v_j, 'RATE_LIMITED', 'FAILED 29: the 31st lookup');
  v_j := public.admin_reveal_customer(u_none, null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'RATE_LIMITED' or v_j ? 'contact' and v_j -> 'contact' is distinct from 'null'::jsonb then
    raise exception 'FAILED 29: a rate-limited reveal %', v_j;
  end if;
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_reveal_customer(u_real, null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'TEST_ADMIN' or (v_j -> 'contact') is not null and v_j -> 'contact' is distinct from 'null'::jsonb then
    raise exception 'FAILED 29: a test admin revealed a real profile %', v_j;
  end if;
  v_j := public.admin_reveal_customer(u_none, null, gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true or v_j #>> '{contact,email}' is distinct from 'e2e-admin-n-' || v_tag || '@example.com' then
    raise exception 'FAILED 29: a test admin on an e2e user''s profile %', v_j;
  end if;
  v_j := public.admin_find_customers('m40-real-' || v_tag || '@mydomainshub.com');
  if (v_j ->> 'ok')::boolean is not true or jsonb_array_length(v_j -> 'rows') is distinct from 0 then
    raise exception 'FAILED 29: a test admin found a real profile %', v_j;
  end if;
  v_j := public.admin_find_customers('e2e-admin-n-' || v_tag || '@example.com');
  if jsonb_array_length(v_j -> 'rows') is distinct from 1 or v_j #>> '{rows,0,maskedEmail}' is distinct from 'e•••@example.com'
     or exists (select 1 from public.admin_audit_log a where a.detail::text like '%' || 'admin-n-' || v_tag || '%') then
    raise exception 'FAILED 29: masked search, or the query was stored %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 30. Grants: every function and view in migrations 40 and 41 (§3.0).
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
    "record_supplier_ledger":"service_role", "bump_funnel":"service_role", "seed_test_failed_email":"service_role",
    "hold_test_refund":"service_role", "purge_test_ledger_entries":"service_role",
    "current_alert_conditions":"service_role", "activate_fx_rate":"service_role"
  }';
  for v_row in select p.oid, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'admin\_%' or v_expected ? p.proname) loop
    v_want := v_expected ->> v_row.proname;
    if v_want is null then raise exception 'FAILED 30: function % has no expected grant', v_row.proname; end if;
    if has_function_privilege('anon', v_row.oid, 'execute') then raise exception 'FAILED 30: % is anon-executable', v_row.proname; end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 30: % has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 30: an expected function is missing (% of %)', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  foreach v_text in array array['admin_payments_v', 'admin_email_outbox_v', 'admin_compliance_notices_v',
                                'admin_ssl_certificates_v', 'admin_domains_v', 'admin_orders_v'] loop
    if has_table_privilege('anon', 'public.' || v_text, 'select')
       or has_table_privilege('authenticated', 'public.' || v_text, 'select')
       or not has_table_privilege('service_role', 'public.' || v_text, 'select') then
      raise exception 'FAILED 30: view % grants', v_text;
    end if;
  end loop;
  foreach v_text in array array['admins', 'admin_changes', 'admin_audit_log', 'admin_note_claims', 'flw_refund_checks',
                                'nameserver_preset_sources', 'nameserver_preset_drafts', 'order_item_costs',
                                'supplier_ledger_entries', 'supplier_ledger_revisions', 'float_topups',
                                'funnel_daily', 'metrics_daily'] loop
    if has_table_privilege('anon', 'public.' || v_text, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', 'public.' || v_text, 'select, insert, update, delete, truncate') then
      raise exception 'FAILED 30: table % is open to the API roles', v_text;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.admins', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'public.admin_audit_log', 'insert, update, delete')
     or has_table_privilege('service_role', 'public.order_item_costs', 'update, delete') then
    raise exception 'FAILED 30: service_role can write admin tables';
  end if;
  foreach v_text in array array['fx_rates', 'pricing_settings', 'tlds', 'ssl_products', 'nameserver_presets',
                                'market_references'] loop
    if has_table_privilege('anon', 'public.' || v_text, 'insert, update, delete, truncate')
       or has_table_privilege('authenticated', 'public.' || v_text, 'insert, update, delete, truncate') then
      raise exception 'FAILED 30: % is writable with the publishable key', v_text;
    end if;
  end loop;
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
               and (has_table_privilege('anon', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'truncate'))) then
    raise exception 'FAILED 30: a table is truncatable by an API role';
  end if;
  if has_function_privilege('anon', 'public.activate_fx_rate(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.activate_fx_rate(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.activate_fx_rate(uuid, uuid)', 'execute') then
    raise exception 'FAILED 30: activate_fx_rate grants';
  end if;
  -- The identity sequences too: Supabase's default privileges would give them
  -- to the API roles. Every sequence owned by a table of migrations 40–41.
  v_n := 0;
  for v_row in
    select s.oid::regclass::text as seq, t.relname
      from pg_class s
      join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = s.oid
                      and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
      join pg_class t on t.oid = d.refobjid
     where s.relkind = 'S' and t.relnamespace = 'public'::regnamespace
       and t.relname = any (array['admins', 'admin_changes', 'admin_audit_log', 'admin_note_claims',
                                  'flw_refund_checks', 'nameserver_preset_sources', 'nameserver_preset_drafts',
                                  'order_item_costs', 'supplier_ledger_entries', 'supplier_ledger_revisions',
                                  'float_topups', 'funnel_daily', 'metrics_daily'])
  loop
    if has_sequence_privilege('anon', v_row.seq, 'usage, select, update')
       or has_sequence_privilege('authenticated', v_row.seq, 'usage, select, update')
       or has_sequence_privilege('public', v_row.seq, 'usage, select, update') then
      raise exception 'FAILED 30: the sequence % of % is open to the API roles', v_row.seq, v_row.relname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < 5 then
    raise exception 'FAILED 30: only % admin sequences found; admin_changes, admin_audit_log, flw_refund_checks, float_topups and supplier_ledger_revisions each have one', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 31. A test admin reveals, and sends again, nothing of a real account's —
  -- even on the test side, and even at a reserved address that is not an e2e
  -- user's (reserved_target, D15). Its refusals keep nothing.
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, registrant)
  values (u_real, 'm40-w-' || v_tag || '.com', 'com', 'registration', true, 'active',
          jsonb_build_object('name', 'Real Registrant', 'country', 'NG'))
  returning id into v_domain;
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_reveal_registrant(v_domain, null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'TEST_ADMIN' or v_j ? 'registrant' or v_j ? 'contacts' then
    raise exception 'FAILED 31: a test admin revealed a real account''s test domain %', v_j;
  end if;
  v_j := public.admin_reveal_registrant((select d.id from public.domains d where d.domain_name = 'm40-v-' || v_tag || '.com'),
                                        null, gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true or v_j #>> '{registrant,name}' is distinct from 'E2E Registrant' then
    raise exception 'FAILED 31: a test admin on an e2e user''s test domain %', v_j;
  end if;
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, attempts, last_error)
  values ('order_receipt', 'transactional', u_real, 'm40-real-' || v_tag || '@mydomainshub.com', 'm40-rq1:' || v_tag,
          true, 'failed', 3, 'x')
  returning id into v_email_id;
  perform pg_temp.expect_code(public.admin_requeue_email(v_email_id, null, gen_random_uuid()), 'TEST_ADMIN',
                              'FAILED 31: a test admin sent a real address''s test email again');
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, attempts, last_error)
  values ('order_receipt', 'transactional', u_real, 'e2e-elsewhere-' || v_tag || '@example.com', 'm40-rq2:' || v_tag,
          true, 'failed', 3, 'x')
  returning id into v_email_id;
  perform pg_temp.expect_code(public.admin_requeue_email(v_email_id, null, gen_random_uuid()), 'TEST_ADMIN',
                              'FAILED 31: a test admin sent a real account''s test email again');
  if (select e.status from public.email_outbox e where e.id = v_email_id) is distinct from 'failed' then
    raise exception 'FAILED 31: a refused requeue moved the email';
  end if;
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, attempts, last_error)
  values ('order_receipt', 'transactional', u_none, 'e2e-admin-n-' || v_tag || '@example.com', 'm40-rq3:' || v_tag,
          true, 'failed', 3, 'x')
  returning id into v_email_id;
  perform pg_temp.expect_ok(public.admin_requeue_email(v_email_id, null, gen_random_uuid()),
                            'FAILED 31: a test admin on an e2e user''s test email');
  if (select e.status from public.email_outbox e where e.id = v_email_id) is distinct from 'pending' then
    raise exception 'FAILED 31: the e2e email was not queued again';
  end if;
  -- A reserved address is not an e2e user: anyone can sign up with one and
  -- type their real name beside it. Profile, test domain, search and email.
  update public.profiles set full_name = 'Resv Person', phone = '+2348030000000' where id = u_resv;
  v_j := public.admin_reveal_customer(u_resv, null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'TEST_ADMIN' or (v_j -> 'contact') is not null then
    raise exception 'FAILED 31: a test admin revealed a reserved, non-e2e profile %', v_j;
  end if;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, registrant)
  values (u_resv, 'm40-x-' || v_tag || '.com', 'com', 'registration', true, 'active',
          jsonb_build_object('name', 'Resv Registrant', 'country', 'NG'))
  returning id into v_domain;
  v_j := public.admin_reveal_registrant(v_domain, null, gen_random_uuid());
  if v_j ->> 'code' is distinct from 'TEST_ADMIN' or v_j ? 'registrant' or v_j ? 'contacts' then
    raise exception 'FAILED 31: a test admin revealed a reserved, non-e2e user''s test domain %', v_j;
  end if;
  v_j := public.admin_find_customers('m40-resv-' || v_tag || '@example.com');
  if (v_j ->> 'ok')::boolean is not true or jsonb_array_length(v_j -> 'rows') is distinct from 0 then
    raise exception 'FAILED 31: a test admin found a reserved, non-e2e profile %', v_j;
  end if;
  insert into public.email_outbox (kind, category, user_id, to_email, dedupe_key, test_mode, status, attempts, last_error)
  values ('order_receipt', 'transactional', u_resv, 'm40-resv-' || v_tag || '@example.com', 'm40-rq4:' || v_tag,
          true, 'failed', 3, 'x')
  returning id into v_email_id;
  perform pg_temp.expect_code(public.admin_requeue_email(v_email_id, null, gen_random_uuid()), 'TEST_ADMIN',
                              'FAILED 31: a test admin sent a reserved, non-e2e address''s test email again');
  if exists (select 1 from public.admin_audit_log a
              where a.admin_label = l_test and a.outcome = 'refused' and a.detail <> '{}'::jsonb) then
    raise exception 'FAILED 31: a test admin''s refusal kept the target''s facts';
  end if;
  v_passed := v_passed + 1;

  -- ── 32. The lookup limit counts under a lock per admin, held to the end of
  -- the transaction, so parallel calls cannot all read the same total (D4).
  v_lock := hashtextextended('admin_lookup:' || u_owner::text, 0);
  if exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid()
               and l.classid::bigint = ((v_lock >> 32) & 4294967295) and l.objid::bigint = (v_lock & 4294967295)) then
    raise exception 'FAILED 32: the owner''s lookup lock was held before any lookup';
  end if;
  perform pg_temp.act(u_owner, s_owner);
  perform pg_temp.expect_ok(public.admin_find_customers('nobody-' || v_tag || '@example.com'), 'FAILED 32: a search');
  if not exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid()
                   and l.classid::bigint = ((v_lock >> 32) & 4294967295) and l.objid::bigint = (v_lock & 4294967295)
                   and l.objsubid = 1 and l.granted) then
    raise exception 'FAILED 32: a search did not take the lookup lock';
  end if;
  -- The rule is a test admin's only: the owner reads the reserved user's test domain (31).
  perform pg_temp.expect_ok(public.admin_reveal_registrant(v_domain, null, gen_random_uuid()),
                            'FAILED 32: the owner on a reserved, non-e2e user''s test domain');
  v_passed := v_passed + 1;

  -- ── 33. Every change that could give someone access is alerted: a real
  -- operator added, made test-only, then re-pinned is three alerts; a test
  -- admin for a real address alerts while it stands. An e2e user's test
  -- admin never alerts.
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_real, 'm40-real-' || v_tag, 'operator', array[f_real], 'm40-check');
  update public.admins set test_only = true where user_id = u_real;
  update public.admins set mfa_factor_ids = array[f_real] where user_id = u_real;
  if (select count(*) from public.admin_alert_conditions(false) c
       where c.kind = 'admin_changed' and c.summary like '%m40-real-' || v_tag || ' (%') is distinct from 3 then
    raise exception 'FAILED 33: % of 3 changes alerted', (select count(*) from public.admin_alert_conditions(false) c
       where c.kind = 'admin_changed' and c.summary like '%m40-real-' || v_tag || ' (%');
  end if;
  if not exists (select 1 from public.admin_alert_conditions(false) c
                  where c.key = 'admin_test_not_e2e:m40-real-' || v_tag and c.severity = 'critical') then
    raise exception 'FAILED 33: a test admin for a real address stood unalerted';
  end if;
  if (select c.was_test_only from public.admin_changes c where c.label = 'm40-real-' || v_tag and c.op = 'INSERT') is not null
     or not exists (select 1 from public.admin_changes c
                     where c.label = 'm40-real-' || v_tag and c.test_only and c.was_test_only is false) then
    raise exception 'FAILED 33: the change log does not hold the flag before the change';
  end if;
  update public.admins set revoked_at = now() where user_id = u_test;
  if exists (select 1 from public.admin_alert_conditions(false) c where c.summary like '%' || l_test || '%') then
    raise exception 'FAILED 33: an e2e user''s test admin alerted';
  end if;
  update public.admins set revoked_at = null where user_id = u_test;
  v_passed := v_passed + 1;

  -- ── 34. Extension flags: null keeps what is stored, for every flag. A pause
  -- sent alone keeps the feature; a feature sent alone keeps the pause and its
  -- reason; rank 0 and an empty tagline are how they are cleared (§3.1.2).
  select min(r) into v_rank from generate_series(1, 50) r
   where not exists (select 1 from public.tlds t where t.featured_rank = r);
  select t.name into v_text from public.tlds t where not t.is_paused and t.featured_rank is null order by t.name limit 1;
  perform pg_temp.act(u_owner, s_owner);
  perform pg_temp.expect_ok(public.admin_set_tld_flags(v_text, null, null, v_rank, 'Fast and local',
                                                       'feature it on the home page', gen_random_uuid()),
                            'FAILED 34: feature an extension');
  if (select row(t.is_paused, t.featured_rank::integer, t.featured_tagline)::text from public.tlds t where t.name = v_text)
     is distinct from row(false, v_rank, 'Fast and local')::text then
    raise exception 'FAILED 34: a null pause did not keep the pause';
  end if;
  perform pg_temp.expect_ok(public.admin_set_tld_flags(v_text, true, 'registry maintenance', null, null,
                                                       'pause it for the night', gen_random_uuid()),
                            'FAILED 34: pause an extension');
  if (select row(t.is_paused, t.paused_reason, t.featured_rank::integer, t.featured_tagline)::text
        from public.tlds t where t.name = v_text)
     is distinct from row(true, 'registry maintenance', v_rank, 'Fast and local')::text then
    raise exception 'FAILED 34: a pause sent without rank and tagline cleared them';
  end if;
  perform pg_temp.expect_ok(public.admin_set_tld_flags(v_text, null, null, null, 'Quick and local',
                                                       'reword the home page card', gen_random_uuid()),
                            'FAILED 34: a new tagline on a paused extension');
  if (select row(t.is_paused, t.paused_reason, t.featured_rank::integer, t.featured_tagline)::text
        from public.tlds t where t.name = v_text)
     is distinct from row(true, 'registry maintenance', v_rank, 'Quick and local')::text then
    raise exception 'FAILED 34: a tagline sent alone moved the pause, its reason or the rank';
  end if;
  perform pg_temp.expect_ok(public.admin_set_tld_flags(v_text, null, null, 0, '',
                                                       'take it off the home page', gen_random_uuid()),
                            'FAILED 34: un-feature an extension');
  if (select row(t.is_paused, t.paused_reason, t.featured_rank, t.featured_tagline)::text from public.tlds t where t.name = v_text)
     is distinct from row(true, 'registry maintenance', null::integer, null::text)::text then
    raise exception 'FAILED 34: rank 0 and an empty tagline did not clear them, or moved the pause';
  end if;
  perform pg_temp.expect_ok(public.admin_set_tld_flags(v_text, false, null, null, null,
                                                       'the registry is back up', gen_random_uuid()),
                            'FAILED 34: resume an extension');
  if (select row(t.is_paused, t.paused_reason)::text from public.tlds t where t.name = v_text)
     is distinct from row(false, null::text)::text then
    raise exception 'FAILED 34: a resume kept the pause reason';
  end if;
  perform pg_temp.expect_code(public.admin_set_tld_flags(v_text, true, null, null, null,
                                                         'pause it with no reason', gen_random_uuid()),
                              'PAUSE_REASON', 'FAILED 34: a new pause without a reason');
  perform pg_temp.expect_code(public.admin_set_tld_flags(v_text, null, null, 51, null,
                                                         'feature it past the end', gen_random_uuid()),
                              'OUT_OF_RANGE', 'FAILED 34: rank 51');
  perform pg_temp.expect_code(public.admin_set_tld_flags(v_text, null, null, -1, null,
                                                         'feature it before the start', gen_random_uuid()),
                              'OUT_OF_RANGE', 'FAILED 34: rank -1');
  if (select row(t.is_paused, t.featured_rank, t.featured_tagline)::text from public.tlds t where t.name = v_text)
     is distinct from row(false, null::integer, null::text)::text then
    raise exception 'FAILED 34: a refused change moved the flags';
  end if;
  v_passed := v_passed + 1;

  -- ── 35. admin_mask_email and the web's maskEmail() mask alike (§2.5): the
  -- web's lib.test.ts reads the rows between these markers and runs each one
  -- through maskEmail(), so the two tables are one table.
  for v_row in
    select t.input, t.expected, public.admin_mask_email(t.input) as got from (values
      -- mask-email table: begin
      ('ayang@gmail.com', 'a•••@gmail.com'),
      ('Ada.Obi@Example.COM', 'A•••@Example.COM'),
      ('é@example.ng', 'é•••@example.ng'),
      ('😀x@example.com', '😀•••@example.com'),
      ('no-at-sign', '•••'),
      ('', '•••'),
      ('a@b@c', 'a•••@b'),
      ('@x.com', '•••@x.com'),
      ('a@', 'a•••@'),
      ('@', '•••@'),
      ('a@@b', 'a•••@'),
      (' a@x.com', ' •••@x.com')
      -- mask-email table: end
    ) as t(input, expected)
  loop
    if v_row.got is distinct from v_row.expected then
      raise exception 'FAILED 35: admin_mask_email(%) is %, not %', v_row.input, v_row.got, v_row.expected;
    end if;
  end loop;
  if public.admin_mask_email(null) is not null then
    raise exception 'FAILED 35: no address masks to something';
  end if;
  v_passed := v_passed + 1;

  -- ── 36. A test admin's search says nothing of live order numbers (D15):
  -- a live-only order's number is recorded as one no order has, while an e2e
  -- user's test order is still found by its number, and an owner finds both.
  select * into v_ord from pg_temp.paid_order(u_real, false, 'm40-ln-' || v_tag || '.com', 'failed', 'ln' || v_tag);
  v_text := (select o.order_number from public.orders o where o.id = v_ord.o_order);
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_find_customers(v_text);
  if (v_j ->> 'ok')::boolean is not true or jsonb_array_length(v_j -> 'rows') is distinct from 0 then
    raise exception 'FAILED 36: a test admin''s search for a live order number %', v_j;
  end if;
  v_detail := (select a.detail from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint);
  v_j := public.admin_find_customers('nd-m40-none-' || v_tag);
  if (select a.detail from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint)
       is distinct from v_detail or v_detail is null then
    raise exception 'FAILED 36: a live order number reads apart from a missing one: % and %', v_detail,
      (select a.detail from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint);
  end if;
  select * into v_ord2 from pg_temp.paid_order(u_none, true, 'm40-tn-' || v_tag || '.com', 'failed', 'tn' || v_tag);
  v_j := public.admin_find_customers((select o.order_number from public.orders o where o.id = v_ord2.o_order));
  if jsonb_array_length(v_j -> 'rows') is distinct from 1
     or (select a.detail ->> 'kind' from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint) is distinct from 'order' then
    raise exception 'FAILED 36: a test admin did not find an e2e user''s test order by its number %', v_j;
  end if;
  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_find_customers(v_text);
  if jsonb_array_length(v_j -> 'rows') is distinct from 1 or v_j #>> '{rows,0,userId}' is distinct from u_real::text
     or (select a.detail ->> 'kind' from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint) is distinct from 'order' then
    raise exception 'FAILED 36: the owner did not find a live order by its number %', v_j;
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 40: % checks passed', v_passed;
end;
$$;

rollback;
