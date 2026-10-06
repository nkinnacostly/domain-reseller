-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 49: MyDomainsHub Mail — SES events in, suppressions, findings and
-- outbound webhooks (docs/MAIL-SPEC.md §4.2, §6, §7.5, MR4, MR5, MR6, §9).
--
--   SNS     → record_send_event (replaced): as migration 44, and now queues
--             the customer's webhooks for the event (email.sent, .delivered,
--             .delivery_delayed, .bounced, .complained) and keeps the casing
--             SES holds a suppressed address in (its suppression API matches
--             case exactly).
--   SNS     → record_tenant_event: EventBridge's tenant status (Sending Status
--             Enabled / Disabled) sets the account's ses_status — never
--             backwards in time — and opens or closes a `sending_paused`
--             finding; Advisor Recommendation Status Open / Resolved opens or
--             closes a reputation finding. MB6 builds alerts, the admin and the
--             owner's email on these rows; nothing here unpauses (MR5).
--   triggers → an email that becomes `failed` (by SES's reject, or by the
--             worker) queues email.failed; a domain that becomes verified or
--             failed queues domain.verified / domain.failed.
--   dashboard → webhooks: create (the signing secret is sealed by the app
--             with AES-GCM — the database never sees it), edit, enable or
--             disable, rotate, delete; resend a delivery; remove a suppression
--             (after the app has removed it from the SES tenant's list).
--   worker  → claim_webhook_deliveries (FOR UPDATE SKIP LOCKED; never a test
--             account's unless asked for it) → a signed POST (Standard
--             Webhooks, MR6) → record_webhook_attempt: retries with backoff
--             for 24 hours; an endpoint failing for 3 days is disabled and
--             flagged for its owner's email.
--   daily   → purge_webhook_deliveries: a delivery is kept as long as the
--             plan keeps its log (§8), then deleted — it carries addresses.
--
-- Every function is revoked from public, anon, authenticated and
-- service_role, then granted to exactly one role, or none;
-- supabase/tests/mail_events.sql checks it all, and mail_sending.sql's
-- check 16 names every function in the schema.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings for webhooks (tuned without a deploy) ───────────────────────
alter table mail.settings
  -- An account's endpoints: enough for staging, production and a spare few.
  add column webhook_endpoints_max integer not null default 10
    check (webhook_endpoints_max between 1 and 100),
  -- §6: a delivery is retried with backoff for this long.
  add column webhook_retry_hours integer not null default 24
    check (webhook_retry_hours between 1 and 72),
  -- §6: an endpoint that has not answered 2xx for this long is disabled.
  add column webhook_disable_after_days integer not null default 3
    check (webhook_disable_after_days between 1 and 30);

-- ── 2. What SES last said about the tenant, and when ────────────────────────
-- EventBridge delivers on a best-effort basis and out of order: a status is
-- applied only when it is newer than the one we hold.
alter table mail.accounts add column ses_status_at timestamptz;

-- SES keeps a suppressed address in the case it was sent to, and its
-- DeleteSuppressedDestination matches case exactly. `address` stays the
-- lower-case form every comparison uses; this is the form to hand back to SES
-- when it differs.
alter table mail.suppressions
  add column ses_address text check (ses_address is null
                                     or (char_length(ses_address) <= 320 and lower(ses_address) = address));

-- ── 3. Findings (§9): SES's reputation findings and its pauses, per account ─
-- MB6 adds our own threshold findings (source `threshold`) and the alerts and
-- emails that follow a finding; this migration records SES's.
create table mail.findings (
  id             bigint generated always as identity primary key,
  account_id     uuid not null references mail.accounts (id) on delete cascade,
  source         text not null check (source in ('ses', 'threshold')),
  -- `sending_paused`, SES's finding type (`bounce`, `complaint`…), or for a
  -- recommendation with no type, `advisor_` and a hash of its words.
  kind           text not null check (kind ~ '^[a-z0-9_]{1,60}$'),
  impact         text check (impact in ('high', 'low')),
  -- AWS's own words ("The bounce rate exceeded 15.0%…"), addresses struck out.
  summary        text check (summary is null or char_length(summary) <= 500),
  resource_arn   text check (resource_arn is null or char_length(resource_arn) <= 300),
  opened_at      timestamptz not null,
  resolved_at    timestamptz,
  -- EventBridge's event ids: the same event delivered twice is kept once.
  open_event     text check (open_event is null or char_length(open_event) <= 200),
  resolve_event  text check (resolve_event is null or char_length(resolve_event) <= 200),
  -- The newest report applied to an open finding (SES repeats an open
  -- recommendation as it changes): an older or repeated one changes nothing.
  last_event     text check (last_event is null or char_length(last_event) <= 200),
  last_seen_at   timestamptz,
  detail         jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint findings_resolved_after_opened check (resolved_at is null or resolved_at >= opened_at)
);
create unique index findings_one_open on mail.findings (account_id, source, kind, coalesce(resource_arn, ''))
  where resolved_at is null;
create unique index findings_open_event on mail.findings (open_event) where open_event is not null;
create unique index findings_resolve_event on mail.findings (resolve_event) where resolve_event is not null;
create index findings_account on mail.findings (account_id, opened_at desc);

-- ── 4. Webhooks (§6, MR6) ───────────────────────────────────────────────────
create table mail.webhooks (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references mail.accounts (id) on delete cascade,
  -- https only; the app refuses private and reserved addresses, SQL refuses
  -- their literals (is_webhook_url) and the worker checks the address it
  -- actually connects to.
  url               text not null check (char_length(url) between 12 and 500),
  description       text check (description is null or char_length(description) <= 100),
  events            text[] not null check (
                      cardinality(events) between 1 and 8
                      and events <@ array['email.sent', 'email.delivered', 'email.delivery_delayed',
                                          'email.bounced', 'email.complained', 'email.failed',
                                          'domain.verified', 'domain.failed']::text[]),
  -- The signing secret, sealed by the app (AES-256-GCM, a key the database
  -- never holds; `v1.<iv>.<ciphertext>`, base64url). Never granted to an API
  -- role: only the worker's claim hands it out, still sealed.
  secret_sealed     text not null check (char_length(secret_sealed) <= 320
                                       and secret_sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$'),
  -- `whsec_` and the secret's first four characters, to tell secrets apart.
  secret_hint       text not null check (secret_hint ~ '^whsec_[A-Za-z0-9+/]{4}$'),
  status            text not null default 'enabled' check (status in ('enabled', 'disabled')),
  disabled_reason   text check (disabled_reason in ('customer', 'failing')),
  disabled_at       timestamptz,
  -- The first failure since the last 2xx; cleared by a success.
  failing_since     timestamptz,
  last_success_at   timestamptz,
  -- Disabled for failing: its owner is to be emailed (MB6's notices read and
  -- clear this). Not readable by API roles.
  owner_notice_due  boolean not null default false,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint webhooks_disabled_has_reason check ((status = 'disabled') = (disabled_reason is not null))
);
create index webhooks_account on mail.webhooks (account_id);

-- One row per message per endpoint, and each attempt's answer (`history`, the
-- last twenty; the newest also in the last_* columns). A resend is a new row
-- with the same message id (`resend_of`): Standard Webhooks' receivers
-- deduplicate on it.
create table mail.webhook_deliveries (
  id                bigint generated always as identity primary key,
  webhook_id        uuid not null references mail.webhooks (id) on delete cascade,
  account_id        uuid not null references mail.accounts (id) on delete cascade,
  message_id        text not null check (message_id ~ '^msg_[0-9a-f]{32}$'),
  event_type        text not null check (event_type in ('email.sent', 'email.delivered', 'email.delivery_delayed',
                                                        'email.bounced', 'email.complained', 'email.failed',
                                                        'domain.verified', 'domain.failed')),
  -- { type, created_at, data } — never a body (MR3).
  payload           jsonb not null check (jsonb_typeof(payload) = 'object'),
  email_id          bigint references mail.emails (id) on delete set null,
  status            text not null default 'pending'
                    check (status in ('pending', 'delivering', 'delivered', 'failed')),
  status_reason     text check (status_reason is null or status_reason ~ '^[a-z_]{1,60}$'),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  give_up_at        timestamptz not null,
  claimed_by        text,
  claimed_at        timestamptz,
  last_attempt_at   timestamptz,
  last_status_code  integer check (last_status_code is null or last_status_code between 100 and 599),
  last_error        text check (last_error is null or last_error ~ '^[a-z_]{1,60}$'),
  -- The start of the endpoint's answer, printable, as it came.
  last_response     text check (last_response is null or char_length(last_response) <= 500),
  last_duration_ms  integer check (last_duration_ms is null or last_duration_ms >= 0),
  history           jsonb not null default '[]' check (jsonb_typeof(history) = 'array'),
  delivered_at      timestamptz,
  resend_of         bigint references mail.webhook_deliveries (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index webhook_deliveries_queue on mail.webhook_deliveries (next_attempt_at, id) where status = 'pending';
create index webhook_deliveries_claimed on mail.webhook_deliveries (claimed_at) where status = 'delivering';
create index webhook_deliveries_webhook on mail.webhook_deliveries (webhook_id, created_at desc);
create index webhook_deliveries_account on mail.webhook_deliveries (account_id, created_at desc);
create index webhook_deliveries_resend on mail.webhook_deliveries (resend_of) where resend_of is not null;

-- ── 5. Helpers (no API role may call them) ──────────────────────────────────

-- ISO 8601 in UTC, as the webhook payload carries times.
create function mail.iso_time(p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- An endpoint we will call: https, a lower-case host name with a dot (or a
-- public IPv4 literal), any port, no credentials, no fragment. Names that
-- only resolve inside a network are refused here; the worker refuses any
-- private address it would actually connect to.
create function mail.is_webhook_url(p_url text)
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
  if v_port is not null and v_port not between 1 and 65535 then
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

-- The events an endpoint wants: known ones, each once, in order; null when
-- the list is empty or names one we do not send.
create function mail.webhook_event_list(p_events text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
           when p_events is null or cardinality(p_events) = 0 or cardinality(p_events) > 16
                or exists (select 1 from unnest(p_events) e
                            where e is null or e not in ('email.sent', 'email.delivered', 'email.delivery_delayed',
                                                         'email.bounced', 'email.complained', 'email.failed',
                                                         'domain.verified', 'domain.failed'))
             then null
           else array(select distinct e from unnest(p_events) e order by e)
         end
$$;

-- The sealed secret and its hint, as the app makes them.
create function mail.is_sealed_secret(p_sealed text, p_hint text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_sealed) <= 320
                  and p_sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$'
                  and p_hint ~ '^whsec_[A-Za-z0-9+/]{4}$', false)
$$;

-- What a webhook says about an email: its id, sender, recipients, subject,
-- tags and when it was accepted — never its body (MR3). The customer's own
-- data, to the customer's own endpoint (MR4).
create function mail.email_webhook_data(p_email mail.emails, p_extra jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'email_id', p_email.public_id,
           'from', p_email.from_address,
           'to', to_jsonb(p_email.to_addresses),
           'subject', p_email.subject,
           'tags', p_email.tags,
           'created_at', mail.iso_time(p_email.created_at))
         || coalesce(p_extra, '{}'::jsonb)
$$;

-- Queues one event for every enabled endpoint of the account that wants it.
-- One message id per event, shared by its endpoints. Answers how many.
create function mail.queue_webhook_event(p_account_id uuid, p_type text, p_data jsonb,
                                         p_occurred_at timestamptz default null, p_email_id bigint default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_hours integer;
  v_msg   text := 'msg_' || replace(gen_random_uuid()::text, '-', '');
  v_n     integer;
begin
  select s.webhook_retry_hours into v_hours from mail.settings s where s.id;
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, email_id, give_up_at)
  select w.id, w.account_id, v_msg, p_type,
         jsonb_build_object('type', p_type, 'created_at', mail.iso_time(coalesce(p_occurred_at, now())),
                            'data', coalesce(p_data, '{}'::jsonb)),
         p_email_id, now() + make_interval(hours => coalesce(v_hours, 24))
    from mail.webhooks w
   where w.account_id = p_account_id and w.status = 'enabled' and p_type = any (w.events);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ── 6. Events from SES (§4.2), now with webhooks ────────────────────────────
-- As migration 44: one SES event for one email, found by SES's message id —
-- or, when the event beats record_send_result, by the email id our tags
-- carry. False when the email is not ours. Status precedence is the shop's
-- rule; a repeated event (same p_event_key) changes nothing and queues
-- nothing. A permanent bounce or a complaint puts the recipients SES names
-- on the account's list (only addresses the email was sent to; the casing
-- SES holds kept beside the lower-case form). New here: each new event
-- queues the customer's webhooks; email.failed comes from the trigger below,
-- whatever made the email fail.
create or replace function mail.record_send_event(p_event text, p_message_id text default null,
                                                  p_email_public_id uuid default null, p_event_key text default null,
                                                  p_occurred_at timestamptz default null, p_detail jsonb default '{}',
                                                  p_recipients integer default 1, p_suppress text[] default '{}')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  mail.emails;
  v_seen   text;
  v_rank   integer;
  v_at     timestamptz := least(coalesce(p_occurred_at, now()), now() + interval '5 minutes');
  v_n      integer := least(greatest(coalesce(p_recipients, 1), 1), 50);
  v_new    bigint;
  v_reason text;
  v_detail jsonb := mail.sanitise_detail(p_detail);
  v_hook   text;
  v_extra  jsonb := '{}';
begin
  if p_event is null or p_event not in ('send', 'delivery', 'bounce', 'complaint', 'reject',
                                        'delivery_delay', 'rendering_failure') then
    raise exception 'not a send event: %', p_event using errcode = '22023';
  end if;

  if coalesce(btrim(p_message_id), '') <> '' then
    select * into v_email from mail.emails where ses_message_id = p_message_id for update;
  end if;
  if v_email.id is null and p_email_public_id is not null then
    select * into v_email from mail.emails
     where public_id = p_email_public_id
       and (ses_message_id is null or ses_message_id = p_message_id)
       and status not in ('queued', 'suppressed', 'canceled')
     for update;
    if v_email.id is not null and v_email.ses_message_id is null and coalesce(btrim(p_message_id), '') <> '' then
      update mail.emails set ses_message_id = p_message_id where id = v_email.id;
    end if;
  end if;
  if v_email.id is null then
    return false;
  end if;

  insert into mail.email_events (email_id, account_id, type, event_key, occurred_at, detail)
  values (v_email.id, v_email.account_id, p_event, nullif(left(p_event_key, 200), ''), v_at, v_detail)
  on conflict (email_id, event_key) where event_key is not null do nothing
  returning id into v_new;
  if v_new is null then
    return true;   -- seen before
  end if;

  v_seen := case p_event
              when 'send' then 'sent'
              when 'delivery' then 'delivered'
              when 'complaint' then 'complained'
              when 'bounce' then 'bounced'
              when 'reject' then 'failed'
              when 'rendering_failure' then 'failed'
              else null
            end;
  v_rank := case v_seen when 'sent' then 1 when 'delivered' then 2 when 'complained' then 3
                        when 'bounced' then 4 when 'failed' then 4 else 0 end;

  update mail.emails e
     set status = case
                    when v_seen is not null
                         and v_rank > case e.status when 'sent' then 1 when 'delivered' then 2 when 'complained' then 3
                                                    when 'bounced' then 4 when 'failed' then 4 else 0 end
                    then v_seen else e.status end,
         status_reason = case when v_seen = 'failed' and e.status not in ('bounced', 'failed') then p_event
                              else e.status_reason end,
         delivered_at = case when p_event = 'delivery' then coalesce(e.delivered_at, v_at) else e.delivered_at end,
         bounced_at = case when p_event = 'bounce' then coalesce(e.bounced_at, v_at) else e.bounced_at end,
         complained_at = case when p_event = 'complaint' then coalesce(e.complained_at, v_at) else e.complained_at end,
         failed_at = case when v_seen = 'failed' then coalesce(e.failed_at, v_at) else e.failed_at end,
         last_event = case when e.last_event_at is null or v_at >= e.last_event_at then p_event else e.last_event end,
         last_event_at = greatest(coalesce(e.last_event_at, v_at), v_at),
         updated_at = now()
   where e.id = v_email.id;

  case p_event
    when 'delivery' then perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'delivered', v_n);
    when 'bounce' then perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'bounced', v_n);
    when 'complaint' then perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'complained', v_n);
    else null;
  end case;

  -- §7.5: the account's list mirrors its tenant's (bounces and complaints).
  v_reason := case
                when p_event = 'complaint' then 'complaint'
                when p_event = 'bounce' and coalesce(p_detail ->> 'bounceType', '') = 'Permanent' then 'bounce'
              end;
  if v_reason is not null then
    insert into mail.suppressions as s (account_id, address, reason, source, ses_address)
    select v_email.account_id, lower(a.addr), v_reason, 'ses', case when a.addr <> lower(a.addr) then a.addr end
      from (select distinct on (lower(btrim(x))) btrim(x) as addr
              from unnest(coalesce(p_suppress, '{}')) x
             where x is not null) a
     where char_length(a.addr) <= 320 and lower(a.addr) ~ '^[^@\s<>]+@[^@\s<>]+$'
       and lower(a.addr) in (select mail.address_of(m)
                               from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m)
    on conflict (account_id, address) do update set ses_address = coalesce(s.ses_address, excluded.ses_address);
  end if;

  -- §6: the customer's webhooks.
  v_hook := case p_event
              when 'send' then 'email.sent'
              when 'delivery' then 'email.delivered'
              when 'delivery_delay' then 'email.delivery_delayed'
              when 'bounce' then 'email.bounced'
              when 'complaint' then 'email.complained'
            end;
  if v_hook is not null then
    v_extra := case p_event
                 when 'bounce' then jsonb_build_object('bounce', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'bounceType', 'sub_type', v_detail ->> 'bounceSubType',
                   'diagnostic', v_detail ->> 'diagnosticCode')))
                 when 'complaint' then jsonb_build_object('complaint', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'complaintFeedbackType', 'sub_type', v_detail ->> 'complaintSubType')))
                 when 'delivery_delay' then jsonb_build_object('delay', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'delayType')))
                 else '{}'::jsonb
               end;
    perform mail.queue_webhook_event(v_email.account_id, v_hook, mail.email_webhook_data(v_email, v_extra),
                                     v_at, v_email.id);
  end if;
  return true;
