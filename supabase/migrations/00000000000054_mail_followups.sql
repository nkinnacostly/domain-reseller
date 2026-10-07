-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 54: MyDomainsHub Mail — follow-ups from the integration pass and
-- the security reviews (docs/MAIL-SPEC.md §5, §6, §7, §8, §9, §10, §11; MR2,
-- MR5, MR6).
--
--   accounts      — members read every column but `reviewed_by`, an admin's
--                   label (review 20).
--   webhooks      — an endpoint's port is 443 or 8443 (review 16); every
--                   change to an endpoint or a delivery names the account it
--                   is made in, and is refused for another account's (review
--                   15: a member of two accounts sealed one account's secret
--                   with the other's id).
--   API keys      — at most settings.api_keys_max live keys an account
--                   (review 13).
--   domain claims — a name whose claim on an account failed, or was let go
--                   unverified, cannot be claimed again by that account, or
--                   any account sharing a member with it, for
--                   settings.domain_claim_cooldown_days; an account may have
--                   settings.domain_failed_claims_max failed claims in
--                   settings.domain_failed_claims_window_days (review 10). A
--                   name is refused while another account holds a live claim
--                   on a parent or a child of it: SES lets a verified parent
--                   cover its subdomains within one AWS account (review 11).
--                   A claim fails as `ses_identity_exists` rather than adopt
--                   an SES identity it did not make (review 12), and becomes
--                   verified only with DKIM's SUCCESS too (review 19).
--   sending       — reserve_send takes the sandbox sender (review 14: every
--                   API send from it was refused as domain_not_verified), and
--                   reserves against the moment the email is to go — its
--                   Lagos day and month, and every 24-hour window of the
--                   shared budget holding its hour (review 17). Rescheduling
--                   gives the reservation back and takes a new one, or is
--                   refused and keeps the old.
--   SES pauses    — AWS's DISABLED, not asked for by us, pauses the account in
--                   our own gate too, with a pause finding; SES's ENABLED
--                   never reopens it — only an owner's resume (review 18, MR5).
--   billing       — a stray underpaid charge on an invoice's reference never
--                   cancels a subscription, and a failed charge makes one past
--                   due only near its period's end (review 22); a past-due
--                   plan paid again starts where the old month ended (review
--                   23); the payment redirect's checks are rate-limited per
--                   checkout and per account (review 21).
--   alerts        — open billing incidents and a webhook backlog over
--                   settings.webhook_backlog_minutes join Mail's ops alerts
--                   (§11, MB6), and Mail's admin lists the incidents.
--
-- Every function created or replaced here is revoked from public, anon,
-- authenticated and service_role, then granted to exactly one role, or none
-- (a helper); a changed signature drops the old one, so no overload is left.
-- supabase/tests/mail_followups.sql checks it all; mail_sending.sql's check 16
-- holds every mail function to its grant, and the shop's admin ACL maps hold
-- admin_mail_billing_incidents.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings (tuned without a deploy) ────────────────────────────────────
alter table mail.settings
  -- Review 13: live keys an account may hold; each one is a door to its sending.
  add column api_keys_max                     integer not null default 50
    check (api_keys_max between 1 and 1000),
  -- Review 10: a name whose claim failed or was let go unverified waits this
  -- long before the same people may claim it again.
  add column domain_claim_cooldown_days       integer not null default 7
    check (domain_claim_cooldown_days between 1 and 30),
  -- Review 10: failed claims an account may have in the window below.
  add column domain_failed_claims_max         integer not null default 5
    check (domain_failed_claims_max between 1 and 100),
  add column domain_failed_claims_window_days integer not null default 30
    check (domain_failed_claims_window_days between 1 and 90),
  -- §11: an alert once webhook deliveries have been due this long untried.
  add column webhook_backlog_minutes          integer not null default 60
    check (webhook_backlog_minutes between 5 and 1440);

alter table mail.billing_settings
  -- Review 21: the payment redirect's Flutterwave checks, per checkout and per
  -- account, in this many minutes (the shop's checkout_return keeps 30 and 60
  -- in 10). Past either, the redirect answers "pending": the webhook still settles it.
  add column return_checks_per_checkout   integer not null default 30
    check (return_checks_per_checkout between 1 and 1000),
  add column return_checks_per_account    integer not null default 60
    check (return_checks_per_account between 1 and 1000),
  add column return_check_window_minutes  integer not null default 10
    check (return_check_window_minutes between 1 and 1440),
  -- Review 22: a failed charge on a subscription's reference counts as its
  -- renewal failing only this close to the period's end, either side.
  add column failed_renewal_window_hours  integer not null default 72
    check (failed_renewal_window_hours between 1 and 336);

-- ── 2. What members read of their account (review 20) ───────────────────────
-- Every column but `reviewed_by`: the label of the admin who reviewed the
-- account is ours. A column added later is not readable until it is named here.
revoke select on mail.accounts from authenticated;
grant select (id, short_id, name, website, use_case, expected_monthly_volume, plan_code, state, state_reason,
              ses_tenant, config_set, ses_status, tenant_ready_at, warmup_day, daily_cap_override,
              monthly_cap_override, reviewed_at, created_by, created_at, updated_at, is_e2e, ses_status_at,
              pre_pause_state, warmup_checked_on)
  on mail.accounts to authenticated;


-- ── 3. Webhook ports (review 16) ────────────────────────────────────────────
-- As migration 49, plus: the port, when one is written, is 443 or 8443. Any
-- other would let an endpoint aim the worker at a service that is not a web
-- server, one port after another. The dashboard's schema (WEBHOOK_PORTS in
-- @dr/shared/mail) and the worker's transport hold the same two.

create or replace function mail.is_webhook_url(p_url text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_host text;
  v_port integer;
  v_ip   inet;
begin
  if p_url is null or char_length(p_url) not between 12 and 500 or p_url !~ '^[\x21-\x7e]+$'
     or p_url !~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^#]*)?$' then
    return false;
  end if;
  v_host := substring(p_url from '^https://([a-z0-9.-]+)');
  v_port := substring(p_url from '^https://[a-z0-9.-]+:([0-9]{1,5})')::integer;
  if v_port is not null and v_port not in (443, 8443) then
    return false;
  end if;
  if v_host ~ '^[0-9]+(\.[0-9]+){3}$' then
    begin
      v_ip := v_host::inet;
    exception when others then
      return false;
    end;
    return not (v_ip <<= any (array['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
                                    '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16',
                                    '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
                                    '224.0.0.0/3']::inet[]));
  end if;
  return v_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
         and char_length(v_host) <= 253
         and v_host !~ '(^|\.)(localhost|local|internal|intranet|lan|localdomain|home\.arpa|invalid|test|onion)$';
end;
$$;

-- ── 4. An endpoint is changed within the account it belongs to (review 15) ──
-- The dashboard names the account it acts in (its role was checked there);
-- migration 49's functions found the endpoint by its id alone, so a member
-- of two accounts could act on one account's endpoint while the app sealed
-- its new secret for the other — breaking their own endpoint. Each now takes
-- p_account_id and answers not_found for an endpoint, or a delivery, of any
-- other account. The old signatures are dropped: one function a name.
drop function mail.update_webhook(uuid, text, text[], text);
drop function mail.set_webhook_enabled(uuid, boolean);
drop function mail.rotate_webhook_secret(uuid, text, text);
drop function mail.delete_webhook(uuid);
drop function mail.resend_webhook_delivery(bigint);
drop function mail.webhook_for_caller(uuid);

-- The endpoint's row, locked, and the caller's role in its account — only
-- when it is that account's.
create function mail.webhook_for_caller(p_account_id uuid, p_webhook_id uuid)
returns table (webhook mail.webhooks, role text, account_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hook mail.webhooks;
begin
  select * into v_hook from mail.webhooks w where w.id = p_webhook_id for update;
  if v_hook.id is null or p_account_id is null or v_hook.account_id <> p_account_id then
    return;
  end if;
  return query
    select v_hook, mail.caller_role(v_hook.account_id), (select a.state from mail.accounts a where a.id = v_hook.account_id);
end;
$$;

create function mail.update_webhook(p_account_id uuid, p_webhook_id uuid, p_url text, p_events text[],
                                    p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_found  record;
  v_hook   mail.webhooks;
  v_events text[] := mail.webhook_event_list(p_events);
  v_desc   text := nullif(btrim(p_description), '');
  v_fields text[] := '{}';
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, p_webhook_id);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_hook := v_found.webhook;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_found.account_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if not mail.is_webhook_url(p_url) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'url');
  end if;
  if v_events is null or cardinality(v_events) > 8 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'events');
  end if;
  if v_desc is not null and char_length(v_desc) > 100 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'description');
  end if;
  if v_hook.url is distinct from p_url then v_fields := array_append(v_fields, 'url'); end if;
  if v_hook.events is distinct from v_events then v_fields := array_append(v_fields, 'events'); end if;
  if v_hook.description is distinct from v_desc then v_fields := array_append(v_fields, 'description'); end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', true, 'webhookId', v_hook.id, 'changed', '[]'::jsonb);
  end if;
  update mail.webhooks set url = p_url, events = v_events, description = v_desc, updated_at = now()
   where id = v_hook.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_hook.account_id, 'user', v_user, 'webhook.updated', v_hook.id::text,
          jsonb_build_object('fields', to_jsonb(v_fields)));
  return jsonb_build_object('ok', true, 'webhookId', v_hook.id, 'changed', to_jsonb(v_fields));
end;
$$;

