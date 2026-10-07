-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 54 (MyDomainsHub Mail, follow-ups), tried as the database owner
-- and, where the grant is the point, as `authenticated` and `service_role`:
-- what members read of an account, webhook ports and the account an endpoint
-- belongs to, the API-key cap, domain claims (cool-down, the failed-claims
-- cap, parents and children, an identity we did not make, DKIM before
-- verified), reservations at the send moment (caps and the shared budget,
-- rescheduling), SES's pause in our own gate, stray charges and paying a
-- past-due plan, the payment redirect's limits, the two new alerts and the
-- admin's incidents, and every grant. People, admins and accounts are made up
-- inside the transaction with e2e-*@example.com addresses; only test payments
-- are recorded; nothing is sent and no AWS API is called. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_followups.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.mf_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

-- Claims for an admin's session (as admin.sql and mail_safety.sql make them).
create function pg_temp.mf_admin(p_uid uuid, p_sid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 minute')::bigint)))::text,
    true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.mf_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.mf_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

create function pg_temp.mf_outcome(p_j jsonb, p_outcome text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true or (p_j ->> 'outcome') is distinct from p_outcome then
    raise exception '% (expected %, got %)', p_what, p_outcome, p_j;
  end if;
end $f$;

-- A statement run as service_role, its jsonb answer back.
create function pg_temp.mf_service(p_sql text) returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v_j;
  execute 'reset role';
  return v_j;
end $f$;

-- POST /emails as the API makes it: p_n recipients, at p_at (null: now).
create function pg_temp.mf_send(p_account uuid, p_from text, p_n integer, p_at timestamptz, p_tag text)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_email(p_account, null,
           jsonb_build_object('from', p_from,
                              'to', (select jsonb_agg(p_tag || '-' || g || '@example.com') from generate_series(1, p_n) g),
                              'subject', 'm54 ' || p_tag)
           || case when p_at is null then '{}'::jsonb else jsonb_build_object('scheduled_at', p_at) end,
           '{"text":"Hi"}');
  execute 'reset role';
  return v_j;
end $f$;

-- What Flutterwave said about a charge, recorded as the app records it (service key).
create function pg_temp.mf_charge(p_tx text, p_ref text, p_status text, p_kobo bigint) returns jsonb
language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.record_billing_charge(true, p_tx, p_ref, p_status, p_kobo, 'NGN', 'card', '4242', 'visa',
                                    jsonb_build_object('id', p_tx::bigint, 'tx_ref', p_ref, 'status', p_status));
  execute 'reset role';
  return v_j;
end $f$;

-- The number in the webhook backlog alert, or 0 when there is none.
create function pg_temp.mf_backlog() returns integer language sql as $f$
  select coalesce((select substring(c.summary from 'Mail: (\d+) webhook')::integer
                     from mail.alert_conditions() c where c.key = 'mail_webhook_backlog'), 0)
$f$;

do $$
declare
  v_tag     text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o       uuid := gen_random_uuid();   -- owner of A and of C: A and C share a member
  u_x       uuid := gen_random_uuid();   -- owner of B, a stranger to A
  u_s       uuid := gen_random_uuid();   -- owner of S, scheduling
  u_bl      uuid := gen_random_uuid();   -- owner of BL, billing (an e2e account)
  u_ad      uuid := gen_random_uuid();   -- an owner admin
  u_ta      uuid := gen_random_uuid();   -- a test-only admin
  f_ad      uuid := gen_random_uuid();
  f_ta      uuid := gen_random_uuid();
  s_ad      uuid := gen_random_uuid();
  s_ta      uuid := gen_random_uuid();
  m_o       text;
  a_acc     uuid;
  b_acc     uuid;
  c_acc     uuid;
  s_acc     uuid;
  p_acc     uuid;
  bl_acc    uuid;
  tp_acc    uuid;
  tq_acc    uuid;
  d_id      uuid;
  w_c       uuid;
  w_a       uuid;
  k1        uuid;
  v_id      bigint;
  v_id2     bigint;
  v_pub     uuid;
  v_j       jsonb;
  v_c1      jsonb;
  v_c2      jsonb;
  v_n       integer;
  v_n0      integer;
  v_t       timestamptz;
  v_until   timestamptz;
  v_end     timestamptz;
  v_text    text;
  v_sub     mail.subscriptions;
  v_tx      bigint := 890000000000 + floor(random() * 100000000)::bigint;
  fw        bigint := 78000000 + floor(random() * 1000000)::bigint;
  v_tenant  text;
  v_from    text;
  v_passed  integer := 0;
begin
  m_o := 'e2e-mf-o-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), '{}', now(), now()),
    (u_x, 'authenticated', 'authenticated', 'e2e-mf-x-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_s, 'authenticated', 'authenticated', 'e2e-mf-s-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_bl, 'authenticated', 'authenticated', 'e2e-mf-bl-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_ad, 'authenticated', 'authenticated', 'e2e-mf-ad-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_ta, 'authenticated', 'authenticated', 'e2e-mf-ta-' || v_tag || '@example.com', now(), '{}', now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_ad, u_ad, 'm54', 'totp', 'verified', now(), now(), 'x'),
    (f_ta, u_ta, 'm54', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_ad, u_ad, now(), now(), f_ad, 'aal2'),
    (s_ta, u_ta, now(), now(), f_ta, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
  values (u_ad, 'm54-owner-' || v_tag, 'owner', array[f_ad], 'm54-check');
  perform public.grant_test_admin(u_ta);

  perform pg_temp.mf_as(u_o);
  a_acc := (mail.create_account('m54 A ' || v_tag) ->> 'accountId')::uuid;
  c_acc := (mail.create_account('m54 C ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mf_as(u_x);
  b_acc := (mail.create_account('m54 B ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mf_as(u_s);
  s_acc := (mail.create_account('m54 S ' || v_tag) ->> 'accountId')::uuid;
  p_acc := (mail.create_account('m54 P ' || v_tag) ->> 'accountId')::uuid;
  tp_acc := (mail.create_account('m54 TP ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mf_as(u_bl);
  bl_acc := (mail.create_account('m54 BL ' || v_tag, 'https://bl.example', 'Receipts', 1000) ->> 'accountId')::uuid;
  tq_acc := (mail.create_account('m54 TQ ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  if a_acc is null or b_acc is null or c_acc is null or s_acc is null or p_acc is null or bl_acc is null
     or tp_acc is null or tq_acc is null then
    raise exception 'SETUP: an account was not created';
  end if;
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled', plan_code = 'pro'
   where id in (a_acc, b_acc, c_acc, s_acc, p_acc, tp_acc, tq_acc);
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled' where id = bl_acc;

  -- ── 1. Members read their account, but never the admin's label (review 20).
  update mail.accounts set reviewed_by = 'm54-admin-label', reviewed_at = now() where id = a_acc;
  perform pg_temp.mf_as(u_o);
  select name into v_text from mail.accounts where id = a_acc;
  if v_text <> 'm54 A ' || v_tag then raise exception 'FAILED 1: a member cannot read the account''s name'; end if;
  perform 1 from mail.accounts
   where id = a_acc and state is not null and short_id is not null and ses_tenant is not null
     and reviewed_at is not null and is_e2e is not null and pre_pause_state is null;
  begin
    perform reviewed_by from mail.accounts where id = a_acc;
    raise exception 'FAILED 1: a member read reviewed_by';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from mail.accounts where id = a_acc;
    raise exception 'FAILED 1: select * still reads every column';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  if has_column_privilege('authenticated', 'mail.accounts', 'reviewed_by', 'select')
     or not has_column_privilege('authenticated', 'mail.accounts', 'state_reason', 'select')
     or has_table_privilege('anon', 'mail.accounts', 'select') then
    raise exception 'FAILED 1: the accounts grants are wrong';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Webhook ports: 443 or 8443 only (review 16).
  if not mail.is_webhook_url('https://hooks.acme.example/in')
     or not mail.is_webhook_url('https://hooks.acme.example:443/in')
     or not mail.is_webhook_url('https://hooks.acme.example:8443/in')
     or not mail.is_webhook_url('https://8.8.8.8:8443/in') then
    raise exception 'FAILED 2: 443 or 8443 was refused';
  end if;
  if mail.is_webhook_url('https://hooks.acme.example:22/in') or mail.is_webhook_url('https://hooks.acme.example:80/in')
     or mail.is_webhook_url('https://hooks.acme.example:8080/in') or mail.is_webhook_url('https://8.8.8.8:6379/in')
     or mail.is_webhook_url('https://hooks.acme.example:65535/in') then
    raise exception 'FAILED 2: another port was accepted';
  end if;
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_code(mail.create_webhook(a_acc, 'https://hooks.acme.example:25/in', array['email.sent'],
                                              'v1.' || repeat('A', 16) || '.' || repeat('B', 48), 'whsec_abcd'),
                          'validation', 'FAILED 2: an endpoint on port 25 was made');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 3. An endpoint is changed only within its own account (review 15): a
  -- member of A and C names A for C's endpoint and is told it is not there.
  perform pg_temp.mf_as(u_o);
  w_c := (mail.create_webhook(c_acc, 'https://hooks.c.example/in', array['email.delivered'],
                              'v1.' || repeat('C', 16) || '.' || repeat('D', 48), 'whsec_cccc') ->> 'webhookId')::uuid;
  w_a := (mail.create_webhook(a_acc, 'https://hooks.a.example/in', array['email.delivered'],
                              'v1.' || repeat('E', 16) || '.' || repeat('F', 48), 'whsec_aaaa') ->> 'webhookId')::uuid;
  execute 'reset role';
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, status, give_up_at,
                                       attempts, delivered_at)
  values (w_c, c_acc, 'msg_' || replace(gen_random_uuid()::text, '-', ''), 'email.delivered',
          '{"type":"email.delivered"}', 'delivered', now() + interval '1 day', 1, now())
  returning id into v_id;
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_code(mail.rotate_webhook_secret(a_acc, w_c, 'v1.' || repeat('G', 16) || '.' || repeat('H', 48),
                                                     'whsec_gggg'), 'not_found', 'FAILED 3: rotate across accounts');
  perform pg_temp.mf_code(mail.update_webhook(a_acc, w_c, 'https://hooks.c.example/x', array['email.sent']),
                          'not_found', 'FAILED 3: update across accounts');
  perform pg_temp.mf_code(mail.set_webhook_enabled(a_acc, w_c, false), 'not_found', 'FAILED 3: turn off across accounts');
  perform pg_temp.mf_code(mail.resend_webhook_delivery(a_acc, v_id), 'not_found', 'FAILED 3: resend across accounts');
  perform pg_temp.mf_code(mail.delete_webhook(a_acc, w_c), 'not_found', 'FAILED 3: delete across accounts');
  perform pg_temp.mf_ok(mail.rotate_webhook_secret(c_acc, w_c, 'v1.' || repeat('G', 16) || '.' || repeat('H', 48),
                                                   'whsec_gggg'), 'FAILED 3: rotate in its own account');
  perform pg_temp.mf_ok(mail.resend_webhook_delivery(c_acc, v_id), 'FAILED 3: resend in its own account');
  execute 'reset role';
  if (select secret_hint from mail.webhooks where id = w_c) <> 'whsec_gggg'
     or not exists (select 1 from mail.webhooks where id = w_c and status = 'enabled') then
    raise exception 'FAILED 3: the endpoint is not as its own account left it';
  end if;
  foreach v_text in array array['mail.update_webhook(uuid, text, text[], text)', 'mail.set_webhook_enabled(uuid, boolean)',
                                'mail.rotate_webhook_secret(uuid, text, text)', 'mail.delete_webhook(uuid)',
                                'mail.resend_webhook_delivery(bigint)', 'mail.webhook_for_caller(uuid)',
                                'mail.reserve_send(uuid, uuid, text, text[])'] loop
    if to_regprocedure(v_text) is not null then
      raise exception 'FAILED 3: the old % is still there', v_text;
    end if;
  end loop;
  v_passed := v_passed + 1;

  -- ── 4. Live API keys, at most api_keys_max an account (review 13).
  update mail.settings set api_keys_max = 2;
  perform pg_temp.mf_as(u_o);
  v_j := mail.create_api_key(a_acc, 'k1', 'full', 'mdh_live_aa' || left(v_tag, 2), md5('1' || v_tag) || md5('2' || v_tag));
  perform pg_temp.mf_ok(v_j, 'FAILED 4: the first key');
  k1 := (v_j ->> 'keyId')::uuid;
  perform pg_temp.mf_ok(mail.create_api_key(a_acc, 'k2', 'sending', 'mdh_live_bb' || left(v_tag, 2),
                                            md5('3' || v_tag) || md5('4' || v_tag)), 'FAILED 4: the second key');
  v_j := mail.create_api_key(a_acc, 'k3', 'sending', 'mdh_live_cc' || left(v_tag, 2), md5('5' || v_tag) || md5('6' || v_tag));
  perform pg_temp.mf_code(v_j, 'key_limit', 'FAILED 4: a third key past the cap');
  if (v_j ->> 'max')::integer <> 2 then raise exception 'FAILED 4: the cap answered %', v_j; end if;
  execute 'reset role';
  v_j := pg_temp.mf_service(format(
    'select mail.api_create_key(%L, %L, %L, %L, %L, %L)', a_acc, k1, 'k4', 'sending', 'mdh_live_dd' || left(v_tag, 2),
    md5('7' || v_tag) || md5('8' || v_tag)));
  perform pg_temp.mf_code(v_j, 'key_limit', 'FAILED 4: a key over the API past the cap');
  update mail.api_keys set revoked_at = now() where account_id = a_acc and name = 'k2';
  perform pg_temp.mf_ok(pg_temp.mf_service(format(
    'select mail.api_create_key(%L, %L, %L, %L, %L, %L)', a_acc, k1, 'k4', 'sending', 'mdh_live_dd' || left(v_tag, 2),
    md5('7' || v_tag) || md5('8' || v_tag))), 'FAILED 4: a revoked key frees its place');
  update mail.settings set api_keys_max = 50;
  v_passed := v_passed + 1;

  -- ── 5. A claim that did not prove its name: the name waits (review 10).
  perform pg_temp.mf_as(u_o);
  v_j := mail.add_domain(a_acc, 'fc-' || v_tag || '.example');
  perform pg_temp.mf_ok(v_j, 'FAILED 5: the first claim');
  d_id := (v_j ->> 'domainId')::uuid;
  execute 'reset role';
  update mail.domains set status = 'failed', failed_reason = 'dkim_record_missing' where id = d_id;
  update mail.domains set released_at = now() where id = d_id;
  if not exists (select 1 from mail.domain_claim_failures
                  where account_id = a_acc and name = 'fc-' || v_tag || '.example' and reason = 'dkim_record_missing') then
    raise exception 'FAILED 5: the failed claim was not written down';
  end if;
  perform pg_temp.mf_as(u_o);
  v_j := mail.add_domain(a_acc, 'fc-' || v_tag || '.example');
  perform pg_temp.mf_code(v_j, 'claim_cooldown', 'FAILED 5: the same account claimed it again at once');
  if (v_j ->> 'until')::timestamptz <> now() + interval '7 days' then
    raise exception 'FAILED 5: the cool-down ends at %', v_j ->> 'until';
  end if;
  perform pg_temp.mf_code(mail.retry_domain(d_id), 'claim_cooldown', 'FAILED 5: a retry at once');
  -- C shares a member with A: the same wait.
  perform pg_temp.mf_code(mail.add_domain(c_acc, 'fc-' || v_tag || '.example'), 'claim_cooldown',
                          'FAILED 5: an account sharing a member claimed it at once');
  -- Removed while pending: the same wait, but not a failure for the cap.
  v_j := mail.add_domain(a_acc, 'rm-' || v_tag || '.example');
  perform pg_temp.mf_ok(v_j, 'FAILED 5: a claim to remove');
  perform pg_temp.mf_ok(mail.remove_domain((v_j ->> 'domainId')::uuid), 'FAILED 5: removing a pending claim');
  execute 'reset role';
  update mail.domains set status = 'removed', removed_at = now(), released_at = now()
   where id = (v_j ->> 'domainId')::uuid;
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_code(mail.add_domain(a_acc, 'rm-' || v_tag || '.example'), 'claim_cooldown',
                          'FAILED 5: a name let go unverified claimed again at once');
  -- Someone else is free to claim either name.
  perform pg_temp.mf_as(u_x);
  perform pg_temp.mf_ok(mail.add_domain(b_acc, 'fc-' || v_tag || '.example'), 'FAILED 5: a stranger was kept waiting');
  execute 'reset role';
  -- After the cool-down, A may try again.
  update mail.domain_claim_failures set failed_at = now() - interval '8 days'
   where account_id = a_acc and name = 'rm-' || v_tag || '.example';
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_ok(mail.add_domain(a_acc, 'rm-' || v_tag || '.example'), 'FAILED 5: claimed after the cool-down');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 6. At most domain_failed_claims_max failed claims in the window (review 10).
  update mail.settings set domain_failed_claims_max = 2;
  perform pg_temp.mf_as(u_o);
  v_j := mail.add_domain(a_acc, 'fc2-' || v_tag || '.example');
  perform pg_temp.mf_ok(v_j, 'FAILED 6: a second claim');
  execute 'reset role';
  update mail.domains set status = 'failed', failed_reason = 'dkim_not_verified', released_at = now()
   where id = (v_j ->> 'domainId')::uuid;
  perform pg_temp.mf_as(u_o);
  v_j := mail.add_domain(a_acc, 'new-' || v_tag || '.example');
  perform pg_temp.mf_code(v_j, 'too_many_failed_claims', 'FAILED 6: a claim past the failed-claims cap');
  if (v_j ->> 'max')::integer <> 2 or (v_j ->> 'windowDays')::integer <> 30
     or (v_j ->> 'until')::timestamptz <> now() + interval '30 days' then
    raise exception 'FAILED 6: the cap answered %', v_j;
  end if;
  execute 'reset role';
  update mail.settings set domain_failed_claims_max = 5;
  v_passed := v_passed + 1;

  -- ── 7. Never under, or above, another account's live claim (review 11).
  perform pg_temp.mf_as(u_x);
  perform pg_temp.mf_ok(mail.add_domain(b_acc, 'pc-' || v_tag || '.example'), 'FAILED 7: B''s claim');
  perform pg_temp.mf_ok(mail.add_domain(b_acc, 'sub.pc-' || v_tag || '.example'),
                        'FAILED 7: a child of B''s own claim');
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_code(mail.add_domain(a_acc, 'mail.pc-' || v_tag || '.example'), 'related_in_use',
                          'FAILED 7: a child of another account''s claim');
  perform pg_temp.mf_code(mail.add_domain(a_acc, 'x.y.pc-' || v_tag || '.example'), 'related_in_use',
                          'FAILED 7: a grandchild of another account''s claim');
  perform pg_temp.mf_ok(mail.add_domain(a_acc, 'deep.zz-' || v_tag || '.example'), 'FAILED 7: A''s child name');
  perform pg_temp.mf_as(u_x);
  perform pg_temp.mf_code(mail.add_domain(b_acc, 'zz-' || v_tag || '.example'), 'related_in_use',
                          'FAILED 7: a parent of another account''s claim');
  perform pg_temp.mf_ok(mail.add_domain(b_acc, 'zzz-' || v_tag || '.example'), 'FAILED 7: a name that only ends alike');
  execute 'reset role';
  -- Released, B's parent no longer stands in A's way; B's live child still does.
  update mail.domains set status = 'failed', failed_reason = 'not_set_up', released_at = now()
   where account_id = b_acc and name = 'pc-' || v_tag || '.example';
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_ok(mail.add_domain(a_acc, 'mail.pc-' || v_tag || '.example'),
                        'FAILED 7: a child once the parent was released');
  perform pg_temp.mf_code(mail.add_domain(a_acc, 'pc-' || v_tag || '.example'), 'related_in_use',
                          'FAILED 7: a parent of B''s live child');
  execute 'reset role';
  -- Ours stays ours: nothing at or under mydomainshub.com.
  perform pg_temp.mf_as(u_o);
  perform pg_temp.mf_code(mail.add_domain(a_acc, 'x.mydomainshub.com'), 'reserved', 'FAILED 7: a reserved name');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 8. An identity this claim did not make fails the claim (review 12), and
  -- verified needs DKIM's SUCCESS (review 19).
  insert into mail.domains (account_id, name, status) values (a_acc, 'ie-' || v_tag || '.example', 'pending')
  returning id into d_id;
  update mail.domains set locked_by = 'm54-worker', locked_until = now() + interval '2 minutes' where id = d_id;
  v_j := pg_temp.mf_service(format('select mail.record_domain_failed(%L, %L, %L, null)', d_id, 'm54-worker',
                                   'ses_identity_exists'));
  perform pg_temp.mf_ok(v_j, 'FAILED 8: ses_identity_exists');
  if (select status || '/' || failed_reason from mail.domains where id = d_id) <> 'failed/ses_identity_exists'
     or not exists (select 1 from mail.domain_claim_failures where domain_id = d_id and reason = 'ses_identity_exists') then
    raise exception 'FAILED 8: the claim did not fail as ses_identity_exists';
  end if;
  insert into mail.domains (account_id, name, status, identity_created_at, mail_from_set_at, config_set_at,
                            tenant_associated_at)
  values (a_acc, 'dk-' || v_tag || '.example', 'pending', now(), now(), now(), now())
  returning id into d_id;
  update mail.domains set locked_by = 'm54-worker', locked_until = now() + interval '2 minutes' where id = d_id;
  v_j := pg_temp.mf_service(format('select mail.record_domain_check(%L, %L, %L::jsonb)', d_id, 'm54-worker',
    jsonb_build_object('found', true, 'verifiedForSending', true, 'verificationStatus', 'SUCCESS',
                       'dkimStatus', 'PENDING', 'dkimTokens', jsonb_build_array(repeat('a', 32)),
                       'mailFromStatus', 'SUCCESS')));
  if v_j ->> 'status' <> 'pending' then
    raise exception 'FAILED 8: verified without DKIM: %', v_j;
  end if;
  update mail.domains set locked_by = 'm54-worker', locked_until = now() + interval '2 minutes' where id = d_id;
  v_j := pg_temp.mf_service(format('select mail.record_domain_check(%L, %L, %L::jsonb)', d_id, 'm54-worker',
    jsonb_build_object('found', true, 'verifiedForSending', true, 'verificationStatus', 'SUCCESS',
                       'dkimStatus', 'SUCCESS', 'dkimTokens', jsonb_build_array(repeat('a', 32)),
                       'mailFromStatus', 'SUCCESS')));
  if v_j ->> 'status' <> 'verified' then
    raise exception 'FAILED 8: not verified with DKIM: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 9. Reservations at the send moment (review 17): three days of a full
  -- cap scheduled for one moment — one day's is taken, the rest refused.
  update mail.accounts set state = 'active', warmup_day = null, daily_cap_override = 10, monthly_cap_override = 1000
   where id = s_acc;
  insert into mail.domains (account_id, name, status, verified_at) values (s_acc, 'ms-' || v_tag || '.example', 'verified', now());
  v_from := 'hello@ms-' || v_tag || '.example';
  v_t := now() + interval '48 hours';
  perform pg_temp.mf_ok(pg_temp.mf_send(s_acc, v_from, 10, v_t, 'd1'), 'FAILED 9: a full day''s cap for the moment');
  perform pg_temp.mf_code(pg_temp.mf_send(s_acc, v_from, 10, v_t, 'd2'), 'quota_exceeded',
                          'FAILED 9: a second day''s cap for the same moment');
  v_j := pg_temp.mf_send(s_acc, v_from, 10, v_t, 'd3');
  perform pg_temp.mf_code(v_j, 'quota_exceeded', 'FAILED 9: a third day''s cap for the same moment');
  if v_j ->> 'scope' <> 'day' then raise exception 'FAILED 9: refused for %', v_j; end if;
  if (select queued from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(v_t)) <> 10
     or exists (select 1 from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(now()) and queued > 0) then
    raise exception 'FAILED 9: the reservation is not on the send moment''s day';
  end if;
  -- Today's own cap is untouched by tomorrow's: a full one now still goes.
  v_j := pg_temp.mf_send(s_acc, v_from, 10, null, 'now');
  perform pg_temp.mf_ok(v_j, 'FAILED 9: today''s cap');
  v_pub := (v_j ->> 'id')::uuid;
  -- Moving today's email onto the full day is refused, and it keeps its place.
  v_j := pg_temp.mf_service(format('select mail.reschedule_email(%L, %L, %L)', s_acc, v_pub, v_t));
  perform pg_temp.mf_code(v_j, 'quota_exceeded', 'FAILED 9: rescheduled onto a full day');
  if (select reserved_on from mail.emails where public_id = v_pub) <> mail.lagos_day(now())
     or (select queued from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(now())) <> 10
     or (select queued from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(v_t)) <> 10
     or (select scheduled_at from mail.emails where public_id = v_pub) > now() + interval '1 minute' then
    raise exception 'FAILED 9: a refused reschedule moved the reservation';
  end if;
  -- Onto a free day: the reservation moves with it.
  perform pg_temp.mf_ok(pg_temp.mf_service(format('select mail.reschedule_email(%L, %L, %L)', s_acc, v_pub,
                                                  v_t + interval '24 hours')), 'FAILED 9: rescheduled onto a free day');
  if (select reserved_on from mail.emails where public_id = v_pub) <> mail.lagos_day(v_t + interval '24 hours')
     or coalesce((select queued from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(now())), 0) <> 0
     or (select queued from mail.usage_daily where account_id = s_acc and day = mail.lagos_day(v_t + interval '24 hours')) <> 10 then
    raise exception 'FAILED 9: the reschedule left its reservation behind';
  end if;
  v_passed := v_passed + 1;

  -- ── 10. The shared budget holds in every 24-hour window around the send
  -- hour (review 17). The hours' table is emptied inside this transaction.
  delete from mail.send_budget_hourly;
  update mail.settings set account_daily_budget = 40;
  update mail.accounts set state = 'active', warmup_day = null, daily_cap_override = 1000, monthly_cap_override = 10000
   where id = p_acc;
  insert into mail.domains (account_id, name, status, verified_at) values (p_acc, 'mp-' || v_tag || '.example', 'verified', now());
  v_from := 'hello@mp-' || v_tag || '.example';
  perform pg_temp.mf_ok(pg_temp.mf_send(p_acc, v_from, 20, null, 'b0'), 'FAILED 10: half the budget now');
  perform pg_temp.mf_ok(pg_temp.mf_send(p_acc, v_from, 1, now() + interval '30 hours', 'b30'),
                        'FAILED 10: a day and more later, in windows of its own');
  perform pg_temp.mf_code(pg_temp.mf_send(p_acc, v_from, 1, now() + interval '10 hours', 'b10'), 'budget_exceeded',
                          'FAILED 10: ten hours on, inside a window holding today''s half');
  perform pg_temp.mf_code(pg_temp.mf_send(p_acc, v_from, 1, null, 'b00'), 'budget_exceeded',
                          'FAILED 10: more than half now');
  update mail.settings set account_daily_budget = 49000;
  v_passed := v_passed + 1;

  -- ── 11. SES's pause holds our own gate; its ENABLED does not lift it (review 18, MR5).
  update mail.accounts set state = 'active', warmup_day = null where id in (tp_acc, tq_acc);
  insert into mail.domains (account_id, name, status, verified_at) values (tp_acc, 'tp-' || v_tag || '.example', 'verified', now());
  select ses_tenant into v_tenant from mail.accounts where id = tp_acc;
  v_j := pg_temp.mf_service(format(
    'select mail.record_tenant_event(%L, %L, %L, null, null, %L, %L, %L)', 'm54-ev1-' || v_tag, 'sending_status',
    v_tenant, now(), 'DISABLED', 'AWS_MANAGED'));
  perform pg_temp.mf_ok(v_j, 'FAILED 11: the pause event');
  if (select state || '/' || pre_pause_state || '/' || state_reason || '/' || ses_status from mail.accounts where id = tp_acc)
       <> 'paused/active/paused_by_ses/disabled'
     or not exists (select 1 from mail.safety_findings where account_id = tp_acc and source = 'ses'
                     and kind = 'ses_paused' and severity = 'pause' and resolved_at is null) then
    raise exception 'FAILED 11: AWS''s pause did not pause the account';
  end if;
  v_j := pg_temp.mf_service(format(
    'select mail.record_tenant_event(%L, %L, %L, null, null, %L, %L, %L)', 'm54-ev2-' || v_tag, 'sending_status',
    v_tenant, now() + interval '1 minute', 'ENABLED', 'AWS_MANAGED'));
  if (select state || '/' || ses_status from mail.accounts where id = tp_acc) <> 'paused/enabled'
     or not exists (select 1 from mail.safety_findings where account_id = tp_acc and source = 'ses' and resolved_at is null) then
    raise exception 'FAILED 11: SES''s enabled reopened the account';
  end if;
  perform pg_temp.mf_code(pg_temp.mf_send(tp_acc, 'hello@tp-' || v_tag || '.example', 1, null, 'tp'), 'account_paused',
                          'FAILED 11: a paused account queued');
  -- Our own pause echoed back by SES changes nothing more.
  insert into mail.tenant_actions (account_id, sending_status, why, requested_by, state, applied_at)
  values (tq_acc, 'DISABLED', 'admin_pause', 'm54-check', 'applied', now());
  select ses_tenant into v_tenant from mail.accounts where id = tq_acc;
  perform pg_temp.mf_service(format(
    'select mail.record_tenant_event(%L, %L, %L, null, null, %L, %L, %L)', 'm54-ev3-' || v_tag, 'sending_status',
    v_tenant, now(), 'DISABLED', 'CUSTOMER_MANAGED'));
  if (select state from mail.accounts where id = tq_acc) <> 'active'
     or exists (select 1 from mail.safety_findings where account_id = tq_acc and source = 'ses') then
    raise exception 'FAILED 11: our own pause, echoed back, was taken for AWS''s';
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Stray charges never cancel a subscription, a failed one far from the
  -- period's end is an incident, and paying a past-due plan starts where the
  -- old month ended (reviews 22, 23). Test payments, an e2e account.
  -- Starter's test plan object on the mock: the first one recorded is kept, ours or one before it.
  v_j := pg_temp.mf_service(format('select mail.register_flutterwave_plan(%L, true, %L, 2150000, %s)',
                                   'starter', 'mock.test:4315', fw));
  perform pg_temp.mf_ok(v_j, 'SETUP 12: a plan object');
  fw := (v_j ->> 'flutterwavePlanId')::bigint;
  perform pg_temp.mf_as(u_bl);
  v_c1 := mail.start_checkout(bl_acc, 'starter', true, fw, 2150000);
  execute 'reset role';
  perform pg_temp.mf_ok(v_c1, 'SETUP 12: a checkout');
  perform pg_temp.mf_outcome(pg_temp.mf_charge(v_tx::text, v_c1 ->> 'txRef', 'successful', 2150000), 'paid',
                             'SETUP 12: the first payment');
  v_j := pg_temp.mf_charge((v_tx + 1)::text, v_c1 ->> 'txRef', 'successful', 100);
  perform pg_temp.mf_outcome(v_j, 'unapplied', 'FAILED 12: a tiny charge on the reference');
  if v_j ->> 'reason' <> 'underpaid' or v_j -> 'cancelTransactions' <> '[]'::jsonb then
    raise exception 'FAILED 12: an underpaid charge asked to cancel the subscription: %', v_j;
  end if;
  v_j := pg_temp.mf_charge((v_tx + 2)::text, v_c1 ->> 'txRef', 'failed', 2150000);
  perform pg_temp.mf_outcome(v_j, 'failed', 'FAILED 12: a failed charge a month from the period''s end');
  select * into v_sub from mail.subscriptions where account_id = bl_acc;
  if v_sub.status <> 'active'
     or not exists (select 1 from mail.billing_incidents where kind = 'unexpected_failed_charge'
                     and provider_reference = (v_tx + 2)::text and account_id = bl_acc) then
    raise exception 'FAILED 12: a stray failed charge made the plan past due, or left no incident';
  end if;
  v_end := now() + interval '1 day';
  update mail.subscriptions set current_period_end = v_end where account_id = bl_acc;
  perform pg_temp.mf_outcome(pg_temp.mf_charge((v_tx + 3)::text, v_c1 ->> 'txRef', 'failed', 2150000),
                             'renewal_failed', 'FAILED 12: a failed renewal a day before the end');
  select * into v_sub from mail.subscriptions where account_id = bl_acc;
  if v_sub.status <> 'past_due' then raise exception 'FAILED 12: the failed renewal is not past due'; end if;
  perform pg_temp.mf_service(format('select mail.note_provider_canceled(%L, %L)', bl_acc, v_tx::text));
  perform pg_temp.mf_as(u_bl);
  v_c2 := mail.start_checkout(bl_acc, 'starter', true, fw, 2150000);
  execute 'reset role';
  perform pg_temp.mf_ok(v_c2, 'SETUP 12: paying what is due');
  if v_c2 ->> 'kind' <> 'pay_due' then raise exception 'SETUP 12: not a payment of what is due: %', v_c2; end if;
  perform pg_temp.mf_outcome(pg_temp.mf_charge((v_tx + 4)::text, v_c2 ->> 'txRef', 'successful', 2150000), 'paid',
                             'FAILED 12: the past-due payment');
  select * into v_sub from mail.subscriptions where account_id = bl_acc;
  if v_sub.status <> 'active' or v_sub.current_period_start <> v_end
     or v_sub.current_period_end <> mail.billing_period_end(v_end) then
    raise exception 'FAILED 12: the paid month did not start where the old one ended: %', row_to_json(v_sub);
  end if;
  v_passed := v_passed + 1;

  -- ── 13. The payment redirect's checks are limited per checkout and per account (review 21).
  update mail.billing_settings set return_checks_per_checkout = 2, return_checks_per_account = 3;
  execute 'set local role service_role';
  if not mail.billing_return_allowed((v_c1 ->> 'checkoutId')::uuid, bl_acc)
     or not mail.billing_return_allowed((v_c1 ->> 'checkoutId')::uuid, bl_acc)
     or mail.billing_return_allowed((v_c1 ->> 'checkoutId')::uuid, bl_acc) then
    raise exception 'FAILED 13: the per-checkout limit';
  end if;
  if not mail.billing_return_allowed((v_c2 ->> 'checkoutId')::uuid, bl_acc)
     or mail.billing_return_allowed((v_c2 ->> 'checkoutId')::uuid, bl_acc) then
    raise exception 'FAILED 13: the per-account limit';
  end if;
  if mail.billing_return_allowed((v_c2 ->> 'checkoutId')::uuid, a_acc) or mail.billing_return_allowed(null, bl_acc) then
    raise exception 'FAILED 13: a checkout checked for another account';
  end if;
  execute 'reset role';
  begin
    perform pg_temp.mf_as(u_bl);
    perform mail.billing_return_allowed((v_c1 ->> 'checkoutId')::uuid, bl_acc);
    raise exception 'FAILED 13: a signed-in person asked the limiter';
  exception when insufficient_privilege then execute 'reset role';
  end;
  v_passed := v_passed + 1;

  -- ── 14. Alerts: an open live billing incident, and a webhook backlog (items 6, 7).
  perform mail.record_billing_incident(false, 'unapplied_charge', a_acc, 'm54-' || v_tag, '{"reason":"m54"}');
  select id into v_id from mail.billing_incidents where provider_reference = 'm54-' || v_tag;
  if not exists (select 1 from mail.alert_conditions() c
                  where c.key = 'mail_billing_incident:' || v_id and c.severity = 'critical'
                    and c.kind = 'mail_billing_incident' and c.summary like '%unapplied charge%'
                    and c.summary not like '%@%')
     or not exists (select 1 from public.current_alert_conditions(false) c where c.key = 'mail_billing_incident:' || v_id) then
    raise exception 'FAILED 14: an open billing incident raised no alert';
  end if;
  if exists (select 1 from mail.alert_conditions() c, mail.billing_incidents i
              where i.account_id = bl_acc and c.key = 'mail_billing_incident:' || i.id) then
    raise exception 'FAILED 14: a test-mode incident raised a live alert';
  end if;
  update mail.billing_incidents set resolved_at = now(), resolved_by = 'm54-check' where id = v_id;
  if exists (select 1 from mail.alert_conditions() c where c.key = 'mail_billing_incident:' || v_id) then
    raise exception 'FAILED 14: a resolved incident still alerts';
  end if;
  update mail.billing_incidents set resolved_at = null, resolved_by = null where id = v_id;
  v_n0 := pg_temp.mf_backlog();
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, give_up_at, next_attempt_at)
  values (w_a, a_acc, 'msg_' || replace(gen_random_uuid()::text, '-', ''), 'email.delivered', '{"type":"email.delivered"}',
          now() + interval '1 day', now() - interval '2 hours')
  returning id into v_id2;
  -- Not due for long enough, or to an endpoint that is off: not a backlog.
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, give_up_at, next_attempt_at)
  values (w_a, a_acc, 'msg_' || replace(gen_random_uuid()::text, '-', ''), 'email.delivered', '{"type":"email.delivered"}',
          now() + interval '1 day', now() - interval '10 minutes'),
         (w_c, c_acc, 'msg_' || replace(gen_random_uuid()::text, '-', ''), 'email.delivered', '{"type":"email.delivered"}',
          now() + interval '1 day', now() - interval '3 hours');
  update mail.webhooks set status = 'disabled', disabled_reason = 'customer', disabled_at = now() where id = w_c;
  if pg_temp.mf_backlog() <> v_n0 + 1 then
    raise exception 'FAILED 14: the backlog counts % (was %)', pg_temp.mf_backlog(), v_n0;
  end if;
  update mail.webhook_deliveries set status = 'delivered', delivered_at = now() where id = v_id2;
  if pg_temp.mf_backlog() <> v_n0 then
    raise exception 'FAILED 14: a delivered webhook is still counted';
  end if;
  v_passed := v_passed + 1;

  -- ── 15. The admin reads the incidents; a test admin only test ones; a stranger nothing.
  perform pg_temp.mf_admin(u_ad, s_ad);
  v_j := public.admin_mail_billing_incidents();
  execute 'reset role';
  if not exists (select 1 from jsonb_array_elements(v_j -> 'rows') r
                  where (r ->> 'id')::bigint = v_id and r ->> 'kind' = 'unapplied_charge'
                    and r ->> 'tenant' = (select ses_tenant from mail.accounts where id = a_acc)
                    and r ->> 'resolvedAt' is null)
     or (v_j ->> 'open')::integer < 1 then
    raise exception 'FAILED 15: the admin''s incidents: %', v_j;
  end if;
  perform pg_temp.mf_admin(u_ta, s_ta);
  v_j := public.admin_mail_billing_incidents(null, 0, 100);
  execute 'reset role';
  if exists (select 1 from jsonb_array_elements(v_j -> 'rows') r where not (r ->> 'testMode')::boolean)
     or not exists (select 1 from jsonb_array_elements(v_j -> 'rows') r
                     where r ->> 'accountId' = bl_acc::text and r ->> 'kind' = 'unexpected_failed_charge') then
    raise exception 'FAILED 15: the test admin''s incidents: %', v_j;
  end if;
  begin
    perform pg_temp.mf_admin(u_ad, s_ad);
    perform public.admin_mail_billing_incidents(true, 0, 0);
    raise exception 'FAILED 15: a bad page size was read';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  begin
    perform pg_temp.mf_admin(u_x, gen_random_uuid());
    perform public.admin_mail_billing_incidents();
    raise exception 'FAILED 15: a stranger read the incidents';
  exception when insufficient_privilege then execute 'reset role';
  end;
  v_passed := v_passed + 1;

  -- ── 16. Every function migration 54 makes or replaces: one signature, its
  -- grant exactly, nothing for anon; and the claims log is functions-only.
  foreach v_text in array array[
    'mail.is_webhook_url(text)=none', 'mail.webhook_for_caller(uuid, uuid)=none',
    'mail.update_webhook(uuid, uuid, text, text[], text)=authenticated',
    'mail.set_webhook_enabled(uuid, uuid, boolean)=authenticated',
    'mail.rotate_webhook_secret(uuid, uuid, text, text)=authenticated',
    'mail.delete_webhook(uuid, uuid)=authenticated', 'mail.resend_webhook_delivery(uuid, bigint)=authenticated',
    'mail.create_api_key(uuid, text, text, text, text, uuid)=authenticated',
    'mail.api_create_key(uuid, uuid, text, text, text, text, uuid)=service_role',
    'mail.note_claim_failure()=none', 'mail.claim_domain_name(uuid, text, text, uuid, uuid, text)=none',
    'mail.record_domain_failed(uuid, text, text, text)=service_role',
    'mail.record_domain_check(uuid, text, jsonb)=service_role',
    'mail.reserve_send(uuid, uuid, text, text[], timestamptz)=none',
    'mail.enqueue_email(uuid, uuid, jsonb, jsonb, text, text)=service_role',
    'mail.reschedule_email(uuid, uuid, timestamptz)=service_role',
    'mail.record_tenant_event(text, text, text, text, text, timestamptz, text, text, text, text, text)=service_role',
    'mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)=service_role',
    'mail.billing_return_allowed(uuid, uuid)=service_role', 'mail.alert_conditions()=none',
    'public.admin_mail_billing_incidents(boolean, integer, integer)=authenticated'] loop
    declare
      v_sig  text := split_part(v_text, '=', 1);
      v_want text := split_part(v_text, '=', 2);
      v_oid  oid := to_regprocedure(split_part(v_text, '=', 1));
    begin
      if v_oid is null then raise exception 'FAILED 16: % is missing', v_sig; end if;
      if (select count(*) from pg_proc p where p.proname = (select proname from pg_proc where oid = v_oid)
            and p.pronamespace = (select pronamespace from pg_proc where oid = v_oid)) <> 1 then
        raise exception 'FAILED 16: % has more than one signature', v_sig;
      end if;
      if has_function_privilege('anon', v_oid, 'execute')
         or has_function_privilege('public', v_oid, 'execute')
         or has_function_privilege('authenticated', v_oid, 'execute') is distinct from (v_want = 'authenticated')
         or has_function_privilege('service_role', v_oid, 'execute') is distinct from (v_want = 'service_role') then
        raise exception 'FAILED 16: % has the wrong grants (want %)', v_sig, v_want;
      end if;
      if (select array_to_string(proconfig, ',') from pg_proc where oid = v_oid) is distinct from 'search_path=""' then
        raise exception 'FAILED 16: % runs with another search path', v_sig;
      end if;
    end;
  end loop;
  if has_table_privilege('authenticated', 'mail.domain_claim_failures', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'mail.domain_claim_failures', 'select, insert, update, delete')
     or not (select relrowsecurity from pg_class where oid = 'mail.domain_claim_failures'::regclass) then
    raise exception 'FAILED 16: the claims log is open to an API role';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mail-purge-claim-failures') then
    raise exception 'FAILED 16: the claims log is not purged';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 54: % checks passed', v_passed;
end;
$$;

rollback;
