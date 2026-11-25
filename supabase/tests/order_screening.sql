-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 73, tried as the database owner on the test side: paid lines are
-- listed for screening once; a screening flagged for review raises a warning
-- until an operator reviews it through the audited wrapper; a screening and
-- its review are final. Each check raises on failure. Everything is rolled
-- back.
--
--   supabase db query --linked -f supabase/tests/order_screening.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.act(p_uid uuid, p_sid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 minute')::bigint)))::text, true);
end $f$;

-- Paid just inside the 7-day window, so the line sorts ahead of the test side's
-- other unscreened lines and is within the list's 200.
create function pg_temp.paid_line(p_user uuid, p_domain text, p_ref text, p_type text default 'register',
                                  p_paid_at timestamptz default now() - interval '6 days 23 hours 58 minutes')
returns uuid language plpgsql as $f$
declare
  v_order uuid;
  v_item  uuid;
begin
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (p_user, 100000, 7.5, 7500, 107500, (select f.id from public.fx_rates f where f.status = 'active' limit 1),
          'MDH-m73-' || p_ref, '{}', 'covered', true, 'provisioning', p_paid_at)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status)
  values (v_order, p_domain, 'com', p_type, 1, 100000, 100000, false, false, 'completed')
  returning id into v_item;
  return v_item;
end $f$;

create function pg_temp.expect_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.alerting(p_item uuid) returns boolean language sql as $f$
  select exists (select 1 from public.current_alert_conditions(true) c where c.key = 'order_screening:' || p_item)