create function mail.set_webhook_enabled(p_account_id uuid, p_webhook_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_found record;
  v_hook  mail.webhooks;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if p_enabled is null then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'enabled');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, p_webhook_id);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_hook := v_found.webhook;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if p_enabled and v_found.account_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if (v_hook.status = 'enabled') = p_enabled then
    return jsonb_build_object('ok', true, 'webhookId', v_hook.id, 'already', true);
  end if;
  if p_enabled then
    update mail.webhooks
       set status = 'enabled', disabled_reason = null, disabled_at = null, failing_since = null,
           owner_notice_due = false, updated_at = now()
     where id = v_hook.id;
  else
    update mail.webhooks
       set status = 'disabled', disabled_reason = 'customer', disabled_at = now(), owner_notice_due = false,
           updated_at = now()
     where id = v_hook.id;
    update mail.webhook_deliveries
       set status = 'failed', status_reason = 'endpoint_disabled', updated_at = now()
     where webhook_id = v_hook.id and status = 'pending';
  end if;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_hook.account_id, 'user', v_user, case when p_enabled then 'webhook.enabled' else 'webhook.disabled' end,
          v_hook.id::text, case when p_enabled then '{}'::jsonb else jsonb_build_object('reason', 'customer') end);
  return jsonb_build_object('ok', true, 'webhookId', v_hook.id);
end;
$$;

create function mail.rotate_webhook_secret(p_account_id uuid, p_webhook_id uuid, p_secret_sealed text,
                                           p_secret_hint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_found record;
  v_hook  mail.webhooks;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, p_webhook_id);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_hook := v_found.webhook;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_found.account_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if not mail.is_sealed_secret(p_secret_sealed, p_secret_hint) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'secret');
  end if;
  update mail.webhooks set secret_sealed = p_secret_sealed, secret_hint = p_secret_hint, updated_at = now()
   where id = v_hook.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target)
  values (v_hook.account_id, 'user', v_user, 'webhook.secret_rotated', v_hook.id::text);
  return jsonb_build_object('ok', true, 'webhookId', v_hook.id);
end;
$$;

create function mail.delete_webhook(p_account_id uuid, p_webhook_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_found record;
  v_hook  mail.webhooks;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, p_webhook_id);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_hook := v_found.webhook;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  delete from mail.webhooks where id = v_hook.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target)
  values (v_hook.account_id, 'user', v_user, 'webhook.deleted', v_hook.id::text);
  return jsonb_build_object('ok', true);
end;
$$;

create function mail.resend_webhook_delivery(p_account_id uuid, p_delivery_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_delivery mail.webhook_deliveries;
  v_found    record;
  v_hours    integer;
  v_id       bigint;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_delivery from mail.webhook_deliveries d
   where d.id = p_delivery_id and d.account_id = p_account_id;
  if v_delivery.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, v_delivery.webhook_id);
  if not found or v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_found.account_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if (v_found.webhook).status <> 'enabled' then
    return jsonb_build_object('ok', false, 'code', 'webhook_disabled');
  end if;
  if v_delivery.status in ('pending', 'delivering')
     or exists (select 1 from mail.webhook_deliveries d
                 where d.resend_of = v_delivery.id and d.status in ('pending', 'delivering')) then
    return jsonb_build_object('ok', false, 'code', 'in_progress');
  end if;
  select s.webhook_retry_hours into v_hours from mail.settings s where s.id;
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, email_id,
                                       give_up_at, resend_of)
  values (v_delivery.webhook_id, v_delivery.account_id, v_delivery.message_id, v_delivery.event_type,
          v_delivery.payload, v_delivery.email_id, now() + make_interval(hours => coalesce(v_hours, 24)),
          v_delivery.id)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'deliveryId', v_id);
end;
$$;


-- ── 5. Live API keys, at most mail.settings.api_keys_max an account (review 13)
-- As migrations 43 and 48, plus the cap: `key_limit` with `max` once the
-- account holds that many unrevoked keys. The account's row is locked first,
-- so two creations cannot both pass the count.

create or replace function mail.create_api_key(p_account_id uuid, p_name text, p_permission text,
                                    p_prefix text, p_key_hash text, p_domain_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_role  text;
  v_state text;
  v_id    uuid;
  v_max   integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select m.role, a.state into v_role, v_state
    from mail.members m join mail.accounts a on a.id = m.account_id
   where m.account_id = p_account_id and m.user_id = v_user;
  perform 1 from mail.accounts a where a.id = p_account_id for update;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if p_permission is null or p_permission not in ('full', 'sending') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'permission');
  end if;
  if not (v_role in ('owner', 'admin') or (v_role = 'developer' and p_permission = 'sending')) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;
  if coalesce(p_prefix, '') !~ '^mdh_live_[A-Za-z0-9]{4}$' or coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'key');
  end if;
  if p_domain_id is not null then
    if p_permission <> 'sending' then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'domain');
    end if;
    if not exists (select 1 from mail.domains d
                    where d.id = p_domain_id and d.account_id = p_account_id and d.status <> 'removed') then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'domain');
    end if;
  end if;

  select s.api_keys_max into v_max from mail.settings s where s.id;
  if (select count(*) from mail.api_keys k
       where k.account_id = p_account_id and k.revoked_at is null) >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'key_limit', 'max', coalesce(v_max, 0));
  end if;

  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, domain_id, created_by)
  values (p_account_id, btrim(p_name), p_prefix, p_key_hash, p_permission, p_domain_id, v_user)
  returning id into v_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'key.created', v_id::text,
          jsonb_build_object('prefix', p_prefix, 'permission', p_permission));
  return jsonb_build_object('ok', true, 'keyId', v_id);
end;
$$;

create or replace function mail.api_create_key(p_account_id uuid, p_actor_key_id uuid, p_name text, p_permission text,
                                    p_prefix text, p_key_hash text, p_domain_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_actor text;
  v_key   mail.api_keys;
  v_max   integer;
begin
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state is null or not mail.is_full_key(p_account_id, p_actor_key_id) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if p_permission is null or p_permission not in ('full', 'sending') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'permission');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;
  if coalesce(p_prefix, '') !~ '^mdh_live_[A-Za-z0-9]{4}$' or coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'key');
  end if;
  if p_domain_id is not null and (p_permission <> 'sending' or not exists (
       select 1 from mail.domains d
        where d.id = p_domain_id and d.account_id = p_account_id and d.status <> 'removed')) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'domain');
  end if;

  select s.api_keys_max into v_max from mail.settings s where s.id;
  if (select count(*) from mail.api_keys k
       where k.account_id = p_account_id and k.revoked_at is null) >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'key_limit', 'max', coalesce(v_max, 0));
  end if;

  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, domain_id)
  values (p_account_id, btrim(p_name), p_prefix, p_key_hash, p_permission, p_domain_id)
  returning * into v_key;
  select k.prefix into v_actor from mail.api_keys k where k.id = p_actor_key_id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (p_account_id, 'api', 'key.created', v_key.id::text,
          jsonb_build_object('prefix', v_key.prefix, 'permission', v_key.permission,
                             'byKeyId', p_actor_key_id, 'byKeyPrefix', v_actor));
  return jsonb_build_object('ok', true, 'key', jsonb_build_object(
    'id', v_key.id, 'name', v_key.name, 'prefix', v_key.prefix, 'permission', v_key.permission,
    'domainId', v_key.domain_id, 'createdAt', mail.utc_text(v_key.created_at), 'lastUsedAt', null));
end;
$$;

-- ── 6. Claims that did not prove the name (reviews 10, 11) ──────────────────
-- §5 releases an unverified claim at 72 hours so nobody can squat a name; but
-- the same account could claim it again at once, and again, and hold it for
-- ever. Each claim that ends unproven — failed, or removed while pending — is
-- written here (a trigger on mail.domains, whoever moved it), and
-- claim_domain_name reads it: the name waits settings.domain_claim_cooldown_days
-- for that account and every account sharing a member with it, and an account
-- may have only settings.domain_failed_claims_max failed claims (removals not
-- counted) in settings.domain_failed_claims_window_days. Functions only: RLS
-- on, no policy, no grant. Kept 90 days (the longest window the settings
-- allow), then purged daily.
create table mail.domain_claim_failures (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  domain_id   uuid references mail.domains (id) on delete set null,
  name        text not null check (char_length(name) <= 253),
  -- failed_reason for a failed claim (dkim_record_missing, ses_identity_exists…),
  -- or removed_unverified.
  reason      text not null check (reason ~ '^[a-z_]{1,60}$'),
  failed_at   timestamptz not null default now()
);
create index domain_claim_failures_name on mail.domain_claim_failures (name, failed_at desc);
create index domain_claim_failures_account on mail.domain_claim_failures (account_id, failed_at desc);

create function mail.note_claim_failure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into mail.domain_claim_failures (account_id, domain_id, name, reason)
  values (new.account_id, new.id, new.name,
          case when new.status = 'failed' then coalesce(new.failed_reason, 'failed') else 'removed_unverified' end);
  return null;
end;
$$;
create trigger domains_claim_failure after update of status on mail.domains
  for each row when (new.kind = 'customer' and old.status = 'pending'
                     and new.status in ('failed', 'removing', 'removed'))
  execute function mail.note_claim_failure();

select cron.schedule('mail-purge-claim-failures', '41 3 * * *',
                     'delete from mail.domain_claim_failures where failed_at < now() - interval ''90 days''');

-- As migration 47, plus, after a name's own claim is checked and before the
-- plan's count: related_in_use (another account holds a live claim on a parent
-- or a child of the name), claim_cooldown (with `until`) and
-- too_many_failed_claims (with `max`, `windowDays` and `until`). The name and
-- every parent of it are locked, so a parent and a child are never decided
-- side by side.

