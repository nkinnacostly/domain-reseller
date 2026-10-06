-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 47: MyDomainsHub Mail — domains and SES tenant provisioning
-- (docs/MAIL-SPEC.md §4.1, §5, §7.2; MR1, MR2).
--
-- SES is called only by apps/mail on Vercel, with the manager key (§4.3: it
-- may manage identities and tenants, never send). The database decides what
-- is due and records what SES answered; the app does the calls in between.
-- Nothing here reaches AWS.
--
--   Provisioning (§4.1). Every account gets a `tenant_provisioning` row when
--   it is made (trigger), and pg_net asks the app's job route to provision
--   it at once; pg_cron asks again every five minutes, so a missed or failed
--   run is picked up. Each step is recorded as SES answers it — tenant (with
--   tenant-level suppression), configuration set, its event destination to
--   SNS, the set joined to the tenant, the reputation policy — and the
--   account's `tenant_ready_at` is set when all are done. The app reads SES
--   before each write, so a half-done provisioning resumes, never repeats.
--   After 30 days the policy moves from Strict to Standard.
--
--   Domains (§5). `add_domain` claims a name for an account (ownership,
--   squatting and reserved-name rules below); the app creates the SES
--   identity, MAIL FROM, default configuration set and tenant association,
--   recording each step. `claim_domain_work` hands out what is due: set-up
--   left half-done, a pending identity to re-read every ten minutes, a claim
--   72 hours old to fail (naming the missing record) and release, and a
--   removal to carry out. `remove_domain` is refused while emails wait.
--
--   Who owns a name. One claim per name across every account (SES keeps one
--   identity per name per AWS account): a claim lasts from `add_domain` until
--   the SES identity is confirmed gone (`released_at`). An unverified claim
--   fails at 72 hours and is released, so nobody can squat a name they cannot
--   prove. mydomainshub.com and its subdomains are reserved.
--
--   The sandbox sender (§7.2 with MR2). A sandbox account may send only to
--   its own members' confirmed addresses — but MR2 wants a verified domain.
--   One shared identity, `sandbox.emails.mydomainshub.com`, is made once by
--   the ops script (apps/mail/scripts/sandbox-identity.ts); once SES verifies
--   it, provisioning joins it to each sandbox account's own tenant and gives
--   the account a `kind = 'sandbox'` domain row with status `sandbox` — never
--   `verified`, so it counts as no customer domain anywhere and passes no
--   gate until the gate asks `sandbox_domain_for` (the change reserve_send and
--   send_gate need is described with this package). Leaving the sandbox
--   retires the row at once (trigger) and the tenant association soon after.
--
--   Test accounts never meet real SES. Every claim names its side: the real
--   side never takes an account with an e2e member, and the mock side (e2e,
--   against a mock SES) takes only accounts whose members are all e2e users.
--
-- Every function is revoked from public, anon, authenticated and
-- service_role, then granted to exactly one role or none;
-- supabase/tests/mail_domains.sql checks it all, and mail_sending.sql's
-- check 16 holds every mail function to its grant.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Domains: claims, set-up steps and the sandbox sender ─────────────────

alter table mail.domains
  add column kind                 text not null default 'customer' check (kind in ('customer', 'sandbox')),
  -- The 72-hour window starts here; a retry starts a new one.
  add column claimed_at           timestamptz not null default now(),
  -- The SES identity is confirmed gone: the name is free for anyone.
  add column released_at          timestamptz,
  add column added_by             uuid,
  -- §5.1–5.4, each set when SES has it.
  add column identity_created_at  timestamptz,
  add column mail_from_set_at     timestamptz,
  add column config_set_at        timestamptz,
  add column tenant_associated_at timestamptz,
  -- The record a failed claim was missing, named for the customer (§5).
  add column missing_record       text check (missing_record is null or missing_record ~ '^[a-z0-9._-]{1,253}$'),
  add column removal_requested_at timestamptz,
  add column removal_requested_by uuid,
  add column removed_at           timestamptz,
  -- The job's own bookkeeping: back-off, and one runner at a time (a lease).
  add column attempts             integer not null default 0 check (attempts >= 0),
  add column last_error           text check (last_error is null or last_error ~ '^[A-Za-z0-9 _:.()/-]{1,120}$'),
  add column next_attempt_at      timestamptz not null default now(),
  add column locked_by            text check (locked_by is null or char_length(locked_by) between 1 and 100),
  add column locked_until         timestamptz;

update mail.domains set claimed_at = created_at;
update mail.domains set released_at = coalesce(released_at, updated_at) where status in ('failed', 'removed');

alter table mail.domains drop constraint domains_status_check;
alter table mail.domains drop constraint domains_name_check;
drop index mail.domains_one_live_claim;

