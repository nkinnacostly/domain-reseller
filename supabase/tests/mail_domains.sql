-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 47 (MyDomainsHub Mail, domains and SES tenant provisioning),
-- tried as the database owner and as `anon`, `authenticated` and
-- `service_role`: claims and their rules (§5: one claim per name, 72 hours to
-- prove it, reserved names, the plan's count), the set-up steps and checks
-- under a lease, failing and releasing a claim, removal refused while emails
-- wait, provisioning to `tenant_ready_at` and Strict → Standard after 30 days
-- (§4.1), the sandbox sender (§7.2), the API's domain functions (§6: a
-- full-access key only), the job route's token, the two sides (real SES
-- never takes a test account), RLS, and every grant. People are
-- made up inside the transaction; nothing reaches AWS (pg_net's queue is
-- rolled back with the rest).
--
--   supabase db query --linked -f supabase/tests/mail_domains.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.md_as(p_uid uuid) returns void language plpgsql as $f$
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

create function pg_temp.md_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.md_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- The service role's calls, each as service_role (the job route's key).
create function pg_temp.md_claim_domains(p_worker text, p_e2e boolean, p_domain uuid default null,
                                         p_account uuid default null)
returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  v := mail.claim_domain_work(p_worker, 50, p_e2e, p_domain, p_account);
  execute 'reset role';
  return v;
end $f$;

create function pg_temp.md_claim_accounts(p_worker text, p_e2e boolean, p_account uuid default null)
returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  v := mail.claim_provisioning_work(p_worker, 50, p_e2e, p_account);
  execute 'reset role';
  return v;
end $f$;

create function pg_temp.md_step(p_domain uuid, p_worker text, p_step text, p_detail jsonb default '{}')
returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  v := mail.record_domain_step(p_domain, p_worker, p_step, p_detail);
  execute 'reset role';
  return v;
end $f$;

create function pg_temp.md_check(p_domain uuid, p_worker text, p_state jsonb)
returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  v := mail.record_domain_check(p_domain, p_worker, p_state);
  execute 'reset role';
  return v;
end $f$;

create function pg_temp.md_prov(p_account uuid, p_worker text, p_step text, p_detail jsonb default '{}')
returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  v := mail.record_provisioning(p_account, p_worker, p_step, p_detail);
  execute 'reset role';
  return v;
end $f$;

-- The ids in a claim's answer.
create function pg_temp.md_ids(p_j jsonb, p_key text default 'id') returns uuid[] language sql as $f$
  select coalesce(array_agg((e ->> p_key)::uuid), '{}') from jsonb_array_elements(p_j) e
$f$;

create function pg_temp.md_item(p_j jsonb, p_key text, p_id uuid) returns jsonb language sql as $f$
  select e from jsonb_array_elements(p_j) e where (e ->> p_key)::uuid = p_id limit 1
$f$;

do $$
declare
  v_tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner    uuid := gen_random_uuid();
  u_dev      uuid := gen_random_uuid();
  u_view     uuid := gen_random_uuid();
  u_none     uuid := gen_random_uuid();
  u_other    uuid := gen_random_uuid();
  u_real     uuid := gen_random_uuid();
  a_acc      uuid;
  b_acc      uuid;
  r_acc      uuid;
  d_one      uuid;
  d_two      uuid;
  d_three    uuid;
  d_real     uuid;
  d_b        uuid;
  d_sand     uuid;
  n_one      text;
  n_two      text;
  n_three    text;
  n_real     text;
  v_j        jsonb;
  v_item     jsonb;
  v_n        integer;
  v_text     text;
  v_token    text;
  v_dom      mail.domains;
  v_tp       mail.tenant_provisioning;
  v_acct     mail.accounts;
  v_arn      text;
  v_tokens   jsonb := '["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3"]';
  v_row      record;
  v_want     text;
  v_expected jsonb;
  v_r        jsonb[] := '{}';
  k_full     uuid;
  k_send     uuid;
  k_old      uuid;
  k_real     uuid;
  v_ids      uuid[];
  v_passed   integer := 0;
