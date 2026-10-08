-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 44 (MyDomainsHub Mail, sending), tried as the database owner and,
-- where the grant is the point, as `authenticated` and `service_role`: the
-- gate and caps of reserve_send (MR2, §4.4, §7, §8), idempotency, the
-- worker's claim and results, event precedence, the 72-hour purge (MR3), the
-- key door, RLS by role, and every mail function's grant. People are made up
-- with e2e-*@example.com addresses; no email is sent. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_sending.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.ms_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.ms_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.ms_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- Queues one email the way the API does (as service_role).
create function pg_temp.ms_send(p_account uuid, p_key uuid, p_from text, p_to text[],
                                p_idem text default null, p_hash text default null)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_email(p_account, p_key,
           jsonb_build_object('from', p_from, 'to', to_jsonb(p_to), 'subject', 'Hello from the m44 check',
                              'tags', '[{"name":"kind","value":"check"}]'::jsonb),
           '{"html":"<p>Hi</p>","text":"Hi","headers":{"X-Check":"m44"},"attachments":[]}'::jsonb,
           p_idem, p_hash);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.ms_claim(p_worker text, p_limit integer default 50, p_paid boolean default false)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.claim_sends(p_worker, p_limit, p_paid);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.ms_result(p_id bigint, p_worker text, p_outcome text, p_msg text default null,
                                  p_code text default null, p_wait integer default null)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.record_send_result(p_id, p_worker, p_outcome, p_msg, p_code, p_wait);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.ms_event(p_msg text, p_public uuid, p_event text, p_key text, p_detail jsonb default '{}',
                                 p_suppress text[] default '{}')
returns boolean language plpgsql as $f$
declare
  v_b boolean;
begin
  execute 'set local role service_role';
  v_b := mail.record_send_event(p_event, p_msg, p_public, p_key, now(), p_detail, 1, p_suppress);
  execute 'reset role';
  return v_b;
end $f$;

create function pg_temp.ms_used(p_account uuid, p_column text) returns integer language plpgsql as $f$
declare
  v_n integer;
begin
  execute format('select coalesce(sum(%I), 0)::integer from mail.usage_daily where account_id = $1', p_column)
     into v_n using p_account;
  return v_n;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_d      uuid := gen_random_uuid();
  u_v      uuid := gen_random_uuid();
  u_u      uuid := gen_random_uuid();   -- a member who never confirmed the address
  u_n      uuid := gen_random_uuid();
  u_b      uuid := gen_random_uuid();
  m_o      text;
  m_d      text;
  m_v      text;
  m_u      text;
  m_x      text;                         -- nobody's
  a_acc    uuid;
  b_acc    uuid;
  d1       uuid;
  d2       uuid;
  d3       uuid;
  db       uuid;
  n1       text;
  n3       text;
  nb       text;
  k_full   uuid;
  k_lim    uuid;
  k_rev    uuid;
  k_b      uuid;
  h_full   text;
  h_rev    text;
  h_b      text;
  v_j      jsonb;
  v_j2     jsonb;
  v_id     uuid;
  v_id2    uuid;
  v_eid    bigint;
  v_eid2   bigint;
  v_n      integer;
  v_m      integer;
  v_b      boolean;
  v_text   text;
  v_acc    mail.accounts;
  v_row    record;
  v_want   text;
  v_expected jsonb;
  v_budget integer;
  v_passed integer := 0;