create or replace function mail.claim_domain_name(p_account_id uuid, p_name text, p_actor text, p_user uuid,
                                       p_key_id uuid, p_key_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account mail.accounts;
  v_name    text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\.+$', ''));
  v_claim   mail.domains;
  v_reuse   uuid;
  v_max     integer;
  v_held    integer;
  v_id      uuid;
  v_settings mail.settings;
  v_labels  text[];
  v_until   timestamptz;
  v_failed  integer;
begin
  -- One add at a time per account, so two cannot both pass the plan's count.
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if mail.is_reserved_domain(v_name) then
    return jsonb_build_object('ok', false, 'code', 'reserved');
  end if;
  if not mail.domain_name_ok(v_name) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;

  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;

  -- One name, one claim, across every account; and a name, its parents and
  -- its children are decided one at a time: every suffix of two labels or
  -- more is locked, shortest first (one order for everyone, so no deadlock).
  v_labels := string_to_array(v_name, '.');
  for v_i in reverse cardinality(v_labels) - 1 .. 1 loop
    perform pg_advisory_xact_lock(hashtextextended('mail.domain:' || array_to_string(v_labels[v_i:], '.'), 0));
  end loop;
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

  -- Review 11: SES lets a verified parent cover its subdomains within one AWS
  -- account, so a name is never claimed under, or above, another account's
  -- live claim (or a sandbox sender, which lives under our reserved name).
  if exists (select 1 from mail.domains d
              where d.account_id <> p_account_id
                and ((d.kind = 'customer' and d.released_at is null) or d.status = 'sandbox')
                and (right(v_name, char_length(d.name) + 1) = '.' || d.name
                     or right(d.name, char_length(v_name) + 1) = '.' || v_name)) then
    return jsonb_build_object('ok', false, 'code', 'related_in_use');
  end if;

  -- Review 10: the name's last unproven claim by these people is recent.
  select max(f.failed_at) into v_until
    from mail.domain_claim_failures f
   where f.name = v_name
     and f.failed_at > now() - make_interval(days => v_settings.domain_claim_cooldown_days)
     and f.account_id in (select p_account_id
                          union
                          select m2.account_id
                            from mail.members m1 join mail.members m2 on m2.user_id = m1.user_id
                           where m1.account_id = p_account_id);
  if v_until is not null then
    return jsonb_build_object('ok', false, 'code', 'claim_cooldown',
                              'until', v_until + make_interval(days => v_settings.domain_claim_cooldown_days));
  end if;

  -- Review 10: too many failed claims lately; open again when the oldest that
  -- keeps the count at the cap leaves the window.
  select count(*) into v_failed
    from mail.domain_claim_failures f
   where f.account_id = p_account_id and f.reason <> 'removed_unverified'
     and f.failed_at > now() - make_interval(days => v_settings.domain_failed_claims_window_days);
  if v_failed >= v_settings.domain_failed_claims_max then
    select f.failed_at + make_interval(days => v_settings.domain_failed_claims_window_days) into v_until
      from mail.domain_claim_failures f
     where f.account_id = p_account_id and f.reason <> 'removed_unverified'
       and f.failed_at > now() - make_interval(days => v_settings.domain_failed_claims_window_days)
     order by f.failed_at
     offset v_failed - v_settings.domain_failed_claims_max
     limit 1;
    return jsonb_build_object('ok', false, 'code', 'too_many_failed_claims',
                              'max', v_settings.domain_failed_claims_max,
                              'windowDays', v_settings.domain_failed_claims_window_days, 'until', v_until);
  end if;

  select p.max_domains into v_max from mail.plans p where p.code = v_account.plan_code;
  select count(*) into v_held from mail.domains d
   where d.account_id = p_account_id and d.kind = 'customer' and d.released_at is null;
  if v_held >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'domain_limit', 'max', coalesce(v_max, 0));
  end if;

  select d.id into v_reuse from mail.domains d
   where d.account_id = p_account_id and d.name = v_name and d.kind = 'customer'
     and d.status = 'failed' and d.released_at is not null
   order by d.created_at desc
   limit 1;
  if v_reuse is not null then
    update mail.domains
       set status = 'pending', claimed_at = now(), released_at = null, added_by = p_user,
           identity_arn = null, dkim_tokens = '{}', dkim_status = null, mail_from_status = null,
           identity_created_at = null, mail_from_set_at = null, config_set_at = null,
           tenant_associated_at = null, failed_reason = null, missing_record = null, verified_at = null,
           last_checked_at = null, attempts = 0, last_error = null, next_attempt_at = now(),
           locked_by = null, locked_until = null, updated_at = now()
     where id = v_reuse;
    v_id := v_reuse;
  else
    insert into mail.domains (account_id, name, status, claimed_at, added_by, mail_from_domain)
    values (p_account_id, v_name, 'pending', now(), p_user, 'send.' || v_name)
    returning id into v_id;
  end if;

  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, p_actor, p_user, case when v_reuse is null then 'domain.added' else 'domain.retried' end,
          v_id::text, jsonb_build_object('name', v_name)
          || case when p_key_id is null then '{}'::jsonb
                  else jsonb_build_object('byKeyId', p_key_id, 'byKeyPrefix', p_key_prefix) end);
  return jsonb_build_object('ok', true, 'domainId', v_id, 'name', v_name);
end;
$$;


-- ── 7. An identity this claim did not make (review 12) ─────────────────────
-- As migration 47, plus `ses_identity_exists`: SES already holds an identity
-- for the name that this claim never recorded creating (an identity made
-- outside Mail, or left by something else). The claim fails and is released
-- without touching that identity: apps/mail deletes from SES only what the
-- claim itself made (identity_created_at).

create or replace function mail.record_domain_failed(p_domain_id uuid, p_worker text, p_reason text,
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
  if p_reason is null
     or p_reason not in ('dkim_record_missing', 'dkim_not_verified', 'not_set_up', 'ses_refused',
                         'ses_identity_exists')
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


-- ── 8. Verified means DKIM verified too (review 19) ────────────────────────
-- As migration 47, plus: a pending domain becomes verified only when SES
-- says it is verified for sending AND its DKIM status is SUCCESS (and every
-- set-up step is recorded, as before).

create or replace function mail.record_domain_check(p_domain_id uuid, p_worker text, p_state jsonb)
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
    when v_domain.status = 'pending' and v_verified and v_dkim = 'SUCCESS' and v_setup then 'verified'
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

-- ── 9. The gate takes the sandbox sender, and reserves for the send moment ──
-- (reviews 14, 17; MR2, §3.1, §4.4, §7.2, §8)
--
-- reserve_send as migration 51, with two changes:
--   • the sandbox sender: a sandbox account's email from its one sandbox
--     address (sandbox_domain_for) passes the domain gate. Migration 52
--     taught send_gate this and assumed reserve_send knew it already; it did
--     not, so every API send from the sandbox sender was refused at queue time.
--   • p_send_at, the moment the email is to go (null or past: now). The
--     plan's day and month are that moment's in Lagos, and the shared budget
--     is held for every 24-hour window that holds its hour. Before, a
--     scheduled email counted on the day it was queued, so three days of a
--     full cap could be scheduled for one moment, past the caps, the warm-up
--     and the SES account's budget alike.
-- enqueue_email passes its scheduled moment; reschedule_email gives the
-- reservation back and takes one for the new moment, or keeps the old and
-- answers the refusal. The old four-argument reserve_send is dropped.
drop function mail.reserve_send(uuid, uuid, text, text[]);

create function mail.reserve_send(p_account_id uuid, p_api_key_id uuid, p_from_address text,
                                  p_recipients text[], p_send_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  mail.accounts;
  v_settings mail.settings;
  v_key      mail.api_keys;
  v_domain   mail.domains;
  v_n        integer := coalesce(cardinality(p_recipients), 0);
  v_from     text := mail.address_of(p_from_address);
  -- The moment it is to go: its own day, month and hour are the ones it counts against.
  v_at       timestamptz := greatest(coalesce(p_send_at, now()), now());
  v_today    date := mail.lagos_day(greatest(coalesce(p_send_at, now()), now()));
  v_month    date := date_trunc('month', mail.lagos_day(greatest(coalesce(p_send_at, now()), now()))::timestamp)::date;
  v_hour     timestamptz := date_trunc('hour', greatest(coalesce(p_send_at, now()), now()));
  v_over     boolean;
  v_caps     record;
  v_day_used integer;
  v_mon_used bigint;
  v_total    bigint;
  v_mine     bigint;
  v_allowed  bigint;
begin
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null or v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if v_account.state = 'paused' or v_account.ses_status = 'disabled' then
    return jsonb_build_object('ok', false, 'code', 'account_paused');
  end if;
  if v_account.tenant_ready_at is null then
    return jsonb_build_object('ok', false, 'code', 'account_not_ready');
  end if;
  if p_api_key_id is not null then
    select * into v_key from mail.api_keys where id = p_api_key_id;
    if v_key.id is null or v_key.account_id <> p_account_id or v_key.revoked_at is not null then
      return jsonb_build_object('ok', false, 'code', 'unauthorized');
    end if;
  end if;

  select * into v_domain from mail.domains d
   where d.account_id = p_account_id and d.status = 'verified'
     and d.name = substring(v_from from '@([^@]+)$');
  -- §7.2 with MR2: in the sandbox, the account's sandbox sender, from its one
  -- address (migration 47's sandbox_domain_for; migration 52 asks the same at send time).
  if v_domain.id is null and v_account.state = 'sandbox' then
    select * into v_domain from mail.domains d
     where d.id = mail.sandbox_domain_for(p_account_id, p_from_address);
  end if;
  if v_domain.id is null then
    return jsonb_build_object('ok', false, 'code', 'domain_not_verified');
  end if;
  if v_key.domain_id is not null and v_key.domain_id <> v_domain.id then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'reason', 'key_domain');
  end if;

  if v_n < 1 or v_n > 50
     or exists (select 1 from unnest(p_recipients) r where r is null or r <> lower(r) or r !~ '^[^@\s<>]+@[^@\s<>]+$') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients');
  end if;

  -- §7.2: the sandbox sends only to its own members' confirmed addresses.
  if v_account.state = 'sandbox' and exists (
       select 1 from unnest(p_recipients) r
        where not exists (
          select 1 from mail.members m join auth.users u on u.id = m.user_id
           where m.account_id = p_account_id and lower(u.email) = r and u.email_confirmed_at is not null)) then
    return jsonb_build_object('ok', false, 'code', 'sandbox_recipient');
  end if;

  if exists (select 1 from mail.suppressions s where s.account_id = p_account_id and s.address = any (p_recipients)) then
    return jsonb_build_object('ok', false, 'code', 'suppressed', 'domainId', v_domain.id);
  end if;

  -- The plan's caps for today and this month (Lagos), in recipients.
  select * into v_caps from mail.effective_caps(v_account);
  select coalesce(sum(u.queued) filter (where u.day = v_today), 0),
         coalesce(sum(u.queued), 0)
    into v_day_used, v_mon_used
    from mail.usage_daily u
   where u.account_id = p_account_id and u.day >= v_month and u.day <= v_today;
  if v_day_used + v_n > v_caps.daily then
    perform mail.note_cap_use(p_account_id, 'day', v_today, v_caps.daily, v_day_used, true);
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'day', 'cap', v_caps.daily,
                              'retryAfter', ceil(extract(epoch from
                                ((v_today + 1)::timestamp at time zone 'Africa/Lagos') - now()))::integer);
  end if;
  if v_mon_used + v_n > v_caps.monthly then
    perform mail.note_cap_use(p_account_id, 'month', v_month, v_caps.monthly, v_mon_used, true);
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'month', 'cap', v_caps.monthly,
                              'retryAfter', ceil(extract(epoch from
                                ((v_month + interval '1 month') at time zone 'Africa/Lagos') - now()))::integer);
  end if;

  -- The SES account's shared 24-hour budget (§4.4, owner 6 Oct 2026). One
  -- lock for every account, so concurrent reservations cannot overshoot it;
  -- no account may hold more than half of what the others leave. Every
  -- 24-hour window holding the send hour must keep both rules — the hours
  -- in (send − 24h, send + 24h), window by window — so emails scheduled
  -- for one moment cannot pile up past the budget.
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mail.send_budget', 0));
  select coalesce(bool_or(w.total + v_n > v_settings.account_daily_budget
                          or w.mine + v_n > floor((v_settings.account_daily_budget - (w.total - w.mine)) / 2.0)),
                  false)
    into v_over
    from generate_series(v_hour - interval '23 hours', v_hour, interval '1 hour') s(start)
    cross join lateral (
      select coalesce(sum(b.recipients), 0) as total,
             coalesce(sum(b.recipients) filter (where b.account_id = p_account_id), 0) as mine
        from mail.send_budget_hourly b
       where b.hour >= s.start and b.hour < s.start + interval '24 hours') w;
  if v_over then
    return jsonb_build_object('ok', false, 'code', 'budget_exceeded',
                              'retryAfter', ceil(extract(epoch from (date_trunc('hour', now()) + interval '1 hour') - now()))::integer);
  end if;

  perform mail.bump_usage(p_account_id, v_today, 'queued', v_n);
  insert into mail.send_budget_hourly as b (hour, account_id, recipients) values (v_hour, p_account_id, v_n)
  on conflict (hour, account_id) do update set recipients = b.recipients + v_n;
  -- §8: 80% and 100% of today's and this month's caps, noted once each.
  perform mail.note_cap_use(p_account_id, 'day', v_today, v_caps.daily, v_day_used + v_n, false);
  perform mail.note_cap_use(p_account_id, 'month', v_month, v_caps.monthly, v_mon_used + v_n, false);
  return jsonb_build_object('ok', true, 'domainId', v_domain.id, 'recipients', v_n,
                            'reservedOn', v_today, 'reservedHour', v_hour, 'sendAt', v_at);
