-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 57 (MyDomainsHub Mail, "Add to Cloudflare", MAIL-SPEC §5.3), tried
-- as the database owner and as people: start_dns_setup lets owners, admins
-- and developers in for a customer domain whose records SES has given, never
-- a viewer, a stranger, the sandbox sender, a failed domain or a domain with
-- no DKIM tokens; it answers what the records are made from, logs each try
-- (never a token: there is no field for one), and stops at ten an hour for
-- one domain. Only `authenticated` may call it. People are made up with
-- e2e-*@example.com addresses. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_dns_setup.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.ds_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.ds_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_v      uuid := gen_random_uuid();
  u_x      uuid := gen_random_uuid();
  a_acc    uuid;
  x_acc    uuid;
  d_p      uuid;
  d_f      uuid;
  d_e      uuid;
  d_sb     uuid;
  v_j      jsonb;
  v_n      integer;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', 'e2e-ds-o-' || v_tag || '@example.com', now(), now(), now()),
    (u_v, 'authenticated', 'authenticated', 'e2e-ds-v-' || v_tag || '@example.com', now(), now(), now()),
    (u_x, 'authenticated', 'authenticated', 'e2e-ds-x-' || v_tag || '@example.com', now(), now(), now());
  perform pg_temp.ds_as(u_o);
  a_acc := (mail.create_account('m57 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.ds_as(u_x);
  x_acc := (mail.create_account('m57 X ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values (a_acc, u_v, 'viewer');

  insert into mail.domains (account_id, name, status, dkim_tokens, mail_from_domain)
  values (a_acc, 'ds1-' || v_tag || '.example', 'pending',
          array['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                'cccccccccccccccccccccccccccccccc'], 'send.ds1-' || v_tag || '.example')
  returning id into d_p;
  insert into mail.domains (account_id, name, status, released_at, failed_reason)
  values (a_acc, 'ds2-' || v_tag || '.example', 'failed', now(), 'expired')
  returning id into d_f;
  insert into mail.domains (account_id, name, status)
  values (a_acc, 'ds3-' || v_tag || '.example', 'pending')
  returning id into d_e;
  insert into mail.domains (account_id, name, kind, status)
  select a_acc, s.name, 'sandbox', 'sandbox' from mail.sandbox_identity s where s.id
  returning id into d_sb;

  -- ── 1. The owner is let in, with what the records are made from, and logged.
  perform pg_temp.ds_as(u_o);
  v_j := mail.start_dns_setup(d_p, 'cloudflare', 'token');
  execute 'reset role';
  if (v_j ->> 'ok')::boolean is not true
     or v_j ->> 'name' <> 'ds1-' || v_tag || '.example'
     or v_j ->> 'mailFromDomain' <> 'send.ds1-' || v_tag || '.example'
     or jsonb_array_length(v_j -> 'dkimTokens') <> 3 then
    raise exception 'FAILED 1: the owner was not let in as expected: %', v_j;
  end if;
  select count(*) into v_n from mail.account_audit_log l
   where l.account_id = a_acc and l.action = 'domain.dns_setup' and l.target = d_p::text
     and l.actor = 'user' and l.actor_user_id = u_o
     and l.detail = jsonb_build_object('name', 'ds1-' || v_tag || '.example',
                                       'provider', 'cloudflare', 'method', 'token');
  if v_n <> 1 then
    raise exception 'FAILED 1: the try was not logged once with its host and method (%)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Refusals: a viewer, a stranger, nobody, a bad host or method, the
  -- sandbox sender, a failed domain, a domain with no records yet.
  perform pg_temp.ds_as(u_v);
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'cloudflare', 'token'), 'forbidden', 'FAILED 2: viewer');
  perform pg_temp.ds_as(u_x);
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'cloudflare', 'token'), 'not_found', 'FAILED 2: stranger');
  perform pg_temp.ds_as(u_o);
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'godaddy', 'token'), 'validation', 'FAILED 2: host');
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'cloudflare', 'magic'), 'validation', 'FAILED 2: method');
  perform pg_temp.ds_code(mail.start_dns_setup(d_sb, 'cloudflare', 'token'), 'forbidden', 'FAILED 2: sandbox');
  perform pg_temp.ds_code(mail.start_dns_setup(d_f, 'cloudflare', 'token'), 'not_ready', 'FAILED 2: failed');
  perform pg_temp.ds_code(mail.start_dns_setup(d_e, 'cloudflare', 'domain_connect'), 'not_ready', 'FAILED 2: no tokens');
  perform pg_temp.ds_code(mail.start_dns_setup(gen_random_uuid(), 'cloudflare', 'token'), 'not_found', 'FAILED 2: no domain');
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'cloudflare', 'token'), 'unauthorized', 'FAILED 2: nobody');
  execute 'reset role';
  select count(*) into v_n from mail.account_audit_log l
   where l.account_id = a_acc and l.action = 'domain.dns_setup';
  if v_n <> 1 then
    raise exception 'FAILED 2: a refused try was logged (% rows)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Ten tries an hour for one domain; the eleventh is refused, unlogged.
  perform pg_temp.ds_as(u_o);
  for i in 2..10 loop
    v_j := mail.start_dns_setup(d_p, 'cloudflare', case when i % 2 = 0 then 'domain_connect' else 'token' end);
    if (v_j ->> 'ok')::boolean is not true then
      raise exception 'FAILED 3: try % was refused: %', i, v_j;
    end if;
  end loop;
  perform pg_temp.ds_code(mail.start_dns_setup(d_p, 'cloudflare', 'token'), 'too_many', 'FAILED 3: eleventh');
  execute 'reset role';
  select count(*) into v_n from mail.account_audit_log l
   where l.account_id = a_acc and l.action = 'domain.dns_setup' and l.target = d_p::text;
  if v_n <> 10 then
    raise exception 'FAILED 3: expected 10 logged tries, found %', v_n;
  end if;
  -- An hour on, the count starts again (the log is append-only, so the clock
  -- is moved by asking about tries older than an hour instead).
  select count(*) into v_n from mail.account_audit_log l
   where l.action = 'domain.dns_setup' and l.target = d_p::text and l.at <= now() - interval '1 hour';
  if v_n <> 0 then
    raise exception 'FAILED 3: tries from over an hour ago counted (%)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Only `authenticated` may call it; it runs with an empty search path.
  if has_function_privilege('anon', 'mail.start_dns_setup(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'mail.start_dns_setup(uuid, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'mail.start_dns_setup(uuid, text, text)', 'execute') then
    raise exception 'FAILED 4: start_dns_setup has the wrong grants';
  end if;
  if (select array_to_string(proconfig, ',') from pg_proc
       where oid = 'mail.start_dns_setup(uuid, text, text)'::regprocedure) is distinct from 'search_path=""' then
    raise exception 'FAILED 4: start_dns_setup runs with another search path';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 57, Add to Cloudflare: % checks passed', v_passed;
end;
$$;

rollback;
