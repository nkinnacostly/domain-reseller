-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 49 (MyDomainsHub Mail: SES events in, suppressions, findings and
-- outbound webhooks), tried as the database owner and, where the grant is the
-- point, as `authenticated` and `service_role`: endpoints and who may manage
-- them, what an SES event queues (and what it never carries), email.failed and
-- domain.* from their triggers, the worker's claim, backoff, give-up and the
-- 3-day disable, resend, the tenant's status never going backwards, findings
-- opened and closed in any order, removing a suppression, RLS, the purge and
-- every new function's grant. People are made up with e2e-*@example.com
-- addresses; nothing is sent. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_events.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.mv_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.mv_service() returns void language plpgsql as $f$
begin
  execute 'set local role service_role';
end $f$;

create function pg_temp.mv_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.mv_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- A sealed secret as the app makes them (v1.<iv>.<ciphertext>), and its hint.
create function pg_temp.mv_sealed(p_c text default 'B') returns text language sql as $f$
  select 'v1.' || repeat('A', 16) || '.' || repeat(p_c, 72)
$f$;

-- Queues one email the way the API does (as service_role) and claims and
-- sends it as the worker would, with this SES message id. Answers its id.
create function pg_temp.mv_sent(p_account uuid, p_from text, p_to text, p_msg text) returns bigint
language plpgsql as $f$
declare
  v_j  jsonb;
  v_id bigint;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_email(p_account, null,
           jsonb_build_object('from', p_from, 'to', jsonb_build_array(p_to), 'subject', 'Hello from the m49 check'),
           '{"html":"<p>Secret body m49</p>","text":"Secret body m49"}'::jsonb);
  if (v_j ->> 'ok')::boolean is not true then
    raise exception 'me_sent: enqueue answered %', v_j;
  end if;
  v_j := mail.claim_sends('m49-sender', 1, false, p_account);
  v_id := (v_j #>> '{0,id}')::bigint;
  if v_id is null then
    raise exception 'me_sent: nothing to claim';
  end if;
  if p_msg is not null then
    v_j := mail.record_send_result(v_id, 'm49-sender', 'sent', p_msg);
  end if;
  execute 'reset role';
  return v_id;
end $f$;

create function pg_temp.mv_event(p_msg text, p_event text, p_key text, p_detail jsonb default '{}',
                                  p_suppress text[] default '{}') returns boolean
language plpgsql as $f$
declare
  v_b boolean;
begin
  execute 'set local role service_role';
  v_b := mail.record_send_event(p_event, p_msg, null, p_key, now(), p_detail, 1, p_suppress);
  execute 'reset role';
  return v_b;
end $f$;

create function pg_temp.mv_tenant(p_id text, p_type text, p_tenant text, p_at timestamptz,
                                   p_status text default null, p_origin text default null,
                                   p_finding text default null, p_impact text default null,
                                   p_summary text default null, p_identity text default null)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.record_tenant_event(p_id, p_type, p_tenant, p_identity,
                                  case when p_tenant is not null
                                       then 'arn:aws:ses:eu-west-2:123456789012:tenant/' || p_tenant || '/t-1' end,
                                  p_at, p_status, p_origin, p_finding, p_impact, p_summary);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_claim(p_limit integer default 100, p_account uuid default null,
                                  p_worker text default 'm49-worker') returns jsonb
language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.claim_webhook_deliveries(p_worker, p_limit, p_account);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_attempt(p_id bigint, p_status integer, p_error text default null,
                                    p_worker text default 'm49-worker', p_response text default null) returns jsonb
language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.record_webhook_attempt(p_id, p_worker, p_status, p_error, p_response, 120);
  execute 'reset role';
  return v_j;
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_a      uuid := gen_random_uuid();
  u_d      uuid := gen_random_uuid();
  u_v      uuid := gen_random_uuid();
  u_n      uuid := gen_random_uuid();
  u_b      uuid := gen_random_uuid();
  m_o      text;
  a_acc    uuid;
  b_acc    uuid;
  a_tenant text;
  n_a      text;
  n_p      text;
  d_p      uuid;
  w1       uuid;
  w2       uuid;
  w3       uuid;
  wb       uuid;
  v_j      jsonb;
  v_j2     jsonb;
  v_e1     bigint;
  v_e2     bigint;
  v_e3     bigint;
  v_id     bigint;
  v_id2    bigint;
  v_n      integer;
  v_text   text;
  v_t0     timestamptz := date_trunc('second', now()) - interval '3 hours';
  v_row    record;
  v_want   text;
  v_expected jsonb;
  v_passed integer := 0;
begin
  m_o := 'e2e-me-o-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), now(), now()),
    (u_a, 'authenticated', 'authenticated', 'e2e-me-a-' || v_tag || '@example.com', now(), now(), now()),
    (u_d, 'authenticated', 'authenticated', 'e2e-me-d-' || v_tag || '@example.com', now(), now(), now()),
    (u_v, 'authenticated', 'authenticated', 'e2e-me-v-' || v_tag || '@example.com', now(), now(), now()),
    (u_n, 'authenticated', 'authenticated', 'e2e-me-n-' || v_tag || '@example.com', now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', 'e2e-me-b-' || v_tag || '@example.com', now(), now(), now());

  perform pg_temp.mv_as(u_o);
  a_acc := (mail.create_account('m49 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mv_as(u_b);
  b_acc := (mail.create_account('m49 B ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled' where id in (a_acc, b_acc);
  select ses_tenant into a_tenant from mail.accounts where id = a_acc;
  insert into mail.members (account_id, user_id, role) values
    (a_acc, u_a, 'admin'), (a_acc, u_d, 'developer'), (a_acc, u_v, 'viewer');
  n_a := 'me-' || v_tag || '.example';
  n_p := 'mp-' || v_tag || '.example';
  insert into mail.domains (account_id, name, status) values (a_acc, n_a, 'verified');
  insert into mail.domains (account_id, name, status) values (a_acc, n_p, 'pending') returning id into d_p;
  insert into mail.domains (account_id, name, status) values (b_acc, 'mb-' || v_tag || '.example', 'verified');

  -- ── 1. Endpoints: who may make them, what is accepted, and what stays sealed.
  if not mail.is_webhook_url('https://hooks.acme.example/mdh?x=1')
     or not mail.is_webhook_url('https://8.8.8.8:8443/in')
     or not mail.is_webhook_url('https://xn--bcher-kva.example/') then
    raise exception 'FAILED 1: a public https endpoint was refused';
  end if;
  if mail.is_webhook_url('http://hooks.acme.example/x') or mail.is_webhook_url('https://localhost/x')
     or mail.is_webhook_url('https://api.localhost/x') or mail.is_webhook_url('https://10.1.2.3/x')
     or mail.is_webhook_url('https://127.0.0.1/x') or mail.is_webhook_url('https://169.254.169.254/latest')
     or mail.is_webhook_url('https://172.20.0.1/x') or mail.is_webhook_url('https://192.168.1.1/x')
     or mail.is_webhook_url('https://100.64.0.1/x') or mail.is_webhook_url('https://0.0.0.0/x')
     or mail.is_webhook_url('https://999.1.1.1/x') or mail.is_webhook_url('https://[::1]/x')
     or mail.is_webhook_url('https://hooks.internal/x') or mail.is_webhook_url('https://nas.local/x')
     or mail.is_webhook_url('https://user:pw@hooks.acme.example/x') or mail.is_webhook_url('https://Hooks.Acme.example/x')
     or mail.is_webhook_url('https://hooks.acme.example:70000/x') or mail.is_webhook_url('https://hooks/x')
     or mail.is_webhook_url('https://hooks.acme.example/a b') or mail.is_webhook_url('https://hooks.acme.example/#frag')
     or mail.is_webhook_url(null) then
    raise exception 'FAILED 1: an endpoint that is not https or not public was accepted';
  end if;

  perform pg_temp.mv_as(u_d);
  v_j := mail.create_webhook(a_acc, 'https://hooks.acme.example/one',
                             array['email.failed', 'email.delivered', 'email.bounced', 'domain.verified', 'email.delivered'],
                             pg_temp.mv_sealed(), 'whsec_abcd', '  Production  ');
  perform pg_temp.mv_ok(v_j, 'FAILED 1: a developer makes an endpoint');
  w1 := (v_j ->> 'webhookId')::uuid;
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'http://hooks.acme.example/x', array['email.sent'],
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'validation', 'FAILED 1: http');
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.opened'],
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'validation', 'FAILED 1: an unknown event');
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', '{}',
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'validation', 'FAILED 1: no events');
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.sent'],
                                              'whsec_plain-text-secret', 'whsec_abcd'), 'validation',
                          'FAILED 1: an unsealed secret');
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.sent'],
                                              pg_temp.mv_sealed(), 'whsec_abcd', repeat('x', 101)), 'validation',
                          'FAILED 1: a long description');
  perform pg_temp.mv_as(u_v);
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.sent'],
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'forbidden', 'FAILED 1: a viewer');
  perform pg_temp.mv_as(u_n);
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.sent'],
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'not_found', 'FAILED 1: a stranger');
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform pg_temp.mv_code(mail.create_webhook(a_acc, 'https://hooks.acme.example/x', array['email.sent'],
                                              pg_temp.mv_sealed(), 'whsec_abcd'), 'unauthorized', 'FAILED 1: no session');
  perform pg_temp.mv_as(u_o);
  w2 := (mail.create_webhook(a_acc, 'https://hooks.acme.example/two', array['email.delivered'],
                             pg_temp.mv_sealed('C'), 'whsec_wxyz') ->> 'webhookId')::uuid;
  w3 := (mail.create_webhook(a_acc, 'https://hooks.acme.example/three', array['email.delivered'],
                             pg_temp.mv_sealed('D'), 'whsec_3333') ->> 'webhookId')::uuid;
  execute 'reset role';
  update mail.settings set webhook_endpoints_max = 3;
  perform pg_temp.mv_as(u_o);
  v_j := mail.create_webhook(a_acc, 'https://hooks.acme.example/four', array['email.sent'],
                             pg_temp.mv_sealed(), 'whsec_abcd');
  perform pg_temp.mv_code(v_j, 'webhook_limit', 'FAILED 1: past the endpoint limit');
  if (v_j ->> 'max')::integer <> 3 then raise exception 'FAILED 1: the limit answered %', v_j; end if;
  perform pg_temp.mv_ok(mail.set_webhook_enabled(w3, false), 'FAILED 1: an owner turns an endpoint off');
  perform pg_temp.mv_as(u_b);
  perform pg_temp.mv_code(mail.update_webhook(w1, 'https://evil.example/x', array['email.sent']), 'not_found',
                          'FAILED 1: another account''s owner edits an endpoint');
  perform pg_temp.mv_code(mail.delete_webhook(w1), 'not_found', 'FAILED 1: another account''s owner deletes it');
  perform pg_temp.mv_code(mail.update_webhook(gen_random_uuid(), 'https://hooks.acme.example/x', array['email.sent']),
                          'not_found', 'FAILED 1: an endpoint that does not exist');
  wb := (mail.create_webhook(b_acc, 'https://hooks.b.example/in', array['email.delivered'],
                             pg_temp.mv_sealed('E'), 'whsec_bbbb') ->> 'webhookId')::uuid;
  perform pg_temp.mv_as(u_v);
  perform pg_temp.mv_code(mail.update_webhook(w1, 'https://hooks.acme.example/one', array['email.sent']), 'forbidden',
                          'FAILED 1: a viewer edits an endpoint');
  perform pg_temp.mv_code(mail.rotate_webhook_secret(w1, pg_temp.mv_sealed('F'), 'whsec_ffff'), 'forbidden',
                          'FAILED 1: a viewer rotates a secret');
  begin
    select secret_sealed into v_text from mail.webhooks limit 1;
    raise exception 'FAILED 1: the sealed secret is readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from mail.webhooks where owner_notice_due;
    raise exception 'FAILED 1: the notice flag is readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into mail.webhooks (account_id, url, events, secret_sealed, secret_hint)
    values (a_acc, 'https://hooks.acme.example/x', array['email.sent'], pg_temp.mv_sealed(), 'whsec_abcd');
    raise exception 'FAILED 1: a member wrote the table';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.mv_as(u_d);
  v_j := mail.update_webhook(w1, 'https://hooks.acme.example/one', array['email.delivered', 'email.bounced',
                             'email.failed', 'domain.verified'], 'Production, eu');
  if v_j -> 'changed' <> '["description"]'::jsonb then raise exception 'FAILED 1: update answered %', v_j; end if;
  perform pg_temp.mv_code(mail.update_webhook(w1, 'https://10.0.0.1/x', array['email.sent']), 'validation',
                          'FAILED 1: an update to a private address');
  perform pg_temp.mv_ok(mail.rotate_webhook_secret(w1, pg_temp.mv_sealed('G'), 'whsec_gggg'), 'FAILED 1: rotate');
  perform pg_temp.mv_code(mail.rotate_webhook_secret(w1, 'v1.short', 'whsec_gggg'), 'validation',
                          'FAILED 1: rotate to an unsealed secret');
  execute 'reset role';
  if (select events from mail.webhooks where id = w1)
       <> array['domain.verified', 'email.bounced', 'email.delivered', 'email.failed']
     or (select description from mail.webhooks where id = w1) <> 'Production, eu'
     or (select secret_hint || right(secret_sealed, 1) from mail.webhooks where id = w1) <> 'whsec_ggggG'
     or (select status || '/' || disabled_reason from mail.webhooks where id = w3) <> 'disabled/customer' then
    raise exception 'FAILED 1: the endpoints were not stored as asked';
  end if;
  select count(*) into v_n from mail.account_audit_log
   where account_id = a_acc and action in ('webhook.created', 'webhook.updated', 'webhook.secret_rotated', 'webhook.disabled')
     and detail::text not like '%whsec%' and detail::text not like '%v1.%';
  if v_n <> 6 then raise exception 'FAILED 1: % audit rows for the endpoints', v_n; end if;
  update mail.settings set webhook_endpoints_max = 10;
  v_passed := v_passed + 1;

  -- ── 2. What an SES event queues: one message per event, to each enabled
  -- endpoint that wants it, with no body; a repeat queues nothing.
  v_e1 := pg_temp.mv_sent(a_acc, 'Acme <hello@' || n_a || '>', m_o, 'm49-' || v_tag || '-1');
  if exists (select 1 from mail.webhook_deliveries where account_id = a_acc) then
    raise exception 'FAILED 2: sending queued a webhook before SES said anything';
  end if;
  if not pg_temp.mv_event('m49-' || v_tag || '-1', 'send', 'k-send') then raise exception 'FAILED 2: send'; end if;
  if exists (select 1 from mail.webhook_deliveries where account_id = a_acc) then
    raise exception 'FAILED 2: email.sent went to endpoints that do not want it';
  end if;
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'delivery', 'k-del');
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'delivery', 'k-del');
  select count(*), count(distinct message_id) into v_n, v_id
    from mail.webhook_deliveries where account_id = a_acc and event_type = 'email.delivered';
  if v_n <> 2 or v_id <> 1
     or exists (select 1 from mail.webhook_deliveries where webhook_id = w3)
     or not exists (select 1 from mail.webhook_deliveries where webhook_id = w1)
     or not exists (select 1 from mail.webhook_deliveries where webhook_id = w2) then
    raise exception 'FAILED 2: a delivery queued % rows with % message ids', v_n, v_id;
  end if;
  select payload into v_j from mail.webhook_deliveries where webhook_id = w1 and event_type = 'email.delivered';
  if v_j ->> 'type' <> 'email.delivered' or v_j #>> '{data,email_id}' <> (select public_id::text from mail.emails where id = v_e1)
     or v_j #>> '{data,to,0}' <> m_o or v_j #>> '{data,subject}' <> 'Hello from the m49 check'
     or v_j ->> 'created_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or v_j::text like '%Secret body%' or v_j::text like '%html%' then
    raise exception 'FAILED 2: the payload was %', v_j;
  end if;
  if (select give_up_at from mail.webhook_deliveries where webhook_id = w1 limit 1)
       not between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
     or (select status || '/' || attempts from mail.webhook_deliveries where webhook_id = w1 limit 1) <> 'pending/0'
     or (select message_id from mail.webhook_deliveries where webhook_id = w1 limit 1) !~ '^msg_[0-9a-f]{32}$' then
    raise exception 'FAILED 2: the delivery''s window, state or id';
  end if;
  -- A permanent bounce: the address SES names is suppressed in both forms, the
  -- payload carries the bounce's codes with every address struck out.
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'bounce', 'k-bounce',
                           jsonb_build_object('bounceType', 'Permanent', 'bounceSubType', 'General',
                                              'diagnosticCode', 'smtp; 550 5.1.1 <' || m_o || '>: no such user'),
                           array[upper(left(m_o, 3)) || substr(m_o, 4), 'E2E-me-x-' || v_tag || '@example.com']);
  select payload into v_j from mail.webhook_deliveries where webhook_id = w1 and event_type = 'email.bounced';
  if v_j #>> '{data,bounce,type}' <> 'Permanent' or v_j #>> '{data,bounce,sub_type}' <> 'General'
     or v_j #>> '{data,bounce,diagnostic}' not like '%[address]%' or v_j #>> '{data,bounce,diagnostic}' like '%@%'
     or exists (select 1 from mail.webhook_deliveries where webhook_id = w2 and event_type = 'email.bounced') then
    raise exception 'FAILED 2: the bounce queued %', v_j;
  end if;
  if (select ses_address from mail.suppressions where account_id = a_acc and address = m_o)
       is distinct from upper(left(m_o, 3)) || substr(m_o, 4)
     or exists (select 1 from mail.suppressions where account_id = a_acc and address like 'e2e-me-x-%') then
    raise exception 'FAILED 2: the suppression kept the wrong addresses or casing';
  end if;
  if (select bounced from mail.usage_daily where account_id = a_acc and day = mail.lagos_day(now())) <> 1
     or (select delivered from mail.usage_daily where account_id = a_acc and day = mail.lagos_day(now())) <> 1 then
    raise exception 'FAILED 2: usage_daily did not count the delivery and the bounce';
  end if;
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'complaint', 'k-comp');
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'delivery_delay', 'k-delay', '{"delayType":"MailboxFull"}');
  if exists (select 1 from mail.webhook_deliveries where account_id = a_acc
              and event_type in ('email.complained', 'email.delivery_delayed', 'email.sent')) then
    raise exception 'FAILED 2: events nobody wants were queued';
  end if;
  if pg_temp.mv_event('nobody-' || v_tag, 'delivery', 'k-x') then raise exception 'FAILED 2: an unknown message'; end if;
  v_passed := v_passed + 1;

  -- ── 3. email.failed comes from the email's status, once, whatever failed it;
  -- domain.verified from the domain's.
  delete from mail.suppressions where account_id = a_acc;
  v_e2 := pg_temp.mv_sent(a_acc, 'hello@' || n_a, m_o, null);
  execute 'set local role service_role';
  perform mail.record_send_result(v_e2, 'm49-sender', 'failed', null, 'MessageRejected');
  execute 'reset role';
  select payload into v_j from mail.webhook_deliveries where webhook_id = w1 and email_id = v_e2;
  if v_j ->> 'type' <> 'email.failed' or v_j #>> '{data,reason}' <> 'messagerejected' then
    raise exception 'FAILED 3: a refused send queued %', v_j;
  end if;
  v_e3 := pg_temp.mv_sent(a_acc, 'hello@' || n_a, m_o, 'm49-' || v_tag || '-3');
  perform pg_temp.mv_event('m49-' || v_tag || '-3', 'reject', 'k-rej', '{"rejectReason":"Bad content"}');
  perform pg_temp.mv_event('m49-' || v_tag || '-3', 'rendering_failure', 'k-rf');
  if (select count(*) from mail.webhook_deliveries where email_id = v_e3) <> 1
     or (select payload #>> '{data,reason}' from mail.webhook_deliveries where email_id = v_e3) <> 'reject' then
    raise exception 'FAILED 3: a rejected email queued % email.failed', (select count(*) from mail.webhook_deliveries
                                                                          where email_id = v_e3);
  end if;
  update mail.domains set status = 'verified', verified_at = now() where id = d_p;
  update mail.domains set updated_at = now() where id = d_p;
  select payload into v_j from mail.webhook_deliveries where webhook_id = w1 and event_type = 'domain.verified';
  if v_j #>> '{data,name}' <> n_p or v_j #>> '{data,domain_id}' <> d_p::text
     or (select count(*) from mail.webhook_deliveries where event_type = 'domain.verified' and account_id = a_acc) <> 1 then
    raise exception 'FAILED 3: a verified domain queued %', v_j;
  end if;
  update mail.domains set status = 'failed', failed_reason = 'dkim_missing' where id = d_p;
  if exists (select 1 from mail.webhook_deliveries where event_type = 'domain.failed') then
    raise exception 'FAILED 3: domain.failed went to an endpoint that does not want it';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. The worker's claim: due deliveries to enabled endpoints, sealed
  -- secret and all; never a test account's unless it is asked for.
  perform pg_temp.mv_as(u_b);
  perform mail.create_webhook(b_acc, 'https://hooks.b.example/two', array['domain.verified'], pg_temp.mv_sealed(),
                              'whsec_bbbb');
  execute 'reset role';
  update mail.accounts set is_e2e = true where id = b_acc;
  update mail.domains set status = 'pending' where account_id = b_acc;
  update mail.domains set status = 'verified' where account_id = b_acc;
  if not exists (select 1 from mail.webhook_deliveries where account_id = b_acc) then
    raise exception 'FAILED 4: the test account''s event was not queued';
  end if;
  v_j := pg_temp.mv_claim(100);
  if exists (select 1 from jsonb_array_elements(v_j) x where (x ->> 'accountId')::uuid = b_acc)
     or jsonb_array_length(v_j) <> (select count(*) from mail.webhook_deliveries where account_id = a_acc) then
    raise exception 'FAILED 4: the worker''s claim answered % rows', jsonb_array_length(v_j);
  end if;
  select x into v_j2 from jsonb_array_elements(v_j) x where (x ->> 'webhookId')::uuid = w2;
  if v_j2 ->> 'url' <> 'https://hooks.acme.example/two' or v_j2 ->> 'secretSealed' <> pg_temp.mv_sealed('C')
     or v_j2 ->> 'messageId' !~ '^msg_' or (v_j2 ->> 'attempt')::integer <> 1 or v_j2 #>> '{payload,type}' <> 'email.delivered'
     or (select status || '/' || claimed_by from mail.webhook_deliveries where id = (v_j2 ->> 'id')::bigint)
          <> 'delivering/m49-worker' then
    raise exception 'FAILED 4: a claimed delivery was %', v_j2;
  end if;
  if jsonb_array_length(pg_temp.mv_claim(100)) <> 0 then raise exception 'FAILED 4: claimed twice'; end if;
  if jsonb_array_length(pg_temp.mv_claim(100, b_acc)) <> 1 then
    raise exception 'FAILED 4: a test account''s own claim';
  end if;
  begin
    perform pg_temp.mv_claim(0);
    raise exception 'FAILED 4: a limit of 0';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  v_passed := v_passed + 1;

  -- ── 5. Answers: 2xx delivers and heals the endpoint; anything else backs off
  -- (30 s, then 2 minutes…) within the 24 hours, then gives up; only the claim's
  -- holder may record; the history keeps the last twenty.
  v_id := (v_j2 ->> 'id')::bigint;
  perform pg_temp.mv_code(pg_temp.mv_attempt(v_id, 200, null, 'someone-else'), 'not_claimed', 'FAILED 5: another worker');
  update mail.webhooks set failing_since = now() - interval '1 hour' where id = w2;
  v_j := pg_temp.mv_attempt(v_id, 204, null, 'm49-worker', E'ok\u0007thanks');
  if v_j ->> 'status' <> 'delivered'
     or (select status || '/' || last_status_code || '/' || last_response || '/' || jsonb_array_length(history)
           from mail.webhook_deliveries where id = v_id) <> 'delivered/204/ok thanks/1'
     or (select failing_since from mail.webhooks where id = w2) is not null
     or (select last_success_at from mail.webhooks where id = w2) is null then
    raise exception 'FAILED 5: a 204 answered %', v_j;
  end if;
  perform pg_temp.mv_code(pg_temp.mv_attempt(v_id, 200), 'not_claimed', 'FAILED 5: recorded twice');
  select id into v_id from mail.webhook_deliveries
   where webhook_id = w1 and event_type = 'email.delivered';
  v_j := pg_temp.mv_attempt(v_id, 500, null, 'm49-worker', repeat('x', 900));
  if v_j ->> 'status' <> 'pending'
     or (select next_attempt_at from mail.webhook_deliveries where id = v_id)
          not between now() + interval '29 seconds' and now() + interval '31 seconds'
     or (select last_error || '/' || char_length(last_response) from mail.webhook_deliveries where id = v_id) <> 'http_status/500'
     or (select failing_since from mail.webhooks where id = w1) is null then
    raise exception 'FAILED 5: a 500 answered %', v_j;
  end if;
  update mail.webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = v_id;
  v_j := pg_temp.mv_claim(1, a_acc);
  if (v_j #>> '{0,id}')::bigint <> v_id or (v_j #>> '{0,attempt}')::integer <> 2 then
    raise exception 'FAILED 5: the retry was claimed as %', v_j;
  end if;
  v_j := pg_temp.mv_attempt(v_id, null, 'Timeout!');
  if (select next_attempt_at from mail.webhook_deliveries where id = v_id)
       not between now() + interval '119 seconds' and now() + interval '121 seconds'
     or (select last_error from mail.webhook_deliveries where id = v_id) <> 'timeout'
     or (select history -> 1 ->> 'error' from mail.webhook_deliveries where id = v_id) <> 'timeout' then
    raise exception 'FAILED 5: a timeout answered %', v_j;
  end if;
  -- The last attempt is never later than the window's end, and after it, none.
  update mail.webhook_deliveries set give_up_at = now() + interval '10 seconds', attempts = 6,
                                     next_attempt_at = now() - interval '1 second' where id = v_id;
  perform pg_temp.mv_claim(1, a_acc);
  perform pg_temp.mv_attempt(v_id, 502);
  if (select next_attempt_at from mail.webhook_deliveries where id = v_id) > now() + interval '10 seconds' then
    raise exception 'FAILED 5: a retry was set after the window';
  end if;
  update mail.webhook_deliveries set give_up_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
   where id = v_id;
  perform pg_temp.mv_claim(1, a_acc);
  v_j := pg_temp.mv_attempt(v_id, 503);
  if (select status || '/' || status_reason from mail.webhook_deliveries where id = v_id) <> 'failed/gave_up' then
    raise exception 'FAILED 5: past its window it answered %', v_j;
  end if;
  -- Twenty-two answers keep twenty.
  update mail.webhook_deliveries set status = 'pending', give_up_at = now() + interval '1 day' where id = v_id;
  for i in 1..17 loop
    update mail.webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = v_id;
    update mail.webhooks set failing_since = null where id = w1;
    perform pg_temp.mv_claim(1, a_acc);
    perform pg_temp.mv_attempt(v_id, 500);
  end loop;
  if (select jsonb_array_length(history) from mail.webhook_deliveries where id = v_id) <> 20 then
    raise exception 'FAILED 5: the history kept % answers', (select jsonb_array_length(history)
                                                              from mail.webhook_deliveries where id = v_id);
  end if;
  begin
    perform pg_temp.mv_attempt(v_id, 99);
    raise exception 'FAILED 5: an HTTP status of 99';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  -- A claim left for five minutes is somebody else's to try.
  update mail.webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = v_id;
  perform pg_temp.mv_claim(1, a_acc, 'm49-gone');
  update mail.webhook_deliveries set claimed_at = now() - interval '6 minutes' where id = v_id;
  v_j := pg_temp.mv_claim(1, a_acc);
  if (v_j #>> '{0,id}')::bigint is distinct from v_id
     or (select claimed_by from mail.webhook_deliveries where id = v_id) <> 'm49-worker' then
    raise exception 'FAILED 5: a lost claim was not taken again: %', v_j;
  end if;
  update mail.webhooks set failing_since = null where id = w1;
  v_j := pg_temp.mv_attempt(v_id, null, 'secret_unreadable');
  if (select status || '/' || status_reason from mail.webhook_deliveries where id = v_id) <> 'failed/secret_unreadable'
     or (select failing_since from mail.webhooks where id = w1) is not null then
    raise exception 'FAILED 5: our own failure counted against the endpoint';
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Resend: the same message, a new delivery; not while it is being
  -- tried, not to an endpoint that is off; owners, admins and developers.
  select id into v_id from mail.webhook_deliveries where webhook_id = w2 and status = 'delivered' limit 1;
  perform pg_temp.mv_as(u_v);
  perform pg_temp.mv_code(mail.resend_webhook_delivery(v_id), 'forbidden', 'FAILED 6: a viewer resends');
  perform pg_temp.mv_as(u_n);
  perform pg_temp.mv_code(mail.resend_webhook_delivery(v_id), 'not_found', 'FAILED 6: a stranger resends');
  perform pg_temp.mv_code(mail.resend_webhook_delivery(-1), 'not_found', 'FAILED 6: no such delivery');
  perform pg_temp.mv_as(u_d);
  v_j := mail.resend_webhook_delivery(v_id);
  perform pg_temp.mv_ok(v_j, 'FAILED 6: a developer resends');
  v_id2 := (v_j ->> 'deliveryId')::bigint;
  perform pg_temp.mv_code(mail.resend_webhook_delivery(v_id), 'in_progress', 'FAILED 6: a second resend while one waits');
  perform pg_temp.mv_code(mail.resend_webhook_delivery(v_id2), 'in_progress', 'FAILED 6: resending one that waits');
  execute 'reset role';
  if (select message_id from mail.webhook_deliveries where id = v_id2)
       <> (select message_id from mail.webhook_deliveries where id = v_id)
     or (select status || '/' || attempts || '/' || resend_of from mail.webhook_deliveries where id = v_id2)
          <> 'pending/0/' || v_id then
    raise exception 'FAILED 6: the resend was not the same message, waiting';
  end if;
  perform pg_temp.mv_as(u_d);
  perform pg_temp.mv_ok(mail.set_webhook_enabled(w2, false), 'FAILED 6: a developer turns an endpoint off');
  perform pg_temp.mv_code(mail.resend_webhook_delivery(v_id), 'webhook_disabled', 'FAILED 6: resend to an endpoint off');
  execute 'reset role';
  if (select status || '/' || status_reason from mail.webhook_deliveries where id = v_id2) <> 'failed/endpoint_disabled' then
    raise exception 'FAILED 6: turning the endpoint off left its delivery waiting';
  end if;
  update mail.webhooks set failing_since = now() - interval '1 day' where id = w2;
  perform pg_temp.mv_as(u_d);
  perform pg_temp.mv_ok(mail.set_webhook_enabled(w2, true), 'FAILED 6: back on');
  v_j := mail.set_webhook_enabled(w2, true);
  if (v_j ->> 'already')::boolean is not true then raise exception 'FAILED 6: on twice answered %', v_j; end if;
  execute 'reset role';
  if (select status || '/' || coalesce(disabled_reason, '-') || '/' || coalesce(failing_since::text, '-')
        from mail.webhooks where id = w2) <> 'enabled/-/-' then
    raise exception 'FAILED 6: an endpoint back on kept its failures';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. Three days without a 2xx: the endpoint is disabled, what waited for it
  -- fails, its owner's notice is due and the account log says why.
  perform pg_temp.mv_event('m49-' || v_tag || '-3', 'delivery', 'k-del-3');
  select id into v_id from mail.webhook_deliveries where webhook_id = w2 and email_id = v_e3;
  select id into v_id2 from mail.webhook_deliveries where webhook_id = w1 and email_id = v_e3 and event_type = 'email.delivered';
  update mail.webhooks set failing_since = now() - interval '3 days 1 minute' where id = w2;
  update mail.webhook_deliveries set next_attempt_at = now() + interval '1 hour' where id = v_id2;
  v_j := pg_temp.mv_claim(1, a_acc);
  if (v_j #>> '{0,id}')::bigint is distinct from v_id then
    raise exception 'FAILED 7: claimed % for the failing endpoint', v_j;
  end if;
  -- Another message waiting for the same endpoint.
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'delivery', 'k-del-again');
  v_j := pg_temp.mv_attempt(v_id, 500);
  if (v_j ->> 'disabled')::boolean is not true
     or (select status || '/' || disabled_reason || '/' || owner_notice_due from mail.webhooks where id = w2)
          <> 'disabled/failing/true'
     or exists (select 1 from mail.webhook_deliveries where webhook_id = w2 and status in ('pending', 'delivering'))
     or (select status_reason from mail.webhook_deliveries where id = v_id) <> 'endpoint_disabled'
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and actor = 'system'
                     and action = 'webhook.disabled' and target = w2::text and detail ->> 'reason' = 'failing') then
    raise exception 'FAILED 7: three days of failures answered %', v_j;
  end if;
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'delivery', 'k-del-after');
  if exists (select 1 from mail.webhook_deliveries where webhook_id = w2 and status = 'pending') then
    raise exception 'FAILED 7: a disabled endpoint was queued';
  end if;
  perform pg_temp.mv_as(u_o);
  perform pg_temp.mv_ok(mail.set_webhook_enabled(w2, true), 'FAILED 7: the owner turns it back on');
  execute 'reset role';
  if (select owner_notice_due from mail.webhooks where id = w2) then
    raise exception 'FAILED 7: the notice stayed due after the endpoint came back';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. The tenant's status (EventBridge): set, never backwards, a finding
  -- while SES has paused it; a pause stops sending (MR5: nothing unpauses here).
  perform pg_temp.mv_code(pg_temp.mv_tenant('ev-unknown-' || v_tag, 'sending_status', 'mdm-ffffffffff', v_t0, 'DISABLED'),
                          null, 'FAILED 8: unknown tenant');
  if (pg_temp.mv_tenant('ev-unknown-' || v_tag, 'sending_status', 'mdm-ffffffffff', v_t0, 'DISABLED') ->> 'known')::boolean then
    raise exception 'FAILED 8: an unknown tenant was known';
  end if;
  v_j := pg_temp.mv_tenant('ev-1-' || v_tag, 'sending_status', a_tenant, v_t0, 'DISABLED', 'AWS_MANAGED', null, null,
                           'Paused for high bounces to bob@example.net.');
  if v_j ->> 'sesStatus' <> 'disabled'
     or (select ses_status || '/' || ses_status_at from mail.accounts where id = a_acc) <> 'disabled/' || v_t0
     or not exists (select 1 from mail.findings where account_id = a_acc and kind = 'sending_paused' and resolved_at is null
                     and impact = 'high' and detail ->> 'origin' = 'AWS_MANAGED' and summary like '%[address]%'
                     and summary not like '%@%' and resource_arn like '%:tenant/' || a_tenant || '/%')
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'ses.sending_paused') then
    raise exception 'FAILED 8: a pause answered %', v_j;
  end if;
  execute 'set local role service_role';
  v_j := mail.enqueue_email(a_acc, null, jsonb_build_object('from', 'hello@' || n_a, 'to', jsonb_build_array(m_o),
                                                            'subject', 'paused?'), '{"text":"x"}');
  execute 'reset role';
  perform pg_temp.mv_code(v_j, 'account_paused', 'FAILED 8: a paused tenant still queued');
  if (pg_temp.mv_tenant('ev-1-' || v_tag, 'sending_status', a_tenant, v_t0, 'DISABLED') ->> 'applied')::boolean
     or (pg_temp.mv_tenant('ev-0-' || v_tag, 'sending_status', a_tenant, v_t0 - interval '1 hour', 'ENABLED') ->> 'applied')::boolean
     or (pg_temp.mv_tenant('ev-0b-' || v_tag, 'sending_status', a_tenant, v_t0, 'ENABLED') ->> 'applied')::boolean
     or (select ses_status from mail.accounts where id = a_acc) <> 'disabled'
     or (select count(*) from mail.findings where account_id = a_acc and kind = 'sending_paused') <> 1 then
    raise exception 'FAILED 8: a repeated or older status moved it';
  end if;
  v_j := pg_temp.mv_tenant('ev-2-' || v_tag, 'sending_status', a_tenant, v_t0 + interval '1 hour', 'ENABLED', 'CUSTOMER_MANAGED');
  if (select ses_status from mail.accounts where id = a_acc) <> 'enabled'
     or exists (select 1 from mail.findings where account_id = a_acc and kind = 'sending_paused' and resolved_at is null)
     or (select resolve_event from mail.findings where account_id = a_acc and kind = 'sending_paused') <> 'ev-2-' || v_tag
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'ses.sending_resumed') then
    raise exception 'FAILED 8: sending enabled answered %', v_j;
  end if;
  perform pg_temp.mv_tenant('ev-3-' || v_tag, 'sending_status', a_tenant, v_t0 + interval '2 hours', 'REINSTATED');
  if (select ses_status from mail.accounts where id = a_acc) <> 'reinstated' then
    raise exception 'FAILED 8: reinstated';
  end if;
  begin
    perform pg_temp.mv_tenant('ev-4-' || v_tag, 'sending_status', a_tenant, now(), 'PAUSED');
    raise exception 'FAILED 8: an unknown status';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  begin
    perform pg_temp.mv_tenant('', 'sending_status', a_tenant, now(), 'ENABLED');
    raise exception 'FAILED 8: no event id';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  begin
    perform pg_temp.mv_tenant('ev-5-' || v_tag, 'email_opened', a_tenant, now());
    raise exception 'FAILED 8: not a tenant event';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  update mail.accounts set ses_status = 'enabled' where id = a_acc;
  v_passed := v_passed + 1;

  -- ── 9. Findings: opened and closed by SES's recommendations, once each, in
  -- any order; an identity's recommendation finds its domain's account.
  v_j := pg_temp.mv_tenant('ev-b1-' || v_tag, 'advisor_open', a_tenant, v_t0, null, null, 'BOUNCE', 'HIGH',
                           'The bounce rate exceeded 15.0% based on a representative volume of 664 emails.');
  perform pg_temp.mv_tenant('ev-b2-' || v_tag, 'advisor_open', a_tenant, v_t0 + interval '10 minutes', null, null,
                            'BOUNCE', 'LOW', 'The bounce rate exceeded 5.0%.');
  perform pg_temp.mv_tenant('ev-b2-' || v_tag, 'advisor_open', a_tenant, v_t0 + interval '10 minutes', null, null,
                            'BOUNCE', 'HIGH', 'repeat');
  if (select count(*) from mail.findings where account_id = a_acc and kind = 'bounce') <> 1
     or (select impact || '/' || summary || '/' || opened_at from mail.findings where account_id = a_acc and kind = 'bounce')
          <> 'low/The bounce rate exceeded 5.0%./' || v_t0 then
    raise exception 'FAILED 9: the bounce finding was %', (select to_jsonb(f) from mail.findings f
                                                           where account_id = a_acc and kind = 'bounce');
  end if;
  perform pg_temp.mv_tenant('ev-b3-' || v_tag, 'advisor_resolved', a_tenant, v_t0 + interval '1 hour', null, null, 'BOUNCE');
  if exists (select 1 from mail.findings where account_id = a_acc and kind = 'bounce' and resolved_at is null) then
    raise exception 'FAILED 9: the bounce finding stayed open';
  end if;
  -- Resolved before its opening arrives: the late opening is old news.
  perform pg_temp.mv_tenant('ev-c1-' || v_tag, 'advisor_resolved', a_tenant, v_t0 + interval '1 hour', null, null, 'COMPLAINT');
  v_j := pg_temp.mv_tenant('ev-c2-' || v_tag, 'advisor_open', a_tenant, v_t0, null, null, 'COMPLAINT', 'HIGH', 'Complaints.');
  if (v_j ->> 'applied')::boolean
     or exists (select 1 from mail.findings where account_id = a_acc and kind = 'complaint' and resolved_at is null) then
    raise exception 'FAILED 9: a late opening reopened a resolved finding: %', v_j;
  end if;
  -- An opening after a resolution stands; a resolution older than it does not close it.
  perform pg_temp.mv_tenant('ev-c3-' || v_tag, 'advisor_open', a_tenant, v_t0 + interval '2 hours', null, null,
                            'COMPLAINT', 'HIGH', 'Complaints again.');
  v_j := pg_temp.mv_tenant('ev-c4-' || v_tag, 'advisor_resolved', a_tenant, v_t0 + interval '90 minutes', null, null,
                           'COMPLAINT');
  if (v_j ->> 'applied')::boolean
     or not exists (select 1 from mail.findings where account_id = a_acc and kind = 'complaint' and resolved_at is null) then
    raise exception 'FAILED 9: an older resolution closed a newer finding: %', v_j;
  end if;
  v_j := pg_temp.mv_tenant('ev-i1-' || v_tag, 'advisor_open', null, v_t0, null, null, null, null,
                           'SPF record was not found.', upper(n_a));
  if (v_j ->> 'known')::boolean is not true
     or not exists (select 1 from mail.findings where account_id = a_acc and kind ~ '^advisor_[0-9a-f]{12}$'
                     and summary = 'SPF record was not found.' and resolved_at is null) then
    raise exception 'FAILED 9: an identity''s recommendation answered %', v_j;
  end if;
  begin
    perform pg_temp.mv_tenant('ev-i2-' || v_tag, 'advisor_open', a_tenant, v_t0);
    raise exception 'FAILED 9: a finding with no type and no words';
  exception when invalid_parameter_value then execute 'reset role';
  end;
  v_passed := v_passed + 1;

  -- ── 10. Removing a suppression: owners and admins, after SES; the log keeps
  -- why, never the address.
  perform pg_temp.mv_event('m49-' || v_tag || '-1', 'complaint', 'k-comp-2', '{}', array[m_o]);
  select id into v_id from mail.suppressions where account_id = a_acc and address = m_o;
  if v_id is null then raise exception 'FAILED 10: the complaint did not suppress'; end if;
  perform pg_temp.mv_as(u_v);
  perform pg_temp.mv_code(mail.remove_suppression(v_id), 'forbidden', 'FAILED 10: a viewer');
  perform pg_temp.mv_as(u_d);
  perform pg_temp.mv_code(mail.remove_suppression(v_id), 'forbidden', 'FAILED 10: a developer');
  perform pg_temp.mv_as(u_b);
  perform pg_temp.mv_code(mail.remove_suppression(v_id), 'not_found', 'FAILED 10: another account''s owner');
  perform pg_temp.mv_as(u_a);
  perform pg_temp.mv_ok(mail.remove_suppression(v_id), 'FAILED 10: an admin');
  perform pg_temp.mv_code(mail.remove_suppression(v_id), 'not_found', 'FAILED 10: removed twice');
  execute 'reset role';
  if exists (select 1 from mail.suppressions where id = v_id)
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'suppression.removed'
                     and target = v_id::text and detail ->> 'reason' = 'complaint' and detail::text not like '%@%') then
    raise exception 'FAILED 10: the removal was not done or not logged';
  end if;
  v_passed := v_passed + 1;

  -- ── 11. RLS: members read their account's endpoints, deliveries and
  -- findings; strangers and other accounts nothing; service_role no table.
  perform pg_temp.mv_as(u_v);
  if not exists (select 1 from mail.webhooks where id = w1) or not exists (select 1 from mail.webhook_deliveries)
     or not exists (select 1 from mail.findings) or exists (select 1 from mail.webhooks where id = wb)
     or exists (select 1 from mail.webhook_deliveries where account_id = b_acc) then
    raise exception 'FAILED 11: a viewer reads the wrong rows';
  end if;
  perform pg_temp.mv_as(u_n);
  if exists (select 1 from mail.webhooks) or exists (select 1 from mail.webhook_deliveries)
     or exists (select 1 from mail.findings) then
    raise exception 'FAILED 11: a stranger reads an account''s webhooks';
  end if;
  begin
    perform 1 from mail.webhook_deliveries where claimed_by is not null;
    raise exception 'FAILED 11: the claim is readable';
  exception when insufficient_privilege then null;
  end;
  begin
    update mail.findings set resolved_at = now();
    raise exception 'FAILED 11: a member wrote findings';
  exception when insufficient_privilege then null;
  end;
  execute 'set local role service_role';
  begin
    perform 1 from mail.webhooks;
    raise exception 'FAILED 11: service_role reads the endpoints';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 12. The purge: a finished delivery goes when the plan's log does (Free:
  -- 7 days); one still being tried stays.
  update mail.webhook_deliveries set created_at = now() - interval '8 days'
   where id = (select min(id) from mail.webhook_deliveries where account_id = a_acc and status = 'delivered');
  select min(id) into v_id from mail.webhook_deliveries where account_id = a_acc and status = 'delivered'
     and created_at < now() - interval '7 days';
  update mail.webhook_deliveries set created_at = now() - interval '6 days'
   where id = (select max(id) from mail.webhook_deliveries where account_id = a_acc and status = 'failed');
  select max(id) into v_id2 from mail.webhook_deliveries where account_id = a_acc and status = 'failed';
  update mail.webhook_deliveries set created_at = now() - interval '30 days'
   where account_id = a_acc and status = 'pending';
  v_n := (select count(*) from mail.webhook_deliveries where account_id = a_acc and status = 'pending');
  perform mail.purge_webhook_deliveries();
  if exists (select 1 from mail.webhook_deliveries where id = v_id)
     or not exists (select 1 from mail.webhook_deliveries where id = v_id2)
     or (select count(*) from mail.webhook_deliveries where account_id = a_acc and status = 'pending') <> v_n then
    raise exception 'FAILED 12: the purge took the wrong deliveries';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mail-purge-webhook-deliveries' and schedule = '23 3 * * *') then
    raise exception 'FAILED 12: the daily purge is not scheduled';
  end if;
  v_passed := v_passed + 1;

  -- ── 13. Deleting an endpoint takes its deliveries; it is logged.
  perform pg_temp.mv_as(u_d);
  perform pg_temp.mv_ok(mail.delete_webhook(w1), 'FAILED 13: a developer deletes an endpoint');
  perform pg_temp.mv_code(mail.delete_webhook(w1), 'not_found', 'FAILED 13: deleted twice');
  execute 'reset role';
  if exists (select 1 from mail.webhook_deliveries where webhook_id = w1)
     or not exists (select 1 from mail.account_audit_log where action = 'webhook.deleted' and target = w1::text) then
    raise exception 'FAILED 13: the endpoint''s deliveries stayed, or the log missed it';
  end if;
  v_passed := v_passed + 1;

  -- ── 14. Migration 49's functions, each granted to exactly the role it names;
  -- the new tables have RLS and are closed to writes.
  v_expected := '{
    "iso_time":"none", "is_webhook_url":"none", "webhook_event_list":"none", "is_sealed_secret":"none",
    "email_webhook_data":"none", "queue_webhook_event":"none", "record_send_event":"service_role",
    "webhook_on_email_failed":"none", "webhook_on_domain_status":"none", "record_tenant_event":"service_role",
    "create_webhook":"authenticated", "webhook_for_caller":"none", "update_webhook":"authenticated",
    "set_webhook_enabled":"authenticated", "rotate_webhook_secret":"authenticated", "delete_webhook":"authenticated",
    "resend_webhook_delivery":"authenticated", "remove_suppression":"authenticated",
    "claim_webhook_deliveries":"service_role", "record_webhook_attempt":"service_role",
    "purge_webhook_deliveries":"none"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') or has_function_privilege('public', v_row.oid, 'execute') then
      raise exception 'FAILED 14: mail.% is executable by anyone', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 14: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 14: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'mail'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')) then
    raise exception 'FAILED 14: a security definer function in mail has no empty search_path';
  end if;
  for v_row in select c.oid, c.relname, c.relrowsecurity from pg_class c
                where c.relnamespace = 'mail'::regnamespace and c.relname in ('findings', 'webhooks', 'webhook_deliveries') loop
    if not v_row.relrowsecurity
       or has_table_privilege('anon', v_row.oid, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', v_row.oid, 'select, insert, update, delete, truncate') then
      raise exception 'FAILED 14: mail.% is open to an API role', v_row.relname;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'mail.webhooks', 'secret_sealed', 'select')
     or has_column_privilege('authenticated', 'mail.webhooks', 'owner_notice_due', 'select')
     or has_column_privilege('authenticated', 'mail.webhook_deliveries', 'claimed_by', 'select')
     or not has_column_privilege('authenticated', 'mail.webhooks', 'secret_hint', 'select')
     or not has_column_privilege('authenticated', 'mail.suppressions', 'ses_address', 'select') then
    raise exception 'FAILED 14: the column grants are wrong';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 49: % checks passed', v_passed;
end;
$$;

rollback;
