-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 75, tried as the database owner: AI calls are counted per hour,
-- feature and model; their cost is estimated at the listed rates, double in
-- peak hours; this month's estimate past the budget raises an alert; the
-- budget is changed only through the audited settings wrapper; a cart line
-- keeps where it came from when an anonymous cart is merged; and the AI page's
-- report counts the side's own lines, with spend kept from test admins.
-- Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/ai_usage.sql
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

create function pg_temp.usage_now(p_feature text) returns public.ai_usage language sql as $f$
  select u from public.ai_usage u
   where u.hour = date_trunc('hour', now(), 'UTC') and u.feature = p_feature and u.model = 'deepseek-flash'
$f$;

create function pg_temp.cost(p_hour timestamptz, p_model text, p_prompt bigint, p_cached bigint, p_completion bigint)
returns bigint language sql as $f$
  select public.ai_usage_cost_micro(row(p_hour, 'name_finder', p_model, 1, 0, 0, p_prompt, p_cached, p_completion)::public.ai_usage)
$f$;

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
  u_test   uuid := gen_random_uuid();
  u_buyer  uuid := gen_random_uuid();
  f_owner  uuid := gen_random_uuid();
  f_test   uuid := gen_random_uuid();
  s_owner  uuid := gen_random_uuid();
  s_test   uuid := gen_random_uuid();
  v_before public.ai_usage;
  v_after  public.ai_usage;
  v_j      jsonb;
  v_r1     jsonb;
  v_key    text := 'ai_budget:' || to_char(now() at time zone 'Africa/Lagos', 'YYYY-MM');
  v_anon   uuid;
  v_order  uuid;
  v_fx     uuid := (select f.id from public.fx_rates f where f.status = 'active' limit 1);
  v_passed integer := 0;
