-- ─────────────────────────────────────────────────────────────────────────────
-- Migrations 52 and 54 (MyDomainsHub Mail, the send gate), tried as the
-- database owner and, for the queue, as `service_role`: a sandbox account's
-- email from its sandbox sender is queued (reserve_send, migration 54) and
-- may go at send time (send_gate, migration 52) — only from its one address,
-- only while the account is in the sandbox and the shared identity is
-- verified — and everything else either refuses as before. Every email goes
-- through enqueue_email, as the API sends it, so a queue that refuses what the
-- gate accepts is caught here (MR2, §7.2). Nothing is sent. People are made
-- up with e2e-*@example.com addresses. Rolled back, the shared sandbox
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

-- POST /emails as the API makes it: enqueue_email with the secret key.
create function pg_temp.sg_send(p_account uuid, p_from text, p_to text) returns jsonb
language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_email(p_account, null,
                            jsonb_build_object('from', p_from, 'to', jsonb_build_array(p_to),
                                               'subject', 'Hello from the m52 check'),
                            '{"text":"Hi"}');
  execute 'reset role';
  return v_j;
end $f$;

-- The queued email's row id, from what enqueue_email answered.
create function pg_temp.sg_id(p_j jsonb) returns bigint language plpgsql as $f$
declare
  v_id bigint;
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true or p_j ->> 'status' <> 'queued' then
    raise exception 'expected a queued email, got %', p_j;
  end if;
  select id into v_id from mail.emails where public_id = (p_j ->> 'id')::uuid;
  return v_id;
end $f$;

create function pg_temp.sg_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
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
  m_b      text;
  a_acc    uuid;
  b_acc    uuid;
  d_sb     uuid;
  d_sb_b   uuid;
  d_v      uuid;
  v_name   text;
  v_from   text;
  v_id     bigint;
  v_id2    bigint;
  v_j      jsonb;
  v_text   text;
  v_passed integer := 0;