alter table mail.domains
  add constraint domains_status_known
    check (status in ('pending', 'verified', 'failed', 'removing', 'removed', 'sandbox')),
  add constraint domains_name_format
    check (char_length(name) <= 253
           and name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'),
  -- mydomainshub.com and its subdomains are ours; only the sandbox sender lives there.
  add constraint domains_name_not_reserved
    check (kind = 'sandbox' or name !~ '(^|\.)mydomainshub\.com$'),
  add constraint domains_sandbox_is_ours
    check (kind = 'customer' or name ~ '(^|\.)mydomainshub\.com$'),
  -- A sandbox row is the sandbox sender or retired; it is never "verified".
  add constraint domains_kind_status
    check ((kind = 'customer' and status <> 'sandbox') or (kind = 'sandbox' and status in ('sandbox', 'removed'))),
  -- A live claim holds the name; a removed one has let it go.
  add constraint domains_claim_released
    check ((status not in ('pending', 'verified', 'removing') or released_at is null)
           and (kind = 'sandbox' or status <> 'removed' or released_at is not null));

-- One claim per name across every account, until SES has let the name go.
create unique index domains_one_claim on mail.domains (name) where kind = 'customer' and released_at is null;
-- One sandbox row per account, retired and revived as the account moves.
create unique index domains_one_sandbox on mail.domains (account_id) where kind = 'sandbox';
create index domains_work on mail.domains (next_attempt_at)
  where kind = 'customer' and status in ('pending', 'removing', 'failed') and released_at is null;

-- ── 2. Provisioning: one row per account ────────────────────────────────────
create table mail.tenant_provisioning (
  account_id               uuid primary key references mail.accounts (id) on delete cascade,
  tenant_arn               text check (tenant_arn is null or tenant_arn ~ '^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:tenant/\S{1,200}$'),
  -- ENABLED, DISABLED or REINSTATED, as GetTenant last said.
  sending_status           text check (sending_status is null or sending_status in ('ENABLED', 'DISABLED', 'REINSTATED')),
  tenant_created_at        timestamptz,
  suppression_at           timestamptz,
  config_set_at            timestamptz,
  event_destination_at     timestamptz,
  config_set_associated_at timestamptz,
  strict_policy_at         timestamptz,
  standard_policy_at       timestamptz,
  sandbox_associated_at    timestamptz,
  attempts                 integer not null default 0 check (attempts >= 0),
  last_error               text check (last_error is null or last_error ~ '^[A-Za-z0-9 _:.()/-]{1,120}$'),
  next_attempt_at          timestamptz not null default now(),
  locked_by                text check (locked_by is null or char_length(locked_by) between 1 and 100),
  locked_until             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index tenant_provisioning_due on mail.tenant_provisioning (next_attempt_at);

insert into mail.tenant_provisioning (account_id)
select a.id from mail.accounts a
on conflict do nothing;

-- ── 3. The shared sandbox sender (§7.2, one row) ────────────────────────────
-- Made once by the ops script with the manager key; its DNS is the owner's,
-- in Cloudflare. The job route reads it from SES until it is verified, then
-- daily. Only the real side writes it: a mock never speaks for production.
create table mail.sandbox_identity (
  id               boolean primary key default true check (id),
  name             text not null default 'sandbox.emails.mydomainshub.com'
                   check (name ~ '^([a-z0-9-]+\.)+mydomainshub\.com$'),
  from_address     text not null default 'onboarding@sandbox.emails.mydomainshub.com',
  status           text not null default 'not_created'
                   check (status in ('not_created', 'pending', 'verified', 'failed')),
  identity_arn     text check (identity_arn is null or identity_arn ~ '^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:identity/\S+$'),
  dkim_tokens      text[] not null default '{}',
  mail_from_status text check (mail_from_status is null or mail_from_status ~ '^[A-Z_]{1,40}$'),
  last_checked_at  timestamptz,
  verified_at      timestamptz,
  updated_at       timestamptz not null default now(),
  constraint sandbox_identity_from check (from_address = 'onboarding@' || name)
);
insert into mail.sandbox_identity default values;

-- ── 4. The job route's address and token (Supabase Vault) ───────────────────
-- pg_net calls https://emails.mydomainshub.com/api/jobs/ses with a bearer
-- token made here; the route asks `begin_ses_jobs` whether it is the one, so
-- the token never has to be copied anywhere. Change the address with
-- vault.update_secret if the app moves.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'mail_jobs_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'mail_jobs_token',
      'MyDomainsHub Mail: the bearer token pg_cron sends to the SES job route (migration 47)');
  end if;
  if not exists (select 1 from vault.secrets where name = 'mail_jobs_url') then
    perform vault.create_secret('https://emails.mydomainshub.com/api/jobs/ses', 'mail_jobs_url',
      'MyDomainsHub Mail: the SES job route pg_cron calls (migration 47)');
  end if;
end;
$$;

-- ── 5. Helpers (no API role may call them) ──────────────────────────────────

-- A name SES can verify and whose records fit in DNS: `<32-char token>._domainkey.`
-- in front of it must stay under 253 characters, so 200 at most.
create function mail.domain_name_ok(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_name) between 4 and 200
                  and p_name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$', false)
$$;

-- §5: mydomainshub.com and every name under it.
create function mail.is_reserved_domain(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_name ~ '(^|\.)mydomainshub\.com$', false)
$$;

-- An error worth keeping: SES's status and error type (`HTTP 400 BadRequestException`),
-- never its message text, which can quote an address (N13).
create function mail.clean_error(p_error text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_error ~ '^[A-Za-z0-9 _:.()/-]{1,120}$' then p_error else 'error' end
$$;

-- Any sign of a test: the e2e flag, an e2e member, or an e2e creator.
create function mail.is_test_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select a.is_e2e from mail.accounts a where a.id = p_account_id), false)
      or exists (select 1 from mail.members m join auth.users u on u.id = m.user_id
                  where m.account_id = p_account_id and coalesce(public.admin_e2e_email(u.email), false))
      or exists (select 1 from mail.accounts a join auth.users u on u.id = a.created_by
                  where a.id = p_account_id and coalesce(public.admin_e2e_email(u.email), false))
$$;

