-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 65: a transfer code is read only for its owner's fresh request.
-- request_auth_code_intent: the owner, at aal2, for their own domain;
-- claim_auth_code_intent: once, within 60 seconds, for that name and side,
-- the domain still theirs. Nobody else writes the table. Made-up users and
-- demo domains. Rolled back.
--
--   supabase db query --linked -f supabase/tests/auth_code_intents.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.ac_as(p_uid uuid, p_aal text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
  execute 'set local role authenticated';
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_a      uuid := gen_random_uuid();
  u_b      uuid := gen_random_uuid();
  d_a      uuid;
  v_name   text;
  v_j      jsonb;
  v_intent uuid;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_a, 'authenticated', 'authenticated', 'e2e-ac-a-' || v_tag || '@example.com', now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', 'e2e-ac-b-' || v_tag || '@example.com', now(), now(), now());
  v_name := 'e2e-ac-' || v_tag || '.com';
  insert into public.domains (user_id, domain_name, tld, source, test_mode)
  values (u_a, upper(v_name), 'com', 'demo', true) returning id into d_a;

  -- ── 1. Asked for by the owner at aal2: an intent; anyone else, or aal1: no.
  perform pg_temp.ac_as(u_a, 'aal1');
  v_j := public.request_auth_code_intent(d_a);
  if v_j ->> 'code' is distinct from 'mfa_required' then
    raise exception 'FAILED 1: an aal1 session got an intent: %', v_j;
  end if;
  perform pg_temp.ac_as(u_b, 'aal2');
  if public.request_auth_code_intent(d_a) ->> 'code' is distinct from 'not_found' then
    raise exception 'FAILED 1: someone else''s domain gave an intent';
  end if;
  perform pg_temp.ac_as(u_a, 'aal2');
  v_j := public.request_auth_code_intent(d_a);
  v_intent := (v_j ->> 'intentId')::uuid;
  execute 'reset role';
  if v_intent is null then
    raise exception 'FAILED 1: the owner at aal2 got no intent: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Claimed once, for its name and side only.
  if public.claim_auth_code_intent(v_intent, v_name, 'live') then
    raise exception 'FAILED 2: an intent claimed for the other side';
  end if;
  if public.claim_auth_code_intent(v_intent, 'other-' || v_name, 'sandbox') then
    raise exception 'FAILED 2: an intent claimed for another name';
  end if;
  if not public.claim_auth_code_intent(v_intent, upper(v_name), 'sandbox') then
    raise exception 'FAILED 2: the right claim was refused';
  end if;
  if public.claim_auth_code_intent(v_intent, v_name, 'sandbox') then
    raise exception 'FAILED 2: an intent claimed twice';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Stale, or no longer the owner's: refused.
  perform pg_temp.ac_as(u_a, 'aal2');
  v_intent := (public.request_auth_code_intent(d_a) ->> 'intentId')::uuid;
  execute 'reset role';
  update public.auth_code_intents set created_at = now() - interval '61 seconds' where id = v_intent;
  if public.claim_auth_code_intent(v_intent, v_name, 'sandbox') then
    raise exception 'FAILED 3: a stale intent was claimed';
  end if;
  perform pg_temp.ac_as(u_a, 'aal2');
  v_intent := (public.request_auth_code_intent(d_a) ->> 'intentId')::uuid;
  execute 'reset role';
  update public.domains set user_id = u_b where id = d_a;
  if public.claim_auth_code_intent(v_intent, v_name, 'sandbox') then
    raise exception 'FAILED 3: an intent was claimed after the domain changed hands';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Nobody but the two functions writes the table; each is granted once.
  if has_table_privilege('service_role', 'public.auth_code_intents', 'insert')
     or has_table_privilege('authenticated', 'public.auth_code_intents', 'select')
     or has_function_privilege('authenticated', 'public.claim_auth_code_intent(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.request_auth_code_intent(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_auth_code_intent(uuid, text, text)', 'execute') then
    raise exception 'FAILED 4: migration 65 has the wrong grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 65, transfer-code intents: % checks passed', v_passed;
end;
$$;

rollback;
