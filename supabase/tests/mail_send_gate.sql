-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 52 (MyDomainsHub Mail, the send gate), tried as the database
-- owner: at send time a sandbox account's email from its sandbox sender may
-- go (MR2, §7.2) — only from its one address, only while the account is in
-- the sandbox and the shared identity is verified — and everything else the
-- gate refused before it still refuses. Emails are written straight into the
-- queue, as the queue functions would leave them; nothing is sent. People are
-- made up with e2e-*@example.com addresses. Rolled back, the shared sandbox
-- identity's status included.
--
--   supabase db query --linked -f supabase/tests/mail_send_gate.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.sg_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

-- One queued email and its body, as enqueue_email leaves them.
create function pg_temp.sg_email(p_account uuid, p_domain uuid, p_from text, p_to text) returns bigint
language plpgsql as $f$
declare
  v_id bigint;
begin
  insert into mail.emails (account_id, domain_id, from_address, to_addresses, subject)
  values (p_account, p_domain, p_from, array[p_to], 'Hello from the m52 check')
  returning id into v_id;
  insert into mail.email_payloads (email_id, text, size_bytes) values (v_id, 'Hi', 2);
  return v_id;
end $f$;

-- What the gate says of one email: 'go', or status/reason.
create function pg_temp.sg_gate(p_id bigint) returns text language sql as $f$
  select coalesce((select g.status || '/' || g.reason from mail.send_gate(p_id) g), 'go')
$f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_b      uuid := gen_random_uuid();
  m_o      text;
  a_acc    uuid;
  b_acc    uuid;
  d_sb     uuid;
  d_sb_b   uuid;
  d_v      uuid;
  d_p      uuid;
  v_name   text;
  v_from   text;
  v_id     bigint;
  v_id2    bigint;
  v_j      jsonb;
  v_text   text;
  v_passed integer := 0;
begin
  m_o := 'e2e-sg-o-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', 'e2e-sg-b-' || v_tag || '@example.com', now(), now(), now());
  perform pg_temp.sg_as(u_o);
  a_acc := (mail.create_account('m52 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.sg_as(u_b);
  b_acc := (mail.create_account('m52 B ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled' where id in (a_acc, b_acc);

  -- The shared sandbox identity, verified for this check only (rolled back).
  update mail.sandbox_identity set status = 'verified', verified_at = now() where id;
  select name, from_address into v_name, v_from from mail.sandbox_identity where id;
  insert into mail.domains (account_id, name, kind, status) values (a_acc, v_name, 'sandbox', 'sandbox')
    returning id into d_sb;
  insert into mail.domains (account_id, name, kind, status) values (b_acc, v_name, 'sandbox', 'sandbox')
    returning id into d_sb_b;
  insert into mail.domains (account_id, name, status, verified_at)
  values (a_acc, 'sg1-' || v_tag || '.example', 'verified', now()) returning id into d_v;
  insert into mail.domains (account_id, name, status)
  values (a_acc, 'sg2-' || v_tag || '.example', 'pending') returning id into d_p;

  -- ── 1. A sandbox account's email from its sandbox sender may go — with a
  -- display name too — and claim_sends takes it with its body.
  v_id := pg_temp.sg_email(a_acc, d_sb, 'Acme <' || v_from || '>', m_o);
  if pg_temp.sg_gate(v_id) <> 'go' then
    raise exception 'FAILED 1: the sandbox sender was refused: %', pg_temp.sg_gate(v_id);
  end if;
  execute 'set local role service_role';
  v_j := mail.claim_sends('m52-worker', 10, false, a_acc);
  execute 'reset role';
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,id}')::bigint <> v_id or v_j #>> '{0,text}' <> 'Hi'
     or (select status from mail.emails where id = v_id) <> 'sending' then
    raise exception 'FAILED 1: the claim answered %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Only from its one address at the sandbox name.
  v_id := pg_temp.sg_email(a_acc, d_sb, 'someone-else@' || v_name, m_o);
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 2: another address at the sandbox name: %', pg_temp.sg_gate(v_id);
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Never another account's sandbox row.
  v_id := pg_temp.sg_email(a_acc, d_sb_b, v_from, m_o);
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 3: another account''s sandbox row: %', pg_temp.sg_gate(v_id);
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Not while the shared identity is not verified at SES.
  v_id := pg_temp.sg_email(a_acc, d_sb, v_from, m_o);
  update mail.sandbox_identity set status = 'pending' where id;
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 4: an unverified sandbox identity: %', pg_temp.sg_gate(v_id);
  end if;
  update mail.sandbox_identity set status = 'verified' where id;
  if pg_temp.sg_gate(v_id) <> 'go' then
    raise exception 'FAILED 4: verified again: %', pg_temp.sg_gate(v_id);
  end if;
  v_passed := v_passed + 1;

  -- ── 5. Not once the account has left the sandbox; its own verified domain
  -- still goes, a pending one still does not, and the other refusals stand.
  update mail.accounts set state = 'active' where id = a_acc;
  v_id2 := pg_temp.sg_email(a_acc, d_v, 'hello@sg1-' || v_tag || '.example', 'x@example.com');
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' or pg_temp.sg_gate(v_id2) <> 'go' then
    raise exception 'FAILED 5: an active account: % and %', pg_temp.sg_gate(v_id), pg_temp.sg_gate(v_id2);
  end if;
  if pg_temp.sg_gate(pg_temp.sg_email(a_acc, d_p, 'hello@sg2-' || v_tag || '.example', 'x@example.com'))
       <> 'failed/domain_not_verified' then
    raise exception 'FAILED 5: a pending domain went';
  end if;
  insert into mail.suppressions (account_id, address, reason, source) values (a_acc, 'x@example.com', 'bounce', 'ses');
  if pg_temp.sg_gate(v_id2) <> 'suppressed/suppressed' then
    raise exception 'FAILED 5: a suppressed recipient: %', pg_temp.sg_gate(v_id2);
  end if;
  update mail.accounts set state = 'paused' where id = a_acc;
  if pg_temp.sg_gate(v_id2) <> 'failed/account_paused' then
    raise exception 'FAILED 5: a paused account: %', pg_temp.sg_gate(v_id2);
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Still a helper: no API role may call it, and it runs with no search path.
  if has_function_privilege('anon', 'mail.send_gate(bigint)', 'execute')
     or has_function_privilege('authenticated', 'mail.send_gate(bigint)', 'execute')
     or has_function_privilege('service_role', 'mail.send_gate(bigint)', 'execute') then
    raise exception 'FAILED 6: send_gate is open to an API role';
  end if;
  select array_to_string(proconfig, ',') into v_text from pg_proc where oid = 'mail.send_gate(bigint)'::regprocedure;
  if v_text is distinct from 'search_path=""' then
    raise exception 'FAILED 6: send_gate runs with %', v_text;
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 52: % checks passed', v_passed;
end;
$$;

rollback;