-- Which side a job may work an account on. Real SES (p_e2e false): an account
-- with members and no sign of a test. The mock (p_e2e true): an account whose
-- members are all e2e users. Neither side ever takes the other's.
create function mail.on_jobs_side(p_account_id uuid, p_e2e boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p_e2e then mail.is_e2e_account(p_account_id)
           else exists (select 1 from mail.members m where m.account_id = p_account_id)
                and not mail.is_test_account(p_account_id)
         end
$$;

-- Asks the app's job route to run now (pg_net: sent after this transaction
-- commits, never if it rolls back). Answers the request's id, or null when
-- the route is not configured. It never fails its caller: an account is made
-- whether or not the route can be asked, and the five-minute schedule asks again.
create function mail.kick_ses_jobs(p_account_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_token text;
  v_id    bigint;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'mail_jobs_url';
  select s.decrypted_secret into v_token from vault.decrypted_secrets s where s.name = 'mail_jobs_token';
  if coalesce(v_url, '') !~ '^https://[a-z0-9.-]+(:[0-9]+)?/' or coalesce(v_token, '') = '' then
    return null;
  end if;
  select net.http_post(
           url := v_url,
           body := case when p_account_id is null then '{}'::jsonb
                        else jsonb_build_object('accountId', p_account_id) end,
           headers := jsonb_build_object('Content-Type', 'application/json',
                                         'Authorization', 'Bearer ' || v_token),
           timeout_milliseconds := 55000)
    into v_id;
  return v_id;
exception when others then
  return null;
end;
$$;

-- A new account gets its provisioning row, and the route is asked at once —
-- unless a test person made it: real SES must never hear of a test account.
create function mail.provisioning_on_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into mail.tenant_provisioning (account_id) values (new.id) on conflict do nothing;
  if not coalesce(new.is_e2e, false)
     and not exists (select 1 from auth.users u
                      where u.id = new.created_by and coalesce(public.admin_e2e_email(u.email), false)) then
    perform mail.kick_ses_jobs(new.id);
  end if;
  return null;
end;
$$;
create trigger accounts_provisioning after insert on mail.accounts
  for each row execute function mail.provisioning_on_account();

-- §7.2: the sandbox sender is the sandbox's alone. An account that leaves the
-- sandbox loses it in the same transaction; the job route then takes the
-- shared identity off its tenant.
create function mail.sandbox_on_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state = 'sandbox' and new.state is distinct from old.state then
    update mail.domains
       set status = 'removed', removed_at = now(), updated_at = now()
     where account_id = new.id and kind = 'sandbox' and status = 'sandbox';
    if not mail.is_test_account(new.id) then
      perform mail.kick_ses_jobs(new.id);
    end if;
  end if;
  return null;
end;
$$;
create trigger accounts_sandbox_sender after update of state on mail.accounts
  for each row execute function mail.sandbox_on_state();

-- For the gate (reserve_send, send_gate): the account's sandbox row, when this
-- `from` may use it — the account is in the sandbox with its tenant ready, the
-- shared identity is verified and joined to its tenant, and the address is
-- exactly the sandbox sender's. Null otherwise. The recipients rule (members'
-- confirmed addresses only) is reserve_send's own, as for any sandbox send.
create function mail.sandbox_domain_for(p_account_id uuid, p_from text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
    from mail.domains d
    join mail.accounts a on a.id = d.account_id
    join mail.sandbox_identity si on si.id
   where d.account_id = p_account_id and d.kind = 'sandbox' and d.status = 'sandbox'
     and a.state = 'sandbox' and a.tenant_ready_at is not null
     and si.status = 'verified' and d.name = si.name
     and mail.address_of(p_from) = si.from_address
$$;

-- ── 6. Domains, as the person (authenticated) ───────────────────────────────

-- §5: claims a name for the account. Owners, admins and developers may.
-- Answers {ok, domainId, name} or {ok: false, code}: unauthorized, not_found,
-- forbidden, account_closed, validation, reserved, already_added (with its
-- domainId), in_use (verified on another account), in_use_pending (another
-- account's unverified claim, with `until`), releasing (a name being let go),
-- domain_limit (the plan's, with `max`).
create function mail.add_domain(p_account_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_role    text;
  v_account mail.accounts;
  v_name    text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\.+$', ''));
  v_claim   mail.domains;
  v_reuse   uuid;
  v_max     integer;
  v_held    integer;
  v_id      uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  -- One add at a time per account, so two cannot both pass the plan's count.
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if mail.is_reserved_domain(v_name) then
    return jsonb_build_object('ok', false, 'code', 'reserved');
  end if;
  if not mail.domain_name_ok(v_name) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;

  -- One name, one claim, across every account.
  perform pg_advisory_xact_lock(hashtextextended('mail.domain:' || v_name, 0));
  select * into v_claim from mail.domains d
   where d.name = v_name and d.kind = 'customer' and d.released_at is null;
  if v_claim.id is not null then
    if v_claim.account_id = p_account_id then
      return jsonb_build_object('ok', false, 'code', 'already_added', 'domainId', v_claim.id);
    end if;
    if v_claim.status = 'verified' then
      return jsonb_build_object('ok', false, 'code', 'in_use');
    end if;
    if v_claim.status = 'pending' then
      return jsonb_build_object('ok', false, 'code', 'in_use_pending',
                                'until', v_claim.claimed_at + interval '72 hours');
    end if;
    return jsonb_build_object('ok', false, 'code', 'releasing');
  end if;

  select p.max_domains into v_max from mail.plans p where p.code = v_account.plan_code;
  select count(*) into v_held from mail.domains d
   where d.account_id = p_account_id and d.kind = 'customer' and d.released_at is null;
  if v_held >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'domain_limit', 'max', coalesce(v_max, 0));
  end if;

  -- The account's own failed, released claim on this name starts again in place.
  select d.id into v_reuse from mail.domains d
   where d.account_id = p_account_id and d.name = v_name and d.kind = 'customer'
     and d.status = 'failed' and d.released_at is not null
   order by d.created_at desc
   limit 1;
  if v_reuse is not null then
    update mail.domains
       set status = 'pending', claimed_at = now(), released_at = null, added_by = v_user,
           identity_arn = null, dkim_tokens = '{}', dkim_status = null, mail_from_status = null,
           identity_created_at = null, mail_from_set_at = null, config_set_at = null,
           tenant_associated_at = null, failed_reason = null, missing_record = null, verified_at = null,
           last_checked_at = null, attempts = 0, last_error = null, next_attempt_at = now(),
           locked_by = null, locked_until = null, updated_at = now()
     where id = v_reuse;
    v_id := v_reuse;
  else
    insert into mail.domains (account_id, name, status, claimed_at, added_by, mail_from_domain)
    values (p_account_id, v_name, 'pending', now(), v_user, 'send.' || v_name)
    returning id into v_id;
  end if;

  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'domain.added', v_id::text, jsonb_build_object('name', v_name));
  return jsonb_build_object('ok', true, 'domainId', v_id, 'name', v_name);
end;
$$;

-- §5: a failed claim, tried again — the same row, a new 72-hour window, new
-- DKIM keys. Answers as add_domain, plus not_failed and releasing (its SES
-- identity is still being let go).
create function mail.retry_domain(p_domain_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_domain  mail.domains;
  v_role    text;
  v_account mail.accounts;
  v_claim   mail.domains;
  v_max     integer;
  v_held    integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_domain from mail.domains where id = p_domain_id;
  if v_domain.id is not null then
    v_role := mail.caller_role(v_domain.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin', 'developer') or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into v_account from mail.accounts where id = v_domain.account_id for update;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mail.domain:' || v_domain.name, 0));
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.status <> 'failed' then
    return jsonb_build_object('ok', false, 'code', 'not_failed', 'status', v_domain.status);
  end if;
  if v_domain.released_at is null then
    return jsonb_build_object('ok', false, 'code', 'releasing');
  end if;
  select * into v_claim from mail.domains d
   where d.name = v_domain.name and d.kind = 'customer' and d.released_at is null;
  if v_claim.id is not null then
    if v_claim.status = 'verified' then
      return jsonb_build_object('ok', false, 'code', 'in_use');
    end if;
    if v_claim.status = 'pending' then
      return jsonb_build_object('ok', false, 'code', 'in_use_pending',
                                'until', v_claim.claimed_at + interval '72 hours');
    end if;
    return jsonb_build_object('ok', false, 'code', 'releasing');
  end if;
  select p.max_domains into v_max from mail.plans p where p.code = v_account.plan_code;
  select count(*) into v_held from mail.domains d
   where d.account_id = v_domain.account_id and d.kind = 'customer' and d.released_at is null;
  if v_held >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'domain_limit', 'max', coalesce(v_max, 0));
  end if;

  update mail.domains
     set status = 'pending', claimed_at = now(), released_at = null, added_by = v_user,
         identity_arn = null, dkim_tokens = '{}', dkim_status = null, mail_from_status = null,
         identity_created_at = null, mail_from_set_at = null, config_set_at = null,
         tenant_associated_at = null, failed_reason = null, missing_record = null, verified_at = null,
         last_checked_at = null, attempts = 0, last_error = null, next_attempt_at = now(),
         locked_by = null, locked_until = null, updated_at = now()
   where id = p_domain_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_domain.account_id, 'user', v_user, 'domain.retried', p_domain_id::text,
          jsonb_build_object('name', v_domain.name));
  return jsonb_build_object('ok', true, 'domainId', p_domain_id, 'name', v_domain.name);