$f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner  uuid := gen_random_uuid();
  u_buyer  uuid := gen_random_uuid();
  f_owner  uuid := gen_random_uuid();
  s_owner  uuid := gen_random_uuid();
  i_flag   uuid;
  i_clear  uuid;
  i_old    uuid;
  v_key    uuid := gen_random_uuid();
  v_j      jsonb;
  v_row    public.order_screenings;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin73-o-' || v_tag || '@example.com', now(), now()),
    (u_buyer, 'authenticated', 'authenticated', 'e2e-m73-b-' || v_tag || '@example.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (f_owner, u_owner, 'm73', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal)
  values (s_owner, u_owner, now(), now(), f_owner, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, 'm73-owner-' || v_tag, 'owner', array[f_owner], 'm73-check');

  i_flag := pg_temp.paid_line(u_buyer, 'paypal-login-' || v_tag || '.com', 'f' || v_tag);
  i_clear := pg_temp.paid_line(u_buyer, 'ibadanbakes-' || v_tag || '.com', 'c' || v_tag, 'transfer');
  i_old := pg_temp.paid_line(u_buyer, 'paypal-old-' || v_tag || '.com', 'o' || v_tag, 'register',
                             now() - interval '8 days');

  -- ── 1. Paid registrations and transfers are listed once; a line paid over a week ago never.
  if not exists (select 1 from public.order_lines_to_screen(true, 200) l where l.order_item_id = i_flag)
     or not exists (select 1 from public.order_lines_to_screen(true, 200) l where l.order_item_id = i_clear)
     or exists (select 1 from public.order_lines_to_screen(true, 200) l where l.order_item_id = i_old) then
    raise exception 'FAILED 1: the lines listed for screening';
  end if;
  insert into public.order_screenings (order_item_id, test_mode, domain, verdict, matched, note, model)
  values (i_flag, true, 'paypal-login-' || v_tag || '.com', 'review', array['paypal', 'login'],
          'Imitates PayPal sign-in', 'deepseek-flash'),
         (i_clear, true, 'ibadanbakes-' || v_tag || '.com', 'clear', '{}', null, null);
  if exists (select 1 from public.order_lines_to_screen(true, 200) l where l.order_item_id in (i_flag, i_clear)) then
    raise exception 'FAILED 1: a screened line was listed again';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A line flagged for review warns; a clear one does not.
  if not pg_temp.alerting(i_flag) or pg_temp.alerting(i_clear) then
    raise exception 'FAILED 2: the review warning';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Final: no rewrite, no live delete, no review outside the wrapper.
  begin
    update public.order_screenings set verdict = 'clear' where order_item_id = i_flag;
    raise exception 'FAILED 3: a screening rewritten';
  exception when others then
    if sqlerrm not like '%never rewritten%' then raise; end if;
  end;
  begin
    update public.order_screenings set decision = 'fine', review_note = 'looks fine to me', reviewed_by = 'x',
                                       reviewed_at = now() where order_item_id = i_flag;
    raise exception 'FAILED 3: a review outside the wrapper';
  exception when others then
    if sqlerrm not like '%only through admin_review_screening%' then raise; end if;
  end;
  -- A live one is never deleted; a test one goes with its purged order.
  insert into public.order_screenings (order_item_id, test_mode, domain, verdict)
  values (i_old, false, 'paypal-old-' || v_tag || '.com', 'clear');
  begin
    delete from public.order_screenings where order_item_id = i_old;
    raise exception 'FAILED 3: a live screening deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  begin
    delete from public.order_items where id = i_clear;
    if exists (select 1 from public.order_screenings s where s.order_item_id = i_clear) then
      raise exception 'FAILED 3: a test screening outlived its line';
    end if;
    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then raise; end if;
  end;
  v_passed := v_passed + 1;

  -- ── 4. The wrapper: refusals, then the review, audited; the warning closes.
  perform pg_temp.act(u_owner, s_owner);
  perform pg_temp.expect_code(public.admin_review_screening(i_flag, 'fine', 'short', gen_random_uuid()),
                              'REASON', 'FAILED 4: a short reason');
  perform pg_temp.expect_code(public.admin_review_screening(i_flag, 'maybe', 'The customer is a PayPal agent', gen_random_uuid()),
                              'BAD_DECISION', 'FAILED 4: an unknown decision');
  perform pg_temp.expect_code(public.admin_review_screening(i_clear, 'fine', 'Nothing to review here at all', gen_random_uuid()),
                              'NOT_FOR_REVIEW', 'FAILED 4: a clear line reviewed');
  perform pg_temp.expect_code(public.admin_review_screening(gen_random_uuid(), 'fine', 'Nothing to review here at all', gen_random_uuid()),
                              'NOT_FOUND', 'FAILED 4: an unknown line');
  v_j := public.admin_review_screening(i_flag, 'abuse', 'Phishing page reported to the registrar', v_key);
  select * into v_row from public.order_screenings where order_item_id = i_flag;
  if (v_j ->> 'ok')::boolean is not true or v_row.decision is distinct from 'abuse'
     or v_row.review_note is distinct from 'Phishing page reported to the registrar'
     or v_row.reviewed_by is distinct from 'm73-owner-' || v_tag or pg_temp.alerting(i_flag)
     or not exists (select 1 from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint
                     and a.action = 'order.review_screening' and a.outcome = 'ok') then
    raise exception 'FAILED 4: the review % %', v_j, v_row.decision;
  end if;
  if (public.admin_review_screening(i_flag, 'abuse', 'Phishing page reported to the registrar', v_key) ->> 'auditId')
     is distinct from v_j ->> 'auditId' then
    raise exception 'FAILED 4: a replay was not the first answer';
  end if;
  perform pg_temp.expect_code(public.admin_review_screening(i_flag, 'fine', 'Changed my mind about this', gen_random_uuid()),
                              'NOT_FOR_REVIEW', 'FAILED 4: reviewed twice');
  v_passed := v_passed + 1;

  -- ── 5. Grants.
  if has_table_privilege('authenticated', 'public.order_screenings', 'select')
     or has_table_privilege('anon', 'public.order_screenings', 'select')
     or not has_table_privilege('service_role', 'public.order_screenings', 'insert')
     or has_table_privilege('service_role', 'public.order_screenings', 'update')
     or has_function_privilege('authenticated', 'public.order_lines_to_screen(boolean, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.order_lines_to_screen(boolean, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_review_screening(uuid, text, text, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.admin_review_screening(uuid, text, text, uuid)', 'execute') then
    raise exception 'FAILED 5: the grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 73: % checks passed', v_passed;
end;
$$;

rollback;
