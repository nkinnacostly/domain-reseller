-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 76, tried as the database owner: the site assistant's calls are
-- counted, a cart line keeps that it came from the assistant through the
-- sign-in merge, and the AI page counts those lines on their own side. Each
-- check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/site_assistant.sql
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

create function pg_temp.refused(p_sql text) returns boolean language plpgsql as $f$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner  uuid := gen_random_uuid();
  u_buyer  uuid := gen_random_uuid();
  f_owner  uuid := gen_random_uuid();
  s_owner  uuid := gen_random_uuid();
  v_calls  integer;
  v_j      jsonb;
  v_r1     jsonb;
  v_live   jsonb;
  v_anon   uuid;
  v_order  uuid;
  v_fx     uuid := (select f.id from public.fx_rates f where f.status = 'active' limit 1);
  v_today  date := (now() at time zone 'Africa/Lagos')::date;
  v_passed integer := 0;
begin
  -- ── 1. The assistant's routing call is counted under its own name; an unknown name is not.
  v_calls := coalesce((select u.calls from public.ai_usage u
                        where u.hour = date_trunc('hour', now(), 'UTC') and u.feature = 'site_assistant'
                          and u.model = 'deepseek-flash'), 0);
  perform public.record_ai_usage('site_assistant', 'deepseek-flash', 'ok', 4000, 3800, 60);
  perform public.record_ai_usage('site_assistant', 'deepseek-flash', 'declined', 4000, 3800, 40);
  if (select u.calls - v_calls from public.ai_usage u
       where u.hour = date_trunc('hour', now(), 'UTC') and u.feature = 'site_assistant'
         and u.model = 'deepseek-flash') is distinct from 2 then
    raise exception 'FAILED 1: the assistant''s calls were not counted';
  end if;
  if not pg_temp.refused($q$select public.record_ai_usage('site_helper', 'deepseek-flash', 'ok', 1, 0, 1)$q$) then
    raise exception 'FAILED 1: an unknown feature was counted';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A line from the assistant survives the sign-in merge; nothing unknown is accepted.
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin76-o-' || v_tag || '@example.com', now(), now()),
    (u_buyer, 'authenticated', 'authenticated', 'e2e-buyer76-' || v_tag || '@example.com', now(), now());
  insert into public.carts (anon_token_hash) values (encode(sha256(convert_to('m76-' || v_tag, 'UTF8')), 'hex')) returning id into v_anon;
  insert into public.cart_items (cart_id, domain, tld, period_years, quoted_total_kobo, quoted_renewal_kobo,
                                 quoted_fx_rate_id, added_via)
  values (v_anon, 'm76-' || v_tag || '.com', 'com', 1, 100000, 100000, v_fx, 'site_assistant');
  perform public.merge_anonymous_cart(encode(sha256(convert_to('m76-' || v_tag, 'UTF8')), 'hex'), u_buyer);
  if (select i.added_via from public.cart_items i join public.carts c on c.id = i.cart_id
       where c.user_id = u_buyer and i.domain = 'm76-' || v_tag || '.com') is distinct from 'site_assistant' then
    raise exception 'FAILED 2: the merge dropped added_via';
  end if;
  if not pg_temp.refused(format($q$update public.cart_items set added_via = 'chat' where domain = %L$q$, 'm76-' || v_tag || '.com')) then
    raise exception 'FAILED 2: an unknown added_via was taken';
  end if;
  -- The earlier sources still stand.
  if pg_temp.refused(format($q$update public.cart_items set added_via = 'assistant_link' where domain = %L$q$, 'm76-' || v_tag || '.com')) then
    raise exception 'FAILED 2: assistant_link is refused';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. The report counts the side's paid lines from the assistant, and only that side's.
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (f_owner, u_owner, 'm76', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal)
  values (s_owner, u_owner, now(), now(), f_owner, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, 'm76-owner-' || v_tag, 'owner', array[f_owner], 'm76-check');

  perform pg_temp.act(u_owner, s_owner);
  v_r1 := public.admin_ai_report(true, v_today - 29, v_today);
  v_live := public.admin_ai_report(false, v_today - 29, v_today);
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (u_buyer, 300000, 7.5, 22500, 322500, v_fx, 'MDH-m76-' || v_tag, '{}', 'covered', true, 'provisioning', now())
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status, added_via)
  values (v_order, 'm76a-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', 'site_assistant'),
         (v_order, 'm76b-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', 'site_assistant'),
         (v_order, 'm76c-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', 'name_finder');
  v_j := public.admin_ai_report(true, v_today - 29, v_today);
  if (v_j #>> '{lines,paid}')::int - (v_r1 #>> '{lines,paid}')::int <> 3
     or (v_j #>> '{lines,siteAssistant}')::int - (v_r1 #>> '{lines,siteAssistant}')::int <> 2
     or (v_j #>> '{lines,nameFinder}')::int - (v_r1 #>> '{lines,nameFinder}')::int <> 1
     or (v_j #>> '{lines,assistantLink}') is null
     or (public.admin_ai_report(false, v_today - 29, v_today) #>> '{lines,siteAssistant}')
          is distinct from (v_live #>> '{lines,siteAssistant}')
     or not exists (select 1 from jsonb_array_elements(v_j #> '{spend,features}') f
                     where f ->> 'feature' = 'site_assistant' and (f ->> 'calls')::int >= 2) then
    raise exception 'FAILED 3: the report %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Grants unchanged: the report for signed-in admins only, usage by the service key only.
  if has_function_privilege('anon', 'public.admin_ai_report(boolean, date, date)', 'execute')
     or has_function_privilege('service_role', 'public.admin_ai_report(boolean, date, date)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_ai_report(boolean, date, date)', 'execute')
     or has_function_privilege('authenticated', 'public.record_ai_usage(text, text, text, integer, integer, integer)', 'execute') then
    raise exception 'FAILED 4: grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 76: % checks passed', v_passed;
end;
$$;

rollback;