end;
$$;

-- §5: removes a domain — refused while any email from it waits to be sent
-- (`emails_queued`, with the count). A claim whose SES identity is already
-- gone is removed here; any other becomes `removing`, and the app takes the
-- identity off the tenant and deletes it (`needsRelease`).
create function mail.remove_domain(p_domain_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_domain mail.domains;
  v_role   text;
  v_queued integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is not null then
    v_role := mail.caller_role(v_domain.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'reason', 'sandbox');
  end if;
  if v_domain.status = 'removed' then
    return jsonb_build_object('ok', true, 'domainId', p_domain_id, 'already', true, 'needsRelease', false);
  end if;
  if v_domain.status = 'removing' then
    return jsonb_build_object('ok', true, 'domainId', p_domain_id, 'already', true, 'needsRelease', true);
  end if;
  select count(*) into v_queued from mail.emails e
   where e.domain_id = p_domain_id and e.status in ('queued', 'sending');
  if v_queued > 0 then
    return jsonb_build_object('ok', false, 'code', 'emails_queued', 'count', v_queued);
  end if;

  if v_domain.released_at is not null then
    update mail.domains
       set status = 'removed', removed_at = now(), removal_requested_at = now(),
           removal_requested_by = v_user, locked_by = null, locked_until = null, updated_at = now()
     where id = p_domain_id;
  else
    update mail.domains
       set status = 'removing', removal_requested_at = now(), removal_requested_by = v_user,
           attempts = 0, last_error = null, next_attempt_at = now(), updated_at = now()
     where id = p_domain_id;
  end if;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_domain.account_id, 'user', v_user, 'domain.removed', p_domain_id::text,
          jsonb_build_object('name', v_domain.name));
  return jsonb_build_object('ok', true, 'domainId', p_domain_id,
                            'needsRelease', v_domain.released_at is null);
end;
$$;

-- ── 7. The job route's door (service_role) ──────────────────────────────────