begin
  -- ── 1. One hour's row adds up every call, whatever the outcome.
  v_before := pg_temp.usage_now('help_answer');
  perform public.record_ai_usage('help_answer', 'deepseek-flash', 'ok', 1000, 600, 200);
  perform public.record_ai_usage('help_answer', 'deepseek-flash', 'declined', 900, 600, 100);
  perform public.record_ai_usage('help_answer', 'deepseek-flash', 'failed', 0, 0, 0);
  v_after := pg_temp.usage_now('help_answer');
  if v_after.calls - coalesce(v_before.calls, 0) <> 3
     or v_after.failed - coalesce(v_before.failed, 0) <> 1
     or v_after.declined - coalesce(v_before.declined, 0) <> 1
     or v_after.prompt_tokens - coalesce(v_before.prompt_tokens, 0) <> 1900
     or v_after.cached_tokens - coalesce(v_before.cached_tokens, 0) <> 1200
     or v_after.completion_tokens - coalesce(v_before.completion_tokens, 0) <> 300 then
    raise exception 'FAILED 1: the hour''s row % after %', v_after, v_before;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. What is not a call is refused: an unknown outcome, feature or model, more cached than sent.
  if not pg_temp.refused($q$select public.record_ai_usage('help_answer', 'deepseek-flash', 'maybe', 1, 0, 1)$q$)
     or not pg_temp.refused($q$select public.record_ai_usage('chat', 'deepseek-flash', 'ok', 1, 0, 1)$q$)
     or not pg_temp.refused($q$select public.record_ai_usage('help_answer', 'gpt-9', 'ok', 1, 0, 1)$q$)
     or not pg_temp.refused($q$select public.record_ai_usage('help_answer', 'deepseek-flash', 'ok', 10, 11, 1)$q$)
     or not pg_temp.refused($q$select public.record_ai_usage('help_answer', 'deepseek-flash', 'ok', -1, 0, 1)$q$) then
    raise exception 'FAILED 2: a bad call was counted';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Cost: a million tokens of each kind, off-peak, at peak, and at a weekend's peak hour.
  -- 2026-11-28 is a Saturday, 2026-11-30 a Monday.
  if pg_temp.cost(timestamptz '2026-11-28 12:00:00+00', 'deepseek-flash', 2000000, 1000000, 1000000) <> 753000
     or pg_temp.cost(timestamptz '2026-11-30 02:00:00+00', 'deepseek-flash', 2000000, 1000000, 1000000) <> 1506000
     or pg_temp.cost(timestamptz '2026-11-28 02:00:00+00', 'deepseek-flash', 2000000, 1000000, 1000000) <> 753000
     or pg_temp.cost(timestamptz '2026-11-30 05:00:00+00', 'deepseek-flash', 2000000, 1000000, 1000000) <> 753000
     or pg_temp.cost(timestamptz '2026-11-30 09:00:00+00', 'deepseek-v4-pro', 2000000, 1000000, 1000000) <> 5324000
     or pg_temp.cost(timestamptz '2026-11-30 10:00:00+00', 'deepseek-v4-pro', 2000000, 1000000, 1000000) <> 2662000
     or pg_temp.cost(timestamptz '2026-11-30 12:00:00+00', 'deepseek-flash', 1, 0, 0) <> 1 then
    raise exception 'FAILED 3: the cost sums';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Past the budget, the live side alerts once for the month; under it, nothing.
  update public.ops_settings set ai_budget_cents = 100 where id;
  perform public.record_ai_usage('order_screening', 'deepseek-flash', 'ok', 0, 0, 2000000);
  if not exists (select 1 from public.admin_alert_conditions(false) c where c.key = v_key and c.kind = 'ai_budget')
     or exists (select 1 from public.admin_alert_conditions(true) c where c.kind = 'ai_budget')
     or not exists (select 1 from public.current_alert_conditions(false) c where c.key = v_key) then
    raise exception 'FAILED 4: no budget alert at $1';
  end if;
  update public.ops_settings set ai_budget_cents = 1000000 where id;
  if exists (select 1 from public.admin_alert_conditions(false) c where c.kind = 'ai_budget') then
    raise exception 'FAILED 4: a budget alert under $10,000';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. The budget is set through the audited wrapper, within $1 to $10,000.
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin75-o-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin75-t-' || v_tag || '@example.com', now(), now()),
    (u_buyer, 'authenticated', 'authenticated', 'e2e-buyer75-' || v_tag || '@example.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_owner, u_owner, 'm75', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm75', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_owner, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, 'm75-owner-' || v_tag, 'owner', array[f_owner], 'm75-check');
  perform public.grant_test_admin(u_test);

  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_update_ops_settings('{"ai_budget_cents": 7500}', 'AI budget for the launch month', gen_random_uuid());
  if (v_j ->> 'ok')::boolean is not true
     or (select s.ai_budget_cents from public.ops_settings s where s.id) <> 7500
     or not exists (select 1 from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint
                     and a.action = 'settings.update' and a.detail #>> '{after,ai_budget_cents}' = '7500'
                     and a.detail #>> '{before,ai_budget_cents}' = '1000000') then
    raise exception 'FAILED 5: setting the budget %', v_j;
  end if;
  v_j := public.admin_update_ops_settings('{"ai_budget_cents": 50}', 'AI budget below the floor', gen_random_uuid());
  if v_j ->> 'code' is distinct from 'OUT_OF_RANGE' or (select s.ai_budget_cents from public.ops_settings s where s.id) <> 7500 then
    raise exception 'FAILED 5: a budget under $1 %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Where a line came from survives the sign-in merge; nothing else is accepted.
  insert into public.carts (anon_token_hash) values (encode(sha256(convert_to('m75-' || v_tag, 'UTF8')), 'hex')) returning id into v_anon;
  insert into public.cart_items (cart_id, domain, tld, period_years, quoted_total_kobo, quoted_renewal_kobo,
                                 quoted_fx_rate_id, added_via)
  values (v_anon, 'm75-' || v_tag || '.com', 'com', 1, 100000, 100000, v_fx, 'name_finder');
  perform public.merge_anonymous_cart(encode(sha256(convert_to('m75-' || v_tag, 'UTF8')), 'hex'), u_buyer);
  if (select i.added_via from public.cart_items i join public.carts c on c.id = i.cart_id
       where c.user_id = u_buyer and i.domain = 'm75-' || v_tag || '.com') is distinct from 'name_finder' then
    raise exception 'FAILED 6: the merge dropped added_via';
  end if;
  if not pg_temp.refused(format($q$update public.cart_items set added_via = 'search' where domain = %L$q$, 'm75-' || v_tag || '.com')) then
    raise exception 'FAILED 6: an unknown added_via was taken';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. The report: the side's paid new-domain lines, by where they came from; spend for real admins only.
  perform pg_temp.act(u_owner, s_owner);
  v_r1 := public.admin_ai_report(true, (now() at time zone 'Africa/Lagos')::date - 29, (now() at time zone 'Africa/Lagos')::date);
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id, tx_ref,
                             registrant, float_check, test_mode, status, paid_at)
  values (u_buyer, 300000, 7.5, 22500, 322500, v_fx, 'MDH-m75-' || v_tag, '{}', 'covered', true, 'provisioning', now())
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, status, added_via)
  values (v_order, 'm75a-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', 'name_finder'),
         (v_order, 'm75b-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', 'assistant_link'),
         (v_order, 'm75c-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false, 'completed', null);
  v_j := public.admin_ai_report(true, (now() at time zone 'Africa/Lagos')::date - 29, (now() at time zone 'Africa/Lagos')::date);
  if (v_j #>> '{lines,paid}')::int - (v_r1 #>> '{lines,paid}')::int <> 3
     or (v_j #>> '{lines,nameFinder}')::int - (v_r1 #>> '{lines,nameFinder}')::int <> 1
     or (v_j #>> '{lines,assistantLink}')::int - (v_r1 #>> '{lines,assistantLink}')::int <> 1
     or jsonb_typeof(v_j -> 'spend') <> 'object'
     or (v_j #>> '{spend,budgetCents}')::int <> 7500
     or (v_j #>> '{spend,monthMicro}')::bigint < 1200000
     or not exists (select 1 from jsonb_array_elements(v_j #> '{spend,features}') f
                     where f ->> 'feature' = 'help_answer' and (f ->> 'calls')::int >= 3)
     or v_j -> 'delegation' is null or v_j -> 'screening' is null or v_j -> 'bulk' is null then
    raise exception 'FAILED 7: the owner''s report %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 8. A test administrator: the test side without spend; the live side refused.
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_ai_report(true, (now() at time zone 'Africa/Lagos')::date - 29, (now() at time zone 'Africa/Lagos')::date);
  if jsonb_typeof(v_j -> 'spend') is distinct from 'null' or (v_j #>> '{lines,paid}')::int < 3 then
    raise exception 'FAILED 8: a test admin''s report %', v_j;
  end if;
  if not pg_temp.refused($q$select public.admin_ai_report(false, current_date - 29, current_date)$q$)
     or not pg_temp.refused($q$select public.admin_ai_report(true, current_date, current_date - 1)$q$) then
    raise exception 'FAILED 8: a live report or a backwards range was answered';
  end if;
  v_passed := v_passed + 1;

  -- ── 9. Grants: usage is written only through the function, by the service key.
  if has_table_privilege('service_role', 'public.ai_usage', 'insert')
     or has_table_privilege('authenticated', 'public.ai_usage', 'select')
     or has_table_privilege('authenticated', 'public.ai_model_rates', 'select')
     or not has_function_privilege('service_role', 'public.record_ai_usage(text, text, text, integer, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.record_ai_usage(text, text, text, integer, integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.admin_ai_report(boolean, date, date)', 'execute')
     or has_function_privilege('service_role', 'public.ai_spend_micro(timestamptz, timestamptz)', 'execute') then
    raise exception 'FAILED 9: grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 75: % checks passed', v_passed;
end;
$$;

rollback;
