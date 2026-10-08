-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 59: public.check_request, PostgREST's pre-request check. A
-- signed-in user with a verified second factor whose token is not aal2 is
-- refused (PT403); everyone else passes: anon, service_role, users without a
-- factor, aal2 tokens, admin_status before the code, and claims it cannot
-- read. People are made up (e2e-*@example.com). Rolled back.
--
--   supabase db query --linked -f supabase/tests/aal_on_every_request.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Whether check_request refuses the request these claims and this path make.
create function pg_temp.aal_refused(p_claims text, p_path text default '/profiles') returns boolean
language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  perform set_config('request.path', p_path, true);
  perform public.check_request();
  return false;
exception when sqlstate 'PT403' then
  return true;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_mfa    uuid := gen_random_uuid();
  u_plain  uuid := gen_random_uuid();
  u_unver  uuid := gen_random_uuid();
  v_passed integer := 0;
  claims   text;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_mfa, 'authenticated', 'authenticated', 'e2e-aal-m-' || v_tag || '@example.com', now(), now(), now()),
    (u_plain, 'authenticated', 'authenticated', 'e2e-aal-p-' || v_tag || '@example.com', now(), now(), now()),
    (u_unver, 'authenticated', 'authenticated', 'e2e-aal-u-' || v_tag || '@example.com', now(), now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
    (gen_random_uuid(), u_mfa, 'm59 verified', 'totp', 'verified', now(), now()),
    (gen_random_uuid(), u_unver, 'm59 unverified', 'totp', 'unverified', now(), now());

  -- ── 1. Two-factor on, code not entered: refused, on tables and functions.
  claims := jsonb_build_object('sub', u_mfa, 'role', 'authenticated', 'aal', 'aal1')::text;
  if not pg_temp.aal_refused(claims) or not pg_temp.aal_refused(claims, '/rpc/create_api_key') then
    raise exception 'FAILED 1: an aal1 session with a verified factor was let through';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. The same person with the code entered, and admin_status before it.
  if pg_temp.aal_refused(jsonb_build_object('sub', u_mfa, 'role', 'authenticated', 'aal', 'aal2')::text) then
    raise exception 'FAILED 2: an aal2 session was refused';
  end if;
  if pg_temp.aal_refused(claims, '/rpc/admin_status') then
    raise exception 'FAILED 2: admin_status was refused before the code';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Everyone else passes: no factor, an unverified one, anon, service_role.
  if pg_temp.aal_refused(jsonb_build_object('sub', u_plain, 'role', 'authenticated', 'aal', 'aal1')::text)
     or pg_temp.aal_refused(jsonb_build_object('sub', u_unver, 'role', 'authenticated', 'aal', 'aal1')::text)
     or pg_temp.aal_refused('{"role":"anon"}')
     or pg_temp.aal_refused('{"role":"service_role"}') then
    raise exception 'FAILED 3: someone without a verified factor, or not a user, was refused';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Claims it cannot read never fail a request.
  if pg_temp.aal_refused(null)
     or pg_temp.aal_refused('')
     or pg_temp.aal_refused('not json')
     or pg_temp.aal_refused('{"role":"authenticated","sub":"not-a-uuid","aal":"aal1"}')
     or pg_temp.aal_refused('{"role":"authenticated","aal":"aal1"}') then
    raise exception 'FAILED 4: unreadable claims refused a request';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. PostgREST is told to run it, and every role can.
  if not exists (select 1 from pg_roles r
                  where r.rolname = 'authenticator'
                    and 'pgrst.db_pre_request=public.check_request' = any (r.rolconfig)) then
    raise exception 'FAILED 5: authenticator does not run public.check_request before each request';
  end if;
  if not has_function_privilege('anon', 'public.check_request()', 'execute')
     or not has_function_privilege('authenticated', 'public.check_request()', 'execute')
     or not has_function_privilege('service_role', 'public.check_request()', 'execute') then
    raise exception 'FAILED 5: a role cannot run the check, so its requests would fail';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 59, two-factor on every request: % checks passed', v_passed;
end;
$$;

rollback;