-- The bearer token pg_cron sent, checked against the Vault's (compared as
-- hashes), and the run noted as a heartbeat (§11). Answers {ok, sandbox} —
-- the shared sender's state, and whether it is due a look from SES.
create function mail.begin_ses_jobs(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_si    mail.sandbox_identity;
begin
  select s.decrypted_secret into v_token from vault.decrypted_secrets s where s.name = 'mail_jobs_token';
  if coalesce(v_token, '') = '' or coalesce(p_token, '') = ''
     or extensions.digest(p_token, 'sha256') <> extensions.digest(v_token, 'sha256') then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  perform public.record_heartbeat('mail:ses-jobs', false, '{}'::jsonb);
  select * into v_si from mail.sandbox_identity where id;
  return jsonb_build_object('ok', true, 'sandbox', jsonb_build_object(
    'name', v_si.name, 'fromAddress', v_si.from_address, 'status', v_si.status,
    'identityArn', v_si.identity_arn,
    'due', v_si.status <> 'verified' or v_si.last_checked_at is null
           or v_si.last_checked_at < now() - interval '1 day'));
end;
$$;

-- What SES says of the shared sandbox sender (the real side only).
create function mail.record_sandbox_identity(p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_si     mail.sandbox_identity;
  v_status text := p_state ->> 'status';
  v_arn    text := p_state ->> 'identityArn';
  v_tokens text[] := mail.text_array(p_state -> 'dkimTokens');
  v_mail   text := p_state ->> 'mailFromStatus';
begin
  select * into v_si from mail.sandbox_identity where id for update;
  if v_status is null or v_status not in ('not_created', 'pending', 'verified', 'failed')
     or (v_arn is not null and v_arn !~ ('^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:identity/'
                                         || replace(v_si.name, '.', '\.') || '$'))
     or (v_status <> 'not_created' and v_arn is null)
     or v_tokens is null or exists (select 1 from unnest(v_tokens) t where t !~ '^[a-z0-9]{16,64}$')
     or (v_mail is not null and v_mail !~ '^[A-Z_]{1,40}$') then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  update mail.sandbox_identity
     set status = v_status, identity_arn = v_arn,
         dkim_tokens = case when cardinality(v_tokens) > 0 then v_tokens
                            when v_status = 'not_created' then '{}' else dkim_tokens end,
         mail_from_status = v_mail, last_checked_at = now(),
         verified_at = case when v_status = 'verified' then coalesce(verified_at, now()) end,
         updated_at = now()
   where id;
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

-- ── 8. Provisioning (service_role) ──────────────────────────────────────────

-- Hands out up to p_limit accounts with provisioning due on this side, each
-- leased to p_worker for two minutes. With p_account_id: that account, now
-- (the app asks right after an account is made or a domain is added).
-- `work` lists what is due: provision (§4.1), policy (Standard after 30
-- days), sandbox_join, sandbox_leave (§7.2).
create function mail.claim_provisioning_work(p_worker text, p_limit integer, p_e2e boolean,
                                             p_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_si   mail.sandbox_identity;
  v_row  record;
  v_work text[];
  v_out  jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 50 or p_e2e is null then
    raise exception 'claim_provisioning_work: a worker name, a limit of 1 to 50 and a side'
      using errcode = '22023';
  end if;
  -- An account whose row is missing (made before this migration, say) gets one.
  insert into mail.tenant_provisioning (account_id)
  select a.id from mail.accounts a
   where not exists (select 1 from mail.tenant_provisioning t where t.account_id = a.id)
  on conflict do nothing;
  select * into v_si from mail.sandbox_identity where id;

  for v_row in
    select t.*, a.short_id, a.ses_tenant, a.config_set, a.state, a.tenant_ready_at,
           a.created_at as account_created_at,
           exists (select 1 from mail.domains d
                    where d.account_id = a.id and d.kind = 'sandbox' and d.status = 'sandbox') as has_sandbox_row
      from mail.tenant_provisioning t
      join mail.accounts a on a.id = t.account_id
     where a.state <> 'closed'
       and (p_account_id is null or t.account_id = p_account_id)
       and (t.locked_until is null or t.locked_until < now())
       and (p_account_id is not null or t.next_attempt_at <= now())
       and mail.on_jobs_side(a.id, p_e2e)
       and (a.tenant_ready_at is null
            or (t.standard_policy_at is null and a.created_at <= now() - interval '30 days')
            or (a.state = 'sandbox' and coalesce(v_si.status, '') = 'verified'
                and (t.sandbox_associated_at is null
                     or not exists (select 1 from mail.domains d
                                     where d.account_id = a.id and d.kind = 'sandbox' and d.status = 'sandbox')))
            or (a.state <> 'sandbox' and t.sandbox_associated_at is not null))
     order by t.next_attempt_at, t.account_id
     limit p_limit
     for update of t skip locked
  loop
    v_work := '{}';
    if v_row.tenant_ready_at is null then
      v_work := v_work || 'provision'::text;
    end if;
    if v_row.standard_policy_at is null and v_row.account_created_at <= now() - interval '30 days' then
      v_work := v_work || 'policy'::text;
    end if;
    if v_row.state = 'sandbox' and coalesce(v_si.status, '') = 'verified'
       and (v_row.sandbox_associated_at is null or not v_row.has_sandbox_row) then
      v_work := v_work || 'sandbox_join'::text;
    end if;
    if v_row.state <> 'sandbox' and v_row.sandbox_associated_at is not null then
      v_work := v_work || 'sandbox_leave'::text;
    end if;

    update mail.tenant_provisioning
       set locked_by = p_worker, locked_until = now() + interval '2 minutes', updated_at = now()
     where account_id = v_row.account_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'accountId', v_row.account_id, 'shortId', v_row.short_id, 'tenant', v_row.ses_tenant,
      'configSet', v_row.config_set, 'state', v_row.state, 'createdAt', v_row.account_created_at,
      'tenantReady', v_row.tenant_ready_at is not null, 'tenantArn', v_row.tenant_arn,
      'policy', case when v_row.account_created_at > now() - interval '30 days' then 'strict' else 'standard' end,
      'steps', jsonb_build_object(
        'tenant', v_row.tenant_created_at is not null, 'suppression', v_row.suppression_at is not null,
        'configSet', v_row.config_set_at is not null, 'eventDestination', v_row.event_destination_at is not null,
        'configSetAssociated', v_row.config_set_associated_at is not null,
        'strictPolicy', v_row.strict_policy_at is not null, 'standardPolicy', v_row.standard_policy_at is not null,
        'sandboxAssociated', v_row.sandbox_associated_at is not null),
      'work', to_jsonb(v_work),
      'sandbox', jsonb_build_object('name', v_si.name, 'fromAddress', v_si.from_address,
                                    'status', v_si.status, 'identityArn', v_si.identity_arn),
      'attempts', v_row.attempts));
  end loop;
  return v_out;
end;
$$;

-- Records one provisioning step as SES answered it, under the caller's lease.
-- Steps: tenant {tenantArn, sendingStatus}, suppression, config_set,
-- event_destination, config_set_association, policy {policy: strict|standard},
-- sandbox_join, sandbox_leave, done (gives the lease back). When the tenant,
-- its suppression, the set, its destination, the association and a policy
-- are all recorded, the account's tenant is ready (`tenant_ready_at`).
create function mail.record_provisioning(p_account_id uuid, p_worker text, p_step text,
                                         p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tp      mail.tenant_provisioning;
  v_account mail.accounts;
  v_si      mail.sandbox_identity;
  v_arn     text;
  v_status  text;
  v_policy  text;
  v_ready   boolean := false;
begin
  select * into v_tp from mail.tenant_provisioning where account_id = p_account_id for update;
  if v_tp.account_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_tp.locked_by is distinct from p_worker or v_tp.locked_until is null or v_tp.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  select * into v_si from mail.sandbox_identity where id;

  case p_step
    when 'tenant' then
      v_arn := p_detail ->> 'tenantArn';
      v_status := p_detail ->> 'sendingStatus';
      if v_arn is null or v_arn !~ '^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:tenant/\S{1,200}$'
         or (v_status is not null and v_status not in ('ENABLED', 'DISABLED', 'REINSTATED')) then
        return jsonb_build_object('ok', false, 'code', 'validation');
      end if;
      update mail.tenant_provisioning
         set tenant_arn = v_arn, sending_status = coalesce(v_status, sending_status),
             tenant_created_at = coalesce(tenant_created_at, now()), updated_at = now()
       where account_id = p_account_id;
    when 'suppression' then
      update mail.tenant_provisioning set suppression_at = coalesce(suppression_at, now()), updated_at = now()
       where account_id = p_account_id;
    when 'config_set' then
      update mail.tenant_provisioning set config_set_at = coalesce(config_set_at, now()), updated_at = now()
       where account_id = p_account_id;
    when 'event_destination' then
      update mail.tenant_provisioning
         set event_destination_at = coalesce(event_destination_at, now()), updated_at = now()
       where account_id = p_account_id;
    when 'config_set_association' then
      update mail.tenant_provisioning
         set config_set_associated_at = coalesce(config_set_associated_at, now()), updated_at = now()
       where account_id = p_account_id;
    when 'policy' then
      v_policy := p_detail ->> 'policy';
      if v_policy is null or v_policy not in ('strict', 'standard') then
        return jsonb_build_object('ok', false, 'code', 'validation');
      end if;
      if v_policy = 'strict' then
        update mail.tenant_provisioning set strict_policy_at = now(), updated_at = now()
         where account_id = p_account_id;
      else
        update mail.tenant_provisioning set standard_policy_at = now(), updated_at = now()
         where account_id = p_account_id;
        if v_account.tenant_ready_at is not null then
          insert into mail.account_audit_log (account_id, actor, action, target, detail)
          values (p_account_id, 'system', 'account.reputation_policy', v_account.ses_tenant,
                  jsonb_build_object('policy', 'standard'));
        end if;
      end if;
    when 'sandbox_join' then
      if v_account.state <> 'sandbox' or v_si.status <> 'verified' or v_si.identity_arn is null then
        return jsonb_build_object('ok', false, 'code', 'not_sandbox');
      end if;
      update mail.tenant_provisioning set sandbox_associated_at = now(), updated_at = now()
       where account_id = p_account_id;
      insert into mail.domains (account_id, kind, name, status, identity_arn, mail_from_domain, claimed_at,
                                verified_at, identity_created_at, mail_from_set_at, tenant_associated_at)
      values (p_account_id, 'sandbox', v_si.name, 'sandbox', v_si.identity_arn, 'send.' || v_si.name, now(),
              now(), now(), now(), now())
      on conflict (account_id) where kind = 'sandbox' do update
        set status = 'sandbox', name = excluded.name, identity_arn = excluded.identity_arn,
            mail_from_domain = excluded.mail_from_domain, verified_at = now(),
            tenant_associated_at = now(), removed_at = null, updated_at = now();
      insert into mail.account_audit_log (account_id, actor, action, target, detail)
      values (p_account_id, 'system', 'account.sandbox_sender', v_si.from_address,
              jsonb_build_object('state', 'on'));
    when 'sandbox_leave' then
      update mail.tenant_provisioning set sandbox_associated_at = null, updated_at = now()
       where account_id = p_account_id;
      update mail.domains set status = 'removed', removed_at = coalesce(removed_at, now()), updated_at = now()
       where account_id = p_account_id and kind = 'sandbox' and status = 'sandbox';
      insert into mail.account_audit_log (account_id, actor, action, target, detail)
      values (p_account_id, 'system', 'account.sandbox_sender', v_si.from_address,
              jsonb_build_object('state', 'off'));
    when 'done' then
      update mail.tenant_provisioning
         set locked_by = null, locked_until = null, attempts = 0, last_error = null,
             next_attempt_at = now(), updated_at = now()
       where account_id = p_account_id;
    else
      return jsonb_build_object('ok', false, 'code', 'validation');
  end case;

  select * into v_tp from mail.tenant_provisioning where account_id = p_account_id;
  if v_account.tenant_ready_at is null and v_tp.tenant_created_at is not null and v_tp.suppression_at is not null
     and v_tp.config_set_at is not null and v_tp.event_destination_at is not null
     and v_tp.config_set_associated_at is not null
     and (v_tp.strict_policy_at is not null or v_tp.standard_policy_at is not null) then
    update mail.accounts
       set tenant_ready_at = now(),
           ses_status = case when ses_status = 'pending'
                             then coalesce(lower(v_tp.sending_status), 'enabled') else ses_status end,
           updated_at = now()
     where id = p_account_id;
    insert into mail.account_audit_log (account_id, actor, action, target, detail)
    values (p_account_id, 'system', 'account.tenant_ready', v_account.ses_tenant,
            jsonb_build_object('policy', case when v_tp.standard_policy_at is not null then 'standard' else 'strict' end));
    v_ready := true;
  end if;
  return jsonb_build_object('ok', true, 'ready', v_ready or v_account.tenant_ready_at is not null);
end;
$$;

-- A provisioning run that SES refused or did not answer: counted, its error
-- kept (status and type only), tried again after p_retry_after seconds
-- (5 seconds to a day), the lease given back.
create function mail.record_provisioning_error(p_account_id uuid, p_worker text, p_error text,
                                               p_retry_after integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tp mail.tenant_provisioning;
begin
  select * into v_tp from mail.tenant_provisioning where account_id = p_account_id for update;
  if v_tp.account_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_tp.locked_by is distinct from p_worker or v_tp.locked_until is null or v_tp.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  update mail.tenant_provisioning
     set attempts = attempts + 1, last_error = mail.clean_error(p_error),
         next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_retry_after, 60), 5), 86400)),
         locked_by = null, locked_until = null, updated_at = now()
   where account_id = p_account_id;
  return jsonb_build_object('ok', true, 'attempts', v_tp.attempts + 1);