begin
  m_o := 'e2e-ms-o-' || v_tag || '@example.com';
  m_d := 'e2e-ms-d-' || v_tag || '@example.com';
  m_v := 'e2e-ms-v-' || v_tag || '@example.com';
  m_u := 'e2e-ms-u-' || v_tag || '@example.com';
  m_x := 'e2e-ms-x-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), now(), now()),
    (u_d, 'authenticated', 'authenticated', m_d, now(), now(), now()),
    (u_v, 'authenticated', 'authenticated', m_v, now(), now(), now()),
    (u_u, 'authenticated', 'authenticated', m_u, null, now(), now()),
    (u_n, 'authenticated', 'authenticated', 'e2e-ms-n-' || v_tag || '@example.com', now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', 'e2e-ms-b-' || v_tag || '@example.com', now(), now(), now());

  perform pg_temp.ms_as(u_o);
  a_acc := (mail.create_account('m44 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.ms_as(u_b);
  b_acc := (mail.create_account('m44 B ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled' where id in (a_acc, b_acc);
  insert into mail.members (account_id, user_id, role) values
    (a_acc, u_d, 'developer'), (a_acc, u_v, 'viewer'), (a_acc, u_u, 'viewer');
  n1 := 'ms1-' || v_tag || '.example';
  n3 := 'ms3-' || v_tag || '.example';
  nb := 'msb-' || v_tag || '.example';
  insert into mail.domains (account_id, name, status) values (a_acc, n1, 'verified') returning id into d1;
  insert into mail.domains (account_id, name, status) values (a_acc, 'ms2-' || v_tag || '.example', 'pending')
    returning id into d2;
  insert into mail.domains (account_id, name, status) values (a_acc, n3, 'verified') returning id into d3;
  insert into mail.domains (account_id, name, status) values (b_acc, nb, 'verified') returning id into db;
  h_full := encode(extensions.digest(v_tag || 'full', 'sha256'), 'hex');
  h_rev := encode(extensions.digest(v_tag || 'rev', 'sha256'), 'hex');
  h_b := encode(extensions.digest(v_tag || 'b', 'sha256'), 'hex');
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (a_acc, 'full', 'mdh_live_full', h_full, 'full') returning id into k_full;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, domain_id) values
    (a_acc, 'limited', 'mdh_live_lim0', encode(extensions.digest(v_tag || 'lim', 'sha256'), 'hex'), 'sending', d3)
    returning id into k_lim;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, revoked_at) values
    (a_acc, 'revoked', 'mdh_live_rev0', h_rev, 'full', now()) returning id into k_rev;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (b_acc, 'b', 'mdh_live_bbbb', h_b, 'full') returning id into k_b;

  -- ── 1. A sandbox account sends to its own confirmed member: queued, the body
  -- kept, the reservation counted for the plan and the account budget.
  v_j := pg_temp.ms_send(a_acc, k_full, 'Acme <hello@' || n1 || '>', array[m_o]);
  perform pg_temp.ms_ok(v_j, 'FAILED 1: a sandbox send to the owner');
  v_id := (v_j ->> 'id')::uuid;
  if v_j ->> 'status' is distinct from 'queued' or (v_j ->> 'replayed')::boolean then
    raise exception 'FAILED 1: answer %', v_j;
  end if;
  select id into v_eid from mail.emails e
   where e.public_id = v_id and e.status = 'queued' and e.domain_id = d1 and e.recipient_count = 1
     and e.reserved_on = mail.lagos_day(now()) and e.reserved_hour = date_trunc('hour', now())
     and e.api_key_id = k_full;
  if v_eid is null or not exists (select 1 from mail.email_payloads p where p.email_id = v_eid and p.html = '<p>Hi</p>'
                                     and p.headers ->> 'X-Check' = 'm44') then
    raise exception 'FAILED 1: the queued row or its body is wrong';
  end if;
  if pg_temp.ms_used(a_acc, 'queued') <> 1
     or (select recipients from mail.send_budget_hourly where account_id = a_acc and hour = date_trunc('hour', now())) <> 1 then
    raise exception 'FAILED 1: the reservation was not counted once';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. The sandbox refuses anyone but confirmed members; addresses compare
  -- in lower case; a recipient twice is a validation error.
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_x]),
                          'sandbox_recipient', 'FAILED 2: a stranger in the sandbox');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_u]),
                          'sandbox_recipient', 'FAILED 2: an unconfirmed member');
  perform pg_temp.ms_ok(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[upper(m_d)]),
                        'FAILED 2: a member, in capitals');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o, upper(m_o)]),
                          'validation', 'FAILED 2: the same recipient twice');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, '{}'::text[]),
                          'validation', 'FAILED 2: no recipient');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'not an address', array[m_o]),
                          'validation', 'FAILED 2: a bad from');
  if pg_temp.ms_used(a_acc, 'queued') <> 2 then
    raise exception 'FAILED 2: refusals reserved something (% queued)', pg_temp.ms_used(a_acc, 'queued');
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Idempotency-Key: the same request answers the same id and reserves
  -- nothing more; a different one is refused for 24 hours, then the key is free.
  v_text := repeat('a', 64);
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o], 'order-1042-receipt', v_text);
  perform pg_temp.ms_ok(v_j, 'FAILED 3: first use of a key');
  v_j2 := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o], 'order-1042-receipt', v_text);
  if (v_j2 ->> 'id') is distinct from (v_j ->> 'id') or (v_j2 ->> 'replayed')::boolean is not true then
    raise exception 'FAILED 3: a replay answered %', v_j2;
  end if;
  if pg_temp.ms_used(a_acc, 'queued') <> 3 then raise exception 'FAILED 3: a replay reserved again'; end if;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_d], 'order-1042-receipt', repeat('b', 64)),
                          'idempotency_conflict', 'FAILED 3: the key with another request');
  -- Another account may use the same key.
  update mail.accounts set state = 'active' where id = b_acc;
  perform pg_temp.ms_ok(pg_temp.ms_send(b_acc, k_b, 'hello@' || nb, array[m_x], 'order-1042-receipt', v_text),
                        'FAILED 3: the same key on another account');
  update mail.emails set created_at = now() - interval '25 hours' where public_id = (v_j ->> 'id')::uuid;
  v_j2 := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_d], 'order-1042-receipt', repeat('b', 64));
  perform pg_temp.ms_ok(v_j2, 'FAILED 3: the key after 24 hours');
  if (v_j2 ->> 'id') = (v_j ->> 'id')
     or (select idempotency_key from mail.emails where public_id = (v_j ->> 'id')::uuid) is not null then
    raise exception 'FAILED 3: the old email kept its key';
  end if;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o], 'order-x', null),
                          'validation', 'FAILED 3: a key without a request hash');
  v_passed := v_passed + 1;

  -- ── 4. The gate (MR2): domain, key, account state, tenant.
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@ms2-' || v_tag || '.example', array[m_o]),
                          'domain_not_verified', 'FAILED 4: a pending domain');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || nb, array[m_o]),
                          'domain_not_verified', 'FAILED 4: another account''s domain');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@sub.' || n1, array[m_o]),
                          'domain_not_verified', 'FAILED 4: a subdomain of a verified domain');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_lim, 'hello@' || n1, array[m_o]),
                          'forbidden', 'FAILED 4: a key limited to another domain');
  perform pg_temp.ms_ok(pg_temp.ms_send(a_acc, k_lim, 'hello@' || n3, array[m_o]), 'FAILED 4: a key on its own domain');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_rev, 'hello@' || n1, array[m_o]),
                          'unauthorized', 'FAILED 4: a revoked key');
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_b, 'hello@' || n1, array[m_o]),
                          'unauthorized', 'FAILED 4: another account''s key');
  update mail.accounts set state = 'paused' where id = a_acc;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'account_paused', 'FAILED 4: paused');
  update mail.accounts set state = 'sandbox', ses_status = 'disabled' where id = a_acc;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'account_paused',
                          'FAILED 4: SES paused the tenant');
  update mail.accounts set ses_status = 'enabled', tenant_ready_at = null where id = a_acc;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'account_not_ready',
                          'FAILED 4: no tenant yet');
  update mail.accounts set state = 'closed', tenant_ready_at = now() where id = a_acc;
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'unauthorized', 'FAILED 4: closed');
  update mail.accounts set state = 'sandbox' where id = a_acc;
  v_passed := v_passed + 1;

  -- ── 5. The sandbox's 100 a day, then the plan's day (Starter) — each the
  -- plan's quota, with when to try again.
  insert into mail.usage_daily as u (account_id, day, queued) values (a_acc, mail.lagos_day(now()), 99)
  on conflict (account_id, day) do update set queued = 99;
  perform pg_temp.ms_ok(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'FAILED 5: the 100th');
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]);
  perform pg_temp.ms_code(v_j, 'quota_exceeded', 'FAILED 5: the 101st');
  if v_j ->> 'scope' is distinct from 'day' or (v_j ->> 'cap')::integer is distinct from 100
     or coalesce((v_j ->> 'retryAfter')::integer, 0) not between 1 and 86400 then
    raise exception 'FAILED 5: the refusal said %', v_j;
  end if;
  update mail.accounts set state = 'active', plan_code = 'starter' where id = a_acc;
  update mail.usage_daily set queued = 5000 where account_id = a_acc and day = mail.lagos_day(now());
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_x]), 'quota_exceeded',
                          'FAILED 5: Starter''s day');
  update mail.usage_daily set queued = 4999 where account_id = a_acc and day = mail.lagos_day(now());
  perform pg_temp.ms_ok(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_x]), 'FAILED 5: an active account to anyone');
  -- The month, when today is not its first day (Lagos).
  if extract(day from mail.lagos_day(now())) > 1 then
    update mail.usage_daily set queued = 0 where account_id = a_acc and day = mail.lagos_day(now());
    insert into mail.usage_daily (account_id, day, queued) values (a_acc, mail.lagos_day(now()) - 1, 50000);
    v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_x]);
    perform pg_temp.ms_code(v_j, 'quota_exceeded', 'FAILED 5: Starter''s month');
    if v_j ->> 'scope' is distinct from 'month' then raise exception 'FAILED 5: the month said %', v_j; end if;
    delete from mail.usage_daily where account_id = a_acc and day = mail.lagos_day(now()) - 1;
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Warm-up (§7.3) and the caps that apply.
  update mail.accounts set warmup_day = 0 where id = a_acc;
  select * into v_acc from mail.accounts where id = a_acc;
  if (select daily from mail.effective_caps(v_acc)) <> 1000 then raise exception 'FAILED 6: day 0 is not 1,000'; end if;
  v_acc.warmup_day := 2;
  if (select daily from mail.effective_caps(v_acc)) <> 4000 then raise exception 'FAILED 6: day 2 is not 4,000'; end if;
  v_acc.warmup_day := 3;
  if (select daily from mail.effective_caps(v_acc)) <> 5000 then raise exception 'FAILED 6: day 3 is past Starter'; end if;
  v_acc.warmup_day := 60;
  if (select daily from mail.effective_caps(v_acc)) <> 5000 then raise exception 'FAILED 6: day 60 overflowed'; end if;
  v_acc.daily_cap_override := 7;
  if (select daily from mail.effective_caps(v_acc)) <> 7 then raise exception 'FAILED 6: an override'; end if;
  v_acc.daily_cap_override := null;
  v_acc.state := 'sandbox';
  if (select daily from mail.effective_caps(v_acc)) <> 100 then raise exception 'FAILED 6: the sandbox'; end if;
  v_acc.state := 'active';
  v_acc.plan_code := 'free';
  v_acc.warmup_day := 0;
  -- Free is 350 a day and 10,500 a month since migration 67: under warm-up's 1,000.
  if (select daily from mail.effective_caps(v_acc)) <> 350 or (select monthly from mail.effective_caps(v_acc)) <> 10500 then
    raise exception 'FAILED 6: Free in warm-up';
  end if;
  v_acc.plan_code := 'gone';
  if (select daily from mail.effective_caps(v_acc)) <> 0 then raise exception 'FAILED 6: no plan must mean no sending'; end if;
  update mail.accounts set warmup_day = null where id = a_acc;
  v_passed := v_passed + 1;

  -- ── 7. A suppressed recipient: kept as `suppressed`, nothing reserved, no body.
  insert into mail.suppressions (account_id, address, reason, source) values (a_acc, lower(m_x), 'bounce', 'ses');
  v_n := pg_temp.ms_used(a_acc, 'queued');
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array['Ex <' || upper(m_x) || '>', m_o]);
  perform pg_temp.ms_ok(v_j, 'FAILED 7: a suppressed send');
  if v_j ->> 'status' is distinct from 'suppressed' or pg_temp.ms_used(a_acc, 'queued') <> v_n
     or exists (select 1 from mail.email_payloads p join mail.emails e on e.id = p.email_id
                 where e.public_id = (v_j ->> 'id')::uuid)
     or (select reserved_on from mail.emails where public_id = (v_j ->> 'id')::uuid) is not null then
    raise exception 'FAILED 7: a suppressed send reserved or kept something: %', v_j;
  end if;
  delete from mail.suppressions where account_id = a_acc;
  v_passed := v_passed + 1;

  -- ── 8. The SES account's 24-hour budget (§4.4): ours, not the plan's; no
  -- account takes more than half of what the others leave; an hour older than
  -- the window does not count.
  select account_daily_budget into v_budget from mail.settings;
  delete from mail.send_budget_hourly where account_id in (a_acc, b_acc);
  update mail.settings set account_daily_budget = (select coalesce(sum(recipients), 0) from mail.send_budget_hourly
                                                    where hour > date_trunc('hour', now()) - interval '24 hours') + 40;
  insert into mail.send_budget_hourly (hour, account_id, recipients) values
    (date_trunc('hour', now()), b_acc, 30),
    (date_trunc('hour', now()) - interval '25 hours', b_acc, 100000);
  perform pg_temp.ms_ok(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'FAILED 8: within half of what is left');
  update mail.send_budget_hourly set recipients = 5 where account_id = a_acc and hour = date_trunc('hour', now());
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]);
  perform pg_temp.ms_code(v_j, 'budget_exceeded', 'FAILED 8: past half of what is left');
  if coalesce((v_j ->> 'retryAfter')::integer, 0) not between 1 and 3600 then raise exception 'FAILED 8: %', v_j; end if;
  update mail.send_budget_hourly set recipients = 0 where account_id = a_acc and hour = date_trunc('hour', now());
  update mail.send_budget_hourly set recipients = 40 where account_id = b_acc and hour = date_trunc('hour', now());
  perform pg_temp.ms_code(pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_o]), 'budget_exceeded',
                          'FAILED 8: the budget spent');
  update mail.settings set account_daily_budget = v_budget;
  delete from mail.send_budget_hourly where account_id = b_acc;
  v_passed := v_passed + 1;

  -- ── 9. claim_sends: what is due, once, with its tenant and body; the gate
  -- asked again; paid-only skips free and sandbox accounts.
  update mail.emails set status = 'canceled' where account_id in (a_acc, b_acc) and status = 'queued';
  update mail.accounts set plan_code = 'free', state = 'active' where id = a_acc;
  v_eid := null;
  v_j := pg_temp.ms_send(a_acc, k_full, 'Acme <hello@' || n1 || '>', array[m_o]);
  v_id := (v_j ->> 'id')::uuid;
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_d]);
  v_id2 := (v_j ->> 'id')::uuid;
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_v]);
  update mail.emails set scheduled_at = now() + interval '1 hour' where public_id = (v_j ->> 'id')::uuid;
  if jsonb_array_length(pg_temp.ms_claim('m44-worker', 50, true)) <> 0 then
    raise exception 'FAILED 9: paid-only claimed a free account''s email';
  end if;
  -- The second one's recipient is suppressed after queueing: settled, not sent.
  insert into mail.suppressions (account_id, address, reason, source) values (a_acc, lower(m_d), 'complaint', 'ses');
  v_n := pg_temp.ms_used(a_acc, 'queued');
  v_j := pg_temp.ms_claim('m44-worker');
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,publicId}')::uuid is distinct from v_id
     or v_j #>> '{0,tenant}' is distinct from (select ses_tenant from mail.accounts where id = a_acc)
     or v_j #>> '{0,configurationSet}' is distinct from (select config_set from mail.accounts where id = a_acc)
     or v_j #>> '{0,html}' is distinct from '<p>Hi</p>' or v_j #>> '{0,from}' is distinct from 'Acme <hello@' || n1 || '>'
     or (v_j #>> '{0,attempt}')::integer is distinct from 1 then
    raise exception 'FAILED 9: the claim answered %', v_j;
  end if;
  v_eid := (v_j #>> '{0,id}')::bigint;
  if (select status from mail.emails where id = v_eid) <> 'sending'
     or (select status || '/' || status_reason from mail.emails where public_id = v_id2) <> 'suppressed/suppressed'
     or pg_temp.ms_used(a_acc, 'queued') <> v_n - 1 then
    raise exception 'FAILED 9: the claim did not settle the suppressed email and give back its reservation';
  end if;
  if jsonb_array_length(pg_temp.ms_claim('m44-worker')) <> 0 then
    raise exception 'FAILED 9: an email was claimed twice';
  end if;
  -- A domain unverified after queueing: failed at claim time.
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n3, array[m_o]);
  update mail.domains set status = 'failed' where id = d3;
  if jsonb_array_length(pg_temp.ms_claim('m44-worker')) <> 0
     or (select status || '/' || status_reason from mail.emails where public_id = (v_j ->> 'id')::uuid)
        <> 'failed/domain_not_verified' then
    raise exception 'FAILED 9: an unverified domain''s email was claimed';
  end if;
  update mail.domains set status = 'verified' where id = d3;
  -- A lost claim (ten minutes) is queued again and claimed again.
  update mail.emails set claimed_at = now() - interval '11 minutes' where id = v_eid;
  v_j := pg_temp.ms_claim('m44-worker-2');
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,attempt}')::integer <> 2
     or (select claimed_by from mail.emails where id = v_eid) <> 'm44-worker-2' then
    raise exception 'FAILED 9: a lost claim was not taken again: %', v_j;
  end if;
  begin
    perform mail.claim_sends('', 10, false);
    raise exception 'FAILED 9: a nameless worker claimed';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- ── 10. record_send_result: only the holder of the claim; sent, throttled,
  -- retried, failed.
  perform pg_temp.ms_code(pg_temp.ms_result(v_eid, 'm44-worker', 'sent', 'x'), 'not_claimed',
                          'FAILED 10: the old worker recorded a result');
  perform pg_temp.ms_ok(pg_temp.ms_result(v_eid, 'm44-worker-2', 'sent', 'm44-' || v_tag || '-1'), 'FAILED 10: sent');
  if (select status || '/' || ses_message_id from mail.emails where id = v_eid) <> 'sent/m44-' || v_tag || '-1'
     or (select sent_at from mail.emails where id = v_eid) is null
     or (select claimed_by from mail.emails where id = v_eid) is not null
     or pg_temp.ms_used(a_acc, 'sent') <> 1 then
    raise exception 'FAILED 10: sent was not recorded';
  end if;
  perform pg_temp.ms_code(pg_temp.ms_result(v_eid, 'm44-worker-2', 'sent', 'again'), 'not_claimed',
                          'FAILED 10: a second result');
  -- Throttled: queued again, the attempt not counted.
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_v]);
  update mail.emails set scheduled_at = now() - interval '1 minute' where account_id = a_acc and status = 'queued';
  v_j := pg_temp.ms_claim('m44-worker', 1);
  v_eid2 := (v_j #>> '{0,id}')::bigint;
  perform pg_temp.ms_ok(pg_temp.ms_result(v_eid2, 'm44-worker', 'throttled', null, 'TooManyRequestsException', 2),
                        'FAILED 10: throttled');
  if (select status from mail.emails where id = v_eid2) <> 'queued' or (select attempts from mail.emails where id = v_eid2) <> 0
     or (select next_attempt_at from mail.emails where id = v_eid2) <> now() + interval '2 seconds' then
    raise exception 'FAILED 10: throttling counted an attempt or did not wait';
  end if;
  -- Retry: queued again with a wait; at the last attempt, failed and given back.
  update mail.emails set next_attempt_at = now() where id = v_eid2;
  perform pg_temp.ms_claim('m44-worker', 5);
  perform pg_temp.ms_ok(pg_temp.ms_result(v_eid2, 'm44-worker', 'retry', null, 'no_answer'), 'FAILED 10: retry');
  if (select status from mail.emails where id = v_eid2) <> 'queued'
     or (select next_attempt_at from mail.emails where id = v_eid2) <= now() then
    raise exception 'FAILED 10: a retry did not wait';
  end if;
  update mail.emails set next_attempt_at = now(), attempts = 7 where id = v_eid2;
  perform pg_temp.ms_claim('m44-worker', 5);
  v_n := pg_temp.ms_used(a_acc, 'queued');
  perform pg_temp.ms_ok(pg_temp.ms_result(v_eid2, 'm44-worker', 'retry', null, 'no_answer'), 'FAILED 10: the last retry');
  if (select status || '/' || status_reason from mail.emails where id = v_eid2) <> 'failed/retries_exhausted'
     or pg_temp.ms_used(a_acc, 'queued') <> v_n - 1 or pg_temp.ms_used(a_acc, 'failed') < 1 then
    raise exception 'FAILED 10: the last retry did not fail and give back';
  end if;
  -- Failed for good: SES's error type, in our own words.
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_v]);
  v_j := pg_temp.ms_claim('m44-worker', 1);
  perform pg_temp.ms_ok(pg_temp.ms_result((v_j #>> '{0,id}')::bigint, 'm44-worker', 'failed', null, 'MessageRejected'),
                        'FAILED 10: failed');
  if (select status_reason from mail.emails where id = (v_j #>> '{0,id}')::bigint) <> 'messagerejected' then
    raise exception 'FAILED 10: the failure reason';
  end if;
  begin
    perform mail.record_send_result(v_eid, 'm44-worker', 'maybe');
    raise exception 'FAILED 10: an unknown outcome';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- ── 11. Events: bounced beats delivered beats sent; a late bounce wins; a
  -- complaint is recorded but is not a bounce; repeats change nothing.
  if not pg_temp.ms_event('m44-' || v_tag || '-1', null, 'send', 'k-send') then raise exception 'FAILED 11: send'; end if;
  if (select status from mail.emails where id = v_eid) <> 'sent' then raise exception 'FAILED 11: send moved the status'; end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'delivery', 'k-del');
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'delivery', 'k-del');
  if (select status from mail.emails where id = v_eid) <> 'delivered' or (select delivered_at from mail.emails where id = v_eid) is null
     or pg_temp.ms_used(a_acc, 'delivered') <> 1
     or (select count(*) from mail.email_events where email_id = v_eid and type = 'delivery') <> 1 then
    raise exception 'FAILED 11: a delivery, delivered twice, counted %', pg_temp.ms_used(a_acc, 'delivered');
  end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'delivery_delay', 'k-delay');
  if (select status from mail.emails where id = v_eid) <> 'delivered' then raise exception 'FAILED 11: a delay moved it'; end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'bounce', 'k-bounce',
                           jsonb_build_object('bounceType', 'Transient', 'diagnosticCode',
                                              'smtp; 550 5.1.1 <' || m_o || '>: no such user', 'emailAddress', m_o),
                           array[lower(m_o)]);
  -- A soft bounce moves the status, but usage counts hard bounces only (migration 53).
  if (select status from mail.emails where id = v_eid) <> 'bounced' or pg_temp.ms_used(a_acc, 'bounced') <> 0 then
    raise exception 'FAILED 11: a late bounce did not win, or a soft one was counted';
  end if;
  select detail::text into v_text from mail.email_events where email_id = v_eid and type = 'bounce';
  if v_text like '%@%' or v_text not like '%[address]%' or v_text like '%emailAddress%' then
    raise exception 'FAILED 11: the bounce detail kept an address: %', v_text;
  end if;
  if exists (select 1 from mail.suppressions where account_id = a_acc and address = lower(m_o)) then
    raise exception 'FAILED 11: a soft bounce suppressed the address';
  end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'delivery', 'k-del-2');
  perform pg_temp.ms_event('m44-' || v_tag || '-1', null, 'complaint', 'k-comp', '{}', array[lower(m_o), lower(m_x)]);
  if (select status from mail.emails where id = v_eid) <> 'bounced' or (select complained_at from mail.emails where id = v_eid) is null
     or pg_temp.ms_used(a_acc, 'complained') <> 1 then
    raise exception 'FAILED 11: a delivery or a complaint undid a bounce';
  end if;
  if not exists (select 1 from mail.suppressions where account_id = a_acc and address = lower(m_o) and reason = 'complaint')
     or exists (select 1 from mail.suppressions where account_id = a_acc and address = lower(m_x)) then
    raise exception 'FAILED 11: a complaint suppressed the wrong addresses';
  end if;
  if pg_temp.ms_event('nobody-' || v_tag, null, 'delivery', 'k-x') then raise exception 'FAILED 11: an unknown message'; end if;
  -- An event that beats record_send_result: found by our tag, its id kept, and the result keeps the status.
  delete from mail.suppressions where account_id = a_acc;
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_d]);
  v_id := (v_j ->> 'id')::uuid;
  v_j := pg_temp.ms_claim('m44-worker', 1);
  v_eid2 := (v_j #>> '{0,id}')::bigint;
  if not pg_temp.ms_event('m44-' || v_tag || '-2', v_id, 'delivery', 'k-early') then
    raise exception 'FAILED 11: an early event was not matched by its email id';
  end if;
  perform pg_temp.ms_ok(pg_temp.ms_result(v_eid2, 'm44-worker', 'sent', 'm44-' || v_tag || '-2'), 'FAILED 11: sent after its event');
  if (select status || '/' || ses_message_id from mail.emails where id = v_eid2) <> 'delivered/m44-' || v_tag || '-2' then
    raise exception 'FAILED 11: the early event was lost';
  end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-2', null, 'complaint', 'k-comp-2');
  if (select status from mail.emails where id = v_eid2) <> 'complained' then
    raise exception 'FAILED 11: a complaint after delivery';
  end if;
  perform pg_temp.ms_event('m44-' || v_tag || '-2', null, 'bounce', 'k-perm', '{"bounceType":"Permanent"}', array[lower(m_d)]);
  if (select status from mail.emails where id = v_eid2) <> 'bounced'
     or not exists (select 1 from mail.suppressions where account_id = a_acc and address = lower(m_d) and reason = 'bounce')
     or pg_temp.ms_used(a_acc, 'bounced') <> 1 then
    raise exception 'FAILED 11: a permanent bounce did not suppress';
  end if;
  begin
    perform mail.record_send_event('open', 'x');
    raise exception 'FAILED 11: an open event';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- ── 12. purge_payloads (MR3): a body goes 72 hours after sending, not before.
  update mail.emails set sent_at = now() - interval '73 hours' where id = v_eid;
  update mail.emails set sent_at = now() - interval '71 hours' where id = v_eid2;
  v_j := pg_temp.ms_send(a_acc, k_full, 'hello@' || n1, array[m_v]);
  update mail.emails set created_at = now() - interval '100 hours', updated_at = now() - interval '100 hours'
   where public_id = (v_j ->> 'id')::uuid;
  perform mail.purge_payloads();
  if exists (select 1 from mail.email_payloads where email_id = v_eid)
     or not exists (select 1 from mail.email_payloads where email_id = v_eid2)
     or not exists (select 1 from mail.email_payloads p join mail.emails e on e.id = p.email_id
                     where e.public_id = (v_j ->> 'id')::uuid) then
    raise exception 'FAILED 12: the purge took the wrong bodies';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mail-purge-payloads' and schedule = '0 * * * *') then
    raise exception 'FAILED 12: the hourly purge is not scheduled';
  end if;
  v_passed := v_passed + 1;

  -- ── 13. The key door: by hash, revoked refused, 20 at once then a wait.
  execute 'set local role service_role';
  perform pg_temp.ms_code(mail.authenticate_key(repeat('f', 64)), 'unauthorized', 'FAILED 13: an unknown hash');
  perform pg_temp.ms_code(mail.authenticate_key('mdh_live_secret'), 'unauthorized', 'FAILED 13: a raw key');
  perform pg_temp.ms_code(mail.authenticate_key(h_rev), 'unauthorized', 'FAILED 13: a revoked key');
  v_j := mail.authenticate_key(h_b);
  if (v_j ->> 'accountId')::uuid is distinct from b_acc or v_j ->> 'permission' <> 'full' then
    raise exception 'FAILED 13: the key answered %', v_j;
  end if;
  for i in 2..20 loop
    perform pg_temp.ms_ok(mail.authenticate_key(h_b), 'FAILED 13: call ' || i || ' of a burst of 20');
  end loop;
  v_j := mail.authenticate_key(h_b);
  execute 'reset role';
  perform pg_temp.ms_code(v_j, 'rate_limited', 'FAILED 13: the 21st call');
  if coalesce((v_j ->> 'retryAfterMs')::integer, 0) not between 1 and 1000
     or (select last_used_at from mail.api_keys where id = k_b) is null then
    raise exception 'FAILED 13: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 14. get_email: the account's own, without a body.
  execute 'set local role service_role';
  v_j := mail.get_email(a_acc, v_id);
  v_j2 := mail.get_email(b_acc, v_id);
  execute 'reset role';
  if v_j ->> 'status' is distinct from 'bounced' or v_j ? 'html' or v_j ? 'text' or v_j ->> 'last_event' <> 'bounce'
     or v_j2 is not null then
    raise exception 'FAILED 14: get_email answered % and %', v_j, v_j2;
  end if;
  v_passed := v_passed + 1;

  -- ── 15. RLS by role: members read the log, developers the bodies, viewers
  -- not the bodies, strangers nothing; nobody reads the budget.
  perform pg_temp.ms_as(u_v);
  select count(*) into v_n from mail.emails;
  select count(*) into v_m from mail.email_payloads;
  if v_n < 5 or v_m <> 0 or not exists (select 1 from mail.email_events) or not exists (select 1 from mail.usage_daily) then
    raise exception 'FAILED 15: a viewer reads % emails, % bodies', v_n, v_m;
  end if;
  perform pg_temp.ms_as(u_d);
  select count(*) into v_m from mail.email_payloads;
  if v_m < 1 then raise exception 'FAILED 15: a developer reads no bodies'; end if;
  perform pg_temp.ms_as(u_n);
  if exists (select 1 from mail.emails) or exists (select 1 from mail.email_payloads)
     or exists (select 1 from mail.email_events) or exists (select 1 from mail.suppressions)
     or exists (select 1 from mail.usage_daily) then
    raise exception 'FAILED 15: a stranger reads an account''s email';
  end if;
  begin
    perform 1 from mail.send_budget_hourly;
    raise exception 'FAILED 15: the budget is readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.enqueue_email(a_acc, k_full, '{}', '{}');
    raise exception 'FAILED 15: a signed-in person queued an email directly';
  exception when insufficient_privilege then null;
  end;
  begin
    select request_hash into v_text from mail.emails limit 1;
    raise exception 'FAILED 15: the request hash is readable';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 16. Every function in schema mail (migrations 43–56), granted to exactly the role it names.
  -- 47, 48, 50 and 51's names are as the hosted project holds them (6 Oct 2026); their packages'
  -- own maps are reconciled with this one at merge. Migration 54 adds note_claim_failure (a
  -- trigger) and billing_return_allowed, and replaces reserve_send, webhook_for_caller and five
  -- webhook functions under new signatures: still one function a name, so the count holds.
  -- Migration 57 adds start_dns_setup; 58 the notification emails' functions; 68 import_suppressions.
  -- Migration 55 adds e2e_set_period_end. Migration 56 adds begin_billing_jobs and
  -- kick_billing_jobs, and replaces record_billing_charge and alert_conditions under their
  -- own signatures.
  v_expected := '{
    "settings_stay":"none", "append_only":"none", "has_role":"authenticated",
    "create_account":"authenticated", "create_api_key":"authenticated", "revoke_api_key":"authenticated",
    "address_of":"none", "text_array":"none", "is_mailbox":"none", "lagos_day":"none", "bump_usage":"none",
    "sanitise_detail":"none", "effective_caps":"none", "release_reservation":"none", "reserve_send":"none",
    "settle_unsent":"none", "send_gate":"none", "purge_payloads":"none", "purge_send_budget":"none",
    "enqueue_email":"service_role", "authenticate_key":"service_role", "get_email":"service_role",
    "claim_sends":"service_role", "record_send_result":"service_role", "record_send_event":"service_role",
    "is_e2e_account":"none", "e2e_ready_account":"service_role", "e2e_purge_account":"service_role",
    "caller_role":"none", "seats_taken":"none", "is_invite_email":"none",
    "account_usage":"authenticated", "account_members":"authenticated",
    "update_account_profile":"authenticated", "create_invite":"authenticated",
    "revoke_invite":"authenticated", "invite_preview":"authenticated", "accept_invite":"authenticated",
    "change_member_role":"authenticated", "remove_member":"authenticated", "leave_account":"authenticated",
    "transfer_ownership":"authenticated", "e2e_set_plan":"service_role",
    "recipient_addresses":"none", "as_timestamptz":"none", "utc_text":"none", "email_view":"none",
    "email_page":"none", "is_full_key":"none", "enqueue_batch":"service_role", "list_emails":"service_role",
    "account_emails":"authenticated", "reschedule_email":"service_role", "cancel_email":"service_role",
    "api_list_keys":"service_role", "api_create_key":"service_role", "api_revoke_key":"service_role",
    "billing_settings_stay":"none", "billing_rows_are_final":"none", "billing_payment_record":"none",
    "billing_keep_record_only":"none", "billing_vat":"none", "billing_period_end":"none",
    "billing_note":"none", "billing_quote":"none", "billing_issue_invoice":"none", "billing_unapplied":"none",
    "billing_sweep":"none", "billing_overview":"authenticated", "start_checkout":"authenticated",
    "schedule_plan_change":"authenticated", "keep_current_plan":"authenticated",
    "flutterwave_plan_for":"service_role", "register_flutterwave_plan":"service_role",
    "billing_provider_state":"service_role", "note_provider_canceled":"service_role",
    "note_provider_active":"service_role", "record_billing_incident":"service_role",
    "record_billing_charge":"service_role", "domain_name_ok":"none", "is_reserved_domain":"none",
    "clean_error":"none", "is_test_account":"none", "on_jobs_side":"none", "kick_ses_jobs":"none",
    "provisioning_on_account":"none", "sandbox_on_state":"none", "sandbox_domain_for":"none",
    "add_domain":"authenticated", "retry_domain":"authenticated", "remove_domain":"authenticated",
    "begin_ses_jobs":"service_role", "record_sandbox_identity":"service_role",
    "claim_provisioning_work":"service_role", "record_provisioning":"service_role",
    "record_provisioning_error":"service_role", "claim_domain_work":"service_role",
    "record_domain_step":"service_role", "record_domain_check":"service_role",
    "record_domain_failed":"service_role", "record_domain_released":"service_role",
    "record_domain_error":"service_role", "domain_view":"none", "domain_api_key":"none",
    "claim_domain_name":"none", "request_domain_removal":"none", "api_list_domains":"service_role",
    "api_get_domain":"service_role", "api_add_domain":"service_role", "api_remove_domain":"service_role",
    "iso_time":"none", "is_webhook_url":"none", "webhook_event_list":"none", "is_sealed_secret":"none",
    "email_webhook_data":"none", "queue_webhook_event":"none", "webhook_on_email_failed":"none",
    "webhook_on_domain_status":"none", "record_tenant_event":"service_role", "create_webhook":"authenticated",
    "webhook_for_caller":"none", "update_webhook":"authenticated", "set_webhook_enabled":"authenticated",
    "rotate_webhook_secret":"authenticated", "delete_webhook":"authenticated",
    "resend_webhook_delivery":"authenticated", "remove_suppression":"authenticated",
    "claim_webhook_deliveries":"service_role", "record_webhook_attempt":"service_role",
    "purge_webhook_deliveries":"none", "advance_warmup":"none", "alert_conditions":"none",
    "asked_ses_to_pause":"none", "claim_tenant_actions":"service_role", "e2e_evaluate":"service_role",
    "e2e_seed_usage":"service_role", "evaluate_account":"none", "note_cap_use":"none", "open_finding":"none",
    "ppm_text":"none", "profile_complete":"none", "purge_old_emails":"none", "purge_safety_records":"none",
    "queue_tenant_action":"none", "rate_ppm":"none", "record_tenant_action":"service_role",
    "run_safety_checks":"service_role", "ses_findings_of":"none", "window_usage":"none",
    "note_claim_failure":"none", "billing_return_allowed":"service_role",
    "e2e_set_period_end":"service_role", "begin_billing_jobs":"service_role", "kick_billing_jobs":"none",
    "start_dns_setup":"authenticated", "notify_members":"none", "email_cap_notice":"none",
    "email_from_audit":"none", "webhook_host":"none", "email_safety_warning":"none",
    "email_ses_finding":"none", "email_invite":"authenticated", "import_suppressions":"authenticated"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p where p.pronamespace = 'mail'::regnamespace loop
    v_want := v_expected ->> v_row.proname;
    if v_want is null then raise exception 'FAILED 16: mail.% has no expected grant', v_row.proname; end if;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 16: mail.% is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 16: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 16: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  for v_row in select c.oid, c.relname from pg_class c where c.relnamespace = 'mail'::regnamespace and c.relkind = 'r' loop
    if has_table_privilege('anon', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', v_row.oid, 'select, insert, update, delete, truncate') then
      raise exception 'FAILED 16: mail.% is open to an API role', v_row.relname;
    end if;
  end loop;
  v_passed := v_passed + 1;

  raise notice 'migration 44: % checks passed', v_passed;
end;
$$;

rollback;
