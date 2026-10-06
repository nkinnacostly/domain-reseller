-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 45 (MyDomainsHub Mail, test accounts), tried as the database
-- owner and, where the grant is the point, as `authenticated` and
-- `service_role`: the helpers act on e2e accounts only, a test account's
-- email is never claimed by the worker, and the purge leaves nothing behind.
-- Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_e2e.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.me_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.me_service(p_sql text) returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v_j;
  execute 'reset role';
  return v_j;
end $f$;

do $$
declare
  v_tag     text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_e2e     uuid := gen_random_uuid();
  u_real    uuid := gen_random_uuid();
  m_e2e     text;
  a_e2e     uuid;
  a_real    uuid;
  a_mixed   uuid;
  v_key     uuid;
  v_hash    text;
  v_dom     text;
  v_j       jsonb;
  v_id      uuid;
  v_eid     bigint;
  v_n       integer;
  v_row     record;
  v_passed  integer := 0;
begin
  m_e2e := 'e2e-m45-' || v_tag || '@example.com';
  v_dom := 'm45-' || v_tag || '.e2e.example';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_e2e, 'authenticated', 'authenticated', m_e2e, now(), now(), now()),
    (u_real, 'authenticated', 'authenticated', 'm45-real-' || v_tag || '@mydomainshub.com', now(), now(), now());
  perform pg_temp.me_as(u_e2e);
  a_e2e := (mail.create_account('m45 e2e ' || v_tag) ->> 'accountId')::uuid;
  a_mixed := (mail.create_account('m45 mixed ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.me_as(u_real);
  a_real := (mail.create_account('m45 real ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values (a_mixed, u_real, 'viewer');

  -- ── 1. Only an account whose every member is an e2e user is a test account.
  if not mail.is_e2e_account(a_e2e) or mail.is_e2e_account(a_real) or mail.is_e2e_account(a_mixed)
     or mail.is_e2e_account(gen_random_uuid()) then
    raise exception 'FAILED 1: is_e2e_account misjudged an account';
  end if;
  foreach v_id in array array[a_real, a_mixed] loop
    v_j := pg_temp.me_service(format('select mail.e2e_ready_account(%L, %L)', v_id, v_dom));
    if v_j ->> 'code' is distinct from 'not_e2e' then raise exception 'FAILED 1: readied a real account: %', v_j; end if;
    v_j := pg_temp.me_service(format('select mail.e2e_purge_account(%L)', v_id));
    if v_j ->> 'code' is distinct from 'not_e2e' then raise exception 'FAILED 1: purged a real account: %', v_j; end if;
  end loop;
  if (select count(*) from mail.accounts where id in (a_real, a_mixed) and not is_e2e and tenant_ready_at is null) <> 2 then
    raise exception 'FAILED 1: a real account changed';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Readying: the reserved .example TLD only; then a ready tenant and a verified domain.
  v_j := pg_temp.me_service(format('select mail.e2e_ready_account(%L, %L)', a_e2e, 'acme.ng'));
  if v_j ->> 'code' is distinct from 'validation' then raise exception 'FAILED 2: a real domain: %', v_j; end if;
  v_j := pg_temp.me_service(format('select mail.e2e_ready_account(%L, %L)', a_e2e, v_dom));
  if (v_j ->> 'ok')::boolean is not true then raise exception 'FAILED 2: %', v_j; end if;
  if not exists (select 1 from mail.accounts a where a.id = a_e2e and a.is_e2e and a.tenant_ready_at is not null
                   and a.ses_status = 'enabled')
     or not exists (select 1 from mail.domains d where d.id = (v_j ->> 'domainId')::uuid and d.status = 'verified'
                      and d.name = v_dom and d.account_id = a_e2e) then
    raise exception 'FAILED 2: the account is not ready';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. The send path on a test account: queued; never taken by the worker's
  -- claim; taken by its own; sent.
  v_hash := encode(extensions.digest(v_tag || 'm45', 'sha256'), 'hex');
  perform pg_temp.me_as(u_e2e);
  v_key := (mail.create_api_key(a_e2e, 'm45', 'full', 'mdh_live_m45a', v_hash) ->> 'keyId')::uuid;
  execute 'reset role';
  v_j := pg_temp.me_service(format('select mail.authenticate_key(%L)', v_hash));
  if (v_j ->> 'accountId')::uuid is distinct from a_e2e then raise exception 'FAILED 3: the key: %', v_j; end if;
  v_j := pg_temp.me_service(format(
    'select mail.enqueue_email(%L, %L, %L::jsonb, %L::jsonb)', a_e2e, v_key,
    jsonb_build_object('from', 'Check <hello@' || v_dom || '>', 'to', jsonb_build_array(m_e2e), 'subject', 'm45'),
    '{"text":"m45"}'));
  if v_j ->> 'status' is distinct from 'queued' then raise exception 'FAILED 3: not queued: %', v_j; end if;
  v_id := (v_j ->> 'id')::uuid;
  v_j := pg_temp.me_service('select mail.claim_sends(''m45-worker'', 100, false)');
  if exists (select 1 from jsonb_array_elements(v_j) e where (e ->> 'publicId')::uuid = v_id) then
    raise exception 'FAILED 3: the worker''s claim took a test account''s email';
  end if;
  -- (Anything else that claim took is put back by the rollback.)
  v_j := pg_temp.me_service(format('select mail.claim_sends(''m45-test'', 10, false, %L)', a_e2e));
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,publicId}')::uuid is distinct from v_id then
    raise exception 'FAILED 3: its own claim answered %', v_j;
  end if;
  v_eid := (v_j #>> '{0,id}')::bigint;
  v_j := pg_temp.me_service(format('select mail.record_send_result(%s, ''m45-test'', ''sent'', %L)',
                                   v_eid, 'm45-' || v_tag));
  if (v_j ->> 'status') is distinct from 'sent'
     or (pg_temp.me_service(format('select mail.get_email(%L, %L)', a_e2e, v_id)) ->> 'status') is distinct from 'sent' then
    raise exception 'FAILED 3: not sent: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 4. The log stays append-only outside the purge.
  begin
    delete from mail.account_audit_log where account_id = a_e2e;
    raise exception 'FAILED 4: the log was deleted outside the purge';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 5. The purge leaves nothing of the account; a second purge is harmless.
  v_j := pg_temp.me_service(format('select mail.e2e_purge_account(%L)', a_e2e));
  if (v_j ->> 'purged')::boolean is not true or (v_j ->> 'emails')::integer <> 1 then
    raise exception 'FAILED 5: %', v_j;
  end if;
  if exists (select 1 from mail.accounts where id = a_e2e) or exists (select 1 from mail.members where account_id = a_e2e)
     or exists (select 1 from mail.account_audit_log where account_id = a_e2e)
     or exists (select 1 from mail.emails where account_id = a_e2e)
     or exists (select 1 from mail.domains where account_id = a_e2e)
     or exists (select 1 from mail.api_keys where account_id = a_e2e)
     or exists (select 1 from mail.usage_daily where account_id = a_e2e)
     or exists (select 1 from mail.send_budget_hourly where account_id = a_e2e) then
    raise exception 'FAILED 5: the purge left something behind';
  end if;
  if coalesce(current_setting('mail.e2e_purge', true), '') = 'on' then
    raise exception 'FAILED 5: the purge left its switch on';
  end if;
  v_j := pg_temp.me_service(format('select mail.e2e_purge_account(%L)', a_e2e));
  if (v_j ->> 'purged')::boolean is not false then raise exception 'FAILED 5: second purge %', v_j; end if;
  begin
    delete from mail.account_audit_log where account_id = a_real;
    raise exception 'FAILED 5: the log was deletable after a purge';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 6. Grants: the helpers and the new claim for service_role only.
  for v_row in select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p
                where p.pronamespace = 'mail'::regnamespace
                  and p.proname in ('e2e_ready_account', 'e2e_purge_account', 'claim_sends', 'is_e2e_account') loop
    if has_function_privilege('anon', v_row.oid, 'execute') or has_function_privilege('authenticated', v_row.oid, 'execute')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_row.proname <> 'is_e2e_account') then
      raise exception 'FAILED 6: mail.%(%) has the wrong grants', v_row.proname, v_row.args;
    end if;
  end loop;
  select count(*) into v_n from pg_proc p where p.pronamespace = 'mail'::regnamespace and p.proname = 'claim_sends';
  if v_n <> 1 then raise exception 'FAILED 6: % claim_sends functions', v_n; end if;
  v_passed := v_passed + 1;

  raise notice 'migration 45: % checks passed', v_passed;
end;
$$;

rollback;