end;
$$;

-- ── 9. Domain jobs (service_role) ───────────────────────────────────────────

-- Hands out up to p_limit customer domains with work due on this side, each
-- leased to p_worker for two minutes. `work` is one of:
--   setup    — §5.1–5.4 not all recorded yet
--   check    — read the identity again (pending: every ten minutes)
--   expire   — a pending claim 72 hours old: a last read, then fail and release
--   teardown — removing, or failed and not yet released: off the tenant, deleted
-- With p_domain_id (and p_account_id, which it must belong to): that domain,
-- now — "Check now" and the steps right after `add_domain`; a verified domain
-- may be checked this way too. A domain checked in the last 15 seconds is
-- not handed out again for a check.
create function mail.claim_domain_work(p_worker text, p_limit integer, p_e2e boolean,
                                       p_domain_id uuid default null, p_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  record;
  v_work text;
  v_out  jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 50 or p_e2e is null then
    raise exception 'claim_domain_work: a worker name, a limit of 1 to 50 and a side' using errcode = '22023';
  end if;

  for v_row in
    select d.id, d.account_id, d.name, d.status, d.mail_from_domain, d.identity_arn, d.dkim_tokens,
           d.identity_created_at, d.mail_from_set_at, d.config_set_at, d.tenant_associated_at,
           d.claimed_at, d.last_checked_at, d.attempts, d.released_at,
           a.ses_tenant, a.config_set, a.tenant_ready_at
      from mail.domains d
      join mail.accounts a on a.id = d.account_id
     where d.kind = 'customer'
       and (p_domain_id is null or d.id = p_domain_id)
       and (p_account_id is null or d.account_id = p_account_id)
       and (d.locked_until is null or d.locked_until < now())
       and (p_domain_id is not null or d.next_attempt_at <= now())
       and (d.status in ('pending', 'removing')
            or (d.status = 'failed' and d.released_at is null)
            or (p_domain_id is not null and d.status = 'verified'))
       and mail.on_jobs_side(d.account_id, p_e2e)
     order by d.next_attempt_at, d.id
     limit p_limit
     for update of d skip locked
  loop
    v_work := case
      when v_row.status in ('removing', 'failed') then 'teardown'
      when v_row.status = 'verified' then 'check'
      when v_row.claimed_at <= now() - interval '72 hours' then 'expire'
      when v_row.identity_created_at is null or v_row.mail_from_set_at is null
           or v_row.config_set_at is null or v_row.tenant_associated_at is null then 'setup'
      else 'check'
    end;
    if p_domain_id is not null and v_work = 'check'
       and v_row.last_checked_at > now() - interval '15 seconds' then
      continue;
    end if;
    update mail.domains
       set locked_by = p_worker, locked_until = now() + interval '2 minutes', updated_at = now()
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'accountId', v_row.account_id, 'name', v_row.name, 'status', v_row.status,
      'work', v_work, 'mailFromDomain', v_row.mail_from_domain, 'identityArn', v_row.identity_arn,
      'dkimTokens', to_jsonb(v_row.dkim_tokens),
      'steps', jsonb_build_object(
        'identity', v_row.identity_created_at is not null, 'mailFrom', v_row.mail_from_set_at is not null,
        'configSet', v_row.config_set_at is not null, 'tenant', v_row.tenant_associated_at is not null),
      'tenant', v_row.ses_tenant, 'configSet', v_row.config_set,
      'tenantReady', v_row.tenant_ready_at is not null,
      'claimedAt', v_row.claimed_at, 'deadline', v_row.claimed_at + interval '72 hours',
      'lastCheckedAt', v_row.last_checked_at, 'attempts', v_row.attempts));
  end loop;
  return v_out;
end;
$$;

