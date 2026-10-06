-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 43 (MyDomainsHub Mail, the core), tried as the database owner and,
-- where the role is the point, as `anon`, `authenticated` and `service_role`.
-- People are made up inside the transaction with e2e-*@example.com addresses.
-- Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_core.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Claims for a signed-in person (or none: anon).
create function pg_temp.mc_as(p_uid uuid) returns void language plpgsql as $f$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
    execute 'set local role authenticated';
  end if;
end $f$;

-- A function's answer must carry exactly this code (a NULL never passes).
create function pg_temp.mc_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.mc_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

do $$
declare
  v_tag     text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner   uuid := gen_random_uuid();
  u_dev     uuid := gen_random_uuid();
  u_view    uuid := gen_random_uuid();
  u_admin   uuid := gen_random_uuid();
  u_none    uuid := gen_random_uuid();
  v_j       jsonb;
  v_acct    uuid;
  v_acct2   uuid;
  v_short   text;
  v_key     uuid;
  v_dom     uuid;
  v_n       integer;
  v_text    text;
  v_row     record;
  v_want    text;
  v_expected jsonb;
  v_passed  integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-mail-o-' || v_tag || '@example.com', now(), now(), now()),
    (u_dev,   'authenticated', 'authenticated', 'e2e-mail-d-' || v_tag || '@example.com', now(), now(), now()),
    (u_view,  'authenticated', 'authenticated', 'e2e-mail-v-' || v_tag || '@example.com', now(), now(), now()),
    (u_admin, 'authenticated', 'authenticated', 'e2e-mail-a-' || v_tag || '@example.com', now(), now(), now()),
    (u_none,  'authenticated', 'authenticated', 'e2e-mail-n-' || v_tag || '@example.com', now(), now(), now());

  -- ── 1. Every table in the schema has RLS; the settings row is there.
  if exists (select 1 from pg_class c where c.relnamespace = 'mail'::regnamespace and c.relkind in ('r', 'p')
               and not c.relrowsecurity) then
    raise exception 'FAILED 1: a mail table has no RLS';
  end if;
  if (select count(*) from mail.settings) <> 1
     or (select account_daily_budget from mail.settings) is distinct from 49000
     or (select sandbox_daily_cap from mail.settings) is distinct from 100
     or (select warmup_start_cap from mail.settings) is distinct from 1000 then
    raise exception 'FAILED 1: mail.settings is not seeded as §4.4 and §7 say';
  end if;
  begin
    delete from mail.settings;
    raise exception 'FAILED 1: the settings row could be deleted';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 2. The four plans of §8, prices in kobo, Scale not offered (owner, 6 Oct 2026).
  select count(*) into v_n from mail.plans p
   where (p.code, p.price_kobo, p.monthly_cap, p.daily_cap, p.max_domains, p.max_members, p.log_retention_days, p.is_offered)
         in (('free', 0, 3000, 100, 1, 1, 7, true),
             ('starter', 2000000, 50000, 5000, 5, 3, 30, true),
             ('pro', 5500000, 150000, 20000, 20, 10, 30, true),
             ('scale', 16000000, 500000, 60000, 50, 25, 60, false));
  if v_n <> 4 or (select count(*) from mail.plans) <> 4 then
    raise exception 'FAILED 2: plans are not the four of §8 (% match)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Signed out, nobody creates an account; anon reads plans and nothing else.
  perform pg_temp.mc_as(null);
  begin
    perform mail.create_account('Nope');
    raise exception 'FAILED 3: anon could call create_account';
  exception when insufficient_privilege then null;
  end;
  select count(*) into v_n from mail.plans;
  if v_n <> 4 then raise exception 'FAILED 3: anon reads % plans', v_n; end if;
  begin
    perform 1 from mail.accounts;
    raise exception 'FAILED 3: anon can read accounts';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 4. create_account: the caller owns it, in the sandbox, on Free, tenant named.
  perform pg_temp.mc_as(u_owner);
  perform pg_temp.mc_code(mail.create_account('   '), 'validation', 'FAILED 4: a blank name');
  v_j := mail.create_account('Acme ' || v_tag, 'https://acme.example', 'Receipts', 1000);
  perform pg_temp.mc_ok(v_j, 'FAILED 4: create_account');
  v_acct := (v_j ->> 'accountId')::uuid;
  v_short := v_j ->> 'shortId';
  execute 'reset role';
  if not exists (select 1 from mail.accounts a
                  where a.id = v_acct and a.state = 'sandbox' and a.plan_code = 'free'
                    and a.ses_tenant = 'mdm-' || v_short and a.config_set = 'mdm-' || v_short
                    and a.ses_status = 'pending' and a.created_by = u_owner and a.warmup_day is null) then
    raise exception 'FAILED 4: the new account is not a pending sandbox account on Free';
  end if;
  if not exists (select 1 from mail.members m where m.account_id = v_acct and m.user_id = u_owner and m.role = 'owner') then
    raise exception 'FAILED 4: the caller is not the owner';
  end if;
  if (select count(*) from mail.account_audit_log l where l.account_id = v_acct
        and l.action in ('account.created', 'member.added')) <> 2 then
    raise exception 'FAILED 4: no audit rows for the new account';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. A person owns at most owned_accounts_max open accounts.
  perform pg_temp.mc_as(u_owner);
  v_acct2 := (mail.create_account('Second ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mc_ok(mail.create_account('Third ' || v_tag), 'FAILED 5: a third account');
  perform pg_temp.mc_code(mail.create_account('Fourth ' || v_tag), 'limit', 'FAILED 5: a fourth account');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 6. Members read their own account by role; strangers read nothing.
  insert into mail.members (account_id, user_id, role) values
    (v_acct, u_dev, 'developer'), (v_acct, u_view, 'viewer'), (v_acct, u_admin, 'admin');
  begin
    insert into mail.members (account_id, user_id, role) values (v_acct, u_none, 'owner');
    raise exception 'FAILED 6: an account took a second owner';
  exception when unique_violation then null;
  end;
  perform pg_temp.mc_as(u_none);
  if exists (select 1 from mail.accounts) or exists (select 1 from mail.members)
     or exists (select 1 from mail.account_audit_log) then
    raise exception 'FAILED 6: a stranger reads an account';
  end if;
  perform pg_temp.mc_as(u_view);
  select count(*) into v_n from mail.accounts;
  if v_n <> 1 then raise exception 'FAILED 6: a viewer reads % accounts', v_n; end if;
  select count(*) into v_n from mail.members;
  if v_n <> 4 then raise exception 'FAILED 6: a viewer reads % members', v_n; end if;
  if exists (select 1 from mail.account_audit_log) then
    raise exception 'FAILED 6: a viewer reads the security log';
  end if;
  perform pg_temp.mc_as(u_admin);
  if not exists (select 1 from mail.account_audit_log) then
    raise exception 'FAILED 6: an admin cannot read the security log';
  end if;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 7. Keys: developers make sending keys, owners and admins full ones;
  -- viewers and strangers none; the hash is never readable.
  insert into mail.domains (account_id, name, status) values (v_acct, 'm43-' || v_tag || '.example', 'verified')
  returning id into v_dom;
  perform pg_temp.mc_as(u_view);
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'v', 'sending', null, 'mdh_live_aaaa', repeat('a', 64)),
                          'forbidden', 'FAILED 7: a viewer made a key');
  perform pg_temp.mc_as(u_none);
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'n', 'sending', null, 'mdh_live_aaaa', repeat('a', 64)),
                          'not_found', 'FAILED 7: a stranger made a key');
  perform pg_temp.mc_as(u_dev);
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'd', 'full', null, 'mdh_live_aaaa', repeat('a', 64)),
                          'forbidden', 'FAILED 7: a developer made a full key');
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'd', 'sending', null, 'mdh_live_aa', repeat('a', 64)),
                          'validation', 'FAILED 7: a short prefix');
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'd', 'sending', null, 'mdh_live_aaaa', 'plain-secret'),
                          'validation', 'FAILED 7: a secret instead of a hash');
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'd', 'full', v_dom, 'mdh_live_aaaa', repeat('a', 64)),
                          'forbidden', 'FAILED 7: a developer''s full key, limited to a domain');
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'd', 'sending', gen_random_uuid(), 'mdh_live_aaaa', repeat('a', 64)),
                          'validation', 'FAILED 7: a key for a domain not the account''s');
  v_j := mail.create_api_key(v_acct, 'Deploys', 'sending', v_dom, 'mdh_live_aaaa', repeat('a', 64));
  perform pg_temp.mc_ok(v_j, 'FAILED 7: a developer''s sending key');
  v_key := (v_j ->> 'keyId')::uuid;
  perform pg_temp.mc_as(u_admin);
  perform pg_temp.mc_ok(mail.create_api_key(v_acct, 'Admin', 'full', null, 'mdh_live_bbbb', repeat('b', 64)),
                        'FAILED 7: an admin''s full key');
  perform pg_temp.mc_code(mail.create_api_key(v_acct, 'Admin', 'full', v_dom, 'mdh_live_bbbb', repeat('c', 64)),
                          'validation', 'FAILED 7: a full key limited to a domain');
  -- Read back as a developer: names and prefixes, never the hash.
  perform pg_temp.mc_as(u_dev);
  select count(*) into v_n from mail.api_keys;
  if v_n <> 2 then raise exception 'FAILED 7: a developer reads % keys', v_n; end if;
  begin
    select key_hash into v_text from mail.api_keys limit 1;
    raise exception 'FAILED 7: the hash is readable';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.mc_as(u_view);
  if exists (select 1 from mail.api_keys) then raise exception 'FAILED 7: a viewer reads keys'; end if;
  execute 'reset role';
  if not exists (select 1 from mail.account_audit_log l where l.account_id = v_acct and l.action = 'key.created'
                   and l.target = v_key::text and l.detail ->> 'prefix' = 'mdh_live_aaaa'
                   and not (l.detail ? 'key_hash')) then
    raise exception 'FAILED 7: no audit row for the key';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. Revoking: a viewer cannot, a developer can revoke a sending key, twice is harmless.
  perform pg_temp.mc_as(u_view);
  perform pg_temp.mc_code(mail.revoke_api_key(v_key), 'forbidden', 'FAILED 8: a viewer revoked a key');
  perform pg_temp.mc_as(u_none);
  perform pg_temp.mc_code(mail.revoke_api_key(v_key), 'not_found', 'FAILED 8: a stranger revoked a key');
  perform pg_temp.mc_as(u_dev);
  perform pg_temp.mc_ok(mail.revoke_api_key(v_key), 'FAILED 8: revoke');
  v_j := mail.revoke_api_key(v_key);
  if (v_j ->> 'already')::boolean is not true then raise exception 'FAILED 8: a second revoke %', v_j; end if;
  execute 'reset role';
  if (select revoked_at from mail.api_keys where id = v_key) is null
     or (select count(*) from mail.account_audit_log where target = v_key::text and action = 'key.revoked') <> 1 then
    raise exception 'FAILED 8: the key is not revoked once';
  end if;
  v_passed := v_passed + 1;

  -- ── 9. The security log is append-only, even for the owner of the database.
  begin
    update mail.account_audit_log set action = 'key.forged' where account_id = v_acct;
    raise exception 'FAILED 9: the log was rewritten';
  exception when check_violation then null;
  end;
  begin
    delete from mail.account_audit_log where account_id = v_acct;
    raise exception 'FAILED 9: the log was deleted';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 10. No API role writes a table, service_role reads none, nothing is truncatable;
  -- the hash columns stay closed.
  for v_row in select c.oid, c.relname from pg_class c where c.relnamespace = 'mail'::regnamespace and c.relkind = 'r' loop
    if has_table_privilege('anon', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', v_row.oid, 'select, insert, update, delete, truncate') then
      raise exception 'FAILED 10: mail.% is open to an API role', v_row.relname;
    end if;
    if has_table_privilege('anon', v_row.oid, 'select') and v_row.relname <> 'plans' then
      raise exception 'FAILED 10: anon reads mail.%', v_row.relname;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'mail.api_keys', 'key_hash', 'select')
     or has_column_privilege('authenticated', 'mail.api_keys', 'rl_tokens', 'select')
     or has_column_privilege('authenticated', 'mail.invites', 'token_hash', 'select')
     or has_table_privilege('authenticated', 'mail.settings', 'select') then
    raise exception 'FAILED 10: a secret column is readable';
  end if;
  for v_row in select s.oid::regclass::text as seq from pg_class s
                where s.relnamespace = 'mail'::regnamespace and s.relkind = 'S' loop
    if has_sequence_privilege('anon', v_row.seq, 'usage, select, update')
       or has_sequence_privilege('authenticated', v_row.seq, 'usage, select, update')
       or has_sequence_privilege('service_role', v_row.seq, 'usage, select, update') then
      raise exception 'FAILED 10: the sequence % is open to an API role', v_row.seq;
    end if;
  end loop;
  v_passed := v_passed + 1;

  -- ── 11. Migration 43's functions: each granted to exactly the role it names.
  v_expected := '{
    "settings_stay":"none", "append_only":"none", "has_role":"authenticated",
    "create_account":"authenticated", "create_api_key":"authenticated", "revoke_api_key":"authenticated"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 11: mail.% is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 11: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 11: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'mail'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')) then
    raise exception 'FAILED 11: a security definer function in mail has no empty search_path';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 43: % checks passed', v_passed;
end;
$$;

rollback;