end;
$$;

-- An email that becomes `failed` — refused or unrenderable at SES, or given
-- up by the worker, or stopped by the gate at send time — tells the customer.
create function mail.webhook_on_email_failed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform mail.queue_webhook_event(new.account_id, 'email.failed',
                                   mail.email_webhook_data(new, jsonb_strip_nulls(
                                     jsonb_build_object('reason', new.status_reason))),
                                   coalesce(new.failed_at, now()), new.id);
  return null;
end;
$$;
create trigger emails_failed_webhook after update of status on mail.emails
  for each row when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function mail.webhook_on_email_failed();

-- A domain that becomes verified or failed (§5) tells the customer.
create function mail.webhook_on_domain_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform mail.queue_webhook_event(new.account_id, 'domain.' || new.status,
                                   jsonb_strip_nulls(jsonb_build_object(
                                     'domain_id', new.id, 'name', new.name, 'status', new.status,
                                     'reason', case when new.status = 'failed' then new.failed_reason end)),
                                   now(), null);
  return null;
end;
$$;
create trigger domains_status_webhook after update of status on mail.domains
  for each row when (new.status in ('verified', 'failed') and old.status is distinct from new.status)
  execute function mail.webhook_on_domain_status();

-- ── 7. The tenant's status and SES's findings (§4.2, via EventBridge) ───────
-- p_type: sending_status (with p_status ENABLED | DISABLED | REINSTATED and
-- p_origin CUSTOMER_MANAGED | AWS_MANAGED), advisor_open or advisor_resolved
-- (with p_finding — SES's type — p_impact and p_summary). The account is
-- found by its tenant (`mdm-…` from the tenant's ARN) or, for a
-- recommendation about an identity, by the domain's live claim. Answers
-- {ok, known, applied}: an event for no account of ours is known = false.
create function mail.record_tenant_event(p_event_id text, p_type text, p_tenant text default null,
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

-- ── 8. Endpoints, from the dashboard (owner, admin, developer) ──────────────
-- Answers {ok: true, …} or {ok: false, code}: unauthorized, not_found,
-- forbidden, account_closed, validation (with field), webhook_limit (with max).

create function mail.create_webhook(p_account_id uuid, p_url text, p_events text[], p_secret_sealed text,
                                    p_secret_hint text, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_role   text;
  v_state  text;
  v_events text[] := mail.webhook_event_list(p_events);
  v_desc   text := nullif(btrim(p_description), '');
  v_max    integer;
  v_id     uuid;
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
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state = 'closed' then
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
  if not mail.is_sealed_secret(p_secret_sealed, p_secret_hint) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'secret');
  end if;
  select s.webhook_endpoints_max into v_max from mail.settings s where s.id;
  if (select count(*) from mail.webhooks w where w.account_id = p_account_id) >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'webhook_limit', 'max', coalesce(v_max, 0));
  end if;

  insert into mail.webhooks (account_id, url, description, events, secret_sealed, secret_hint, created_by)
  values (p_account_id, p_url, v_desc, v_events, p_secret_sealed, p_secret_hint, v_user)
  returning id into v_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'webhook.created', v_id::text, jsonb_build_object('events', to_jsonb(v_events)));
  return jsonb_build_object('ok', true, 'webhookId', v_id);
end;
$$;

-- The endpoint's row, locked, and the caller's role in its account.
create function mail.webhook_for_caller(p_webhook_id uuid)
returns table (webhook mail.webhooks, role text, account_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hook mail.webhooks;
begin
  select * into v_hook from mail.webhooks w where w.id = p_webhook_id for update;
  if v_hook.id is null then
    return;
  end if;
  return query
    select v_hook, mail.caller_role(v_hook.account_id), (select a.state from mail.accounts a where a.id = v_hook.account_id);
end;
$$;

create function mail.update_webhook(p_webhook_id uuid, p_url text, p_events text[], p_description text default null)
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
  select * into v_found from mail.webhook_for_caller(p_webhook_id);
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

-- Turning an endpoint off fails what was waiting for it; turning it back on
-- forgets its failures (and any notice still due).
create function mail.set_webhook_enabled(p_webhook_id uuid, p_enabled boolean)
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
  select * into v_found from mail.webhook_for_caller(p_webhook_id);
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

-- A new signing secret, sealed by the app and shown once; the old one stops
-- signing at once.
create function mail.rotate_webhook_secret(p_webhook_id uuid, p_secret_sealed text, p_secret_hint text)
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
  select * into v_found from mail.webhook_for_caller(p_webhook_id);
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

create function mail.delete_webhook(p_webhook_id uuid)
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
  select * into v_found from mail.webhook_for_caller(p_webhook_id);
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

-- "Resend" (§10): the same message again, to the same endpoint, as a new
-- delivery with its own retries. Not while it is still being tried, nor to an
-- endpoint that is off.
create function mail.resend_webhook_delivery(p_delivery_id bigint)
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
  select * into v_delivery from mail.webhook_deliveries d where d.id = p_delivery_id;
  if v_delivery.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_found from mail.webhook_for_caller(v_delivery.webhook_id);
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

-- ── 9. Suppressions (§7.5): removing one, after SES has ─────────────────────
-- The app removes the address from the SES tenant's list first (manager key),
-- then here. Owners and admins only: sending to an address that bounced or
-- complained risks the account's reputation. The log keeps the reason, never
-- the address (§9).
create function mail.remove_suppression(p_suppression_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row  mail.suppressions;
  v_role text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_row from mail.suppressions s where s.id = p_suppression_id for update;
  if v_row.id is not null then
    v_role := mail.caller_role(v_row.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  delete from mail.suppressions where id = v_row.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_row.account_id, 'user', v_user, 'suppression.removed', v_row.id::text,
          jsonb_build_object('reason', v_row.reason, 'source', v_row.source));
  return jsonb_build_object('ok', true);
end;
$$;

-- ── 10. The worker's side ───────────────────────────────────────────────────

-- Claims up to p_limit due deliveries (FOR UPDATE SKIP LOCKED) to enabled
-- endpoints, with what the worker needs to sign and send them: the URL, the
-- sealed secret, the message id and the payload. A claim older than five
-- minutes belongs to a worker that stopped and is tried again. The worker's
-- claim (no account) never takes a test account's delivery; a test passes its
-- own account and takes only that account's.
create function mail.claim_webhook_deliveries(p_worker text, p_limit integer, p_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_out jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 100 then
    raise exception 'claim_webhook_deliveries: a worker name and a limit of 1 to 100' using errcode = '22023';
  end if;

  update mail.webhook_deliveries
     set status = 'pending', claimed_by = null, claimed_at = null, next_attempt_at = now(), updated_at = now()
   where status = 'delivering' and claimed_at < now() - interval '5 minutes';

  for v_row in
    select d.id, d.webhook_id, d.account_id, d.message_id, d.event_type, d.payload, d.attempts,
           w.url, w.secret_sealed
      from mail.webhook_deliveries d
      join mail.webhooks w on w.id = d.webhook_id
      join mail.accounts a on a.id = d.account_id
     where d.status = 'pending' and d.next_attempt_at <= now() and w.status = 'enabled'
       and case when p_account_id is null then not a.is_e2e else d.account_id = p_account_id end
     order by d.next_attempt_at, d.id
     limit p_limit
     for update of d skip locked
  loop
    update mail.webhook_deliveries
       set status = 'delivering', claimed_by = p_worker, claimed_at = now(), attempts = attempts + 1,
           last_attempt_at = now(), updated_at = now()
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'webhookId', v_row.webhook_id, 'accountId', v_row.account_id, 'url', v_row.url,
      'secretSealed', v_row.secret_sealed, 'messageId', v_row.message_id, 'eventType', v_row.event_type,
      'payload', v_row.payload, 'attempt', v_row.attempts + 1));
  end loop;
  return v_out;
end;
$$;

-- What the endpoint answered to one claimed delivery. Only the worker holding
-- the claim may record it.
--   2xx            — delivered; the endpoint is healthy again.
--   anything else  — tried again after 30 s, 2, 8, 32 minutes… (at most six
--                    hours apart) until the delivery's 24 hours are up, then
--                    failed. An endpoint with no 2xx for 3 days is disabled,
--                    what waited for it fails, and its owner's notice is due.
--   secret_unreadable — ours, not the endpoint's: the delivery fails and the
--                    endpoint's health is untouched.
-- p_error is a code (timeout, connection_failed, private_address…), never
-- text from the endpoint; p_response is the start of its answer.
create function mail.record_webhook_attempt(p_delivery_id bigint, p_worker text, p_status_code integer default null,
                                            p_error text default null, p_response text default null,
                                            p_duration_ms integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery mail.webhook_deliveries;
  v_hook     mail.webhooks;
  v_settings mail.settings;
  v_ok       boolean := coalesce(p_status_code between 200 and 299, false);
  v_code     text := nullif(left(btrim(regexp_replace(lower(coalesce(p_error, '')), '[^a-z_]+', '_', 'g'), '_'), 60), '');
  v_answer   text := nullif(left(btrim(regexp_replace(coalesce(p_response, ''), '[[:cntrl:]]+', ' ', 'g')), 500), '');
  v_ms       integer := case when p_duration_ms is null then null else greatest(p_duration_ms, 0) end;
  v_entry    jsonb;
  v_next     timestamptz;
begin
  if p_status_code is not null and p_status_code not between 100 and 599 then
    raise exception 'record_webhook_attempt: % is not an HTTP status', p_status_code using errcode = '22023';
  end if;
  select * into v_delivery from mail.webhook_deliveries where id = p_delivery_id for update;
  if v_delivery.id is null or v_delivery.status <> 'delivering' or v_delivery.claimed_by is distinct from p_worker then
    return jsonb_build_object('ok', false, 'code', 'not_claimed');
  end if;
  if not v_ok and v_code is null then
    v_code := case when p_status_code is null then 'no_answer' else 'http_status' end;
  end if;
  select * into v_hook from mail.webhooks where id = v_delivery.webhook_id for update;
  select * into v_settings from mail.settings where id;

  v_entry := jsonb_strip_nulls(jsonb_build_object(
    'at', mail.iso_time(now()), 'attempt', v_delivery.attempts, 'status', p_status_code,
    'error', case when v_ok then null else v_code end, 'ms', v_ms));
  update mail.webhook_deliveries
     set last_status_code = p_status_code, last_error = case when v_ok then null else v_code end,
         last_response = v_answer, last_duration_ms = v_ms,
         history = case when jsonb_array_length(history) >= 20 then history - 0 else history end || v_entry,
         claimed_by = null, claimed_at = null, updated_at = now()
   where id = v_delivery.id;

  if v_ok then
    update mail.webhook_deliveries set status = 'delivered', status_reason = null, delivered_at = now()
     where id = v_delivery.id;
    update mail.webhooks set failing_since = null, last_success_at = now(), updated_at = now() where id = v_hook.id;
    return jsonb_build_object('ok', true, 'status', 'delivered');
  end if;

  if v_code = 'secret_unreadable' then
    update mail.webhook_deliveries set status = 'failed', status_reason = 'secret_unreadable' where id = v_delivery.id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  if v_hook.status <> 'enabled' then
    update mail.webhook_deliveries set status = 'failed', status_reason = 'endpoint_disabled' where id = v_delivery.id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  update mail.webhooks set failing_since = coalesce(failing_since, now()), updated_at = now()
   where id = v_hook.id
   returning * into v_hook;
  if v_hook.failing_since <= now() - make_interval(days => coalesce(v_settings.webhook_disable_after_days, 3)) then
    update mail.webhooks
       set status = 'disabled', disabled_reason = 'failing', disabled_at = now(), owner_notice_due = true,
           updated_at = now()
     where id = v_hook.id;
    update mail.webhook_deliveries
       set status = 'failed', status_reason = 'endpoint_disabled', updated_at = now()
     where webhook_id = v_hook.id and (id = v_delivery.id or status = 'pending');
    insert into mail.account_audit_log (account_id, actor, action, target, detail)
    values (v_hook.account_id, 'system', 'webhook.disabled', v_hook.id::text,
            jsonb_build_object('reason', 'failing', 'failingSince', mail.iso_time(v_hook.failing_since)));
    return jsonb_build_object('ok', true, 'status', 'failed', 'disabled', true);
  end if;

  if now() >= v_delivery.give_up_at then
    update mail.webhook_deliveries set status = 'failed', status_reason = 'gave_up' where id = v_delivery.id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  v_next := least(now() + make_interval(secs => least(30 * power(4, greatest(v_delivery.attempts - 1, 0)), 21600)),
                  v_delivery.give_up_at);
  update mail.webhook_deliveries set status = 'pending', next_attempt_at = v_next where id = v_delivery.id;
  return jsonb_build_object('ok', true, 'status', 'pending', 'nextAttemptAt', v_next);
end;
$$;

-- ── 11. Housekeeping ────────────────────────────────────────────────────────
-- A finished delivery carries addresses (MR4): kept as long as the plan keeps
-- its log (§8), then deleted.
create function mail.purge_webhook_deliveries()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from mail.webhook_deliveries d
     using mail.accounts a, mail.plans p
     where a.id = d.account_id and p.code = a.plan_code
       and d.status in ('delivered', 'failed')
       and d.created_at < now() - make_interval(days => p.log_retention_days)
    returning 1)
  select count(*)::integer from gone
$$;

select cron.schedule('mail-purge-webhook-deliveries', '23 3 * * *', 'select mail.purge_webhook_deliveries()');

-- ── 12. Row-level security ──────────────────────────────────────────────────
alter table mail.findings           enable row level security;
alter table mail.webhooks           enable row level security;
alter table mail.webhook_deliveries enable row level security;

create policy findings_member_read on mail.findings for select to authenticated
  using (mail.has_role(account_id));
create policy webhooks_member_read on mail.webhooks for select to authenticated
  using (mail.has_role(account_id));
create policy webhook_deliveries_member_read on mail.webhook_deliveries for select to authenticated
  using (mail.has_role(account_id));

-- ── 13. Grants ──────────────────────────────────────────────────────────────
-- Reads only, and never the sealed secret, the notice flag or the claim.
revoke all on mail.findings, mail.webhooks, mail.webhook_deliveries from public, anon, authenticated, service_role;
grant select on mail.findings to authenticated;
grant select (id, account_id, url, description, events, secret_hint, status, disabled_reason, disabled_at,
              failing_since, last_success_at, created_by, created_at, updated_at)
  on mail.webhooks to authenticated;
grant select (id, webhook_id, account_id, message_id, event_type, payload, email_id, status, status_reason, attempts,
              next_attempt_at, give_up_at, last_attempt_at, last_status_code, last_error, last_response,
              last_duration_ms, history, delivered_at, resend_of, created_at, updated_at)
  on mail.webhook_deliveries to authenticated;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.iso_time(timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.is_webhook_url(text) from public, anon, authenticated, service_role;
revoke all on function mail.webhook_event_list(text[]) from public, anon, authenticated, service_role;
revoke all on function mail.is_sealed_secret(text, text) from public, anon, authenticated, service_role;
revoke all on function mail.email_webhook_data(mail.emails, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.queue_webhook_event(uuid, text, jsonb, timestamptz, bigint)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_send_event(text, text, uuid, text, timestamptz, jsonb, integer, text[])
  from public, anon, authenticated, service_role;
revoke all on function mail.webhook_on_email_failed() from public, anon, authenticated, service_role;
revoke all on function mail.webhook_on_domain_status() from public, anon, authenticated, service_role;
revoke all on function mail.record_tenant_event(text, text, text, text, text, timestamptz, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.create_webhook(uuid, text, text[], text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.webhook_for_caller(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.update_webhook(uuid, text, text[], text) from public, anon, authenticated, service_role;
revoke all on function mail.set_webhook_enabled(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function mail.rotate_webhook_secret(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.delete_webhook(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.resend_webhook_delivery(bigint) from public, anon, authenticated, service_role;
revoke all on function mail.remove_suppression(bigint) from public, anon, authenticated, service_role;
revoke all on function mail.claim_webhook_deliveries(text, integer, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.record_webhook_attempt(bigint, text, integer, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.purge_webhook_deliveries() from public, anon, authenticated, service_role;

-- The SNS endpoint (apps/mail, secret key).
grant execute on function mail.record_send_event(text, text, uuid, text, timestamptz, jsonb, integer, text[])
  to service_role;
grant execute on function mail.record_tenant_event(text, text, text, text, text, timestamptz, text, text, text, text, text)
  to service_role;
-- The dashboard (the person's session; SQL checks the role).
grant execute on function mail.create_webhook(uuid, text, text[], text, text, text) to authenticated;
grant execute on function mail.update_webhook(uuid, text, text[], text) to authenticated;
grant execute on function mail.set_webhook_enabled(uuid, boolean) to authenticated;
grant execute on function mail.rotate_webhook_secret(uuid, text, text) to authenticated;
grant execute on function mail.delete_webhook(uuid) to authenticated;
grant execute on function mail.resend_webhook_delivery(bigint) to authenticated;
grant execute on function mail.remove_suppression(bigint) to authenticated;
-- The worker (secret key).
grant execute on function mail.claim_webhook_deliveries(text, integer, uuid) to service_role;
grant execute on function mail.record_webhook_attempt(bigint, text, integer, text, text, integer) to service_role;