-- One set-up step as SES answered it, under the caller's lease (the lease is
-- kept: the run goes on to the next step). Steps: identity {identityArn,
-- dkimTokens, dkimStatus}, mail_from {mailFromDomain}, config_set, tenant.
create function mail.record_domain_step(p_domain_id uuid, p_worker text, p_step text,
                                        p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain mail.domains;
  v_arn    text := p_detail ->> 'identityArn';
  v_tokens text[] := mail.text_array(p_detail -> 'dkimTokens');
  v_dkim   text := p_detail ->> 'dkimStatus';
begin
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is null or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_domain.locked_by is distinct from p_worker or v_domain.locked_until is null
     or v_domain.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_domain.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'not_pending', 'status', v_domain.status);
  end if;

  case p_step
    when 'identity' then
      if v_arn is null or v_arn !~ ('^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:identity/'
                                     || replace(v_domain.name, '.', '\.') || '$')
         or v_tokens is null or cardinality(v_tokens) not between 1 and 10
         or exists (select 1 from unnest(v_tokens) t where t !~ '^[a-z0-9]{16,64}$')
         or (v_dkim is not null and v_dkim !~ '^[A-Z_]{1,40}$') then
        return jsonb_build_object('ok', false, 'code', 'validation');
      end if;
      update mail.domains
         set identity_arn = v_arn, dkim_tokens = v_tokens, dkim_status = v_dkim,
             identity_created_at = coalesce(identity_created_at, now()), attempts = 0, last_error = null,
             updated_at = now()
       where id = p_domain_id;
    when 'mail_from' then
      if p_detail ->> 'mailFromDomain' is distinct from 'send.' || v_domain.name then
        return jsonb_build_object('ok', false, 'code', 'validation');
      end if;
      update mail.domains
         set mail_from_domain = 'send.' || v_domain.name, mail_from_set_at = coalesce(mail_from_set_at, now()),
             attempts = 0, last_error = null, updated_at = now()
       where id = p_domain_id;
    when 'config_set' then
      if v_domain.identity_created_at is null then
        return jsonb_build_object('ok', false, 'code', 'out_of_order');
      end if;
      update mail.domains set config_set_at = coalesce(config_set_at, now()), attempts = 0, last_error = null,
                              updated_at = now()
       where id = p_domain_id;
    when 'tenant' then
      if v_domain.identity_created_at is null then
        return jsonb_build_object('ok', false, 'code', 'out_of_order');
      end if;
      update mail.domains
         set tenant_associated_at = coalesce(tenant_associated_at, now()), attempts = 0, last_error = null,
             updated_at = now()
       where id = p_domain_id;
    else
      return jsonb_build_object('ok', false, 'code', 'validation');
  end case;
  return jsonb_build_object('ok', true);
end;
$$;

-- What GetEmailIdentity said, under the caller's lease, which it gives back.
-- p_state: {found, verifiedForSending, verificationStatus, dkimStatus,
-- dkimTokens, mailFromStatus}. A pending domain becomes verified only when
-- SES verifies it AND every set-up step is recorded (an identity off its
-- tenant would be refused by SES at send time). A verified domain whose
-- identity SES now reports FAILED is pending again, with a new 72 hours. An
-- identity SES no longer has is set up again from the start.
create function mail.record_domain_check(p_domain_id uuid, p_worker text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain   mail.domains;
  v_found    boolean := coalesce(p_state -> 'found' = 'true'::jsonb, false);
  v_verified boolean := coalesce(p_state -> 'verifiedForSending' = 'true'::jsonb, false);
  v_vstatus  text := p_state ->> 'verificationStatus';
  v_dkim     text := p_state ->> 'dkimStatus';
  v_mail     text := p_state ->> 'mailFromStatus';
  v_tokens   text[] := mail.text_array(p_state -> 'dkimTokens');
  v_setup    boolean;
  v_status   text;
begin
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is null or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_domain.locked_by is distinct from p_worker or v_domain.locked_until is null
     or v_domain.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_domain.status not in ('pending', 'verified') then
    update mail.domains set locked_by = null, locked_until = null, updated_at = now() where id = p_domain_id;
    return jsonb_build_object('ok', false, 'code', 'not_checkable', 'status', v_domain.status);
  end if;
  if (v_vstatus is not null and v_vstatus !~ '^[A-Z_]{1,40}$') or (v_dkim is not null and v_dkim !~ '^[A-Z_]{1,40}$')
     or (v_mail is not null and v_mail !~ '^[A-Z_]{1,40}$') or v_tokens is null
     or exists (select 1 from unnest(v_tokens) t where t !~ '^[a-z0-9]{16,64}$') then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;

  if not v_found then
    update mail.domains
       set status = 'pending', identity_arn = null, dkim_tokens = '{}', dkim_status = null,
           mail_from_status = null, identity_created_at = null, mail_from_set_at = null, config_set_at = null,
           tenant_associated_at = null, verified_at = null,
           claimed_at = case when status = 'verified' then now() else claimed_at end,
           last_checked_at = now(), next_attempt_at = now(), attempts = 0, last_error = null,
           locked_by = null, locked_until = null, updated_at = now()
     where id = p_domain_id;
    if v_domain.status = 'verified' then
      insert into mail.account_audit_log (account_id, actor, action, target, detail)
      values (v_domain.account_id, 'system', 'domain.unverified', p_domain_id::text,
              jsonb_build_object('name', v_domain.name, 'reason', 'identity_missing'));
    end if;
    return jsonb_build_object('ok', true, 'status', 'pending', 'reset', true);
  end if;

  v_setup := v_domain.identity_created_at is not null and v_domain.mail_from_set_at is not null
             and v_domain.config_set_at is not null and v_domain.tenant_associated_at is not null;
  v_status := case
    when v_domain.status = 'pending' and v_verified and v_setup then 'verified'
    when v_domain.status = 'verified' and not v_verified and v_vstatus = 'FAILED' then 'pending'
    else v_domain.status
  end;

  update mail.domains
     set status = v_status, dkim_status = v_dkim, mail_from_status = v_mail,
         dkim_tokens = case when cardinality(v_tokens) > 0 then v_tokens else dkim_tokens end,
         verified_at = case when v_status = 'verified' then coalesce(verified_at, now()) end,
         claimed_at = case when v_domain.status = 'verified' and v_status = 'pending' then now() else claimed_at end,
         last_checked_at = now(), next_attempt_at = now() + interval '10 minutes', attempts = 0,
         last_error = null, locked_by = null, locked_until = null, updated_at = now()
   where id = p_domain_id;

  if v_status is distinct from v_domain.status then
    insert into mail.account_audit_log (account_id, actor, action, target, detail)
    values (v_domain.account_id, 'system',
            case when v_status = 'verified' then 'domain.verified' else 'domain.unverified' end,
            p_domain_id::text, jsonb_build_object('name', v_domain.name));
  end if;
  return jsonb_build_object('ok', true, 'status', v_status, 'changed', v_status is distinct from v_domain.status);
end;
$$;

-- A pending claim that ran out of time (§5: 72 hours) or that SES refused to
-- set up: failed, with the record that is missing when one is. The lease is
-- kept, so the run goes on to release the name.
create function mail.record_domain_failed(p_domain_id uuid, p_worker text, p_reason text,
                                          p_missing_record text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain mail.domains;
begin
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is null or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_domain.locked_by is distinct from p_worker or v_domain.locked_until is null
     or v_domain.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_domain.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'not_pending', 'status', v_domain.status);
  end if;
  if p_reason is null or p_reason not in ('dkim_record_missing', 'dkim_not_verified', 'not_set_up', 'ses_refused')
     or (p_missing_record is not null and p_missing_record !~ '^[a-z0-9._-]{1,253}$') then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  update mail.domains
     set status = 'failed', failed_reason = p_reason, missing_record = p_missing_record,
         attempts = 0, last_error = null, next_attempt_at = now(), updated_at = now()
   where id = p_domain_id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (v_domain.account_id, 'system', 'domain.failed', p_domain_id::text,
          jsonb_build_object('name', v_domain.name, 'reason', p_reason)
          || case when p_missing_record is null then '{}'::jsonb
                  else jsonb_build_object('missingRecord', p_missing_record) end);
  return jsonb_build_object('ok', true);
end;
$$;

-- The SES identity is off the tenant and deleted (or was never made): the
-- name is free (`released_at`); a removal is done. The lease is given back.
create function mail.record_domain_released(p_domain_id uuid, p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain mail.domains;
begin
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is null or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_domain.locked_by is distinct from p_worker or v_domain.locked_until is null
     or v_domain.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_domain.status not in ('failed', 'removing') or v_domain.released_at is not null then
    return jsonb_build_object('ok', false, 'code', 'not_releasing', 'status', v_domain.status);
  end if;
  update mail.domains
     set released_at = now(),
         status = case when status = 'removing' then 'removed' else status end,
         removed_at = case when status = 'removing' then now() else removed_at end,
         identity_arn = null, tenant_associated_at = null, config_set_at = null,
         attempts = 0, last_error = null, locked_by = null, locked_until = null, updated_at = now()
   where id = p_domain_id;
  if v_domain.status = 'failed' then
    insert into mail.account_audit_log (account_id, actor, action, target, detail)
    values (v_domain.account_id, 'system', 'domain.released', p_domain_id::text,
            jsonb_build_object('name', v_domain.name));
  end if;
  return jsonb_build_object('ok', true, 'status', case when v_domain.status = 'removing' then 'removed' else 'failed' end);
end;
$$;

-- A domain job SES refused or did not answer: counted, its error kept
-- (status and type only), tried again after p_retry_after seconds (5 seconds
-- to a day), the lease given back.
create function mail.record_domain_error(p_domain_id uuid, p_worker text, p_error text, p_retry_after integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain mail.domains;
begin
  select * into v_domain from mail.domains where id = p_domain_id for update;
  if v_domain.id is null or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_domain.locked_by is distinct from p_worker or v_domain.locked_until is null
     or v_domain.locked_until < now() then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  update mail.domains
     set attempts = attempts + 1, last_error = mail.clean_error(p_error),
         next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_retry_after, 60), 5), 86400)),
         locked_by = null, locked_until = null, updated_at = now()
   where id = p_domain_id;
  return jsonb_build_object('ok', true, 'attempts', v_domain.attempts + 1);