end;
$$;

create or replace function mail.enqueue_email(p_account_id uuid, p_api_key_id uuid, p_email jsonb, p_payload jsonb,
                                              p_idempotency_key text default null, p_request_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from    text;
  v_to      text[];
  v_cc      text[];
  v_bcc     text[];
  v_reply   text[];
  v_all     text[];
  v_subject text;
  v_tags    jsonb;
  v_headers jsonb;
  v_attach  jsonb;
  v_size    integer;
  v_prior   mail.emails;
  v_gate    jsonb;
  v_id      bigint;
  v_public  uuid;
  v_status  text;
  v_sched   timestamptz;
  v_send_at timestamptz;
begin
  if p_account_id is null or jsonb_typeof(p_email) is distinct from 'object'
     or jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  if (p_idempotency_key is null) <> (p_request_hash is null)
     or coalesce(p_idempotency_key, 'x') !~ '^[\x21-\x7e]+$' or char_length(p_idempotency_key) > 256
     or coalesce(p_request_hash, repeat('0', 64)) !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'idempotency_key');
  end if;

  v_from := p_email ->> 'from';
  v_to := mail.text_array(p_email -> 'to');
  v_cc := mail.text_array(p_email -> 'cc');
  v_bcc := mail.text_array(p_email -> 'bcc');
  v_reply := mail.text_array(p_email -> 'reply_to');
  v_subject := p_email ->> 'subject';
  v_tags := coalesce(p_email -> 'tags', '[]'::jsonb);
  v_headers := coalesce(p_payload -> 'headers', '{}'::jsonb);
  v_attach := coalesce(p_payload -> 'attachments', '[]'::jsonb);
  if not mail.is_mailbox(v_from) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'from');
  end if;
  if v_to is null or v_cc is null or v_bcc is null or v_reply is null or cardinality(v_to) < 1
     or cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 50 or cardinality(v_reply) > 50
     or exists (select 1 from unnest(v_to || v_cc || v_bcc || v_reply) m where not mail.is_mailbox(m)) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients');
  end if;
  if v_subject is null or char_length(v_subject) not between 1 and 998 or v_subject ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'subject');
  end if;
  if jsonb_typeof(v_tags) <> 'array' or jsonb_typeof(v_headers) <> 'object' or jsonb_typeof(v_attach) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  if coalesce(p_payload ->> 'html', '') = '' and coalesce(p_payload ->> 'text', '') = '' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  -- §3.1: scheduled at most 72 hours ahead (five minutes' grace for clocks);
  -- a moment already past is now, so a retried request still sends.
  if jsonb_typeof(p_email -> 'scheduled_at') is not null and jsonb_typeof(p_email -> 'scheduled_at') <> 'null' then
    v_sched := case when jsonb_typeof(p_email -> 'scheduled_at') = 'string'
                    then mail.as_timestamptz(p_email ->> 'scheduled_at') end;
    if v_sched is null or v_sched > now() + interval '72 hours 5 minutes' then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'scheduled_at');
    end if;
  end if;
  v_send_at := greatest(coalesce(v_sched, now()), now());
  -- A backstop behind the app's own limit: what PostgREST carried, at most.
  v_size := octet_length(p_payload::text);
  if v_size > 8 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'size');
  end if;
  -- Each recipient once: the caps, the budget and SES all count recipients.
  v_all := array(select distinct mail.address_of(m) from unnest(v_to || v_cc || v_bcc) m);
  if cardinality(v_all) <> cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients', 'reason', 'duplicate');
  end if;

  -- One account at a time from here: the replay check and the reservation
  -- see each other's writes (reserve_send takes the same lock).
  perform 1 from mail.accounts where id = p_account_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;

  if p_idempotency_key is not null then
    select * into v_prior from mail.emails
     where account_id = p_account_id and idempotency_key = p_idempotency_key;
    if v_prior.id is not null then
      if v_prior.created_at > now() - interval '24 hours' then
        if v_prior.request_hash = p_request_hash then
          return jsonb_build_object('ok', true, 'id', v_prior.public_id, 'status', v_prior.status,
                                    'replayed', true);
        end if;
        return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
      end if;
      -- Older than a day: the key is free again.
      update mail.emails set idempotency_key = null, request_hash = null, updated_at = now()
       where id = v_prior.id;
    end if;
  end if;

  v_gate := mail.reserve_send(p_account_id, p_api_key_id, v_from, v_all, v_send_at);
  if not coalesce((v_gate ->> 'ok')::boolean, false) and v_gate ->> 'code' is distinct from 'suppressed' then
    return v_gate;
  end if;
  v_status := case when (v_gate ->> 'ok')::boolean then 'queued' else 'suppressed' end;

  insert into mail.emails (account_id, api_key_id, domain_id, from_address, to_addresses, cc_addresses,
                           bcc_addresses, reply_to, subject, tags, status, status_reason, idempotency_key,
                           request_hash, reserved_on, reserved_hour, scheduled_at, next_attempt_at)
  values (p_account_id, p_api_key_id, (v_gate ->> 'domainId')::uuid, v_from, v_to, v_cc, v_bcc, v_reply,
          v_subject, v_tags, v_status, case when v_status = 'suppressed' then 'suppressed' end,
          p_idempotency_key, p_request_hash,
          (v_gate ->> 'reservedOn')::date, (v_gate ->> 'reservedHour')::timestamptz, v_send_at, v_send_at)
  returning id, public_id into v_id, v_public;
  if v_status = 'queued' then
    insert into mail.email_payloads (email_id, html, text, headers, attachments, size_bytes)
    values (v_id, nullif(p_payload ->> 'html', ''), nullif(p_payload ->> 'text', ''), v_headers, v_attach, v_size);
  end if;
  return jsonb_build_object('ok', true, 'id', v_public, 'status', v_status, 'replayed', false);
end;
$$;

