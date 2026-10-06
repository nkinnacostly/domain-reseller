-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 51 (MyDomainsHub Mail, trust and safety and its admin area),
-- tried as the database owner and, where the grant is the point, as `anon`,
-- `authenticated` and `service_role` (docs/MAIL-SPEC.md §4.4, §7, §8, §10,
-- §11, MR5; docs/ADMIN-SPEC.md §2–§3). Admins, factors, sessions, people and
-- accounts are made up inside the transaction with e2e-*@example.com
-- addresses (and one made-up live customer); nothing is sent and no AWS API
-- is called. Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_safety.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Claims for an admin's session: who, which session, how fresh the code is.
create function pg_temp.m51_act(p_uid uuid, p_sid uuid, p_totp_age interval default interval '1 minute')
returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_sid,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint),
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_totp_age)::bigint)))::text, true);
end $f$;

-- Claims for a customer (aal1), or none.
create function pg_temp.m51_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
end $f$;

-- An answer must carry exactly this code (a NULL never passes, CLAUDE.md §15).
create function pg_temp.m51_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.m51_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- Sets an account's last-7-days counters to exactly these, on today's row.
create function pg_temp.m51_usage(p_account uuid, p_sent integer, p_bounced integer, p_complained integer)
returns void language plpgsql as $f$
begin
  delete from mail.usage_daily where account_id = p_account;
  insert into mail.usage_daily (account_id, day, queued, sent, bounced, complained)
  values (p_account, mail.lagos_day(now()), p_sent, p_sent, p_bounced, p_complained);
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  -- Admins: owner, operator, viewer, a test-only admin, and a stranger.
  u_ow     uuid := gen_random_uuid();
  u_op     uuid := gen_random_uuid();
  u_vw     uuid := gen_random_uuid();
  u_ta     uuid := gen_random_uuid();
  u_st     uuid := gen_random_uuid();
  f_ow     uuid := gen_random_uuid();
  f_op     uuid := gen_random_uuid();
  f_vw     uuid := gen_random_uuid();
  f_ta     uuid := gen_random_uuid();
  f_st     uuid := gen_random_uuid();
  s_ow     uuid := gen_random_uuid();
  s_op     uuid := gen_random_uuid();
  s_vw     uuid := gen_random_uuid();
  s_ta     uuid := gen_random_uuid();
  s_st     uuid := gen_random_uuid();
  l_ow     text := 'm51-owner-' || v_tag;
  l_op     text := 'm51-op-' || v_tag;
  l_vw     text := 'm51-view-' || v_tag;
  l_ta     text;
  -- Customers: an e2e person, a made-up live person, and a stranger to both.
  u_e2e    uuid := gen_random_uuid();
  u_live   uuid := gen_random_uuid();
  u_other  uuid := gen_random_uuid();
  a_live   uuid;   -- a live sandbox account, approved here
  a_rej    uuid;   -- a live sandbox account, rejected here
  a_e2e    uuid;   -- an e2e sandbox account
  a_th     uuid;   -- a live active account for the thresholds
  a_cap    uuid;   -- a live active account for the cap notices
  a_wu     uuid;   -- a live active account warming up
  d_cap    text;
  v_j      jsonb;
  v_j2     jsonb;
  v_id     bigint;
  v_id2    bigint;
  v_n      integer;
  v_acc    mail.accounts;
  v_row    record;
  v_sql    text;
  v_text   text;
  v_key    uuid;
  v_want   text;
  v_expected jsonb;
  m51_ses  jsonb;
  v_passed integer := 0;