end;
$$;

-- ── 10. Row-level security ──────────────────────────────────────────────────
-- domains keeps migration 43's policy (members read their account's rows).
-- Provisioning is the job route's alone; the sandbox sender's address and
-- state are for any signed-in person (nothing secret: its DNS is public).
alter table mail.tenant_provisioning enable row level security;   -- no policies: functions only
alter table mail.sandbox_identity enable row level security;
create policy sandbox_identity_read on mail.sandbox_identity for select to authenticated using (true);

revoke all on mail.tenant_provisioning from public, anon, authenticated, service_role;
revoke all on mail.sandbox_identity from public, anon, authenticated, service_role;
grant select (name, from_address, status, verified_at) on mail.sandbox_identity to authenticated;

-- ── 11. The schedule ────────────────────────────────────────────────────────
-- cron.schedule replaces a job of the same name, so this is safe to run again.
select cron.schedule('mail-ses-jobs', '*/5 * * * *', 'select mail.kick_ses_jobs()');

-- ── 12. Grants ──────────────────────────────────────────────────────────────
revoke all on function mail.domain_name_ok(text) from public, anon, authenticated, service_role;
revoke all on function mail.is_reserved_domain(text) from public, anon, authenticated, service_role;
revoke all on function mail.clean_error(text) from public, anon, authenticated, service_role;
revoke all on function mail.is_test_account(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.on_jobs_side(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function mail.kick_ses_jobs(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.provisioning_on_account() from public, anon, authenticated, service_role;
revoke all on function mail.sandbox_on_state() from public, anon, authenticated, service_role;
revoke all on function mail.sandbox_domain_for(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.add_domain(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.retry_domain(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.remove_domain(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.begin_ses_jobs(text) from public, anon, authenticated, service_role;
revoke all on function mail.record_sandbox_identity(jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.claim_provisioning_work(text, integer, boolean, uuid)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_provisioning(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_provisioning_error(uuid, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.claim_domain_work(text, integer, boolean, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_step(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_check(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_failed(uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_released(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_error(uuid, text, text, integer)
  from public, anon, authenticated, service_role;

grant execute on function mail.add_domain(uuid, text) to authenticated;
grant execute on function mail.retry_domain(uuid) to authenticated;
grant execute on function mail.remove_domain(uuid) to authenticated;
grant execute on function mail.begin_ses_jobs(text) to service_role;
grant execute on function mail.record_sandbox_identity(jsonb) to service_role;
grant execute on function mail.claim_provisioning_work(text, integer, boolean, uuid) to service_role;
grant execute on function mail.record_provisioning(uuid, text, text, jsonb) to service_role;
grant execute on function mail.record_provisioning_error(uuid, text, text, integer) to service_role;
grant execute on function mail.claim_domain_work(text, integer, boolean, uuid, uuid) to service_role;
grant execute on function mail.record_domain_step(uuid, text, text, jsonb) to service_role;
grant execute on function mail.record_domain_check(uuid, text, jsonb) to service_role;
grant execute on function mail.record_domain_failed(uuid, text, text, text) to service_role;
grant execute on function mail.record_domain_released(uuid, text) to service_role;
grant execute on function mail.record_domain_error(uuid, text, text, integer) to service_role;
