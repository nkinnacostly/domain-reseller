-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 74, tried as the database owner: asking the ops copilot about an
-- alert is an audited read that answers with the alert's own words; a
-- repeated request is the same read; a test administrator learns nothing
-- about a live alert. Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/ops_copilot.sql
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

create function pg_temp.expect_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner  uuid := gen_random_uuid();
  u_test   uuid := gen_random_uuid();
  f_owner  uuid := gen_random_uuid();
  f_test   uuid := gen_random_uuid();
  s_owner  uuid := gen_random_uuid();
  s_test   uuid := gen_random_uuid();
  a_test   bigint;
  a_live   bigint;
  v_key    uuid := gen_random_uuid();
  v_j      jsonb;
  v_j2     jsonb;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-admin74-o-' || v_tag || '@example.com', now(), now()),
    (u_test, 'authenticated', 'authenticated', 'e2e-admin74-t-' || v_tag || '@example.com', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_owner, u_owner, 'm74', 'totp', 'verified', now(), now(), 'x'),
    (f_test, u_test, 'm74', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_owner, u_owner, now(), now(), f_owner, 'aal2'),
    (s_test, u_test, now(), now(), f_test, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_owner, 'm74-owner-' || v_tag, 'owner', array[f_owner], 'm74-check');
  perform public.grant_test_admin(u_test);

  insert into public.ops_alerts (key, test_mode, severity, kind, summary)
  values ('m74-test:' || v_tag, true, 'warning', 'catalogue_sync', 'Price list sync refused: 3 prices moved over 20%')
  returning id into a_test;
  insert into public.ops_alerts (key, test_mode, severity, kind, summary)
  values ('m74-live:' || v_tag, false, 'critical', 'job_needs_attention', 'Registration of m74-' || v_tag || '.com needs a person')
  returning id into a_live;

  -- ── 1. An owner's request: audited, answered with the alert's words.
  perform pg_temp.act(u_owner, s_owner);
  v_j := public.admin_alert_help(a_test, 'explain', v_key);
  if (v_j ->> 'ok')::boolean is not true
     or v_j #>> '{alert,kind}' is distinct from 'catalogue_sync'
     or v_j #>> '{alert,summary}' is distinct from 'Price list sync refused: 3 prices moved over 20%'
     or v_j #>> '{alert,side}' is distinct from 'test' or (v_j #>> '{alert,resolved}')::boolean
     or not exists (select 1 from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint
                     and a.action = 'alert.explain' and a.outcome = 'ok' and a.target_type = 'alert'
                     and a.target_id = a_test::text and a.detail ->> 'mode' = 'explain') then
    raise exception 'FAILED 1: the answer %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A repeated request is the same read, answered again; nothing new is audited.
  v_j2 := public.admin_alert_help(a_test, 'explain', v_key);
  if v_j2 ->> 'auditId' is distinct from v_j ->> 'auditId' or v_j2 #>> '{alert,kind}' is distinct from 'catalogue_sync'
     or (select count(*) from public.admin_audit_log a where a.request_key = v_key) <> 1 then
    raise exception 'FAILED 2: the replay %', v_j2;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Refusals: an unknown mode, an unknown alert — no words.
  v_j := public.admin_alert_help(a_live, 'act', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'BAD_MODE', 'FAILED 3: an unknown mode');
  if v_j ? 'alert' then raise exception 'FAILED 3: a refusal carried the alert'; end if;
  perform pg_temp.expect_code(public.admin_alert_help(-1, 'explain', gen_random_uuid()), 'NOT_FOUND',
                              'FAILED 3: an unknown alert');
  v_passed := v_passed + 1;

  -- ── 4. A test administrator: its own side only, nothing of a live alert kept or told.
  perform pg_temp.act(u_test, s_test);
  v_j := public.admin_alert_help(a_live, 'ticket', gen_random_uuid());
  perform pg_temp.expect_code(v_j, 'TEST_ADMIN', 'FAILED 4: a test admin on a live alert');
  if v_j ? 'alert' or (select a.detail from public.admin_audit_log a where a.id = (v_j ->> 'auditId')::bigint) <> '{}'::jsonb then
    raise exception 'FAILED 4: a live alert leaked to a test admin %', v_j;
  end if;
  if (public.admin_alert_help(a_test, 'ticket', gen_random_uuid()) ->> 'ok')::boolean is not true then
    raise exception 'FAILED 4: a test admin on a test alert';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. Grants and the tier.
  if not has_function_privilege('authenticated', 'public.admin_alert_help(bigint, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.admin_alert_help(bigint, text, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.admin_alert_help(bigint, text, uuid)', 'execute')
     or (select t.min_role from public.admin_tier('alert.explain') t) is distinct from 'viewer'
     or (select t.min_role from public.admin_tier('order.review_screening') t) is distinct from 'operator' then
    raise exception 'FAILED 5: grants or tier';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 74: % checks passed', v_passed;
end;
$$;

rollback;