begin
  n_one := 'one-' || v_tag || '.example';
  n_two := 'two-' || v_tag || '.example';
  n_three := 'three-' || v_tag || '.example';
  n_real := 'real-' || v_tag || '.example';
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-m47-o-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_dev,   'authenticated', 'authenticated', 'e2e-m47-d-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_view,  'authenticated', 'authenticated', 'e2e-m47-v-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_none,  'authenticated', 'authenticated', 'e2e-m47-n-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_other, 'authenticated', 'authenticated', 'e2e-m47-b-' || v_tag || '@example.com', now(), '{}', now(), now()),
    -- Not an e2e address: the real side's account (nothing here reaches SES).
    (u_real,  'authenticated', 'authenticated', 'm47-real-' || v_tag || '@example.com', now(), '{}', now(), now());

  perform pg_temp.md_as(u_owner);
  a_acc := (mail.create_account('m47 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.md_as(u_other);
  b_acc := (mail.create_account('m47 B ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.md_as(u_real);
  r_acc := (mail.create_account('m47 R ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values
    (a_acc, u_dev, 'developer'), (a_acc, u_view, 'viewer');

  -- ── 1. A new account gets its provisioning row; a real one asks the route at once.
  if (select count(*) from mail.tenant_provisioning where account_id in (a_acc, b_acc, r_acc)) is distinct from 3 then
    raise exception 'FAILED 1: an account has no provisioning row';
  end if;
  if not exists (select 1 from net.http_request_queue q
                  where q.body is not null and convert_from(q.body, 'utf8')::jsonb ->> 'accountId' = r_acc::text) then
    raise exception 'FAILED 1: the real account did not ask the job route';
  end if;
  if exists (select 1 from net.http_request_queue q
              where q.body is not null and convert_from(q.body, 'utf8')::jsonb ->> 'accountId' in (a_acc::text, b_acc::text)) then
    raise exception 'FAILED 1: a test account asked the job route';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Signed out, nobody reaches any of it; a signed-in person reaches no job function.
  perform pg_temp.md_as(null);
  begin
    perform mail.add_domain(a_acc, n_one);
    raise exception 'FAILED 2: anon could add a domain';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.md_as(u_owner);
  begin
    perform mail.claim_domain_work('me', 1, true);
    raise exception 'FAILED 2: a signed-in person could claim domain work';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.record_provisioning(a_acc, 'me', 'done', '{}');
    raise exception 'FAILED 2: a signed-in person could record provisioning';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.begin_ses_jobs('x');
    raise exception 'FAILED 2: a signed-in person could open the job route';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 3. add_domain: who may, what names, one claim, the plan's count (§5).
  perform pg_temp.md_as(u_view);
  perform pg_temp.md_code(mail.add_domain(a_acc, n_one), 'forbidden', 'FAILED 3: a viewer added a domain');
  perform pg_temp.md_as(u_none);
  perform pg_temp.md_code(mail.add_domain(a_acc, n_one), 'not_found', 'FAILED 3: a stranger added a domain');
  perform pg_temp.md_as(u_owner);
  perform pg_temp.md_code(mail.add_domain(a_acc, 'mydomainshub.com'), 'reserved', 'FAILED 3: mydomainshub.com');
  perform pg_temp.md_code(mail.add_domain(a_acc, 'Mail.MyDomainsHub.com.'), 'reserved', 'FAILED 3: a subdomain of ours');
  perform pg_temp.md_code(mail.add_domain(a_acc, 'not a domain'), 'validation', 'FAILED 3: spaces');
  perform pg_temp.md_code(mail.add_domain(a_acc, 'localhost'), 'validation', 'FAILED 3: one label');
  perform pg_temp.md_code(mail.add_domain(a_acc, repeat('a', 60) || '.' || repeat('b', 60) || '.'
                                                 || repeat('c', 60) || '.' || repeat('d', 30) || '.example'),
                          'validation', 'FAILED 3: too long for its DKIM records');
  v_j := mail.add_domain(a_acc, '  ' || upper(n_one) || '. ');
  perform pg_temp.md_ok(v_j, 'FAILED 3: the owner adds a domain');
  d_one := (v_j ->> 'domainId')::uuid;
  if v_j ->> 'name' is distinct from n_one then
    raise exception 'FAILED 3: the name was not lower-cased and trimmed (%)', v_j;
  end if;
  v_j := mail.add_domain(a_acc, n_one);
  perform pg_temp.md_code(v_j, 'already_added', 'FAILED 3: added twice');
  if (v_j ->> 'domainId')::uuid is distinct from d_one then raise exception 'FAILED 3: already_added names another row'; end if;
  -- The Free plan holds one domain.
  v_j := mail.add_domain(a_acc, n_two);
  perform pg_temp.md_code(v_j, 'domain_limit', 'FAILED 3: past the Free plan''s one domain');
  if (v_j ->> 'max')::integer is distinct from 1 then raise exception 'FAILED 3: the limit is not the plan''s (%)', v_j; end if;
  execute 'reset role';
  update mail.accounts set plan_code = 'pro' where id in (a_acc, b_acc);
  perform pg_temp.md_as(u_dev);
  v_j := mail.add_domain(a_acc, n_two);
  perform pg_temp.md_ok(v_j, 'FAILED 3: a developer adds a domain');
  d_two := (v_j ->> 'domainId')::uuid;
  -- Another account cannot take a name someone is still proving.
  perform pg_temp.md_as(u_other);
  v_j := mail.add_domain(b_acc, n_one);
  perform pg_temp.md_code(v_j, 'in_use_pending', 'FAILED 3: another account took a pending claim');
  if (v_j ->> 'until')::timestamptz is distinct from now() + interval '72 hours' then
    raise exception 'FAILED 3: the pending claim''s end is not 72 hours on (%)', v_j;
  end if;
  execute 'reset role';
  select * into v_dom from mail.domains where id = d_one;
  if v_dom.status is distinct from 'pending' or v_dom.kind is distinct from 'customer' or v_dom.mail_from_domain is distinct from 'send.' || n_one
     or v_dom.added_by is distinct from u_owner or v_dom.claimed_at is distinct from now() or v_dom.released_at is not null then
    raise exception 'FAILED 3: the claim row is wrong';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.account_id = a_acc and l.action = 'domain.added'
                    and l.target = d_one::text and l.actor_user_id = u_owner and l.detail ->> 'name' = n_one) then
    raise exception 'FAILED 3: the add was not written to the account log';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Domain work goes to its side only, under a lease.
  v_j := pg_temp.md_claim_domains('real-1', false);
  if d_one = any (pg_temp.md_ids(v_j)) or d_two = any (pg_temp.md_ids(v_j)) then
    raise exception 'FAILED 4: the real side took a test account''s domain';
  end if;
  v_j := pg_temp.md_claim_domains('mock-1', true, null, a_acc);
  if not (d_one = any (pg_temp.md_ids(v_j))) or not (d_two = any (pg_temp.md_ids(v_j))) then
    raise exception 'FAILED 4: the mock side did not get the test account''s domains (%)', v_j;
  end if;
  v_item := pg_temp.md_item(v_j, 'id', d_one);
  if v_item ->> 'work' is distinct from 'setup' or v_item ->> 'tenant' is distinct from (select ses_tenant from mail.accounts where id = a_acc)
     or (v_item -> 'steps' ->> 'identity')::boolean or (v_item ->> 'tenantReady')::boolean
     or (v_item ->> 'deadline')::timestamptz is distinct from now() + interval '72 hours' then
    raise exception 'FAILED 4: the claim''s answer is wrong (%)', v_item;
  end if;
  if (select locked_by from mail.domains where id = d_one) is distinct from 'mock-1' then
    raise exception 'FAILED 4: no lease was taken';
  end if;
  v_j := pg_temp.md_claim_domains('mock-2', true, null, a_acc);
  if jsonb_array_length(v_j) is distinct from 0 then raise exception 'FAILED 4: a leased domain was handed out twice'; end if;
  begin
    execute 'set local role service_role';
    perform mail.claim_domain_work('w', 0, true);
    raise exception 'FAILED 4: a limit of 0 was accepted';
  exception when invalid_parameter_value then
    execute 'reset role';
  end;
  v_passed := v_passed + 1;

  -- ── 5. Set-up steps are recorded under the lease, checked as they come (§5.1–5.4).
  v_arn := 'arn:aws:ses:eu-west-2:111122223333:identity/' || n_one;
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-2', 'identity',
                            jsonb_build_object('identityArn', v_arn, 'dkimTokens', v_tokens)),
                          'lease_lost', 'FAILED 5: another worker recorded a step');
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-1', 'identity',
                            jsonb_build_object('identityArn', 'arn:aws:ses:eu-west-2:111122223333:identity/other.example',
                                               'dkimTokens', v_tokens)),
                          'validation', 'FAILED 5: an identity for another name');
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-1', 'identity',
                            jsonb_build_object('identityArn', v_arn, 'dkimTokens', '["NOT A TOKEN"]'::jsonb)),
                          'validation', 'FAILED 5: a bad DKIM token');
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-1', 'config_set'), 'out_of_order',
                          'FAILED 5: a configuration set before the identity');
  perform pg_temp.md_ok(pg_temp.md_step(d_one, 'mock-1', 'identity',
                          jsonb_build_object('identityArn', v_arn, 'dkimTokens', v_tokens, 'dkimStatus', 'PENDING')),
                        'FAILED 5: the identity step');
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-1', 'mail_from',
                            jsonb_build_object('mailFromDomain', 'bounce.' || n_one)),
                          'validation', 'FAILED 5: a MAIL FROM other than send.');
  perform pg_temp.md_ok(pg_temp.md_step(d_one, 'mock-1', 'mail_from',
                          jsonb_build_object('mailFromDomain', 'send.' || n_one)), 'FAILED 5: the MAIL FROM step');
  perform pg_temp.md_code(pg_temp.md_step(d_one, 'mock-1', 'nonsense'), 'validation', 'FAILED 5: an unknown step');
  -- SES verifies it before the tenant step: still pending (it could not send yet).
  perform pg_temp.md_ok(pg_temp.md_check(d_one, 'mock-1',
                          jsonb_build_object('found', true, 'verifiedForSending', true, 'verificationStatus', 'SUCCESS',
                                             'dkimStatus', 'SUCCESS', 'dkimTokens', v_tokens)),
                        'FAILED 5: an early check');
  select * into v_dom from mail.domains where id = d_one;
  if v_dom.status is distinct from 'pending' or v_dom.locked_by is not null or v_dom.next_attempt_at is distinct from now() + interval '10 minutes'
     or v_dom.dkim_tokens is distinct from array['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3']
     or v_dom.identity_arn is distinct from v_arn or v_dom.mail_from_set_at is null then
    raise exception 'FAILED 5: verified before its set-up was done, or the check left the wrong state';
  end if;
  -- Not for another account's id.
  if jsonb_array_length(pg_temp.md_claim_domains('mock-3', true, d_one, b_acc)) is distinct from 0 then
    raise exception 'FAILED 5: a domain was handed out under another account';
  end if;
  v_j := pg_temp.md_claim_domains('mock-3', true, d_one, a_acc);
  if pg_temp.md_item(v_j, 'id', d_one) ->> 'work' is distinct from 'setup' then
    raise exception 'FAILED 5: the half-done set-up is not handed out to resume (%)', v_j;
  end if;
  perform pg_temp.md_ok(pg_temp.md_step(d_one, 'mock-3', 'config_set'), 'FAILED 5: the configuration set step');
  perform pg_temp.md_ok(pg_temp.md_step(d_one, 'mock-3', 'tenant'), 'FAILED 5: the tenant step');
  perform pg_temp.md_ok(pg_temp.md_check(d_one, 'mock-3',
                          jsonb_build_object('found', true, 'verifiedForSending', true, 'verificationStatus', 'SUCCESS',
                                             'dkimStatus', 'SUCCESS', 'mailFromStatus', 'PENDING', 'dkimTokens', '[]'::jsonb)),
                        'FAILED 5: the verifying check');
  select * into v_dom from mail.domains where id = d_one;
  if v_dom.status is distinct from 'verified' or v_dom.verified_at is distinct from now() or v_dom.mail_from_status is distinct from 'PENDING'
     or cardinality(v_dom.dkim_tokens) is distinct from 3 then
    raise exception 'FAILED 5: the domain is not verified as SES said';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.account_id = a_acc and l.action = 'domain.verified'
                    and l.target = d_one::text and l.actor = 'system') then
    raise exception 'FAILED 5: the verification was not written to the account log';
  end if;
  -- "Check now" right after a check hands nothing out.
  if jsonb_array_length(pg_temp.md_claim_domains('mock-3', true, d_one, a_acc)) is distinct from 0 then
    raise exception 'FAILED 5: a domain checked a moment ago was handed out for another check';
  end if;
  perform pg_temp.md_code(pg_temp.md_check(d_one, 'mock-3', '{"found": true}'), 'lease_lost',
                          'FAILED 5: a check without a lease');
  -- A verified name is refused to everyone else (§5).
  perform pg_temp.md_as(u_other);
  perform pg_temp.md_code(mail.add_domain(b_acc, n_one), 'in_use', 'FAILED 5: another account took a verified name');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 6. A verified domain SES now fails is pending again; one SES lost is set up again.
  update mail.domains set last_checked_at = now() - interval '1 minute' where id = d_one;
  v_j := pg_temp.md_claim_domains('mock-4', true, d_one, a_acc);
  if pg_temp.md_item(v_j, 'id', d_one) ->> 'work' is distinct from 'check' then raise exception 'FAILED 6: no check for a verified domain'; end if;
  perform pg_temp.md_ok(pg_temp.md_check(d_one, 'mock-4',
                          jsonb_build_object('found', true, 'verifiedForSending', false, 'verificationStatus', 'TEMPORARY_FAILURE')),
                        'FAILED 6: a temporary failure');
  if (select status from mail.domains where id = d_one) is distinct from 'verified' then
    raise exception 'FAILED 6: a temporary failure unverified the domain';
  end if;
  update mail.domains set last_checked_at = now() - interval '1 minute', claimed_at = now() - interval '5 days'
   where id = d_one;
  perform pg_temp.md_claim_domains('mock-4', true, d_one, a_acc);
  perform pg_temp.md_ok(pg_temp.md_check(d_one, 'mock-4',
                          jsonb_build_object('found', true, 'verifiedForSending', false, 'verificationStatus', 'FAILED')),
                        'FAILED 6: a failed identity');
  select * into v_dom from mail.domains where id = d_one;
  if v_dom.status is distinct from 'pending' or v_dom.verified_at is not null or v_dom.claimed_at is distinct from now() then
    raise exception 'FAILED 6: a failed identity did not start a new 72 hours';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.target = d_one::text and l.action = 'domain.unverified') then
    raise exception 'FAILED 6: the unverification was not logged';
  end if;
  update mail.domains set last_checked_at = now() - interval '1 minute' where id = d_one;
  perform pg_temp.md_claim_domains('mock-4', true, d_one, a_acc);
  perform pg_temp.md_ok(pg_temp.md_check(d_one, 'mock-4', '{"found": false}'), 'FAILED 6: an identity SES lost');
  select * into v_dom from mail.domains where id = d_one;
  if v_dom.identity_created_at is not null or v_dom.tenant_associated_at is not null or v_dom.identity_arn is not null
     or cardinality(v_dom.dkim_tokens) is distinct from 0 or v_dom.status is distinct from 'pending' then
    raise exception 'FAILED 6: a lost identity is not set up again';
  end if;
  v_passed := v_passed + 1;

  -- ── 7. 72 hours unproven: a last read, failed naming the record, released (§5).
  -- d_two's lease from check 4 has run out: anyone may take it now.
  update mail.domains set claimed_at = now() - interval '73 hours', locked_until = now() - interval '1 second'
   where id = d_two;
  v_j := pg_temp.md_claim_domains('mock-5', true, null, a_acc);
  if pg_temp.md_item(v_j, 'id', d_two) ->> 'work' is distinct from 'expire' then
    raise exception 'FAILED 7: an old claim is not handed out to expire (%)', v_j;
  end if;
  execute 'set local role service_role';
  v_j := mail.record_domain_failed(d_two, 'mock-5', 'because', null);
  execute 'reset role';
  perform pg_temp.md_code(v_j, 'validation', 'FAILED 7: an unknown reason');
  execute 'set local role service_role';
  v_j := mail.record_domain_failed(d_two, 'mock-5', 'dkim_record_missing',
                                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1._domainkey.' || n_two);
  execute 'reset role';
  perform pg_temp.md_ok(v_j, 'FAILED 7: failing an old claim');
  select * into v_dom from mail.domains where id = d_two;
  if v_dom.status is distinct from 'failed' or v_dom.failed_reason is distinct from 'dkim_record_missing' or v_dom.released_at is not null
     or v_dom.missing_record is distinct from 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1._domainkey.' || n_two or v_dom.locked_by is distinct from 'mock-5' then
    raise exception 'FAILED 7: the failed claim is wrong';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.target = d_two::text and l.action = 'domain.failed'
                    and l.detail ->> 'missingRecord' like '%._domainkey.' || n_two) then
    raise exception 'FAILED 7: the failure did not name the record in the account log';
  end if;
  -- Until SES lets the name go, it is still held; retrying waits too.
  perform pg_temp.md_as(u_other);
  perform pg_temp.md_code(mail.add_domain(b_acc, n_two), 'releasing', 'FAILED 7: a name taken before its release');
  perform pg_temp.md_as(u_owner);
  perform pg_temp.md_code(mail.retry_domain(d_two), 'releasing', 'FAILED 7: a retry before the release');
  perform pg_temp.md_code(mail.retry_domain(d_one), 'not_failed', 'FAILED 7: a pending domain retried');
  execute 'reset role';
  execute 'set local role service_role';
  v_j := mail.record_domain_released(d_two, 'mock-5');
  execute 'reset role';
  perform pg_temp.md_ok(v_j, 'FAILED 7: releasing the name');
  select * into v_dom from mail.domains where id = d_two;
  if v_dom.status is distinct from 'failed' or v_dom.released_at is distinct from now() or v_dom.locked_by is not null then
    raise exception 'FAILED 7: the name was not released';
  end if;
  -- Released: anyone may now claim it, and the old claim's owner waits for them.
  perform pg_temp.md_as(u_other);
  v_j := mail.add_domain(b_acc, n_two);
  perform pg_temp.md_ok(v_j, 'FAILED 7: a released name could not be claimed');
  d_b := (v_j ->> 'domainId')::uuid;
  perform pg_temp.md_as(u_owner);
  perform pg_temp.md_code(mail.retry_domain(d_two), 'in_use_pending', 'FAILED 7: retried over another''s claim');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 8. remove_domain: refused while emails wait; the identity let go; a retry in place.
  perform pg_temp.md_as(u_owner);
  v_j := mail.add_domain(a_acc, n_three);
  perform pg_temp.md_ok(v_j, 'FAILED 8: adding a third domain');
  d_three := (v_j ->> 'domainId')::uuid;
  execute 'reset role';
  insert into mail.emails (account_id, domain_id, from_address, to_addresses, subject)
  values (a_acc, d_three, 'hi@' || n_three, array['e2e-m47-o-' || v_tag || '@example.com'], 'm47 check');
  perform pg_temp.md_as(u_view);
  perform pg_temp.md_code(mail.remove_domain(d_three), 'forbidden', 'FAILED 8: a viewer removed a domain');
  perform pg_temp.md_as(u_none);
  perform pg_temp.md_code(mail.remove_domain(d_three), 'not_found', 'FAILED 8: a stranger removed a domain');
  perform pg_temp.md_as(u_dev);
  v_j := mail.remove_domain(d_three);
  perform pg_temp.md_code(v_j, 'emails_queued', 'FAILED 8: removed with an email waiting');
  if (v_j ->> 'count')::integer is distinct from 1 then raise exception 'FAILED 8: the waiting count is wrong (%)', v_j; end if;
  execute 'reset role';
  update mail.emails set status = 'sent', sent_at = now() where domain_id = d_three;
  perform pg_temp.md_as(u_dev);
  v_j := mail.remove_domain(d_three);
  perform pg_temp.md_ok(v_j, 'FAILED 8: removing a domain');
  if (v_j ->> 'needsRelease')::boolean is not true then raise exception 'FAILED 8: the identity is not to be let go'; end if;
  execute 'reset role';
  if (select status from mail.domains where id = d_three) is distinct from 'removing'
     or not exists (select 1 from mail.account_audit_log l where l.target = d_three::text and l.action = 'domain.removed'
                       and l.actor_user_id = u_dev) then
    raise exception 'FAILED 8: the removal was not recorded and logged';
  end if;
  v_j := pg_temp.md_claim_domains('mock-6', true, null, a_acc);
  if pg_temp.md_item(v_j, 'id', d_three) ->> 'work' is distinct from 'teardown' then
    raise exception 'FAILED 8: a removal is not handed out (%)', v_j;
  end if;
  execute 'set local role service_role';
  v_j := mail.record_domain_error(d_three, 'mock-6', 'HTTP 429 TooManyRequestsException', 30);
  execute 'reset role';
  select * into v_dom from mail.domains where id = d_three;
  if v_dom.attempts is distinct from 1 or v_dom.last_error is distinct from 'HTTP 429 TooManyRequestsException' or v_dom.locked_by is not null
     or v_dom.next_attempt_at is distinct from now() + interval '30 seconds' then
    raise exception 'FAILED 8: an error was not counted and backed off';
  end if;
  update mail.domains set next_attempt_at = now() where id = d_three;
  perform pg_temp.md_claim_domains('mock-6', true, null, a_acc);
  execute 'set local role service_role';
  v_j := mail.record_domain_error(d_three, 'mock-6', 'SES said <ada@example.com> is bad', 1);
  execute 'reset role';
  select * into v_dom from mail.domains where id = d_three;
  if v_dom.last_error is distinct from 'error' or v_dom.next_attempt_at is distinct from now() + interval '5 seconds' then
    raise exception 'FAILED 8: an error message was kept as given, or the back-off was not floored';
  end if;
  update mail.domains set next_attempt_at = now() where id = d_three;
  perform pg_temp.md_claim_domains('mock-6', true, null, a_acc);
  execute 'set local role service_role';
  v_j := mail.record_domain_released(d_three, 'mock-6');
  execute 'reset role';
  perform pg_temp.md_ok(v_j, 'FAILED 8: completing the removal');
  select * into v_dom from mail.domains where id = d_three;
  if v_dom.status is distinct from 'removed' or v_dom.released_at is distinct from now() or v_dom.removed_at is distinct from now() then
    raise exception 'FAILED 8: the removal did not complete';
  end if;
  perform pg_temp.md_as(u_owner);
  v_j := mail.remove_domain(d_three);
  if (v_j ->> 'already')::boolean is not true then raise exception 'FAILED 8: removing twice (%)', v_j; end if;
  execute 'reset role';
  -- B removes its claim on n_two; A then retries its old claim, in place.
  perform pg_temp.md_as(u_other);
  perform pg_temp.md_ok(mail.remove_domain(d_b), 'FAILED 8: B removes its domain');
  execute 'reset role';
  perform pg_temp.md_claim_domains('mock-7', true, d_b, b_acc);
  execute 'set local role service_role';
  perform mail.record_domain_released(d_b, 'mock-7');
  execute 'reset role';
  perform pg_temp.md_as(u_owner);
  v_j := mail.retry_domain(d_two);
  perform pg_temp.md_ok(v_j, 'FAILED 8: a retry of a released claim');
  execute 'reset role';
  select * into v_dom from mail.domains where id = d_two;
  if v_dom.status is distinct from 'pending' or v_dom.released_at is not null or v_dom.claimed_at is distinct from now()
     or v_dom.failed_reason is not null or v_dom.missing_record is not null or v_dom.identity_created_at is not null then
    raise exception 'FAILED 8: the retry did not start the claim afresh';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.target = d_two::text and l.action = 'domain.retried') then
    raise exception 'FAILED 8: the retry was not logged';
  end if;
  -- And one that failed and was released goes straight to removed.
  update mail.domains set status = 'failed', released_at = now(), failed_reason = 'not_set_up' where id = d_two;
  perform pg_temp.md_as(u_owner);
  v_j := mail.remove_domain(d_two);
  perform pg_temp.md_ok(v_j, 'FAILED 8: removing a released failure');
  if (v_j ->> 'needsRelease')::boolean then raise exception 'FAILED 8: a released claim asked to be let go'; end if;
  execute 'reset role';
  if (select status from mail.domains where id = d_two) is distinct from 'removed' then
    raise exception 'FAILED 8: a released failure was not removed at once';
  end if;
  -- A closed account adds nothing.
  update mail.accounts set state = 'closed' where id = b_acc;
  perform pg_temp.md_as(u_other);
  perform pg_temp.md_code(mail.add_domain(b_acc, 'four-' || v_tag || '.example'), 'account_closed',
                          'FAILED 8: a closed account added a domain');
  execute 'reset role';
  update mail.accounts set state = 'sandbox' where id = b_acc;
  v_passed := v_passed + 1;

  -- ── 9. Provisioning: the real side only, step by step, to tenant_ready_at (§4.1).
  v_j := pg_temp.md_claim_accounts('real-p', false);
  if a_acc = any (pg_temp.md_ids(v_j, 'accountId')) or b_acc = any (pg_temp.md_ids(v_j, 'accountId')) then
    raise exception 'FAILED 9: the real side took a test account';
  end if;
  v_item := pg_temp.md_item(v_j, 'accountId', r_acc);
  if v_item is null or v_item -> 'work' is distinct from '["provision"]'::jsonb or v_item ->> 'policy' is distinct from 'strict'
     or (v_item -> 'steps' ->> 'tenant')::boolean then
    raise exception 'FAILED 9: the real account is not handed out to provision (%)', v_item;
  end if;
  if r_acc = any (pg_temp.md_ids(pg_temp.md_claim_accounts('mock-p', true), 'accountId')) then
    raise exception 'FAILED 9: the mock side took a real account';
  end if;
  perform pg_temp.md_code(pg_temp.md_prov(r_acc, 'other', 'suppression'), 'lease_lost',
                          'FAILED 9: another worker recorded a step');
  perform pg_temp.md_code(pg_temp.md_prov(r_acc, 'real-p', 'tenant', '{"tenantArn": "arn:aws:sns:x"}'), 'validation',
                          'FAILED 9: a tenant ARN that is not one');
  v_text := 'arn:aws:ses:eu-west-2:111122223333:tenant/' || (select ses_tenant from mail.accounts where id = r_acc) || '/tn-1';
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'tenant',
                          jsonb_build_object('tenantArn', v_text, 'sendingStatus', 'ENABLED')), 'FAILED 9: the tenant');
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'suppression'), 'FAILED 9: suppression');
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'config_set'), 'FAILED 9: the set');
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'event_destination'), 'FAILED 9: the destination');
  v_j := pg_temp.md_prov(r_acc, 'real-p', 'config_set_association');
  if (v_j ->> 'ready')::boolean then raise exception 'FAILED 9: ready before its policy'; end if;
  perform pg_temp.md_code(pg_temp.md_prov(r_acc, 'real-p', 'policy', '{"policy": "none"}'), 'validation',
                          'FAILED 9: policy none');
  v_j := pg_temp.md_prov(r_acc, 'real-p', 'policy', '{"policy": "strict"}');
  if (v_j ->> 'ready')::boolean is not true then raise exception 'FAILED 9: not ready after every step (%)', v_j; end if;
  select * into v_acct from mail.accounts where id = r_acc;
  if v_acct.tenant_ready_at is distinct from now() or v_acct.ses_status is distinct from 'enabled' then
    raise exception 'FAILED 9: the account''s tenant is not ready';
  end if;
  if not exists (select 1 from mail.account_audit_log l where l.account_id = r_acc and l.action = 'account.tenant_ready'
                    and l.detail ->> 'policy' = 'strict') then
    raise exception 'FAILED 9: readiness was not logged';
  end if;
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'done'), 'FAILED 9: giving the lease back');
  if (select locked_by from mail.tenant_provisioning where account_id = r_acc) is not null then
    raise exception 'FAILED 9: the lease was kept';
  end if;
  if r_acc = any (pg_temp.md_ids(pg_temp.md_claim_accounts('real-p', false), 'accountId')) then
    raise exception 'FAILED 9: a ready account is handed out again';
  end if;
  -- An error backs off; the error words are SES's type, never its text.
  perform pg_temp.md_claim_accounts('mock-p', true, a_acc);
  execute 'set local role service_role';
  v_j := mail.record_provisioning_error(a_acc, 'mock-p', 'HTTP 403 AccessDeniedException', 120);
  execute 'reset role';
  select * into v_tp from mail.tenant_provisioning where account_id = a_acc;
  if v_tp.attempts is distinct from 1 or v_tp.last_error is distinct from 'HTTP 403 AccessDeniedException' or v_tp.locked_by is not null
     or v_tp.next_attempt_at is distinct from now() + interval '2 minutes' then
    raise exception 'FAILED 9: a provisioning error was not counted and backed off';
  end if;
  if a_acc = any (pg_temp.md_ids(pg_temp.md_claim_accounts('mock-p', true), 'accountId')) then
    raise exception 'FAILED 9: an account backing off was handed out';
  end if;
  -- After 30 days: Standard (§4.1.4).
  update mail.accounts set created_at = now() - interval '31 days' where id = r_acc;
  v_item := pg_temp.md_item(pg_temp.md_claim_accounts('real-p', false), 'accountId', r_acc);
  if v_item -> 'work' is distinct from '["policy"]'::jsonb or v_item ->> 'policy' is distinct from 'standard' then
    raise exception 'FAILED 9: no Standard policy after 30 days (%)', v_item;
  end if;
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-p', 'policy', '{"policy": "standard"}'), 'FAILED 9: Standard');
  perform pg_temp.md_prov(r_acc, 'real-p', 'done');
  if not exists (select 1 from mail.account_audit_log l where l.account_id = r_acc
                    and l.action = 'account.reputation_policy' and l.detail ->> 'policy' = 'standard') then
    raise exception 'FAILED 9: the Standard policy was not logged';
  end if;
  if r_acc = any (pg_temp.md_ids(pg_temp.md_claim_accounts('real-p', false), 'accountId')) then
    raise exception 'FAILED 9: a Standard account is handed out again';
  end if;
  v_passed := v_passed + 1;

  -- ── 10. The sandbox sender (§7.2): joined while in the sandbox, gone on leaving.
  execute 'set local role service_role';
  v_j := mail.record_sandbox_identity('{"status": "verified", "identityArn": "arn:aws:ses:eu-west-2:111122223333:identity/evil.example"}');
  execute 'reset role';
  perform pg_temp.md_code(v_j, 'validation', 'FAILED 10: another name''s identity as the sandbox sender');
  execute 'set local role service_role';
  v_j := mail.record_sandbox_identity(jsonb_build_object('status', 'verified',
           'identityArn', 'arn:aws:ses:eu-west-2:111122223333:identity/sandbox.emails.mydomainshub.com',
           'dkimTokens', v_tokens, 'mailFromStatus', 'SUCCESS'));
  execute 'reset role';
  perform pg_temp.md_ok(v_j, 'FAILED 10: recording the verified sandbox sender');
  -- Not before the tenant is ready, and not on the other side.
  update mail.accounts set created_at = now() where id = r_acc;
  v_item := pg_temp.md_item(pg_temp.md_claim_accounts('real-s', false), 'accountId', r_acc);
  if v_item -> 'work' is distinct from '["sandbox_join"]'::jsonb or v_item -> 'sandbox' ->> 'status' is distinct from 'verified' then
    raise exception 'FAILED 10: the sandbox account is not handed out to join (%)', v_item;
  end if;
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-s', 'sandbox_join'), 'FAILED 10: joining');
  perform pg_temp.md_prov(r_acc, 'real-s', 'done');
  select * into v_dom from mail.domains where account_id = r_acc and kind = 'sandbox';
  d_sand := v_dom.id;
  if v_dom.status is distinct from 'sandbox' or v_dom.name is distinct from 'sandbox.emails.mydomainshub.com' or v_dom.released_at is not null then
    raise exception 'FAILED 10: no sandbox row for the account';
  end if;
  if mail.sandbox_domain_for(r_acc, 'Acme <Onboarding@Sandbox.Emails.MyDomainsHub.com>') is distinct from d_sand then
    raise exception 'FAILED 10: the sandbox sender was not offered to the gate';
  end if;
  if mail.sandbox_domain_for(r_acc, 'billing@sandbox.emails.mydomainshub.com') is not null
     or mail.sandbox_domain_for(a_acc, 'onboarding@sandbox.emails.mydomainshub.com') is not null then
    raise exception 'FAILED 10: the sandbox sender was offered for another address or account';
  end if;
  -- It is no customer domain: not verified, not counted, not removable.
  perform pg_temp.md_as(u_real);
  v_j := mail.add_domain(r_acc, n_real);
  perform pg_temp.md_ok(v_j, 'FAILED 10: the sandbox row took the Free plan''s one domain');
  d_real := (v_j ->> 'domainId')::uuid;
  perform pg_temp.md_code(mail.remove_domain(d_sand), 'forbidden', 'FAILED 10: the sandbox row was removable');
  perform pg_temp.md_code(mail.retry_domain(d_sand), 'forbidden', 'FAILED 10: the sandbox row was retryable');
  execute 'reset role';
  if (select count(*) from mail.domains where account_id = r_acc and status = 'verified') is distinct from 0 then
    raise exception 'FAILED 10: the sandbox row counts as verified';
  end if;
  v_j := pg_temp.md_claim_domains('real-d', false, null, r_acc);
  if d_sand = any (pg_temp.md_ids(v_j)) then
    raise exception 'FAILED 10: the sandbox row was handed out as domain work';
  end if;
  if not (d_real = any (pg_temp.md_ids(v_j))) then
    raise exception 'FAILED 10: the real side does not get the real account''s domain';
  end if;
  if d_real = any (pg_temp.md_ids(pg_temp.md_claim_domains('mock-d', true, d_real, r_acc))) then
    raise exception 'FAILED 10: the mock side got a real account''s domain';
  end if;
  -- Leaving the sandbox retires it at once; the route then takes it off the tenant.
  update mail.accounts set state = 'active' where id = r_acc;
  if (select status from mail.domains where id = d_sand) is distinct from 'removed'
     or mail.sandbox_domain_for(r_acc, 'onboarding@sandbox.emails.mydomainshub.com') is not null then
    raise exception 'FAILED 10: leaving the sandbox kept the sandbox sender';
  end if;
  v_item := pg_temp.md_item(pg_temp.md_claim_accounts('real-s', false), 'accountId', r_acc);
  if v_item -> 'work' is distinct from '["sandbox_leave"]'::jsonb then
    raise exception 'FAILED 10: the active account is not handed out to leave (%)', v_item;
  end if;
  perform pg_temp.md_code(pg_temp.md_prov(r_acc, 'real-s', 'sandbox_join'), 'not_sandbox',
                          'FAILED 10: an active account joined the sandbox sender');
  perform pg_temp.md_ok(pg_temp.md_prov(r_acc, 'real-s', 'sandbox_leave'), 'FAILED 10: leaving');
  perform pg_temp.md_prov(r_acc, 'real-s', 'done');
  if (select sandbox_associated_at from mail.tenant_provisioning where account_id = r_acc) is not null
     or (select count(*) from mail.account_audit_log l where l.account_id = r_acc
          and l.action = 'account.sandbox_sender') is distinct from 2 then
    raise exception 'FAILED 10: leaving was not recorded and logged';
  end if;
  -- Back in the sandbox, it joins again, the same row.
  update mail.accounts set state = 'sandbox' where id = r_acc;
  v_item := pg_temp.md_item(pg_temp.md_claim_accounts('real-s', false), 'accountId', r_acc);
  if v_item -> 'work' is distinct from '["sandbox_join"]'::jsonb then raise exception 'FAILED 10: no join on return'; end if;
  perform pg_temp.md_prov(r_acc, 'real-s', 'sandbox_join');
  if (select count(*) from mail.domains where account_id = r_acc and kind = 'sandbox') is distinct from 1
     or (select status from mail.domains where id = d_sand) is distinct from 'sandbox' then
    raise exception 'FAILED 10: the sandbox row was not revived in place';
  end if;
  v_passed := v_passed + 1;

  -- ── 11. The API's domain functions (§6): a live full-access key of the account, asked again in SQL.
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (a_acc, 'm47 full', 'mdh_live_af01', encode(extensions.digest('m47-af-' || v_tag, 'sha256'), 'hex'), 'full')
  returning id into k_full;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (a_acc, 'm47 send', 'mdh_live_as01', encode(extensions.digest('m47-as-' || v_tag, 'sha256'), 'hex'), 'sending')
  returning id into k_send;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, revoked_at) values
    (a_acc, 'm47 old', 'mdh_live_ao01', encode(extensions.digest('m47-ao-' || v_tag, 'sha256'), 'hex'), 'full', now())
  returning id into k_old;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (r_acc, 'm47 real', 'mdh_live_rf01', encode(extensions.digest('m47-rf-' || v_tag, 'sha256'), 'hex'), 'full')
  returning id into k_real;
  perform pg_temp.md_as(u_owner);
  begin
    perform mail.api_add_domain(a_acc, k_full, 'api-' || v_tag || '.example');
    raise exception 'FAILED 11: a signed-in person called the API''s add';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  execute 'set local role service_role';
  v_r := v_r || mail.api_list_domains(a_acc, k_send);                                -- 1
  v_r := v_r || mail.api_list_domains(a_acc, k_real);                                -- 2
  v_r := v_r || mail.api_list_domains(a_acc, k_old);                                 -- 3
  v_r := v_r || mail.api_list_domains(a_acc, k_full);                                -- 4
  v_r := v_r || mail.api_list_domains(r_acc, k_real);                                -- 5
  v_r := v_r || mail.api_get_domain(a_acc, k_full, d_real);                          -- 6
  v_r := v_r || mail.api_get_domain(a_acc, k_full, d_one);                           -- 7
  v_r := v_r || mail.api_add_domain(a_acc, k_send, 'api-' || v_tag || '.example');   -- 8
  v_r := v_r || mail.api_add_domain(a_acc, k_full, 'Api-' || v_tag || '.Example');   -- 9
  v_r := v_r || mail.api_add_domain(a_acc, k_full, 'x.mydomainshub.com');            -- 10
  v_r := v_r || mail.api_remove_domain(a_acc, k_full, d_real);                       -- 11
  v_r := v_r || mail.api_remove_domain(r_acc, k_real, d_sand);                       -- 12
  v_r := v_r || mail.api_remove_domain(a_acc, k_full, (v_r[9] ->> 'domainId')::uuid); -- 13
  v_r := v_r || mail.api_get_domain(a_acc, k_full, d_three);                         -- 14
  execute 'reset role';
  perform pg_temp.md_code(v_r[1], 'forbidden', 'FAILED 11: a sending key listed domains');
  perform pg_temp.md_code(v_r[2], 'forbidden', 'FAILED 11: another account''s key listed domains');
  perform pg_temp.md_code(v_r[3], 'forbidden', 'FAILED 11: a revoked key listed domains');
  perform pg_temp.md_ok(v_r[4], 'FAILED 11: a full key lists domains');
  select coalesce(array_agg((e ->> 'id')::uuid), '{}') into v_ids from jsonb_array_elements(v_r[4] -> 'domains') e;
  if not (d_one = any (v_ids)) or d_two = any (v_ids) or d_three = any (v_ids) then
    raise exception 'FAILED 11: the list is not the live domains (%)', v_r[4];
  end if;
  select coalesce(array_agg((e ->> 'id')::uuid), '{}') into v_ids from jsonb_array_elements(v_r[5] -> 'domains') e;
  if not (d_real = any (v_ids)) or d_sand = any (v_ids) then
    raise exception 'FAILED 11: the sandbox row was listed, or a domain left out (%)', v_r[5];
  end if;
  perform pg_temp.md_code(v_r[6], 'not_found', 'FAILED 11: another account''s domain was read');
  perform pg_temp.md_ok(v_r[7], 'FAILED 11: reading a domain');
  if (v_r[7] -> 'domain' ->> 'id')::uuid is distinct from d_one
     or v_r[7] -> 'domain' ->> 'status' is distinct from 'pending'
     or v_r[7] -> 'domain' ->> 'mailFromDomain' is distinct from 'send.' || n_one
     or v_r[7] -> 'domain' ->> 'deadline' is null or jsonb_typeof(v_r[7] -> 'domain' -> 'dkimTokens') is distinct from 'array' then
    raise exception 'FAILED 11: the domain''s view is wrong (%)', v_r[7];
  end if;
  perform pg_temp.md_code(v_r[8], 'forbidden', 'FAILED 11: a sending key added a domain');
  perform pg_temp.md_ok(v_r[9], 'FAILED 11: a full key adds a domain');
  if v_r[9] ->> 'name' is distinct from 'api-' || v_tag || '.example' then
    raise exception 'FAILED 11: the API''s name was not lower-cased (%)', v_r[9];
  end if;
  perform pg_temp.md_code(v_r[10], 'reserved', 'FAILED 11: the API added a name of ours');
  perform pg_temp.md_code(v_r[11], 'not_found', 'FAILED 11: the API removed another account''s domain');
  -- The sandbox row is no domain of the API's: not listed, not found.
  perform pg_temp.md_code(v_r[12], 'not_found', 'FAILED 11: the API found the sandbox sender');
  perform pg_temp.md_ok(v_r[13], 'FAILED 11: a full key removes a domain');
  if (v_r[13] ->> 'needsRelease')::boolean is not true then
    raise exception 'FAILED 11: the API''s removal does not let the identity go';
  end if;
  perform pg_temp.md_code(v_r[14], 'not_found', 'FAILED 11: a removed domain was read');
  if (select count(*) from mail.account_audit_log l
       where l.account_id = a_acc and l.actor = 'api' and l.actor_user_id is null
         and l.target = v_r[9] ->> 'domainId' and l.action in ('domain.added', 'domain.removed')
         and l.detail ->> 'byKeyPrefix' = 'mdh_live_af01' and (l.detail ->> 'byKeyId')::uuid = k_full) is distinct from 2 then
    raise exception 'FAILED 11: the API''s add and removal were not logged with the key';
  end if;
  v_passed := v_passed + 1;

  -- ── 12. The job route's token, its heartbeat, and the schedule.
  select s.decrypted_secret into v_token from vault.decrypted_secrets s where s.name = 'mail_jobs_token';
  if coalesce(v_token, '') !~ '^[0-9a-f]{64}$' then raise exception 'FAILED 12: no job token in the Vault'; end if;
  execute 'set local role service_role';
  v_j := mail.begin_ses_jobs('not-the-token');
  execute 'reset role';
  perform pg_temp.md_code(v_j, 'unauthorized', 'FAILED 12: a wrong token opened the route');
  execute 'set local role service_role';
  v_j := mail.begin_ses_jobs(null);
  execute 'reset role';
  perform pg_temp.md_code(v_j, 'unauthorized', 'FAILED 12: no token opened the route');
  execute 'set local role service_role';
  v_j := mail.begin_ses_jobs(v_token);
  execute 'reset role';
  perform pg_temp.md_ok(v_j, 'FAILED 12: the token did not open the route');
  if v_j -> 'sandbox' ->> 'fromAddress' is distinct from 'onboarding@sandbox.emails.mydomainshub.com'
     or (v_j -> 'sandbox' ->> 'due')::boolean then
    raise exception 'FAILED 12: the sandbox sender''s state is wrong (%)', v_j;
  end if;
  if not exists (select 1 from public.service_heartbeats h where h.name = 'mail:ses-jobs' and h.beat_at = now()) then
    raise exception 'FAILED 12: the run left no heartbeat';
  end if;
  if not exists (select 1 from cron.job j where j.jobname = 'mail-ses-jobs' and j.schedule = '*/5 * * * *'
                    and j.command = 'select mail.kick_ses_jobs()') then
    raise exception 'FAILED 12: the five-minute schedule is missing';
  end if;
  if mail.kick_ses_jobs() is null then raise exception 'FAILED 12: the route could not be asked'; end if;
  perform vault.update_secret((select id from vault.secrets where name = 'mail_jobs_url'), 'http://localhost:3001/x');
  if mail.kick_ses_jobs() is not null then raise exception 'FAILED 12: the route was asked over plain http'; end if;
  v_passed := v_passed + 1;

  -- ── 13. RLS: members read their account's domains; the rest read nothing they should not.
  perform pg_temp.md_as(u_view);
  select count(*) into v_n from mail.domains where account_id = a_acc;
  if v_n < 3 then raise exception 'FAILED 13: a viewer reads % of the account''s domains', v_n; end if;
  select status into v_text from mail.sandbox_identity;
  if v_text is distinct from 'verified' then raise exception 'FAILED 13: a member cannot read the sandbox sender''s state'; end if;
  begin
    select identity_arn into v_text from mail.sandbox_identity;
    raise exception 'FAILED 13: the sandbox sender''s ARN is readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from mail.tenant_provisioning;
    raise exception 'FAILED 13: provisioning is readable by a person';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.md_as(u_none);
  if exists (select 1 from mail.domains where account_id in (a_acc, r_acc)) then
    raise exception 'FAILED 13: a stranger reads another account''s domains';
  end if;
  perform pg_temp.md_as(null);
  begin
    perform 1 from mail.sandbox_identity;
    raise exception 'FAILED 13: anon reads the sandbox sender';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  execute 'set local role service_role';
  begin
    perform 1 from mail.tenant_provisioning;
    raise exception 'FAILED 13: the service key reads provisioning directly';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 14. Migration 47's functions, each granted to exactly the role it names.
  v_expected := '{
    "domain_name_ok":"none", "is_reserved_domain":"none", "clean_error":"none", "is_test_account":"none",
    "on_jobs_side":"none", "kick_ses_jobs":"none", "provisioning_on_account":"none", "sandbox_on_state":"none",
    "sandbox_domain_for":"none",
    "add_domain":"authenticated", "retry_domain":"authenticated", "remove_domain":"authenticated",
    "begin_ses_jobs":"service_role", "record_sandbox_identity":"service_role",
    "claim_provisioning_work":"service_role", "record_provisioning":"service_role",
    "record_provisioning_error":"service_role", "claim_domain_work":"service_role",
    "record_domain_step":"service_role", "record_domain_check":"service_role",
    "record_domain_failed":"service_role", "record_domain_released":"service_role",
    "record_domain_error":"service_role",
    "domain_view":"none", "domain_api_key":"none", "claim_domain_name":"none", "request_domain_removal":"none",
    "api_list_domains":"service_role", "api_get_domain":"service_role", "api_add_domain":"service_role",
    "api_remove_domain":"service_role"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 14: mail.% is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 14: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n is distinct from (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 14: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  for v_row in select c.oid, c.relname from pg_class c
                where c.oid in ('mail.tenant_provisioning'::regclass, 'mail.sandbox_identity'::regclass, 'mail.domains'::regclass) loop
    if has_table_privilege('anon', v_row.oid, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', v_row.oid, 'select, insert, update, delete, truncate') then
      raise exception 'FAILED 14: mail.% is open to an API role', v_row.relname;
    end if;
  end loop;
  v_passed := v_passed + 1;

  raise notice 'migration 47: % checks passed', v_passed;
end;
$$;

rollback;