begin
  m_o := 'e2e-sg-o-' || v_tag || '@example.com';
  m_b := 'e2e-sg-b-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', m_b, now(), now(), now());
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
  values (a_acc, 'sg2-' || v_tag || '.example', 'pending');

  -- ── 1. A sandbox account's email from its sandbox sender is queued — with a
  -- display name too — on its own sandbox row, may go, and claim_sends takes
  -- it with its body (migration 54: reserve_send asked only for verified domains).
  v_j := pg_temp.sg_send(a_acc, 'Acme <' || v_from || '>', m_o);
  v_id := pg_temp.sg_id(v_j);
  if (select domain_id from mail.emails where id = v_id) <> d_sb then
    raise exception 'FAILED 1: the sandbox email is not on the account''s own sandbox row';
  end if;
  if pg_temp.sg_gate(v_id) <> 'go' then
    raise exception 'FAILED 1: the sandbox sender was refused at send time: %', pg_temp.sg_gate(v_id);
  end if;
  execute 'set local role service_role';
  v_j := mail.claim_sends('m52-worker', 10, false, a_acc);
  execute 'reset role';
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,id}')::bigint <> v_id or v_j #>> '{0,text}' <> 'Hi'
     or (select status from mail.emails where id = v_id) <> 'sending' then
    raise exception 'FAILED 1: the claim answered %', v_j;
  end if;
  -- The other sandbox account sends from the same address, on its own row.
  v_id2 := pg_temp.sg_id(pg_temp.sg_send(b_acc, v_from, m_b));
  if (select domain_id from mail.emails where id = v_id2) <> d_sb_b then
    raise exception 'FAILED 1: B''s sandbox email is not on B''s sandbox row';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Only from its one address at the sandbox name: refused when queued.
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, 'someone-else@' || v_name, m_o), 'domain_not_verified',
                          'FAILED 2: another address at the sandbox name was queued');
  -- The sandbox only reaches the account's own members.
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, v_from, 'x@example.com'), 'sandbox_recipient',
                          'FAILED 2: a sandbox email to someone else was queued');
  v_passed := v_passed + 1;

  -- ── 3. Never another account's sandbox row: a queued email moved onto B's
  -- row (as no function would) is refused at send time.
  v_id := pg_temp.sg_id(pg_temp.sg_send(a_acc, v_from, m_o));
  update mail.emails set domain_id = d_sb_b where id = v_id;
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 3: another account''s sandbox row: %', pg_temp.sg_gate(v_id);
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Not while the shared identity is not verified at SES: not queued,
  -- and one queued before is held at send time until it is verified again.
  v_id := pg_temp.sg_id(pg_temp.sg_send(a_acc, v_from, m_o));
  update mail.sandbox_identity set status = 'pending' where id;
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, v_from, m_o), 'domain_not_verified',
                          'FAILED 4: queued from an unverified sandbox identity');
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 4: an unverified sandbox identity: %', pg_temp.sg_gate(v_id);
  end if;
  update mail.sandbox_identity set status = 'verified' where id;
  if pg_temp.sg_gate(v_id) <> 'go' then
    raise exception 'FAILED 4: verified again: %', pg_temp.sg_gate(v_id);
  end if;
  v_passed := v_passed + 1;

  -- ── 5. Once the account has left the sandbox: its sandbox sender is refused
  -- when queued and at send time; its own verified domain is queued and goes,
  -- a pending one is refused, a suppressed recipient is kept as suppressed,
  -- and a paused account queues nothing and sends nothing.
  update mail.accounts set state = 'active' where id = a_acc;
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, v_from, m_o), 'domain_not_verified',
                          'FAILED 5: an active account queued from the sandbox sender');
  if pg_temp.sg_gate(v_id) <> 'failed/domain_not_verified' then
    raise exception 'FAILED 5: an active account''s sandbox email: %', pg_temp.sg_gate(v_id);
  end if;
  v_id2 := pg_temp.sg_id(pg_temp.sg_send(a_acc, 'hello@sg1-' || v_tag || '.example', 'x@example.com'));
  if (select domain_id from mail.emails where id = v_id2) <> d_v or pg_temp.sg_gate(v_id2) <> 'go' then
    raise exception 'FAILED 5: the account''s verified domain: %', pg_temp.sg_gate(v_id2);
  end if;
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, 'hello@sg2-' || v_tag || '.example', 'x@example.com'),
                          'domain_not_verified', 'FAILED 5: a pending domain was queued');
  insert into mail.suppressions (account_id, address, reason, source) values (a_acc, 'x@example.com', 'bounce', 'ses');
  v_j := pg_temp.sg_send(a_acc, 'hello@sg1-' || v_tag || '.example', 'x@example.com');
  if v_j ->> 'status' <> 'suppressed' then
    raise exception 'FAILED 5: a suppressed recipient was queued: %', v_j;
  end if;
  if pg_temp.sg_gate(v_id2) <> 'suppressed/suppressed' then
    raise exception 'FAILED 5: a suppressed recipient at send time: %', pg_temp.sg_gate(v_id2);
  end if;
  update mail.accounts set state = 'paused' where id = a_acc;
  perform pg_temp.sg_code(pg_temp.sg_send(a_acc, 'hello@sg1-' || v_tag || '.example', 'y@example.com'),
                          'account_paused', 'FAILED 5: a paused account queued');
  if pg_temp.sg_gate(v_id2) <> 'failed/account_paused' then
    raise exception 'FAILED 5: a paused account: %', pg_temp.sg_gate(v_id2);
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Still helpers: no API role may call the gate or the reservation, and
  -- they run with no search path.
  foreach v_text in array array['mail.send_gate(bigint)',
                                'mail.reserve_send(uuid, uuid, text, text[], timestamptz)'] loop
    if has_function_privilege('anon', v_text, 'execute')
       or has_function_privilege('authenticated', v_text, 'execute')
       or has_function_privilege('service_role', v_text, 'execute') then
      raise exception 'FAILED 6: % is open to an API role', v_text;
    end if;
    if (select array_to_string(proconfig, ',') from pg_proc where oid = v_text::regprocedure)
         is distinct from 'search_path=""' then
      raise exception 'FAILED 6: % runs with another search path', v_text;
    end if;
  end loop;
  v_passed := v_passed + 1;

  raise notice 'migrations 52 and 54, the send gate: % checks passed', v_passed;
end;
$$;

rollback;
