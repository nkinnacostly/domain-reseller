-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 58 (MyDomainsHub Mail, the notification emails, MAIL-SPEC §15),
-- tried as the database owner and as people: each event queues its email in
-- the shop's outbox, to the right members, once; a customer's own webhook
-- switch, a low-impact SES finding and SES's echo of a pause queue nothing;
-- a closed account hears nothing; an invite is emailed only by its account's
-- owner or admin holding its token, once, and the token leaves the outbox
-- when the email is sent. People are made up with e2e-*@example.com
-- addresses (queued as skipped, never sent). Rolled back: nothing reaches the
-- gateway.
--
--   supabase db query --linked -f supabase/tests/mail_notifications.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.mn_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

-- The outbox rows of one kind for one account, as "who:status" sorted.
create function pg_temp.mn_rows(p_account uuid, p_kind text) returns text language sql as $f$
  select coalesce(string_agg(split_part(o.to_email, '@', 1) || ':' || o.status, ',' order by o.to_email), '')
    from public.email_outbox o
   where o.kind = p_kind and o.data ->> 'accountId' = p_account::text
$f$;

create function pg_temp.mn_expect(p_got text, p_want text, p_what text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception '% (expected %, got %)', p_what, p_want, p_got;
  end if;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_a      uuid := gen_random_uuid();
  u_d      uuid := gen_random_uuid();
  u_v      uuid := gen_random_uuid();
  a_acc    uuid;
  c_acc    uuid;
  v_o      text;
  v_a      text;
  v_token  text := rpad('tok' || v_tag, 43, 'x');
  v_token2 text := rpad('two' || v_tag, 43, 'y');
  v_invite uuid;
  v_inv2   uuid;
  v_hook   uuid;
  v_j      jsonb;
  v_n      integer;
  v_data   jsonb;
  v_passed integer := 0;
begin
  v_o := 'e2e-mn-o-' || v_tag;
  v_a := 'e2e-mn-a-' || v_tag;
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', v_o || '@example.com', now(), now(), now()),
    (u_a, 'authenticated', 'authenticated', v_a || '@example.com', now(), now(), now()),
    (u_d, 'authenticated', 'authenticated', 'e2e-mn-d-' || v_tag || '@example.com', now(), now(), now()),
    (u_v, 'authenticated', 'authenticated', 'e2e-mn-v-' || v_tag || '@example.com', now(), now(), now());
  perform pg_temp.mn_as(u_o);
  a_acc := (mail.create_account('m58 A ' || v_tag) ->> 'accountId')::uuid;
  c_acc := (mail.create_account('m58 C ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values
    (a_acc, u_a, 'admin'), (a_acc, u_d, 'developer'), (a_acc, u_v, 'viewer');
  update mail.accounts set state = 'closed' where id = c_acc;
  -- Pro: seats for the members above and the invites below.
  update mail.accounts set plan_code = 'pro' where id = a_acc;

  -- ── 1. Caps: owner and admins, once per account, cap, period and level.
  insert into mail.cap_notices (account_id, scope, period_start, level, cap, used)
  values (a_acc, 'day', current_date, 80, 100, 80);
  insert into mail.cap_notices (account_id, scope, period_start, level, cap, used)
  values (a_acc, 'day', current_date, 80, 100, 81) on conflict do nothing;
  perform pg_temp.mn_expect(pg_temp.mn_rows(a_acc, 'mail_cap_reached'),
    v_a || ':skipped,' || v_o || ':skipped', 'FAILED 1: cap notice recipients');
  select o.data into v_data from public.email_outbox o
   where o.kind = 'mail_cap_reached' and o.data ->> 'accountId' = a_acc::text limit 1;
  if v_data ->> 'scope' <> 'day' or (v_data ->> 'level')::int <> 80 or (v_data ->> 'cap')::int <> 100
     or v_data ->> 'plan' <> 'Pro' or v_data ->> 'accountName' <> 'm58 A ' || v_tag
     or (select o.category from public.email_outbox o
          where o.kind = 'mail_cap_reached' and o.data ->> 'accountId' = a_acc::text limit 1) <> 'transactional' then
    raise exception 'FAILED 1: the cap notice''s data is wrong: %', v_data;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Billing: the owner only, from the log the sweep writes.
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (a_acc, 'system', 'billing.past_due', a_acc::text, '{"plan":"starter"}'),
         (a_acc, 'system', 'billing.lapsed', a_acc::text, '{"from":"starter"}');
  perform pg_temp.mn_expect(pg_temp.mn_rows(a_acc, 'mail_past_due'), v_o || ':skipped', 'FAILED 2: past due');
  perform pg_temp.mn_expect(pg_temp.mn_rows(a_acc, 'mail_plan_lapsed'), v_o || ':skipped', 'FAILED 2: lapsed');
  select o.data into v_data from public.email_outbox o
   where o.kind = 'mail_past_due' and o.data ->> 'accountId' = a_acc::text;
  if v_data ->> 'plan' <> 'Starter' then
    raise exception 'FAILED 2: the plan is named by its code, not its name: %', v_data;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Webhooks: a failing endpoint the worker turned off, by host only;
  -- a customer turning one off is not told.
  insert into mail.webhooks (account_id, url, events, secret_sealed, secret_hint, status, disabled_reason,
                             owner_notice_due)
  values (a_acc, 'https://user:pw@Hooks.Acme.example/in?token=abc', array['email.sent'],
          'v1.' || repeat('a', 16) || '.' || repeat('b', 40), 'whsec_abcd', 'disabled', 'failing', true)
  returning id into v_hook;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (a_acc, 'system', 'webhook.disabled', v_hook::text, '{"reason":"failing","failingSince":"2026-10-05T10:00:00.000Z"}'),
         (a_acc, 'user', 'webhook.disabled', v_hook::text, '{}');
  perform pg_temp.mn_expect(pg_temp.mn_rows(a_acc, 'mail_webhook_disabled'),
    v_a || ':skipped,' || v_o || ':skipped', 'FAILED 3: webhook recipients');
  select o.data into v_data from public.email_outbox o
   where o.kind = 'mail_webhook_disabled' and o.data ->> 'accountId' = a_acc::text limit 1;
  if v_data ->> 'endpoint' <> 'hooks.acme.example' or v_data::text like '%token=abc%' or v_data::text like '%pw@%' then
    raise exception 'FAILED 3: the endpoint is not its host alone: %', v_data;
  end if;
  if (select w.owner_notice_due from mail.webhooks w where w.id = v_hook) then
    raise exception 'FAILED 3: the owner''s notice is still marked due';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Pauses: every way an account is paused; warnings before one.
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (a_acc, 'system', 'account.paused', a_acc::text,
          '{"reason":"bounce_rate","bouncePpm":43000,"complaintPpm":10,"windowDays":7}');
  perform pg_temp.mn_expect(pg_temp.mn_rows(a_acc, 'mail_account_paused'),
    v_a || ':skipped,' || v_o || ':skipped', 'FAILED 4: pause recipients');
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (a_acc, 'admin', 'account.paused', a_acc::text, '{"reason":"admin"}');
  select count(*) into v_n from public.email_outbox o
   where o.kind = 'mail_account_paused' and o.data ->> 'accountId' = a_acc::text and o.data ->> 'reason' = 'admin';
  if v_n <> 2 then
    raise exception 'FAILED 4: an admin pause queued % emails', v_n;
  end if;
  perform mail.open_finding(a_acc, 'threshold', 'bounce_warning', 'warning',
                            '{"bouncePpm":21000,"windowDays":7}');
  perform mail.open_finding(a_acc, 'threshold', 'bounce_warning', 'warning',
                            '{"bouncePpm":22000,"windowDays":7}');
  perform mail.open_finding(a_acc, 'threshold', 'bounce_pause', 'pause', '{"bouncePpm":43000}');
  insert into mail.findings (account_id, source, kind, impact, summary, opened_at) values
    (a_acc, 'ses', 'bounce', 'high', 'The bounce rate exceeded 5%.', now()),
    (a_acc, 'ses', 'advisor_abc', 'low', 'Add a DMARC record.', now()),
    (a_acc, 'ses', 'sending_paused', 'high', 'Paused.', now());
  select count(*) into v_n from public.email_outbox o
   where o.kind = 'mail_sending_warning' and o.data ->> 'accountId' = a_acc::text;
  if v_n <> 4 then
    raise exception 'FAILED 4: expected 4 warning emails (one threshold, one SES high, two each), got %', v_n;
  end if;
  select o.data into v_data from public.email_outbox o
   where o.kind = 'mail_sending_warning' and o.data ->> 'accountId' = a_acc::text and o.data ->> 'source' = 'threshold'
   limit 1;
  if (v_data ->> 'pausePpm')::int <> (select s.bounce_pause_ppm from mail.settings s) then
    raise exception 'FAILED 4: a threshold warning does not carry the pause line: %', v_data;
  end if;
  v_passed := v_passed + 1;

  -- ── 5. A closed account hears nothing.
  insert into mail.cap_notices (account_id, scope, period_start, level, cap, used)
  values (c_acc, 'month', date_trunc('month', current_date)::date, 100, 3000, 3000);
  select count(*) into v_n from public.email_outbox o where o.data ->> 'accountId' = c_acc::text;
  if v_n <> 0 then
    raise exception 'FAILED 5: a closed account was emailed (%)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Invites: the inviter with the token, once; the token leaves when sent.
  perform pg_temp.mn_as(u_o);
  v_invite := (mail.create_invite(a_acc, 'e2e-mn-new-' || v_tag || '@example.com', 'developer',
                                  encode(sha256(convert_to(v_token, 'UTF8')), 'hex')) ->> 'inviteId')::uuid;
  perform pg_temp.mn_expect(mail.email_invite(v_invite, v_token2) ->> 'code', 'not_found', 'FAILED 6: wrong token');
  v_j := mail.email_invite(v_invite, v_token);
  perform pg_temp.mn_expect(v_j::text, '{"ok": true, "queued": false}', 'FAILED 6: reserved address');
  perform pg_temp.mn_expect(mail.email_invite(v_invite, v_token) ->> 'code', 'already_sent', 'FAILED 6: twice');
  perform pg_temp.mn_as(u_v);
  perform pg_temp.mn_expect(mail.email_invite(v_invite, v_token) ->> 'code', 'forbidden', 'FAILED 6: viewer');
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform pg_temp.mn_expect(mail.email_invite(v_invite, v_token) ->> 'code', 'unauthorized', 'FAILED 6: nobody');
  execute 'reset role';
  select o.data into v_data from public.email_outbox o where o.dedupe_key = 'mail:invite:' || v_invite::text;
  if v_data ? 'token' or v_data ->> 'role' <> 'developer' or v_data ->> 'accountName' <> 'm58 A ' || v_tag then
    raise exception 'FAILED 6: a skipped invite email kept the token, or lost its data: %', v_data;
  end if;

  -- An address that can receive mail: queued with the token, which goes once sent.
  -- (Rolled back with everything else: the gateway never sees it.)
  perform pg_temp.mn_as(u_a);
  v_inv2 := (mail.create_invite(a_acc, 'mn-check-' || v_tag || '@mydomainshub.com', 'viewer',
                                encode(sha256(convert_to(v_token2, 'UTF8')), 'hex')) ->> 'inviteId')::uuid;
  v_j := mail.email_invite(v_inv2, v_token2);
  execute 'reset role';
  perform pg_temp.mn_expect(v_j::text, '{"ok": true, "queued": true}', 'FAILED 6: admin, real address');
  select o.data into v_data from public.email_outbox o where o.dedupe_key = 'mail:invite:' || v_inv2::text;
  if v_data ->> 'token' <> v_token2 or v_data ->> 'invitedBy' <> v_a || '@example.com' then
    raise exception 'FAILED 6: the pending invite email lacks its token or inviter: %', v_data;
  end if;
  update public.email_outbox set status = 'sent', sent_at = now() where dedupe_key = 'mail:invite:' || v_inv2::text;
  select o.data into v_data from public.email_outbox o where o.dedupe_key = 'mail:invite:' || v_inv2::text;
  if v_data ? 'token' then
    raise exception 'FAILED 6: the token stayed in the outbox after sending';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. Grants: only email_invite, only to `authenticated`; empty search paths.
  if has_function_privilege('anon', 'mail.email_invite(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'mail.email_invite(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'mail.email_invite(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'mail.notify_members(uuid, text[], text, text, jsonb)', 'execute')
     or has_function_privilege('service_role', 'mail.notify_members(uuid, text[], text, text, jsonb)', 'execute') then
    raise exception 'FAILED 7: migration 58 has the wrong grants';
  end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('mail', 'notify_members'), ('mail', 'email_cap_notice'),
                                    ('mail', 'email_from_audit'), ('mail', 'webhook_host'),
                                    ('mail', 'email_safety_warning'), ('mail', 'email_ses_finding'),
                                    ('mail', 'email_invite'), ('public', 'email_outbox_forget_invite_token'))
     and array_to_string(p.proconfig, ',') is distinct from 'search_path=""';
  if v_n <> 0 then
    raise exception 'FAILED 7: % functions run with another search path', v_n;
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 58, Mail notification emails: % checks passed', v_passed;
end;
$$;

rollback;