-- PATCH /emails/{id} (migration 48), now through the gate again: the
-- reservation of the old moment is given back and one for the new moment
-- taken (reserve_send's caps, warm-up and budget, for that moment's day and
-- hours). A refusal undoes the giving back — one subtransaction — so the
-- email keeps its old moment and reservation, and the refusal is answered as
-- POST /emails answers it.
create or replace function mail.reschedule_email(p_account_id uuid, p_public_id uuid, p_scheduled_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email mail.emails;
  v_at    timestamptz;
  v_all   text[];
  v_gate  jsonb;
begin
  if p_scheduled_at is null or p_scheduled_at > now() + interval '72 hours 5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'scheduled_at');
  end if;
  -- Waits for a claim in progress, then reads the row as it left it.
  select * into v_email from mail.emails
   where account_id = p_account_id and public_id = p_public_id
     for update;
  if v_email.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_email.status <> 'queued' or v_email.attempts > 0 then
    return jsonb_build_object('ok', false, 'code', 'not_pending',
                              'status', case when v_email.status = 'queued' then 'sending' else v_email.status end);
  end if;
  v_at := greatest(p_scheduled_at, now());
  v_all := array(select distinct mail.address_of(m)
                   from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m);

  begin
    perform mail.release_reservation(v_email.id);
    v_gate := mail.reserve_send(p_account_id, v_email.api_key_id, v_email.from_address, v_all, v_at);
    if not coalesce((v_gate ->> 'ok')::boolean, false) then
      -- PL/pgSQL variables outlive the rollback below; the release does not.
      raise exception 'mail.reschedule_email: refused' using errcode = 'MB302';
    end if;
  exception when sqlstate 'MB302' then
    return v_gate;
  end;

  update mail.emails
     set scheduled_at = v_at, next_attempt_at = v_at,
         reserved_on = (v_gate ->> 'reservedOn')::date, reserved_hour = (v_gate ->> 'reservedHour')::timestamptz,
         updated_at = now()
   where id = v_email.id;
  return jsonb_build_object('ok', true, 'id', v_email.public_id, 'status', 'queued',
                            'scheduledAt', mail.utc_text(v_at));
end;
$$;

-- ── 10. A pause by SES pauses the account in our own gate too (review 18, MR5)
-- Before, SES's DISABLED for a tenant set ses_status, which the gate refused —
-- and SES's ENABLED set it back, so the gate reopened by itself. Now a DISABLED
-- we did not ask for (asked_ses_to_pause) also pauses the account here: state
-- `paused`, the state it interrupted in pre_pause_state, state_reason
-- `paused_by_ses`, and a pause finding (source `ses`) for the admin to read.
-- ENABLED and REINSTATED still record SES's status and close SES's own
-- finding, but leave the account paused: only an owner's
-- admin_mail_resume_account reopens it, and that waits for SES's enabled
-- status (its SES_PAUSED check). As migration 49 otherwise.
alter table mail.safety_findings drop constraint safety_findings_source_check;
alter table mail.safety_findings
  add constraint safety_findings_source_check check (source in ('threshold', 'admin', 'ses'));

create or replace function mail.record_tenant_event(p_event_id text, p_type text, p_tenant text default null,
                                         p_identity text default null, p_resource_arn text default null,
                                         p_occurred_at timestamptz default null, p_status text default null,
                                         p_origin text default null, p_finding text default null,
                                         p_impact text default null, p_summary text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text := nullif(left(btrim(coalesce(p_event_id, '')), 200), '');
  v_at      timestamptz := least(coalesce(p_occurred_at, now()), now() + interval '5 minutes');
  v_account mail.accounts;
  v_arn     text := nullif(left(btrim(coalesce(p_resource_arn, '')), 300), '');
  v_summary text := nullif(left(regexp_replace(btrim(coalesce(p_summary, '')),
                                               '[^\s<>()"'',;:@]+@[^\s<>()"'',;:@]+', '[address]', 'g'), 500), '');
  v_origin  text := nullif(left(regexp_replace(upper(coalesce(p_origin, '')), '[^A-Z_]', '', 'g'), 40), '');
  v_status  text;
  v_kind    text;
  v_impact  text := case lower(coalesce(p_impact, '')) when 'high' then 'high' when 'low' then 'low' end;
  v_open    mail.findings;
  v_pause   bigint;
begin
  if p_type is null or p_type not in ('sending_status', 'advisor_open', 'advisor_resolved') then
    raise exception 'record_tenant_event: % is not a tenant event', p_type using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'record_tenant_event: an event id is needed' using errcode = '22023';
  end if;

  if coalesce(p_tenant, '') <> '' then
    select * into v_account from mail.accounts where ses_tenant = p_tenant for update;
  elsif coalesce(p_identity, '') <> '' then
    select a.* into v_account
      from mail.domains d join mail.accounts a on a.id = d.account_id
     where d.name = lower(p_identity) and d.status in ('pending', 'verified')
     for update of a;
  end if;
  if v_account.id is null then
    return jsonb_build_object('ok', true, 'known', false);
  end if;
  if exists (select 1 from mail.findings f
              where f.account_id = v_account.id
                and (f.open_event = v_key or f.resolve_event = v_key or f.last_event = v_key)) then
    return jsonb_build_object('ok', true, 'known', true, 'applied', false);
  end if;

  if p_type = 'sending_status' then
    v_status := case upper(coalesce(p_status, ''))
                  when 'DISABLED' then 'disabled' when 'ENABLED' then 'enabled' when 'REINSTATED' then 'reinstated'
                end;
    if v_status is null then
      raise exception 'record_tenant_event: % is not a sending status', p_status using errcode = '22023';
    end if;
    -- Never backwards: an older report, or the same one again, changes nothing.
    if v_account.ses_status_at is not null and v_at <= v_account.ses_status_at then
      return jsonb_build_object('ok', true, 'known', true, 'applied', false);
    end if;
    update mail.accounts set ses_status = v_status, ses_status_at = v_at, updated_at = now()
     where id = v_account.id;
    if v_status = 'disabled' then
      -- MR5: a pause is final until a person looks; the finding is what they read.
      insert into mail.findings (account_id, source, kind, impact, summary, resource_arn, opened_at, open_event, detail)
      values (v_account.id, 'ses', 'sending_paused', 'high', v_summary, v_arn, v_at, v_key,
              jsonb_strip_nulls(jsonb_build_object('origin', v_origin)))
      on conflict (account_id, source, kind, coalesce(resource_arn, '')) where resolved_at is null do nothing;
      insert into mail.account_audit_log (account_id, actor, action, target, detail)
      values (v_account.id, 'system', 'ses.sending_paused', v_account.ses_tenant,
              jsonb_strip_nulls(jsonb_build_object('origin', v_origin)));
      -- MR5 (review 18): AWS's pause, not ours echoed back, stops our own gate
      -- as well, so SES's later ENABLED cannot reopen it by itself.
      if not mail.asked_ses_to_pause(v_account.id) then
        v_pause := mail.open_finding(v_account.id, 'ses', 'ses_paused', 'pause',
                                     jsonb_strip_nulls(jsonb_build_object('origin', v_origin, 'eventAt', v_at,
                                                                          'tenant', v_account.ses_tenant)));
        if v_account.state in ('sandbox', 'active') then
          update mail.accounts
             set pre_pause_state = state, state = 'paused', state_reason = 'paused_by_ses', updated_at = now()
           where id = v_account.id;
          insert into mail.account_audit_log (account_id, actor, action, target, detail)
          values (v_account.id, 'system', 'account.paused', v_account.id::text,
                  jsonb_build_object('reason', 'ses', 'findingId', v_pause));
        end if;
      end if;
    else
      update mail.findings
         set resolved_at = greatest(v_at, opened_at), resolve_event = v_key, updated_at = now()
       where account_id = v_account.id and source = 'ses' and kind = 'sending_paused' and resolved_at is null;
      insert into mail.account_audit_log (account_id, actor, action, target, detail)
      values (v_account.id, 'system', 'ses.sending_resumed', v_account.ses_tenant,
              jsonb_strip_nulls(jsonb_build_object('origin', v_origin, 'status', v_status)));
    end if;
    return jsonb_build_object('ok', true, 'known', true, 'applied', true, 'sesStatus', v_status);
  end if;

  -- A recommendation: SES's type names it; one without a type is named by its words.
  v_kind := nullif(left(btrim(regexp_replace(lower(coalesce(p_finding, '')), '[^a-z0-9]+', '_', 'g'), '_'), 60), '');
  if v_kind is null then
    if v_summary is null then
      raise exception 'record_tenant_event: a finding needs a type or words' using errcode = '22023';
    end if;
    v_kind := 'advisor_' || left(md5(v_summary), 12);
  end if;
  select * into v_open from mail.findings f
   where f.account_id = v_account.id and f.source = 'ses' and f.kind = v_kind
     and coalesce(f.resource_arn, '') = coalesce(v_arn, '') and f.resolved_at is null
   for update;

  if p_type = 'advisor_open' then
    if v_open.id is not null then
      -- The newest words win; an older report only moves the opening earlier.
      update mail.findings
         set impact = case when v_at >= coalesce(last_seen_at, opened_at) then coalesce(v_impact, impact) else impact end,
             summary = case when v_at >= coalesce(last_seen_at, opened_at) then coalesce(v_summary, summary) else summary end,
             last_event = case when v_at >= coalesce(last_seen_at, opened_at) then v_key else last_event end,
             last_seen_at = greatest(coalesce(last_seen_at, opened_at), v_at),
             opened_at = least(opened_at, v_at), updated_at = now()
       where id = v_open.id;
      return jsonb_build_object('ok', true, 'known', true, 'applied', true, 'findingId', v_open.id);
    end if;
    -- Resolved at or after this opening: the opening is old news.
    if exists (select 1 from mail.findings f
                where f.account_id = v_account.id and f.source = 'ses' and f.kind = v_kind
                  and coalesce(f.resource_arn, '') = coalesce(v_arn, '') and f.resolved_at >= v_at) then
      return jsonb_build_object('ok', true, 'known', true, 'applied', false);
    end if;
    insert into mail.findings (account_id, source, kind, impact, summary, resource_arn, opened_at, open_event)
    values (v_account.id, 'ses', v_kind, v_impact, v_summary, v_arn, v_at, v_key)
    returning * into v_open;
    return jsonb_build_object('ok', true, 'known', true, 'applied', true, 'findingId', v_open.id);
  end if;

  -- advisor_resolved
  if v_open.id is not null and v_open.opened_at <= v_at then
    update mail.findings set resolved_at = v_at, resolve_event = v_key, updated_at = now() where id = v_open.id;
    return jsonb_build_object('ok', true, 'known', true, 'applied', true, 'findingId', v_open.id);
  end if;
  if v_open.id is not null then
    -- Opened after this resolution (out of order): it stands.
    return jsonb_build_object('ok', true, 'known', true, 'applied', false);
  end if;
  -- Resolved before its opening arrived: remembered, so the late opening is ignored.
  insert into mail.findings (account_id, source, kind, impact, summary, resource_arn, opened_at, resolved_at,
                             resolve_event)
  values (v_account.id, 'ses', v_kind, v_impact, v_summary, v_arn, v_at, v_at, v_key)
  returning * into v_open;
  return jsonb_build_object('ok', true, 'known', true, 'applied', true, 'findingId', v_open.id);
end;
$$;

-- ── 11. Billing: stray charges and paying a past-due plan (reviews 22, 23) ──
-- record_billing_charge as migration 50, with three changes:
--   • a later charge on a paid checkout's reference that pays for nothing asks
--     the app to cancel the Flutterwave subscription only when ours is stale —
--     replaced, canceled, ended, its checkout unapplied, or the account closed
--     — never for an underpaid one: an invoice prints the reference, and
--     anyone can make a tiny charge on it.
--   • a failed charge there makes the subscription past due only within
--     billing_settings.failed_renewal_window_hours of its period's end;
--     otherwise it is recorded as an `unexpected_failed_charge` incident.
--   • a `pay_due` checkout's month starts where the past-due one ended
--     (current_period_end), not when it was paid: the days past due were
--     sending on credit, not free.
alter table mail.billing_incidents drop constraint billing_incidents_kind_check;
alter table mail.billing_incidents
  add constraint billing_incidents_kind_check check (kind in (
    'unknown_reference',          -- an MDM- reference no checkout has
    'tx_ref_mismatch',            -- a charge presented for another checkout
    'mode_mismatch',              -- a test charge for a live checkout, or back
    'currency_mismatch',          -- a successful charge not in naira
    'unapplied_charge',           -- recorded, paid for nothing: refund it
    'subscription_not_canceled',  -- Flutterwave may charge again: cancel it
    'unrecorded_payment',         -- confirmed by Flutterwave, not recorded here
    'unexpected_failed_charge')); -- a failed charge far from the period's end

create or replace function mail.record_billing_charge(p_test_mode boolean, p_transaction_id text, p_tx_ref text,
                                           p_status text, p_amount_kobo bigint, p_currency text,
                                           p_method text, p_card_last4 text, p_card_brand text, p_raw jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_checkout mail.checkouts;
  v_account  mail.accounts;
  v_sub      mail.subscriptions;
  v_prior    mail.payments;
  v_plan     mail.plans;
  v_payment  uuid;
  v_number   text;
  v_start    timestamptz := now();
  v_end      timestamptz;
  v_reason   text;
  v_cancel   text[] := '{}';
  v_status   text := lower(coalesce(p_status, ''));
  v_last4    text := case when coalesce(p_card_last4, '') ~ '^[0-9]{4}$' then p_card_last4 end;
  v_brand    text := case when coalesce(p_card_brand, '') ~ '^[A-Za-z][A-Za-z ]{1,19}$'
                          then upper(p_card_brand) end;
  v_lines    jsonb;
  v_action   text;
  v_window   interval;
begin
  if p_test_mode is null or coalesce(p_transaction_id, '') !~ '^[0-9]{1,20}$' then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  select * into v_settings from mail.billing_settings where id;
  if v_settings.id is null then
    raise exception 'mail.billing_settings is missing' using errcode = '55000';
  end if;

  if coalesce(p_tx_ref, '') ~ '^MDM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_checkout from mail.checkouts where tx_ref = p_tx_ref;
  end if;
  if v_checkout.id is null then
    if v_status = 'successful' then
      perform mail.record_billing_incident(p_test_mode, 'unknown_reference', null, p_transaction_id,
                                           jsonb_build_object('amount_kobo', p_amount_kobo,
                                                              'currency', p_currency));
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'unknown_reference');
  end if;

  -- One account's billing at a time: the redirect and the webhook race.
  select * into v_account from mail.accounts where id = v_checkout.account_id for update;
  select * into v_checkout from mail.checkouts where id = v_checkout.id;
  select * into v_sub from mail.subscriptions where account_id = v_account.id for update;

  -- A test charge never settles a live checkout, nor a live one a test checkout (N12).
  if v_checkout.test_mode <> p_test_mode then
    perform mail.record_billing_incident(p_test_mode, 'mode_mismatch', v_account.id, p_transaction_id,
                                         jsonb_build_object('checkout_test_mode', v_checkout.test_mode));
    return jsonb_build_object('ok', true, 'outcome', 'mismatch');
  end if;

  -- Idempotent on Flutterwave's transaction id.
  select * into v_prior from mail.payments where provider_reference = p_transaction_id;
  if v_prior.id is not null then
    if v_prior.tx_ref <> p_tx_ref then
      perform mail.record_billing_incident(p_test_mode, 'tx_ref_mismatch', v_account.id, p_transaction_id,
                                           jsonb_build_object('reason', 'charge_recorded_for_another_reference'));
      return jsonb_build_object('ok', true, 'outcome', 'mismatch');
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'already', 'applied', v_prior.applied);
  end if;

  if v_status = 'pending' then
    return jsonb_build_object('ok', true, 'outcome', 'pending');
  end if;

  if v_status <> 'successful' then
    -- A first payment that failed changes nothing. A failed charge on a paid
    -- checkout's reference is Flutterwave failing to renew (§8): past due.
    -- Only near the period's end (review 22): anyone can make a charge fail
    -- on a reference printed on an invoice, so one at any other time is an
    -- incident for a person, never a past-due subscription.
    v_window := make_interval(hours => v_settings.failed_renewal_window_hours);
    if v_checkout.status = 'paid' and v_sub.id is not null and v_sub.checkout_id = v_checkout.id
       and v_sub.status = 'active' and v_sub.first_transaction_id is distinct from p_transaction_id
       and now() not between v_sub.current_period_end - v_window and v_sub.current_period_end + v_window then
      perform mail.record_billing_incident(p_test_mode, 'unexpected_failed_charge', v_account.id,
                                           p_transaction_id,
                                           jsonb_build_object('status', v_status, 'amount_kobo', p_amount_kobo));
      return jsonb_build_object('ok', true, 'outcome', 'failed');
    end if;
    if v_checkout.status = 'paid' and v_sub.id is not null and v_sub.checkout_id = v_checkout.id
       and v_sub.status = 'active' and v_sub.first_transaction_id is distinct from p_transaction_id then
      update mail.subscriptions
         set status = 'past_due', past_due_reason = 'renewal_failed', past_due_since = now(),
             past_due_until = greatest(current_period_end, now())
                              + make_interval(days => v_settings.past_due_days),
             scheduled_plan_code = null, scheduled_at = null, updated_at = now()
       where id = v_sub.id;
      perform mail.billing_note(v_account.id, 'system', 'billing.renewal_failed',
                                jsonb_build_object('plan', v_sub.plan_code));
      return jsonb_build_object('ok', true, 'outcome', 'renewal_failed');
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'failed');
  end if;

  -- Not naira: never applied and not refunded automatically; a person looks.
  if upper(coalesce(p_currency, '')) <> 'NGN' then
    perform mail.record_billing_incident(p_test_mode, 'currency_mismatch', v_account.id, p_transaction_id,
                                         jsonb_build_object('currency', left(p_currency, 3)));
    return jsonb_build_object('ok', true, 'outcome', 'mismatch');
  end if;
  if coalesce(p_amount_kobo, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;

  -- ── A later charge on a paid checkout's reference: a renewal.
  if v_checkout.status <> 'open' then
    v_reason := case
      when v_checkout.status = 'unapplied' then 'checkout_unapplied'
      when v_sub.id is null or v_sub.checkout_id is distinct from v_checkout.id then 'subscription_replaced'
      when v_sub.status = 'ended' then 'subscription_ended'
      when v_account.state = 'closed' then 'account_closed'
      when v_sub.scheduled_plan_code is not null or v_sub.provider_canceled_at is not null then 'subscription_canceled'
      when p_amount_kobo < v_sub.amount_kobo then 'underpaid'
      else null end;
    if v_reason is not null then
      perform mail.billing_unapplied(p_test_mode, v_account.id, v_checkout.id, v_sub.id, 'renewal',
                                     coalesce(v_sub.plan_code, v_checkout.plan_code), p_transaction_id, p_tx_ref,
                                     p_amount_kobo, p_method, p_raw, v_reason);
      -- Stop the Flutterwave subscription only when ours is stale (review
      -- 22): never for an underpaid charge, which anyone can make on a
      -- reference an invoice prints.
      return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', v_reason,
                                'cancelTransactions',
                                case when v_reason in ('subscription_replaced', 'subscription_canceled',
                                                       'subscription_ended', 'checkout_unapplied',
                                                       'account_closed')
                                     then to_jsonb(array_remove(array[v_checkout.paid_transaction_id], null))
                                     else '[]'::jsonb end);
    end if;

    -- Late or early, the month follows on from the last: no gap, no overlap.
    v_start := v_sub.current_period_end;
    v_end := mail.billing_period_end(v_start);
    insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                               provider_reference, tx_ref, amount_kobo, currency, method, test_mode,
                               period_start, period_end, raw)
    values (v_account.id, v_sub.id, v_checkout.id, 'renewal', true, v_sub.plan_code, p_transaction_id, p_tx_ref,
            p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, v_start, v_end,
            coalesce(p_raw, '{}'))
    returning id into v_payment;
    select * into v_plan from mail.plans where code = v_sub.plan_code;
    v_number := mail.billing_issue_invoice(
      v_payment,
      jsonb_build_array(jsonb_build_object('description', v_plan.name || ' plan, one month',
                                           'amountKobo', v_sub.price_kobo)),
      v_sub.price_kobo, v_sub.vat_bps);
    update mail.subscriptions
       set status = 'active', current_period_start = v_start, current_period_end = v_end,
           past_due_reason = null, past_due_since = null, past_due_until = null,
           card_last4 = coalesce(v_last4, card_last4), card_brand = coalesce(v_brand, card_brand),
           updated_at = now()
     where id = v_sub.id;
    if v_account.plan_code is distinct from v_sub.plan_code then
      update mail.accounts set plan_code = v_sub.plan_code, updated_at = now() where id = v_account.id;
    end if;
    perform mail.billing_note(v_account.id, 'system', 'billing.renewed',
                              jsonb_build_object('plan', v_sub.plan_code, 'invoice', v_number));
    return jsonb_build_object('ok', true, 'outcome', 'renewed', 'invoiceNumber', v_number,
                              'cancelTransactions', '[]'::jsonb);
  end if;

  -- ── The checkout's first payment.
  v_reason := case
    when v_account.state = 'closed' then 'account_closed'
    when v_checkout.created_at + make_interval(mins => v_settings.checkout_ttl_minutes) < now() then 'checkout_expired'
    when p_amount_kobo < v_checkout.total_kobo then 'underpaid'
    when v_checkout.kind = 'subscribe' and coalesce(v_sub.status, 'ended') <> 'ended' then 'already_subscribed'
    when v_checkout.kind = 'upgrade'
         and (v_sub.id is null or v_sub.status <> 'active' or v_sub.plan_code is distinct from v_checkout.from_plan_code
              or v_sub.current_period_end is distinct from v_checkout.credit_until) then 'subscription_changed'
    when v_checkout.kind = 'pay_due' and coalesce(v_sub.status, 'ended') <> 'past_due' then 'subscription_changed'
    else null end;
  if v_reason is not null then
    perform mail.billing_unapplied(p_test_mode, v_account.id, v_checkout.id, v_sub.id, 'first',
                                   v_checkout.plan_code, p_transaction_id, p_tx_ref, p_amount_kobo, p_method,
                                   p_raw, v_reason);
    update mail.checkouts
       set status = 'unapplied', paid_at = now(), paid_transaction_id = p_transaction_id
     where id = v_checkout.id;
    -- This charge started a Flutterwave subscription of its own: stop it.
    return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', v_reason,
                              'cancelTransactions', jsonb_build_array(p_transaction_id));
  end if;

  -- A past-due plan paid again (review 23): the new month starts where the
  -- old one ended, so the days past due are not given free.
  if v_checkout.kind = 'pay_due' then
    v_start := coalesce(v_sub.current_period_end, now());
  end if;
  v_end := mail.billing_period_end(v_start);
  -- An upgrade replaces the Flutterwave subscription that was charging.
  if v_sub.id is not null and v_sub.first_transaction_id is not null and v_sub.provider_canceled_at is null then
    v_cancel := array[v_sub.first_transaction_id];
  end if;
  if v_sub.id is null then
    insert into mail.subscriptions (account_id, plan_code, status, test_mode, price_kobo, vat_bps, amount_kobo,
                                    current_period_start, current_period_end, checkout_id,
                                    first_transaction_id, flutterwave_plan_id, card_last4, card_brand)
    values (v_account.id, v_checkout.plan_code, 'active', p_test_mode, v_checkout.price_kobo, v_checkout.vat_bps,
            v_checkout.recurring_kobo, v_start, v_end, v_checkout.id, p_transaction_id,
            v_checkout.flutterwave_plan_id, v_last4, v_brand)
    returning * into v_sub;
  else
    update mail.subscriptions
       set plan_code = v_checkout.plan_code, status = 'active', test_mode = p_test_mode,
           price_kobo = v_checkout.price_kobo, vat_bps = v_checkout.vat_bps, amount_kobo = v_checkout.recurring_kobo,
           current_period_start = v_start, current_period_end = v_end,
           scheduled_plan_code = null, scheduled_at = null,
           past_due_reason = null, past_due_since = null, past_due_until = null,
           ended_at = null, ended_reason = null,
           checkout_id = v_checkout.id, first_transaction_id = p_transaction_id,
           flutterwave_plan_id = v_checkout.flutterwave_plan_id, provider_canceled_at = null,
           card_last4 = v_last4, card_brand = v_brand, updated_at = now()
     where id = v_sub.id
    returning * into v_sub;
  end if;
  update mail.accounts set plan_code = v_checkout.plan_code, updated_at = now() where id = v_account.id;

  insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                             provider_reference, tx_ref, amount_kobo, currency, method, test_mode,
                             period_start, period_end, raw)
  values (v_account.id, v_sub.id, v_checkout.id, 'first', true, v_checkout.plan_code, p_transaction_id, p_tx_ref,
          p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, v_start, v_end,
          coalesce(p_raw, '{}'))
  returning id into v_payment;
  select * into v_plan from mail.plans where code = v_checkout.plan_code;
  v_lines := jsonb_build_array(jsonb_build_object('description', v_plan.name || ' plan, one month',
                                                  'amountKobo', v_checkout.price_kobo));
  if v_checkout.credit_kobo > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description', 'Credit for the unused part of the '
                     || (select p.name from mail.plans p where p.code = v_checkout.from_plan_code) || ' plan''s month',
      'amountKobo', -v_checkout.credit_kobo));
  end if;
  v_number := mail.billing_issue_invoice(v_payment, v_lines, v_checkout.subtotal_kobo, v_checkout.vat_bps);
  update mail.checkouts
     set status = 'paid', paid_at = now(), paid_transaction_id = p_transaction_id
   where id = v_checkout.id;
  v_action := case v_checkout.kind when 'upgrade' then 'billing.upgraded' when 'pay_due' then 'billing.paid'
                                   else 'billing.subscribed' end;
  perform mail.billing_note(v_account.id, 'system', v_action,
                            jsonb_build_object('plan', v_checkout.plan_code, 'invoice', v_number));
  return jsonb_build_object('ok', true, 'outcome', 'paid', 'kind', v_checkout.kind, 'invoiceNumber', v_number,
                            'cancelTransactions', to_jsonb(v_cancel));