begin
  -- ── People, factors, sessions and admins (as admin.sql).
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_ow, 'authenticated', 'authenticated', 'e2e-m51-ow-' || v_tag || '@example.com', now(), now(), now()),
    (u_op, 'authenticated', 'authenticated', 'e2e-m51-op-' || v_tag || '@example.com', now(), now(), now()),
    (u_vw, 'authenticated', 'authenticated', 'e2e-m51-vw-' || v_tag || '@example.com', now(), now(), now()),
    (u_ta, 'authenticated', 'authenticated', 'e2e-m51-ta-' || v_tag || '@example.com', now(), now(), now()),
    (u_st, 'authenticated', 'authenticated', 'e2e-m51-st-' || v_tag || '@example.com', now(), now(), now()),
    (u_e2e, 'authenticated', 'authenticated', 'e2e-m51-c-' || v_tag || '@example.com', now(), now(), now()),
    (u_live, 'authenticated', 'authenticated', 'm51-live-' || v_tag || '@mydomainshub.com', now(), now(), now()),
    (u_other, 'authenticated', 'authenticated', 'e2e-m51-x-' || v_tag || '@example.com', now(), now(), now());
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
    (f_ow, u_ow, 'm51', 'totp', 'verified', now(), now(), 'x'),
    (f_op, u_op, 'm51', 'totp', 'verified', now(), now(), 'x'),
    (f_vw, u_vw, 'm51', 'totp', 'verified', now(), now(), 'x'),
    (f_ta, u_ta, 'm51', 'totp', 'verified', now(), now(), 'x'),
    (f_st, u_st, 'm51', 'totp', 'verified', now(), now(), 'x');
  insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
    (s_ow, u_ow, now(), now(), f_ow, 'aal2'),
    (s_op, u_op, now(), now(), f_op, 'aal2'),
    (s_vw, u_vw, now(), now(), f_vw, 'aal2'),
    (s_ta, u_ta, now(), now(), f_ta, 'aal2'),
    (s_st, u_st, now(), now(), f_st, 'aal2');
  insert into public.admins (user_id, label, role, mfa_factor_ids, added_by) values
    (u_ow, l_ow, 'owner', array[f_ow], 'm51-check'),
    (u_op, l_op, 'operator', array[f_op], 'm51-check'),
    (u_vw, l_vw, 'viewer', array[f_vw], 'm51-check');
  l_ta := public.grant_test_admin(u_ta);

  -- ── Accounts, created as their owners.
  perform pg_temp.m51_as(u_live);
  a_live := (mail.create_account('m51 live ' || v_tag, 'https://live.example', 'Receipts', 1000) ->> 'accountId')::uuid;
  a_rej := (mail.create_account('m51 rejected ' || v_tag) ->> 'accountId')::uuid;
  a_th := (mail.create_account('m51 thresholds ' || v_tag, 'https://th.example', 'Alerts', 5000) ->> 'accountId')::uuid;
  perform pg_temp.m51_as(u_e2e);
  a_e2e := (mail.create_account('m51 e2e ' || v_tag, 'https://e2e.example', 'Sign-in links', 100) ->> 'accountId')::uuid;
  a_cap := (mail.create_account('m51 caps ' || v_tag, 'https://cap.example', 'Receipts', 100) ->> 'accountId')::uuid;
  a_wu := (mail.create_account('m51 warm-up ' || v_tag, 'https://wu.example', 'Receipts', 100) ->> 'accountId')::uuid;
  if a_live is null or a_rej is null or a_th is null or a_e2e is null or a_cap is null or a_wu is null then
    raise exception 'SETUP: an account was not created';
  end if;
  perform set_config('request.jwt.claims', '', true);
  -- Tenants made, as provisioning would; the e2e accounts flagged as migration 45 does.
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled'
   where id in (a_live, a_rej, a_th, a_e2e, a_cap, a_wu);
  perform mail.e2e_ready_account(a_e2e, 'm51e-' || v_tag || '.example');
  perform mail.e2e_ready_account(a_cap, 'm51c-' || v_tag || '.example');
  perform mail.e2e_ready_account(a_wu, 'm51w-' || v_tag || '.example');
  d_cap := 'm51c-' || v_tag || '.example';
  update mail.accounts set state = 'active', warmup_day = null where id in (a_th, a_cap);
  -- a_cap stands for a live account in the threshold job: unflag it there.
  update mail.accounts set is_e2e = false where id in (a_cap, a_wu);

  -- ── 1. A stranger: admin:not_admin from every admin_mail_* function, and no audit row.
  perform pg_temp.m51_act(u_st, s_st);
  execute 'set local role authenticated';
  foreach v_sql in array array[
    format('select public.admin_mail_approve_account(%L, ''a reason of ten'', gen_random_uuid())', a_live),
    format('select public.admin_mail_reject_account(%L, ''a reason of ten'', gen_random_uuid())', a_live),
    format('select public.admin_mail_pause_account(%L, ''a reason of ten'', gen_random_uuid())', a_live),
    format('select public.admin_mail_resume_account(%L, null, ''a reason of ten'', gen_random_uuid())', a_live),
    format('select public.admin_mail_override_caps(%L, 10, 100, ''a reason of ten'', gen_random_uuid())', a_live),
    'select public.admin_mail_overview()',
    'select public.admin_mail_review_queue()',
    'select public.admin_mail_accounts()',
    format('select public.admin_mail_account(%L)', a_live),
    'select public.admin_mail_domains()',
    'select public.admin_mail_ses_health()',
    'select public.admin_mail_audit()'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 1: % ran for a stranger', v_sql;
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'admin:not_admin' then
        raise exception 'FAILED 1: % said % (a missing grant?)', v_sql, sqlerrm;
      end if;
    end;
  end loop;
  execute 'reset role';
  if exists (select 1 from public.admin_audit_log a where a.admin_id = u_st) then
    raise exception 'FAILED 1: a stranger left audit rows';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. The action map: Mail's five tiers, and the shop's untouched.
  for v_row in select * from (values
      ('mail.approve', 'operator', false, 'test_target'), ('mail.reject', 'operator', false, 'test_target'),
      ('mail.pause', 'operator', false, 'test_target'), ('mail.resume', 'owner', true, 'never'),
      ('mail.cap_override', 'owner', true, 'never'), ('refund.approve', 'operator', true, 'test_target'),
      ('customer.reveal', 'operator', false, 'reserved_target'), ('supplier.ssl_catalogue_apply', 'owner', true, 'never'))
      as t (action, min_role, money, test_rule) loop
    if (select row(x.min_role, x.money, x.test_rule)::text from public.admin_tier(v_row.action) x)
       is distinct from row(v_row.min_role, v_row.money, v_row.test_rule)::text then
      raise exception 'FAILED 2: admin_tier(%) is wrong', v_row.action;
    end if;
  end loop;
  if (select count(*) from (values ('mail.approve'), ('mail.close'), ('mail.unpause')) v(a)
       where (select x.min_role from public.admin_tier(v.a) x) is not null) <> 1 then
    raise exception 'FAILED 2: admin_tier knows an action it should not';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Approve (§7.2): a role, a reason, a verified domain and a complete profile.
  perform pg_temp.m51_act(u_vw, s_vw);
  perform pg_temp.m51_code(public.admin_mail_approve_account(a_live, 'Looks like a real business', gen_random_uuid()),
                          'ROLE', 'FAILED 3: a viewer approved');
  perform pg_temp.m51_act(u_op, s_op);
  perform pg_temp.m51_code(public.admin_mail_approve_account(a_live, 'short', gen_random_uuid()),
                          'REASON', 'FAILED 3: a short reason');
  perform pg_temp.m51_code(public.admin_mail_approve_account(a_live, 'Looks like a real business', gen_random_uuid()),
                          'NO_VERIFIED_DOMAIN', 'FAILED 3: approved with no verified domain');
  insert into mail.domains (account_id, name, status, verified_at) values (a_live, 'm51l-' || v_tag || '.example', 'verified', now());
  update mail.accounts set website = null where id = a_live;
  perform pg_temp.m51_code(public.admin_mail_approve_account(a_live, 'Looks like a real business', gen_random_uuid()),
                          'PROFILE_INCOMPLETE', 'FAILED 3: approved with no website');
  update mail.accounts set website = 'https://live.example' where id = a_live;
  v_key := gen_random_uuid();
  v_j := public.admin_mail_approve_account(a_live, 'Looks like a real business', v_key);
  perform pg_temp.m51_ok(v_j, 'FAILED 3: the approval');
  select * into v_acc from mail.accounts where id = a_live;
  if v_acc.state <> 'active' or v_acc.warmup_day is distinct from 0 or v_acc.reviewed_by is distinct from l_op
     or v_acc.reviewed_at is null or v_acc.warmup_checked_on is distinct from mail.lagos_day(now()) then
    raise exception 'FAILED 3: approved as %', row_to_json(v_acc);
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.account_id = a_live and l.actor = 'admin'
                    and l.action = 'account.approved' and l.actor_user_id is null) then
    raise exception 'FAILED 3: no admin row in the account''s own log';
  end if;
  v_j2 := public.admin_mail_approve_account(a_live, 'Looks like a real business', v_key);
  if (v_j2 ->> 'replayed')::boolean is not true or (v_j2 ->> 'auditId') is distinct from (v_j ->> 'auditId')
     or (select count(*) from public.admin_audit_log a where a.request_key = v_key) <> 1 then
    raise exception 'FAILED 3: the repeat was not a replay %', v_j2;
  end if;
  perform pg_temp.m51_code(public.admin_mail_approve_account(a_live, 'Looks like a real business', gen_random_uuid()),
                          'NOT_SANDBOX', 'FAILED 3: approved twice');
  if (select count(*) from public.admin_audit_log a where a.admin_label = l_op and a.action = 'mail.approve'
        and a.outcome = 'refused' and a.target_type = 'mail_account' and a.side = 'live') <> 4
     or (select count(*) from public.admin_audit_log a where a.admin_label = l_vw and a.error_code = 'ROLE') <> 1 then
    raise exception 'FAILED 3: refusals were not all recorded';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. A test admin: e2e accounts only, and the live ones' refusals keep no detail (D15).
  perform pg_temp.m51_act(u_ta, s_ta);
  perform pg_temp.m51_code(public.admin_mail_reject_account(a_rej, 'Not a real business', gen_random_uuid()),
                          'TEST_ADMIN', 'FAILED 4: a test admin rejected a live account');
  perform pg_temp.m51_ok(public.admin_mail_approve_account(a_e2e, 'An e2e account, ready', gen_random_uuid()),
                        'FAILED 4: a test admin approving an e2e account');
  if (select state from mail.accounts where id = a_e2e) <> 'active' then
    raise exception 'FAILED 4: the e2e account was not approved';
  end if;
  if exists (select 1 from public.admin_audit_log a where a.admin_label = l_ta and a.outcome = 'refused'
                and a.detail <> '{}'::jsonb)
     or not exists (select 1 from public.admin_audit_log a where a.admin_label = l_ta and a.outcome = 'ok'
                       and a.side = 'test' and a.target_test_mode and a.test_actor) then
    raise exception 'FAILED 4: a test admin''s rows';
  end if;
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_e2e, null, 'An e2e account, resumed', gen_random_uuid()),
                          'TEST_ADMIN', 'FAILED 4: a test admin may never resume');
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_e2e, 10, 100, 'An e2e account, capped', gen_random_uuid()),
                          'TEST_ADMIN', 'FAILED 4: a test admin may never override caps');
  -- Reads: e2e accounts only; nothing of the live SES account.
  if public.admin_mail_account(a_live) is not null or public.admin_mail_account(a_e2e) is null then
    raise exception 'FAILED 4: a test admin read a live account, or not its own e2e one';
  end if;
  if exists (select 1 from jsonb_array_elements(public.admin_mail_review_queue()) e
              where not mail.is_e2e_account((e ->> 'id')::uuid))
     or exists (select 1 from jsonb_array_elements(public.admin_mail_accounts(null, null, 0, 100) -> 'rows') e
                 where not mail.is_e2e_account((e ->> 'id')::uuid))
     or exists (select 1 from jsonb_array_elements(public.admin_mail_domains(null, null, 0, 100) -> 'rows') e
                 where not mail.is_e2e_account((e ->> 'accountId')::uuid))
     or exists (select 1 from jsonb_array_elements(public.admin_mail_audit(null, 0, 100) -> 'rows') e
                 where (e ->> 'testActor')::boolean is not true) then
    raise exception 'FAILED 4: a test admin''s lists hold live rows';
  end if;
  if (public.admin_mail_overview() ->> 'testOnly')::boolean is not true then
    raise exception 'FAILED 4: the overview does not say it is a test admin''s';
  end if;
  begin
    perform public.admin_mail_ses_health();
    raise exception 'FAILED 4: a test admin read the live SES account';
  exception when insufficient_privilege then
    if sqlerrm is distinct from 'admin:test_admin' then raise exception 'FAILED 4: health said %', sqlerrm; end if;
  end;
  v_passed := v_passed + 1;

  -- ── 5. Reject (§7.2): a sandbox account is closed with a code, never the admin's words.
  perform pg_temp.m51_act(u_op, s_op);
  perform pg_temp.m51_ok(public.admin_mail_reject_account(a_rej, 'No website, no use case given', gen_random_uuid()),
                        'FAILED 5: the rejection');
  select * into v_acc from mail.accounts where id = a_rej;
  if v_acc.state <> 'closed' or v_acc.state_reason is distinct from 'rejected_at_review' then
    raise exception 'FAILED 5: rejected as % / %', v_acc.state, v_acc.state_reason;
  end if;
  perform pg_temp.m51_code(public.admin_mail_reject_account(a_live, 'Changed my mind about it', gen_random_uuid()),
                          'NOT_SANDBOX', 'FAILED 5: an active account was rejected');
  perform pg_temp.m51_code(public.admin_mail_reject_account(gen_random_uuid(), 'Changed my mind about it', gen_random_uuid()),
                          'NOT_FOUND', 'FAILED 5: a missing account');
  v_passed := v_passed + 1;

  -- ── 6. An admin's pause: our gate at once, SES's tenant asked, a finding opened.
  perform pg_temp.m51_ok(public.admin_mail_pause_account(a_live, 'Phishing reported by a recipient', gen_random_uuid()),
                        'FAILED 6: the pause');
  select * into v_acc from mail.accounts where id = a_live;
  if v_acc.state <> 'paused' or v_acc.pre_pause_state is distinct from 'active'
     or v_acc.state_reason is distinct from 'paused_by_admin' then
    raise exception 'FAILED 6: paused as %', row_to_json(v_acc);
  end if;
  select id into v_id from mail.safety_findings
   where account_id = a_live and source = 'admin' and kind = 'admin_pause' and severity = 'pause' and resolved_at is null;
  if v_id is null or not exists (select 1 from mail.tenant_actions t where t.account_id = a_live
                                    and t.sending_status = 'DISABLED' and t.why = 'admin_pause'
                                    and t.state = 'pending' and t.finding_id = v_id and t.requested_by = l_op) then
    raise exception 'FAILED 6: no finding or no SES pause asked for';
  end if;
  if (mail.reserve_send(a_live, null, 'a@m51l-' || v_tag || '.example', array['x@example.com']) ->> 'code')
     is distinct from 'account_paused' then
    raise exception 'FAILED 6: a paused account reserved a send';
  end if;
  perform pg_temp.m51_code(public.admin_mail_pause_account(a_live, 'Phishing reported again', gen_random_uuid()),
                          'NOT_PAUSABLE', 'FAILED 6: paused twice');
  -- The test admin pauses its e2e account: no SES request for a tenant that is not real.
  perform pg_temp.m51_act(u_ta, s_ta);
  perform pg_temp.m51_ok(public.admin_mail_pause_account(a_e2e, 'An e2e pause, for the test', gen_random_uuid()),
                        'FAILED 6: a test admin pausing an e2e account');
  if exists (select 1 from mail.tenant_actions t where t.account_id = a_e2e) then
    raise exception 'FAILED 6: an e2e account''s pause asked SES';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. Resume (MR5): the owner, a fresh code, the finding named, never under SES's own pause.
  perform pg_temp.m51_act(u_op, s_op);
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_live, v_id, 'Recipient confirmed it was theirs', gen_random_uuid()),
                          'ROLE', 'FAILED 7: an operator resumed');
  perform pg_temp.m51_act(u_ow, s_ow, interval '20 minutes');
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_live, v_id, 'Recipient confirmed it was theirs', gen_random_uuid()),
                          'NEEDS_CODE', 'FAILED 7: a 20-minute-old code resumed');
  perform pg_temp.m51_act(u_ow, s_ow);
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_live, null, 'Recipient confirmed it was theirs', gen_random_uuid()),
                          'FINDING_MISMATCH', 'FAILED 7: resumed without naming the finding');
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_live, v_id + 100000, 'Recipient confirmed it was theirs', gen_random_uuid()),
                          'FINDING_MISMATCH', 'FAILED 7: resumed naming another finding');
  -- AWS's own pause: SES says disabled, and we never asked it to.
  update mail.tenant_actions set state = 'canceled' where account_id = a_live and state = 'pending';
  update mail.accounts set ses_status = 'disabled' where id = a_live;
  perform pg_temp.m51_code(public.admin_mail_resume_account(a_live, v_id, 'Recipient confirmed it was theirs', gen_random_uuid()),
                          'SES_PAUSED', 'FAILED 7: resumed under AWS''s own pause');
  update mail.accounts set ses_status = 'enabled' where id = a_live;
  update mail.tenant_actions set state = 'pending' where account_id = a_live and state = 'canceled';
  v_j := public.admin_mail_resume_account(a_live, v_id, 'Recipient confirmed it was theirs', gen_random_uuid());
  perform pg_temp.m51_ok(v_j, 'FAILED 7: the resume');
  select * into v_acc from mail.accounts where id = a_live;
  if v_acc.state <> 'active' or v_acc.pre_pause_state is not null or v_acc.state_reason is not null
     or v_acc.warmup_day is distinct from 0 then
    raise exception 'FAILED 7: resumed as %', row_to_json(v_acc);
  end if;
  if (select resolution from mail.safety_findings where id = v_id) is distinct from 'resumed'
     or (select resolved_by from mail.safety_findings where id = v_id) is distinct from l_ow then
    raise exception 'FAILED 7: the finding was not closed by the resume';
  end if;
  -- SES never took the pause: it is withdrawn, and nothing is asked to undo it.
  if (v_j #>> '{after,tenantActionId}') is not null
     or exists (select 1 from mail.tenant_actions t where t.account_id = a_live and t.state <> 'canceled') then
    raise exception 'FAILED 7: an SES pause never applied was not simply withdrawn';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. SES-side changes (§4.3): claimed in order, retried with backoff, applied once.
  perform pg_temp.m51_act(u_op, s_op);
  perform pg_temp.m51_ok(public.admin_mail_pause_account(a_live, 'Second report of phishing', gen_random_uuid()),
                        'FAILED 8: the second pause');
  execute 'set local role service_role';
  v_j := mail.claim_tenant_actions('m51-check', 20);
  execute 'reset role';
  select (e ->> 'id')::bigint into v_id2 from jsonb_array_elements(v_j) e where (e ->> 'accountId')::uuid = a_live;
  if v_id2 is null or exists (select 1 from jsonb_array_elements(v_j) e
                                where (e ->> 'accountId')::uuid = a_live
                                  and (e ->> 'tenant' is distinct from (select ses_tenant from mail.accounts where id = a_live)
                                       or e ->> 'sendingStatus' <> 'DISABLED')) then
    raise exception 'FAILED 8: the claim %', v_j;
  end if;
  execute 'set local role service_role';
  perform pg_temp.m51_code(mail.record_tenant_action(v_id2, 'another-worker', 'applied'), 'not_claimed',
                          'FAILED 8: another worker recorded the claim');
  v_j := mail.record_tenant_action(v_id2, 'm51-check', 'retry', 'HTTP 503 ServiceUnavailable <x@y.z>');
  execute 'reset role';
  if (select state from mail.tenant_actions where id = v_id2) <> 'pending'
     or (select next_attempt_at from mail.tenant_actions where id = v_id2) <= now()
     or (select last_error from mail.tenant_actions where id = v_id2) ~ '[<>@]' then
    raise exception 'FAILED 8: a retry %', (select row_to_json(t) from mail.tenant_actions t where t.id = v_id2);
  end if;
  execute 'set local role service_role';
  if exists (select 1 from jsonb_array_elements(mail.claim_tenant_actions('m51-check', 20)) e where (e ->> 'id')::bigint = v_id2) then
    raise exception 'FAILED 8: claimed again before its backoff';
  end if;
  execute 'reset role';
  update mail.tenant_actions set next_attempt_at = now() where id = v_id2;
  execute 'set local role service_role';
  perform mail.claim_tenant_actions('m51-check', 20);
  perform pg_temp.m51_ok(mail.record_tenant_action(v_id2, 'm51-check', 'applied'), 'FAILED 8: applied');
  execute 'reset role';
  -- Applied at SES, and echoed back as disabled (the events endpoint): ours, so a
  -- resume may undo it, and asks SES to.
  update mail.accounts set ses_status = 'disabled' where id = a_live;
  select id into v_id from mail.safety_findings where account_id = a_live and kind = 'admin_pause' and resolved_at is null;
  perform pg_temp.m51_act(u_ow, s_ow);
  v_j := public.admin_mail_resume_account(a_live, v_id, 'The second report was a mistake too', gen_random_uuid());
  perform pg_temp.m51_ok(v_j, 'FAILED 8: the second resume');
  if not exists (select 1 from mail.tenant_actions t where t.id = (v_j #>> '{after,tenantActionId}')::bigint
                    and t.sending_status = 'ENABLED' and t.why = 'admin_resume' and t.state = 'pending'
                    and t.requested_by = l_ow) then
    raise exception 'FAILED 8: no SES resume after an applied pause %', v_j;
  end if;
  -- Until SES says enabled, our gate still refuses the resumed account.
  if (mail.reserve_send(a_live, null, 'a@m51l-' || v_tag || '.example', array['x@example.com']) ->> 'code')
     is distinct from 'account_paused' then
    raise exception 'FAILED 8: sent before SES enabled the tenant again';
  end if;
  update mail.accounts set ses_status = 'enabled' where id = a_live;
  v_passed := v_passed + 1;

  -- ── 9. Thresholds (§7.4): 500 sends at least; warn at 2% / 0.05%, pause at 4% / 0.08%.
  perform pg_temp.m51_usage(a_th, 400, 40, 0);   -- 10% of too few sends
  execute 'set local role service_role';
  v_j := mail.run_safety_checks('ok', 1000, 100, now() - interval '20 minutes');
  execute 'reset role';
  if exists (select 1 from mail.safety_findings where account_id = a_th) or (select state from mail.accounts where id = a_th) <> 'active' then
    raise exception 'FAILED 9: judged on fewer than 500 sends';
  end if;
  if (v_j ->> 'pendingTenantActions')::integer < 1 then
    raise exception 'FAILED 9: the run did not count the SES request waiting %', v_j;
  end if;
  perform pg_temp.m51_usage(a_th, 600, 15, 0);   -- 2.5%: a warning
  perform mail.run_safety_checks('no_data');
  if not exists (select 1 from mail.safety_findings where account_id = a_th and kind = 'bounce_warning'
                    and severity = 'warning' and resolved_at is null and (detail ->> 'bouncePpm')::integer = 25000)
     or (select state from mail.accounts where id = a_th) <> 'active' then
    raise exception 'FAILED 9: no bounce warning at 2.5%%';
  end if;
  perform pg_temp.m51_usage(a_th, 600, 6, 0);    -- 1%: the warning clears itself
  perform mail.run_safety_checks('failed');
  if exists (select 1 from mail.safety_findings where account_id = a_th and resolved_at is null)
     or (select resolution from mail.safety_findings where account_id = a_th and kind = 'bounce_warning') <> 'cleared' then
    raise exception 'FAILED 9: the warning did not clear';
  end if;
  perform pg_temp.m51_usage(a_th, 2000, 0, 1);   -- 0.05% complaints: a warning
  perform mail.run_safety_checks('no_data');
  if not exists (select 1 from mail.safety_findings where account_id = a_th and kind = 'complaint_warning' and resolved_at is null) then
    raise exception 'FAILED 9: no complaint warning at 0.05%%';
  end if;
  perform pg_temp.m51_usage(a_th, 600, 30, 0);   -- 5%: paused
  perform mail.run_safety_checks('no_data');
  select * into v_acc from mail.accounts where id = a_th;
  if v_acc.state <> 'paused' or v_acc.pre_pause_state is distinct from 'active'
     or v_acc.state_reason is distinct from 'paused_bounce_rate' then
    raise exception 'FAILED 9: not paused at 5%%: %', row_to_json(v_acc);
  end if;
  select id into v_id from mail.safety_findings
   where account_id = a_th and source = 'threshold' and kind = 'bounce_pause' and severity = 'pause' and resolved_at is null;
  if v_id is null
     or not exists (select 1 from mail.tenant_actions t where t.account_id = a_th and t.why = 'threshold'
                       and t.sending_status = 'DISABLED' and t.finding_id = v_id and t.requested_by = 'system')
     or not exists (select 1 from mail.account_audit_log l where l.account_id = a_th and l.actor = 'system'
                       and l.action = 'account.paused' and l.detail ->> 'reason' = 'bounce_rate') then
    raise exception 'FAILED 9: the pause left no finding, SES request or log row';
  end if;
  -- MR5: falling rates never lift a pause.
  perform pg_temp.m51_usage(a_th, 600, 0, 0);
  perform mail.run_safety_checks('no_data');
  if (select state from mail.accounts where id = a_th) <> 'paused'
     or (select resolved_at from mail.safety_findings where id = v_id) is not null then
    raise exception 'FAILED 9: code lifted a pause';
  end if;
  -- Complaints at 0.1% on another account pause it too; an e2e account is left to its own helper.
  perform pg_temp.m51_usage(a_cap, 1000, 0, 1);
  update mail.accounts set is_e2e = true where id = a_cap;
  perform mail.run_safety_checks('no_data');
  if (select state from mail.accounts where id = a_cap) <> 'active' then
    raise exception 'FAILED 9: the worker''s run judged an e2e account';
  end if;
  execute 'set local role service_role';
  v_j := mail.e2e_evaluate(a_cap);
  perform pg_temp.m51_code(mail.e2e_evaluate(a_live), 'not_e2e', 'FAILED 9: e2e_evaluate judged a live account');
  perform pg_temp.m51_code(mail.e2e_seed_usage(a_live, 1, 0, 0), 'not_e2e', 'FAILED 9: e2e_seed_usage on a live account');
  execute 'reset role';
  if (v_j ->> 'paused')::boolean is not true or (select state_reason from mail.accounts where id = a_cap) <> 'paused_complaint_rate'
     or not exists (select 1 from mail.safety_findings where account_id = a_cap and kind = 'complaint_pause' and resolved_at is null)
     or exists (select 1 from mail.tenant_actions where account_id = a_cap) then
    raise exception 'FAILED 9: an e2e complaint pause %', v_j;
  end if;
  -- The readings, and their checks.
  if (select count(*) from mail.reputation_readings r where r.read_at = now()) < 4
     or not exists (select 1 from mail.reputation_readings r where r.read_at = now() and r.outcome = 'ok'
                       and r.bounce_ppm = 1000 and r.complaint_ppm = 100 and r.metric_at < now()) then
    raise exception 'FAILED 9: the readings were not kept';
  end if;
  foreach v_sql in array array[
    'select mail.run_safety_checks(''maybe'')',
    'select mail.run_safety_checks(''ok'')',
    'select mail.run_safety_checks(''no_data'', 10)',
    'select mail.run_safety_checks(''ok'', 2000000)'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 9: % ran', v_sql;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  v_passed := v_passed + 1;

  -- ── 10. Warm-up (§7.3): a day on, once a day, while the rates hold and it sends.
  update mail.accounts set state = 'active', warmup_day = 0, warmup_checked_on = null, plan_code = 'pro'
   where id = a_wu;
  perform pg_temp.m51_usage(a_wu, 800, 4, 0);    -- 0.5%: under the warning level
  perform mail.advance_warmup();
  if (select warmup_day from mail.accounts where id = a_wu) <> 1
     or (select warmup_checked_on from mail.accounts where id = a_wu) <> mail.lagos_day(now()) then
    raise exception 'FAILED 10: no day on';
  end if;
  perform mail.advance_warmup();
  if (select warmup_day from mail.accounts where id = a_wu) <> 1 then
    raise exception 'FAILED 10: two days on in one day';
  end if;
  select * into v_acc from mail.accounts where id = a_wu;
  if (select daily from mail.effective_caps(v_acc)) <> 2000 then
    raise exception 'FAILED 10: day 1''s cap is %', (select daily from mail.effective_caps(v_acc));
  end if;
  update mail.accounts set warmup_checked_on = null where id = a_wu;
  perform pg_temp.m51_usage(a_wu, 800, 20, 0);   -- 2.5%: held
  perform mail.advance_warmup();
  if (select warmup_day from mail.accounts where id = a_wu) <> 1
     or (select warmup_checked_on from mail.accounts where id = a_wu) is distinct from mail.lagos_day(now()) then
    raise exception 'FAILED 10: warmed up over the warning level';
  end if;
  update mail.accounts set warmup_checked_on = null where id = a_wu;
  delete from mail.usage_daily where account_id = a_wu;   -- sent nothing: held
  perform mail.advance_warmup();
  if (select warmup_day from mail.accounts where id = a_wu) <> 1 then
    raise exception 'FAILED 10: warmed up without sending';
  end if;
  -- At the plan's cap the warm-up has nothing left to say: Pro's 20,000 is 1,000 × 2^5 away.
  update mail.accounts set warmup_checked_on = null, warmup_day = 5 where id = a_wu;
  perform pg_temp.m51_usage(a_wu, 800, 0, 0);
  perform mail.advance_warmup();
  if (select warmup_day from mail.accounts where id = a_wu) <> 5 then
    raise exception 'FAILED 10: warmed up past the plan''s cap';
  end if;
  v_passed := v_passed + 1;

  -- ── 11. Cap notices (§8): 80% and 100%, once each; a refusal at the cap is the 100% too.
  update mail.accounts set state = 'active', daily_cap_override = 10, is_e2e = true where id = a_cap;
  delete from mail.usage_daily where account_id = a_cap;
  v_j := mail.reserve_send(a_cap, null, 'Caps <a@' || d_cap || '>',
                           array['r1@example.com', 'r2@example.com', 'r3@example.com', 'r4@example.com',
                                 'r5@example.com', 'r6@example.com', 'r7@example.com']);
  perform pg_temp.m51_ok(v_j, 'FAILED 11: 7 of 10');
  if exists (select 1 from mail.cap_notices where account_id = a_cap) then
    raise exception 'FAILED 11: a notice at 70%%';
  end if;
  perform pg_temp.m51_ok(mail.reserve_send(a_cap, null, 'a@' || d_cap, array['r8@example.com']), 'FAILED 11: 8 of 10');
  if (select count(*) from mail.cap_notices where account_id = a_cap and scope = 'day' and level = 80 and used = 8 and cap = 10) <> 1
     or exists (select 1 from mail.cap_notices where account_id = a_cap and level = 100) then
    raise exception 'FAILED 11: the 80%% notice';
  end if;
  perform pg_temp.m51_ok(mail.reserve_send(a_cap, null, 'a@' || d_cap, array['r9@example.com']), 'FAILED 11: 9 of 10');
  perform pg_temp.m51_ok(mail.reserve_send(a_cap, null, 'a@' || d_cap, array['r10@example.com']), 'FAILED 11: 10 of 10');
  perform pg_temp.m51_code(mail.reserve_send(a_cap, null, 'a@' || d_cap, array['r11@example.com']), 'quota_exceeded',
                          'FAILED 11: past the cap');
  if (select count(*) from mail.cap_notices where account_id = a_cap) <> 2
     or (select used from mail.cap_notices where account_id = a_cap and level = 100) <> 10
     or (select period_start from mail.cap_notices where account_id = a_cap and level = 100) <> mail.lagos_day(now()) then
    raise exception 'FAILED 11: the 100%% notice';
  end if;
  -- The month's cap: 80% and 100% are noted as the month fills (13 and 15 of 15).
  update mail.accounts set daily_cap_override = 1000, monthly_cap_override = 15 where id = a_cap;
  perform pg_temp.m51_ok(mail.reserve_send(a_cap, null, 'a@' || d_cap,
                                          array['r12@example.com', 'r13@example.com', 'r14@example.com']),
                        'FAILED 11: 13 of the month''s 15');
  if not exists (select 1 from mail.cap_notices where account_id = a_cap and scope = 'month' and level = 80 and used = 13
                    and period_start = date_trunc('month', mail.lagos_day(now())::timestamp)::date)
     or exists (select 1 from mail.cap_notices where account_id = a_cap and scope = 'month' and level = 100) then
    raise exception 'FAILED 11: the month''s 80%% notice';
  end if;
  perform pg_temp.m51_ok(mail.reserve_send(a_cap, null, 'a@' || d_cap, array['r15@example.com', 'r16@example.com']),
                        'FAILED 11: 15 of the month''s 15');
  if not exists (select 1 from mail.cap_notices where account_id = a_cap and scope = 'month' and level = 100 and used = 15) then
    raise exception 'FAILED 11: the month''s 100%% notice';
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Cap overrides (§10): the owner, a fresh code, in range, and a change.
  perform pg_temp.m51_act(u_op, s_op);
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_live, 500, 5000, 'Agreed a higher cap by email', gen_random_uuid()),
                          'ROLE', 'FAILED 12: an operator overrode caps');
  perform pg_temp.m51_act(u_ow, s_ow);
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_live, 5000, 500, 'Agreed a higher cap by email', gen_random_uuid()),
                          'OUT_OF_RANGE', 'FAILED 12: a day over the month');
  v_n := (select account_daily_budget from mail.settings) + 1;
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_live, v_n, null, 'Agreed a higher cap by email', gen_random_uuid()),
                          'OUT_OF_RANGE', 'FAILED 12: a day over the SES budget');
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_live, 0, null, 'Agreed a higher cap by email', gen_random_uuid()),
                          'OUT_OF_RANGE', 'FAILED 12: a zero cap');
  perform pg_temp.m51_ok(public.admin_mail_override_caps(a_live, 500, 5000, 'Agreed a higher cap by email', gen_random_uuid()),
                        'FAILED 12: the override');
  select * into v_acc from mail.accounts where id = a_live;
  if v_acc.daily_cap_override <> 500 or v_acc.monthly_cap_override <> 5000
     or (select row(c.daily, c.monthly)::text from mail.effective_caps(v_acc) c) <> row(500, 5000)::text then
    raise exception 'FAILED 12: overridden as %', row_to_json(v_acc);
  end if;
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_live, 500, 5000, 'Agreed a higher cap by email', gen_random_uuid()),
                          'NO_CHANGE', 'FAILED 12: an unchanged override');
  perform pg_temp.m51_ok(public.admin_mail_override_caps(a_live, null, null, 'Back to the plan''s caps', gen_random_uuid()),
                        'FAILED 12: clearing the override');
  perform pg_temp.m51_code(public.admin_mail_override_caps(a_rej, 10, 100, 'Agreed a higher cap by email', gen_random_uuid()),
                          'ACCOUNT_CLOSED', 'FAILED 12: a closed account');
  v_passed := v_passed + 1;

  -- ── 13. SES's own findings (§4.2): the admin's account page reads them when the events
  -- package's table is there (by name: this migration does not depend on it), else none.
  if to_regclass('mail.findings') is not null then
    execute format($q$insert into mail.findings (account_id, source, kind, impact, summary, opened_at)
                     values (%L, 'ses', 'm51_check', 'high', 'Bounce rate is high', now()) returning id$q$, a_live)
       into v_id;
    m51_ses := (select e from jsonb_array_elements(mail.ses_findings_of(a_live)) e where (e ->> 'id')::bigint = v_id);
    if m51_ses is null or m51_ses ->> 'kind' <> 'm51_check' or m51_ses ->> 'impact' <> 'high' then
      raise exception 'FAILED 13: the SES finding was not read %', mail.ses_findings_of(a_live);
    end if;
  elsif mail.ses_findings_of(a_live) <> '[]'::jsonb then
    raise exception 'FAILED 13: SES findings with no table to hold them';
  end if;
  v_passed := v_passed + 1;

  -- ── 14. Alerts (§11): live side only, never for an e2e account.
  update mail.tenant_actions set requested_at = now() - interval '20 minutes' where account_id = a_th;
  insert into mail.reputation_readings (read_at, outcome, bounce_ppm, complaint_ppm)
  values (now() + interval '1 second', 'ok', 25000, 900);
  insert into public.service_heartbeats (name, test_mode, beat_at, detail)
  values ('mail-worker:m51-' || v_tag, false, now() - interval '20 minutes', '{}'),
         ('mail-worker:m51s-' || v_tag, false, now() - interval '20 minutes', '{"everyMinutes": 15}');
  insert into public.service_heartbeats (name, test_mode, beat_at, detail)
  values ('mail-worker:quota', false, now(), '{"share": 0.85}')
  on conflict (name) do update set beat_at = now(), detail = excluded.detail;
  create temp table m51_alerts on commit drop as select * from public.current_alert_conditions(false);
  foreach v_text in array array[
    'mail_threshold_pause:' || a_th, 'mail_tenant_action:' || (select max(id) from mail.tenant_actions where account_id = a_th),
    'mail_reputation:bounce', 'mail_reputation:complaint', 'mail_silent:mail-worker:m51-' || v_tag, 'mail_quota:24h'
  ] loop
    if not exists (select 1 from m51_alerts a where a.key = v_text) then
      raise exception 'FAILED 14: no % alert', v_text;
    end if;
  end loop;
  if (select severity from m51_alerts where key = 'mail_reputation:complaint') <> 'critical'
     or (select severity from m51_alerts where key = 'mail_reputation:bounce') <> 'warning'
     or exists (select 1 from m51_alerts where key = 'mail_silent:mail-worker:m51s-' || v_tag)
     or exists (select 1 from m51_alerts where key in ('mail_threshold_pause:' || a_cap, 'mail_threshold_pause:' || a_e2e))
     or exists (select 1 from m51_alerts where key like 'mail\_%' and summary ~ '[^\s<>()]+@[^\s<>()]+') then
    raise exception 'FAILED 14: severities, a 15-minute job read as silent, an e2e account, or an address';
  end if;
  update mail.accounts set ses_status = 'disabled' where id in (a_live, a_th);
  -- a_th's newest SES request is our pause: its `disabled` is ours, not AWS's.
  if exists (select 1 from public.current_alert_conditions(false) a where a.key = 'mail_tenant_paused:' || a_th) then
    raise exception 'FAILED 14: our own pause, echoed by SES, alerted as SES''s';
  end if;
  update mail.accounts set ses_status = 'enabled' where id = a_th;
  if not exists (select 1 from public.current_alert_conditions(false) a where a.key = 'mail_tenant_paused:' || a_live)
     or exists (select 1 from public.current_alert_conditions(true) a where a.key like 'mail\_%') then
    raise exception 'FAILED 14: the SES pause alert, or a mail alert on the test side';
  end if;
  update mail.accounts set ses_status = 'enabled' where id = a_live;
  -- The event endpoint: emails sent 15–60 minutes ago with no SES event at all.
  insert into mail.emails (account_id, domain_id, from_address, to_addresses, subject, status, ses_message_id, sent_at)
  values (a_live, (select id from mail.domains where account_id = a_live limit 1), 'a@m51l-' || v_tag || '.example',
          array['x@example.com'], 'm51', 'sent', 'm51-msg-' || v_tag, now() - interval '20 minutes')
  returning id into v_id;
  if not exists (select 1 from public.current_alert_conditions(false) a where a.key = 'mail_events_silent')
     and not exists (select 1 from mail.emails e join mail.email_events v on v.email_id = e.id
                      where e.sent_at between now() - interval '60 minutes' and now() - interval '15 minutes') then
    raise exception 'FAILED 14: no alert for a silent event endpoint';
  end if;
  insert into mail.email_events (email_id, account_id, type, occurred_at) values (v_id, a_live, 'send', now() - interval '19 minutes');
  if exists (select 1 from public.current_alert_conditions(false) a where a.key = 'mail_events_silent') then
    raise exception 'FAILED 14: the event alert stayed once an event came';
  end if;
  v_passed := v_passed + 1;

  -- ── 15. Retention (§8, §9): the plan's days since the last activity; queued email stays.
  update mail.accounts set plan_code = 'free' where id = a_live;
  insert into mail.emails (account_id, domain_id, from_address, to_addresses, subject, status, created_at, sent_at, last_event_at)
  values (a_live, (select id from mail.domains where account_id = a_live limit 1), 'a@x.example', array['old@example.com'],
          'm51 old', 'delivered', now() - interval '10 days', now() - interval '10 days', now() - interval '9 days'),
         (a_live, (select id from mail.domains where account_id = a_live limit 1), 'a@x.example', array['late@example.com'],
          'm51 late', 'bounced', now() - interval '10 days', now() - interval '10 days', now() - interval '2 days'),
         (a_live, (select id from mail.domains where account_id = a_live limit 1), 'a@x.example', array['q@example.com'],
          'm51 queued', 'queued', now() - interval '10 days', null, null);
  perform mail.purge_old_emails();
  if exists (select 1 from mail.emails where account_id = a_live and subject = 'm51 old')
     or (select count(*) from mail.emails where account_id = a_live and subject in ('m51 late', 'm51 queued', 'm51')) <> 3 then
    raise exception 'FAILED 15: the purge';
  end if;
  insert into mail.reputation_readings (read_at, outcome) values (now() - interval '91 days', 'no_data');
  perform mail.purge_safety_records();
  if exists (select 1 from mail.reputation_readings where read_at < now() - interval '90 days') then
    raise exception 'FAILED 15: an old reading stayed';
  end if;
  if (select count(*) from cron.job where jobname in ('mail-purge-old-emails', 'mail-purge-safety', 'mail-advance-warmup',
                                                      'mail-purge-payloads')) <> 4 then
    raise exception 'FAILED 15: a pg_cron job is missing';
  end if;
  v_passed := v_passed + 1;

  -- ── 16. Admin reads: the queue's readiness, a masked owner, filters checked.
  update mail.accounts set state = 'sandbox' where id = a_th;
  perform pg_temp.m51_act(u_vw, s_vw);
  select e into v_j from jsonb_array_elements(public.admin_mail_review_queue()) e where (e ->> 'id')::uuid = a_th;
  if v_j is null or (v_j ->> 'ready')::boolean or (v_j ->> 'profileComplete')::boolean is not true
     or (v_j ->> 'ownerEmail') is distinct from 'm•••@mydomainshub.com' then
    raise exception 'FAILED 16: the queue row %', v_j;
  end if;
  v_j := public.admin_mail_account(a_live);
  if v_j ->> 'ownerEmail' <> 'm•••@mydomainshub.com' or jsonb_array_length(v_j -> 'findings') <> 2
     or jsonb_array_length(v_j -> 'tenantActions') < 2 or (v_j #>> '{thresholds,bouncePausePpm}')::integer <> 40000
     or v_j::text like '%m51-live-%' then
    raise exception 'FAILED 16: the account %', v_j;
  end if;
  if (public.admin_mail_accounts('paused', null, 0, 100) -> 'rows') @> jsonb_build_array(jsonb_build_object('id', a_live))
     or not (public.admin_mail_accounts(null, 'mdm-' || (select short_id from mail.accounts where id = a_live), 0, 10) -> 'rows')
            @> jsonb_build_array(jsonb_build_object('id', a_live))
     or (public.admin_mail_audit('mail.approve', 0, 100) ->> 'total')::integer < 1
     or (public.admin_mail_ses_health() #>> '{reputation,latest,bouncePpm}')::integer <> 25000 then
    raise exception 'FAILED 16: the lists or the health';
  end if;
  foreach v_sql in array array[
    'select public.admin_mail_accounts(''frozen'')', 'select public.admin_mail_accounts(null, null, 0, 101)',
    'select public.admin_mail_domains(''gone'')', 'select public.admin_mail_audit(''refund.approve'')'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAILED 16: % ran', v_sql;
    exception when invalid_parameter_value then
      if sqlerrm is distinct from 'admin:bad_filter' then raise exception 'FAILED 16: % said %', v_sql, sqlerrm; end if;
    end;
  end loop;
  v_passed := v_passed + 1;

  -- ── 17. Customers: members read their findings (never who resolved them) and notices; nobody else.
  perform pg_temp.m51_as(u_live);
  execute 'set local role authenticated';
  if (select count(*) from mail.safety_findings where account_id = a_live) <> 2 then
    raise exception 'FAILED 17: a member cannot read the account''s findings';
  end if;
  begin
    perform resolved_by from mail.safety_findings limit 1;
    raise exception 'FAILED 17: a member read who resolved a finding';
  exception when insufficient_privilege then null;
  end;
  foreach v_sql in array array['select 1 from mail.tenant_actions', 'select 1 from mail.reputation_readings'] loop
    begin
      execute v_sql;
      raise exception 'FAILED 17: % ran for a member', v_sql;
    exception when insufficient_privilege then null;
    end;
  end loop;
  execute 'reset role';
  perform pg_temp.m51_as(u_other);
  execute 'set local role authenticated';
  if exists (select 1 from mail.safety_findings where account_id in (a_live, a_th))
     or exists (select 1 from mail.cap_notices where account_id = a_cap) then
    raise exception 'FAILED 17: a stranger read an account''s findings or notices';
  end if;
  execute 'reset role';
  perform pg_temp.m51_as(u_e2e);
  execute 'set local role authenticated';
  if (select count(*) from mail.cap_notices where account_id = a_cap) < 2 then
    raise exception 'FAILED 17: a member cannot read the cap notices';
  end if;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 18. Grants: every function migration 51 makes, to exactly the role it names.
  v_expected := '{
    "rate_ppm":"none", "ppm_text":"none", "window_usage":"none", "profile_complete":"none", "open_finding":"none",
    "queue_tenant_action":"none", "asked_ses_to_pause":"none", "note_cap_use":"none", "reserve_send":"none", "evaluate_account":"none",
    "advance_warmup":"none", "purge_old_emails":"none", "purge_safety_records":"none", "alert_conditions":"none",
    "run_safety_checks":"service_role", "claim_tenant_actions":"service_role", "record_tenant_action":"service_role",
    "ses_findings_of":"none", "e2e_seed_usage":"service_role", "e2e_evaluate":"service_role",
    "admin_mail_approve_account":"authenticated", "admin_mail_reject_account":"authenticated",
    "admin_mail_pause_account":"authenticated", "admin_mail_resume_account":"authenticated",
    "admin_mail_override_caps":"authenticated", "admin_mail_overview":"authenticated",
    "admin_mail_review_queue":"authenticated", "admin_mail_accounts":"authenticated",
    "admin_mail_account":"authenticated", "admin_mail_domains":"authenticated",
    "admin_mail_ses_health":"authenticated", "admin_mail_audit":"authenticated",
    "admin_tier":"none", "current_alert_conditions":"service_role"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where (p.pronamespace = 'mail'::regnamespace or p.pronamespace = 'public'::regnamespace)
                  and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 18: % is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 18: % has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 18: % functions for % names (a second signature, or one missing)', v_n,
      (select count(*) from jsonb_object_keys(v_expected));
  end if;
  foreach v_text in array array['safety_findings', 'tenant_actions', 'reputation_readings', 'cap_notices'] loop
    if has_table_privilege('anon', 'mail.' || v_text, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', 'mail.' || v_text, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', 'mail.' || v_text, 'select, insert, update, delete, truncate')
       or not (select c.relrowsecurity from pg_class c where c.oid = ('mail.' || v_text)::regclass) then
      raise exception 'FAILED 18: mail.% is open to an API role, or has no RLS', v_text;
    end if;
  end loop;
  if exists (select 1 from pg_class c where c.relnamespace = 'mail'::regnamespace and c.relkind = 'S'
               and (has_sequence_privilege('anon', c.oid, 'usage, select, update')
                    or has_sequence_privilege('authenticated', c.oid, 'usage, select, update'))) then
    raise exception 'FAILED 18: a mail sequence is open to the API roles';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 51: % checks passed', v_passed;
end;
$$;

rollback;