end;
$$;

-- Review 21: whether the payment redirect may ask Flutterwave about this
-- checkout now. Each return re-reads a charge with the key the shop and Paidly
-- share, and anyone with a checkout could replay any transaction id; so, as
-- the shop's checkout_return does, at most return_checks_per_checkout for the
-- checkout and return_checks_per_account for its account in each
-- return_check_window_minutes (public.rate_limit_hit's fixed windows). False
-- also for a checkout that is not that account's. The app answers "pending"
-- when this is false: the webhook still settles the charge.
create function mail.billing_return_allowed(p_checkout_id uuid, p_account_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_window   integer;
begin
  if p_checkout_id is null or p_account_id is null
     or not exists (select 1 from mail.checkouts c where c.id = p_checkout_id and c.account_id = p_account_id) then
    return false;
  end if;
  select * into v_settings from mail.billing_settings where id;
  if v_settings.id is null then
    raise exception 'mail.billing_settings is missing' using errcode = '55000';
  end if;
  v_window := v_settings.return_check_window_minutes * 60;
  if not public.rate_limit_hit('mail_checkout_return:' || p_checkout_id, v_settings.return_checks_per_checkout,
                               v_window) then
    return false;
  end if;
  return public.rate_limit_hit('mail_checkout_return_account:' || p_account_id,
                               v_settings.return_checks_per_account, v_window);
end;
$$;

-- ── 12. Alerts: billing incidents and the webhook backlog (§8, §11, MB6) ────
-- As migration 51, plus two conditions:
--   mail_billing_incident:<id> — an open billing incident on the live side
--     (money a person must refund, cancel or record; critical for those,
--     a warning for the rest). Worked under Accounts → Billing incidents in
--     Mail's admin. Before, mail.billing_incidents was written and read by no one.
--   mail_webhook_backlog — customer webhook deliveries to enabled endpoints
--     due for over settings.webhook_backlog_minutes and not tried, or claimed
--     that long ago and never answered: the worker's webhook loop is behind or
--     stopped. e2e accounts' deliveries are left out (only their tests claim them).
-- The shop's current_alert_conditions (live side) reads this, unchanged.

create or replace function mail.alert_conditions()
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  -- SES paused an account's tenant (§4.2): nothing it queues is sent (MR5).
  select 'mail_tenant_paused:' || a.id, 'critical', 'mail_tenant_paused',
         format('Mail: SES paused the tenant of account %s. Nothing it queues is sent; read the finding in Mail''s admin before anyone resumes it (MR5).',
                a.ses_tenant)
    from mail.accounts a
   where a.ses_status = 'disabled' and a.state <> 'closed' and not a.is_e2e
     and not mail.asked_ses_to_pause(a.id)

  union all
  -- Our own threshold paused an account (§7.4).
  select 'mail_threshold_pause:' || a.id, 'critical', 'mail_threshold_pause',
         format('Mail: account %s paused by our threshold: bounces %s, complaints %s over %s days (%s sent). Only the owner can resume it (MR5).',
                a.ses_tenant, mail.ppm_text((f.detail ->> 'bouncePpm')::integer),
                mail.ppm_text((f.detail ->> 'complaintPpm')::integer),
                coalesce(f.detail ->> 'windowDays', '7'), coalesce(f.detail ->> 'sent', '?'))
    from mail.accounts a
    join lateral (select x.detail from mail.safety_findings x
                   where x.account_id = a.id and x.source = 'threshold' and x.severity = 'pause'
                     and x.resolved_at is null
                   order by x.opened_at desc limit 1) f on true
   where a.state = 'paused' and not a.is_e2e

  union all
  -- An account over our warning level (§7.4).
  select 'mail_threshold_warning:' || a.id, 'warning', 'mail_threshold_warning',
         format('Mail: account %s is over our warning level: bounces %s, complaints %s over %s days (%s sent).',
                a.ses_tenant, mail.ppm_text((f.detail ->> 'bouncePpm')::integer),
                mail.ppm_text((f.detail ->> 'complaintPpm')::integer),
                coalesce(f.detail ->> 'windowDays', '7'), coalesce(f.detail ->> 'sent', '?'))
    from mail.accounts a
    join lateral (select x.detail from mail.safety_findings x
                   where x.account_id = a.id and x.source = 'threshold' and x.severity = 'warning'
                     and x.resolved_at is null
                   order by x.opened_at desc limit 1) f on true
   where a.state in ('sandbox', 'active') and not a.is_e2e

  union all
  -- The whole SES account's reputation (§7.8), before AWS's own review levels.
  select 'mail_reputation:bounce',
         case when r.bounce_ppm >= s.bounce_pause_ppm then 'critical' else 'warning' end,
         'mail_reputation',
         format('The SES account''s bounce rate is %s (CloudWatch, the shop''s email included). AWS reviews accounts at 5%%.',
                mail.ppm_text(r.bounce_ppm))
    from mail.settings s
    cross join lateral (select x.bounce_ppm from mail.reputation_readings x
                         where x.outcome = 'ok' and x.bounce_ppm is not null
                           and x.read_at > now() - interval '2 hours'
                         order by x.read_at desc limit 1) r
   where s.id and r.bounce_ppm >= s.bounce_warn_ppm

  union all
  select 'mail_reputation:complaint',
         case when r.complaint_ppm >= s.complaint_pause_ppm then 'critical' else 'warning' end,
         'mail_reputation',
         format('The SES account''s complaint rate is %s (CloudWatch, the shop''s email included). AWS reviews accounts at 0.1%%.',
                mail.ppm_text(r.complaint_ppm))
    from mail.settings s
    cross join lateral (select x.complaint_ppm from mail.reputation_readings x
                         where x.outcome = 'ok' and x.complaint_ppm is not null
                           and x.read_at > now() - interval '2 hours'
                         order by x.read_at desc limit 1) r
   where s.id and r.complaint_ppm >= s.complaint_warn_ppm

  union all
  -- The SES account's 24-hour quota (§4.4), as the worker last read it.
  select 'mail_quota:24h',
         case when q.share >= 0.95 then 'critical' else 'warning' end,
         'mail_quota',
         format('The SES account has used %s%% of its 24-hour quota; free and sandbox Mail accounts wait for paid ones.',
                floor(q.share * 100)::integer)
    from mail.settings s
    cross join lateral (select case when jsonb_typeof(h.detail -> 'share') = 'number'
                                    then (h.detail ->> 'share')::numeric end as share
                          from public.service_heartbeats h
                         where h.name = 'mail-worker:quota' and h.beat_at > now() - interval '30 minutes') q
   where s.id and q.share is not null and q.share * 100 >= s.quota_alert_pct

  union all
  -- A worker loop that stopped reporting (§11: send, webhooks, quota, domains, safety).
  select 'mail_silent:' || h.name, 'critical', 'mail_silent',
         format('Mail: %s has not reported for %s minutes.', h.name,
                floor(extract(epoch from now() - h.beat_at) / 60)::integer)
    from public.service_heartbeats h
   where h.name like 'mail-worker:%'
     and h.beat_at < now() - make_interval(mins => 15 + case when h.detail ->> 'everyMinutes' ~ '^\d{1,4}$'
                                                            then (h.detail ->> 'everyMinutes')::integer else 0 end)

  union all
  -- The event endpoint (§4.2, §11): every email sent 15–60 minutes ago is
  -- still without a single SES event, though SES publishes one on sending.
  select 'mail_events_silent', 'critical', 'mail_events_silent',
         format('Mail: none of the %s emails sent 15 to 60 minutes ago has an SES event yet — /api/ses/events or its SNS subscription may be down.',
                x.sent)
    from (select count(*) as sent,
                 count(*) filter (where not exists (select 1 from mail.email_events v where v.email_id = e.id)) as silent
            from mail.emails e join mail.accounts a on a.id = e.account_id
           where e.sent_at between now() - interval '60 minutes' and now() - interval '15 minutes'
             and e.ses_message_id is not null and not a.is_e2e) x
   where x.sent > 0 and x.silent = x.sent

  union all
  -- A pause or resume SES has not taken (§7.4): our own gate holds meanwhile.
  select 'mail_tenant_action:' || t.id, 'critical', 'mail_tenant_action',
         format('Mail: SES has not %s the tenant of account %s yet (asked %s minutes ago, %s tries%s). Our own gate %s meanwhile.',
                case t.sending_status when 'DISABLED' then 'paused' else 'resumed' end, a.ses_tenant,
                floor(extract(epoch from now() - t.requested_at) / 60)::integer, t.attempts,
                coalesce('; last: ' || t.last_error, ''),
                case t.sending_status when 'DISABLED' then 'refuses its email' else 'lets it send' end)
    from mail.tenant_actions t join mail.accounts a on a.id = t.account_id
   where t.state in ('pending', 'claimed') and t.requested_at < now() - interval '15 minutes'

  union all
  -- A billing incident (§8): money a person must look at. Live side only.
  select 'mail_billing_incident:' || i.id,
         case when i.kind in ('unrecorded_payment', 'unapplied_charge', 'subscription_not_canceled')
              then 'critical' else 'warning' end,
         'mail_billing_incident',
         format('Mail billing: incident %s (%s)%s needs a person. Read it under Accounts, Billing incidents, in Mail''s admin.',
                i.id, replace(i.kind, '_', ' '), coalesce(' on account ' || a.ses_tenant, ''))
    from mail.billing_incidents i
    left join mail.accounts a on a.id = i.account_id
   where i.resolved_at is null and not i.test_mode and not coalesce(a.is_e2e, false)

  union all
  -- Customer webhooks due and untried for too long (§11: "a webhook backlog over an hour").
  select 'mail_webhook_backlog', 'critical', 'mail_webhook_backlog',
         format('Mail: %s webhook deliveries have waited over %s minutes without being tried (the oldest %s minutes); the worker''s webhook loop is behind or stopped.',
                x.n, s.webhook_backlog_minutes, x.oldest)
    from mail.settings s
    cross join lateral (
      select count(*) as n,
             floor(extract(epoch from now() - min(case when d.status = 'delivering' then d.claimed_at
                                                       else d.next_attempt_at end)) / 60)::integer as oldest
        from mail.webhook_deliveries d
        join mail.webhooks w on w.id = d.webhook_id
        join mail.accounts a on a.id = d.account_id
       where w.status = 'enabled' and not a.is_e2e
         and ((d.status = 'pending' and d.next_attempt_at < now() - make_interval(mins => s.webhook_backlog_minutes))
              or (d.status = 'delivering' and d.claimed_at < now() - make_interval(mins => s.webhook_backlog_minutes)))) x
   where s.id and x.n > 0
$$;

-- Mail's billing incidents for the admin (§10), read-only: newest first, the
-- open ones by default (p_open false: resolved ones; null: all), with the
-- account's tenant and name. A test admin reads test-mode incidents of e2e
-- accounts (or of no account) only. Details are statuses, amounts and reasons,
-- as record_billing_incident keeps them — never a card or a customer.
create function public.admin_mail_billing_incidents(p_open boolean default true, p_offset integer default 0,
                                                    p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_total integer;
  v_open  integer;
  v_rows  jsonb;
begin
  if coalesce(p_offset, -1) < 0 or coalesce(p_limit, 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'admin:bad_filter';
  end if;
  select count(*) filter (where p_open is null or (i.resolved_at is null) = p_open),
         count(*) filter (where i.resolved_at is null)
    into v_total, v_open
    from mail.billing_incidents i
   where not v_admin.test_only
      or (i.test_mode and (i.account_id is null or mail.is_e2e_account(i.account_id)));
  select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id desc), '[]'::jsonb) into v_rows
    from (
      select i.id, i.created_at,
             jsonb_build_object(
               'id', i.id, 'createdAt', i.created_at, 'testMode', i.test_mode, 'kind', i.kind,
               'accountId', i.account_id, 'tenant', a.ses_tenant, 'accountName', a.name,
               'providerReference', i.provider_reference, 'detail', i.detail,
               'resolvedAt', i.resolved_at, 'resolvedBy', i.resolved_by) as row
        from mail.billing_incidents i
        left join mail.accounts a on a.id = i.account_id
       where (p_open is null or (i.resolved_at is null) = p_open)
         and (not v_admin.test_only
              or (i.test_mode and (i.account_id is null or mail.is_e2e_account(i.account_id))))
       order by i.created_at desc, i.id desc
      offset p_offset limit p_limit) r;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'open', v_open);
end;
$$;

-- ── 13. Row-level security and grants ───────────────────────────────────────
alter table mail.domain_claim_failures enable row level security;   -- no policies: functions only
revoke all on mail.domain_claim_failures from public, anon, authenticated, service_role;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.is_webhook_url(text) from public, anon, authenticated, service_role;
revoke all on function mail.webhook_for_caller(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.update_webhook(uuid, uuid, text, text[], text)
  from public, anon, authenticated, service_role;
revoke all on function mail.set_webhook_enabled(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function mail.rotate_webhook_secret(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.delete_webhook(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.resend_webhook_delivery(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function mail.create_api_key(uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function mail.api_create_key(uuid, uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function mail.note_claim_failure() from public, anon, authenticated, service_role;
revoke all on function mail.claim_domain_name(uuid, text, text, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_failed(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.record_domain_check(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.reserve_send(uuid, uuid, text, text[], timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function mail.enqueue_email(uuid, uuid, jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.reschedule_email(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.record_tenant_event(text, text, text, text, text, timestamptz, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.billing_return_allowed(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.alert_conditions() from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_billing_incidents(boolean, integer, integer)
  from public, anon, authenticated, service_role;

-- The dashboard (the person's session; SQL checks the role and the account).
grant execute on function mail.update_webhook(uuid, uuid, text, text[], text) to authenticated;
grant execute on function mail.set_webhook_enabled(uuid, uuid, boolean) to authenticated;
grant execute on function mail.rotate_webhook_secret(uuid, uuid, text, text) to authenticated;
grant execute on function mail.delete_webhook(uuid, uuid) to authenticated;
grant execute on function mail.resend_webhook_delivery(uuid, bigint) to authenticated;
grant execute on function mail.create_api_key(uuid, text, text, text, text, uuid) to authenticated;
-- The admin area (the admin's session; admin_session decides).
grant execute on function public.admin_mail_billing_incidents(boolean, integer, integer) to authenticated;
-- The API, the SES job route, the SNS endpoint and billing (apps/mail, secret key).
grant execute on function mail.api_create_key(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function mail.record_domain_failed(uuid, text, text, text) to service_role;
grant execute on function mail.record_domain_check(uuid, text, jsonb) to service_role;
grant execute on function mail.enqueue_email(uuid, uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function mail.reschedule_email(uuid, uuid, timestamptz) to service_role;
grant execute on function mail.record_tenant_event(text, text, text, text, text, timestamptz, text, text, text, text, text)
  to service_role;
grant execute on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  to service_role;
grant execute on function mail.billing_return_allowed(uuid, uuid) to service_role;
-- Helpers (is_webhook_url, webhook_for_caller, note_claim_failure,
-- claim_domain_name, reserve_send, alert_conditions) stay granted to no API
-- role: security-definer callers and triggers use them.

notify pgrst, 'reload schema';
