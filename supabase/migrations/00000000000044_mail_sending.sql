-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 44: MyDomainsHub Mail — sending (docs/MAIL-SPEC.md §3, §6, §9).
--
-- The send path, end to end, in SQL:
--
--   API key → authenticate_key (hash lookup, revoked refused, per-key token
--             bucket, last_used_at)
--   POST    → enqueue_email: idempotency per account for 24 h, then
--             reserve_send — the gate of MR2 (account sending, domain verified
--             and its own, sandbox rules, recipients not suppressed) and the
--             caps (plan, day, month, warm-up, and the SES account's shared
--             24-hour budget) reserved atomically — then the row and its body.
--   worker  → claim_sends (FOR UPDATE SKIP LOCKED; the gate asked again at
--             send time) → SES SendEmail → record_send_result.
--   SNS     → record_send_event: bounced beats complained beats delivered
--             beats sent; a late bounce wins; a complaint is recorded, and is
--             not a bounce; a repeated event changes nothing.
--   hourly  → purge_payloads: a body is kept 72 hours after sending (MR3).
--
-- Caps and budgets count recipients, as SES does. Every function is revoked
-- from public, anon, authenticated and service_role and granted to at most
-- one role; supabase/tests/mail_sending.sql checks it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────────────────

create table mail.emails (
  id               bigint generated always as identity primary key,
  -- The id the API answers with; the bigint never leaves the database.
  public_id        uuid not null unique default gen_random_uuid(),
  account_id       uuid not null references mail.accounts (id) on delete cascade,
  api_key_id       uuid references mail.api_keys (id) on delete set null,
  domain_id        uuid not null references mail.domains (id) on delete restrict,
  -- Mailboxes as sent: `Name <address>` or a bare address (MR4: personal data,
  -- kept for the plan's retention, shown only to the account's members).
  from_address     text not null check (char_length(from_address) <= 400 and from_address !~ '[\r\n]'),
  to_addresses     text[] not null,
  cc_addresses     text[] not null default '{}',
  bcc_addresses    text[] not null default '{}',
  reply_to         text[] not null default '{}',
  recipient_count  integer generated always as
                   (cardinality(to_addresses) + cardinality(cc_addresses) + cardinality(bcc_addresses)) stored,
  subject          text not null check (char_length(subject) between 1 and 998 and subject !~ '[\r\n]'),
  tags             jsonb not null default '[]' check (jsonb_typeof(tags) = 'array'),
  status           text not null default 'queued'
                   check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained',
                                     'failed', 'suppressed', 'canceled')),
  status_reason    text check (status_reason is null or status_reason ~ '^[a-z_]{1,60}$'),
  -- Printable ASCII, at most 256 (PostgreSQL's regex repeats stop at 255).
  idempotency_key  text check (idempotency_key is null
                               or (char_length(idempotency_key) <= 256 and idempotency_key ~ '^[\x21-\x7e]+$')),
  request_hash     text check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  ses_message_id   text,
  scheduled_at     timestamptz not null default now(),
  -- The reservation (reserve_send): the Lagos day of the plan's count and the
  -- hour of the account-wide budget's. Cleared when it is given back.
  reserved_on      date,
  reserved_hour    timestamptz,
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null default now(),
  claimed_by       text,
  claimed_at       timestamptz,
  sent_at          timestamptz,
  delivered_at     timestamptz,
  bounced_at       timestamptz,
  complained_at    timestamptz,
  failed_at        timestamptz,
  canceled_at      timestamptz,
  last_event       text,
  last_event_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint emails_recipients check (
    cardinality(to_addresses) >= 1
    and cardinality(to_addresses) + cardinality(cc_addresses) + cardinality(bcc_addresses) <= 50
    and cardinality(reply_to) <= 50),
  constraint emails_key_needs_hash check ((idempotency_key is null) = (request_hash is null))
);
-- Idempotency-Key, per account (§6). A key older than 24 hours is released by
-- enqueue_email before it is used again.
create unique index emails_idempotency on mail.emails (account_id, idempotency_key)
  where idempotency_key is not null;
create index emails_queue on mail.emails (next_attempt_at, id) where status = 'queued';
create index emails_claimed on mail.emails (claimed_at) where status = 'sending';
create unique index emails_ses_message on mail.emails (ses_message_id) where ses_message_id is not null;
create index emails_account_created on mail.emails (account_id, created_at desc);

-- The body (MR3): kept 72 hours after sending, then deleted by purge_payloads.
-- Nothing else ever copies it.
create table mail.email_payloads (
  email_id     bigint primary key references mail.emails (id) on delete cascade,
  html         text,
  text         text,
  headers      jsonb not null default '{}' check (jsonb_typeof(headers) = 'object'),
  attachments  jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'),
  size_bytes   integer not null check (size_bytes >= 0),
  created_at   timestamptz not null default now(),
  constraint email_payloads_has_body check (coalesce(html, '') <> '' or coalesce(text, '') <> '')
);

-- One row per SES event (§4.2), detail sanitised: type codes and diagnostic
-- text with every address struck out (MR4).
create table mail.email_events (
  id           bigint generated always as identity primary key,
  email_id     bigint not null references mail.emails (id) on delete cascade,
  account_id   uuid not null references mail.accounts (id) on delete cascade,
  type         text not null check (type in ('send', 'delivery', 'bounce', 'complaint', 'reject',
                                             'delivery_delay', 'rendering_failure')),
  -- SNS's message id: the same event delivered twice is kept once.
  event_key    text check (event_key is null or char_length(event_key) <= 200),
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  detail       jsonb not null default '{}' check (jsonb_typeof(detail) = 'object')
);
create unique index email_events_once on mail.email_events (email_id, event_key) where event_key is not null;
create index email_events_email on mail.email_events (email_id, occurred_at);
create index email_events_account on mail.email_events (account_id, occurred_at desc);

-- The account's suppression list, a mirror of its SES tenant's (§7.5).
create table mail.suppressions (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  address     text not null check (address = lower(address) and address ~ '^[^@\s<>]+@[^@\s<>]+$'),
  reason      text not null check (reason in ('bounce', 'complaint', 'manual')),
  source      text not null check (source in ('ses', 'customer', 'admin')),
  created_at  timestamptz not null default now(),
  unique (account_id, address)
);

-- Per account per Lagos day, in recipients. `queued` is what counts against
-- the caps: an email that never left (failed before sending) is given back.
create table mail.usage_daily (
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  day         date not null,
  queued      integer not null default 0 check (queued >= 0),
  sent        integer not null default 0 check (sent >= 0),
  delivered   integer not null default 0 check (delivered >= 0),
  bounced     integer not null default 0 check (bounced >= 0),
  complained  integer not null default 0 check (complained >= 0),
  failed      integer not null default 0 check (failed >= 0),
  primary key (account_id, day)
);

-- The SES account's 24-hour quota is a rolling window shared with the shop
-- (§4.4): recipients reserved per hour, per account. Kept two days.
create table mail.send_budget_hourly (
  hour        timestamptz not null check (hour = date_trunc('hour', hour)),
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  recipients  integer not null default 0 check (recipients >= 0),
  primary key (hour, account_id)
);
create index send_budget_hourly_account on mail.send_budget_hourly (account_id, hour);

-- ── 2. Small helpers ────────────────────────────────────────────────────────

-- The address in a mailbox (`Name <a@b>` or `a@b`), lower-cased.
create function mail.address_of(p_mailbox text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(substring(p_mailbox from '<([^<>]+)>\s*$'), p_mailbox)))
$$;

-- A JSON array of strings as text[]; '{}' for null; null for anything else.
create function mail.text_array(p_value jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
           when p_value is null or jsonb_typeof(p_value) = 'null' then '{}'::text[]
           when jsonb_typeof(p_value) <> 'array' then null
           when exists (select 1 from jsonb_array_elements(p_value) e where jsonb_typeof(e) <> 'string') then null
           else array(select jsonb_array_elements_text(p_value))
         end
$$;

-- A mailbox we accept: one line, an address with a domain, nothing odd.
create function mail.is_mailbox(p_mailbox text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    char_length(p_mailbox) <= 400
    and p_mailbox !~ '[\r\n]'
    and mail.address_of(p_mailbox) ~ '^[^@\s<>",;]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
    false)
$$;

-- The customer-facing day: Nigeria's (§8 "a day").
create function mail.lagos_day(p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_at at time zone 'Africa/Lagos')::date
$$;

-- Adds to one usage counter.
create function mail.bump_usage(p_account_id uuid, p_day date, p_column text, p_n integer)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_column not in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed') then
    raise exception 'bump_usage: % is not a counter', p_column using errcode = '22023';
  end if;
  if coalesce(p_n, 0) = 0 then
    return;
  end if;
  execute format(
    'insert into mail.usage_daily as u (account_id, day, %1$I) values ($1, $2, greatest($3, 0))
     on conflict (account_id, day) do update set %1$I = greatest(u.%1$I + $3, 0)', p_column)
  using p_account_id, p_day, p_n;
end;
$$;

-- An event's detail, kept to type codes and words, every address struck out
-- (MR4): what SES sends can quote the recipient.
create function mail.sanitise_detail(p_detail jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, left(regexp_replace(v, '[^\s<>()"'',;:@]+@[^\s<>()"'',;:@]+', '[address]', 'g'), 500)),
                  '{}'::jsonb)
    from jsonb_each_text(case when jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end) as e(k, v)
   where k in ('bounceType', 'bounceSubType', 'diagnosticCode', 'complaintFeedbackType', 'complaintSubType',
               'delayType', 'rejectReason', 'errorMessage', 'smtpResponse', 'status', 'action')
     and v is not null
$$;

-- The caps that apply to this account today (§7.2, §7.3, §8), in recipients.
create function mail.effective_caps(p_account mail.accounts)
returns table (daily integer, monthly integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_plan     mail.plans;
  v_settings mail.settings;
  v_daily    bigint;
begin
  select * into v_plan from mail.plans where code = p_account.plan_code;
  select * into v_settings from mail.settings where id;
  if v_plan.code is null or v_settings.id is null then
    -- Fail closed: no plan or no settings means no sending.
    return query select 0, 0;
    return;
  end if;
  v_daily := coalesce(p_account.daily_cap_override, v_plan.daily_cap);
  monthly := coalesce(p_account.monthly_cap_override, v_plan.monthly_cap);
  if p_account.state = 'sandbox' then
    v_daily := least(v_daily, v_settings.sandbox_daily_cap);
  elsif p_account.warmup_day is not null and p_account.daily_cap_override is null then
    -- Starts at warmup_start_cap and doubles each warm-up day, up to the plan.
    v_daily := least(v_daily, v_settings.warmup_start_cap::bigint * (2::bigint ^ least(p_account.warmup_day, 30)));
  end if;
  daily := least(v_daily, monthly)::integer;
  return next;
end;
$$;

-- Gives back an email's reservation: the plan's count and the account budget.
create function mail.release_reservation(p_email_id bigint)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_email mail.emails;
begin
  select * into v_email from mail.emails where id = p_email_id;
  if v_email.reserved_on is null then
    return;
  end if;
  perform mail.bump_usage(v_email.account_id, v_email.reserved_on, 'queued', -v_email.recipient_count);
  update mail.send_budget_hourly
     set recipients = greatest(recipients - v_email.recipient_count, 0)
   where hour = v_email.reserved_hour and account_id = v_email.account_id;
  update mail.emails set reserved_on = null, reserved_hour = null, updated_at = now() where id = p_email_id;
end;
$$;

-- ── 3. The gate and the reservation (MR2) ───────────────────────────────────
-- Answers {ok: true, domainId, recipients} having reserved them, or
-- {ok: false, code, …}. Codes: unauthorized, account_paused, account_not_ready,
-- forbidden, domain_not_verified, sandbox_recipient, validation, suppressed,
-- quota_exceeded (scope day or month: the plan's), budget_exceeded (ours —
-- the SES account's shared quota, §4.4). Called inside enqueue_email; no API
-- role may reserve without queueing.
create function mail.reserve_send(p_account_id uuid, p_api_key_id uuid, p_from_address text,
                                  p_recipients text[])
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
  v_today    date := mail.lagos_day(now());
  v_month    date := date_trunc('month', mail.lagos_day(now())::timestamp)::date;
  v_hour     timestamptz := date_trunc('hour', now());
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
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'day', 'cap', v_caps.daily,
                              'retryAfter', ceil(extract(epoch from
                                ((v_today + 1)::timestamp at time zone 'Africa/Lagos') - now()))::integer);
  end if;
  if v_mon_used + v_n > v_caps.monthly then
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'month', 'cap', v_caps.monthly,
                              'retryAfter', ceil(extract(epoch from
                                ((v_month + interval '1 month') at time zone 'Africa/Lagos') - now()))::integer);
  end if;

  -- The SES account's shared 24-hour budget (§4.4, owner 6 Oct 2026). One
  -- lock for every account, so concurrent reservations cannot overshoot it;
  -- no account may hold more than half of what the others leave.
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mail.send_budget', 0));
  select coalesce(sum(b.recipients), 0),
         coalesce(sum(b.recipients) filter (where b.account_id = p_account_id), 0)
    into v_total, v_mine
    from mail.send_budget_hourly b
   where b.hour > v_hour - interval '24 hours';
  v_allowed := floor((v_settings.account_daily_budget - (v_total - v_mine)) / 2.0);
  if v_total + v_n > v_settings.account_daily_budget or v_mine + v_n > v_allowed then
    return jsonb_build_object('ok', false, 'code', 'budget_exceeded',
                              'retryAfter', ceil(extract(epoch from (v_hour + interval '1 hour') - now()))::integer);
  end if;

  perform mail.bump_usage(p_account_id, v_today, 'queued', v_n);
  insert into mail.send_budget_hourly as b (hour, account_id, recipients) values (v_hour, p_account_id, v_n)
  on conflict (hour, account_id) do update set recipients = b.recipients + v_n;
  return jsonb_build_object('ok', true, 'domainId', v_domain.id, 'recipients', v_n,
                            'reservedOn', v_today, 'reservedHour', v_hour);
end;
$$;

-- ── 4. Queueing an email ────────────────────────────────────────────────────
-- p_email: { from, to[], cc[], bcc[], reply_to[], subject, tags[] }
-- p_payload: { html, text, headers{}, attachments[] }
-- Answers {ok: true, id, status, replayed} or reserve_send's refusals, plus
-- `idempotency_conflict` (the key was used for a different request in the
-- last 24 hours). A request whose recipient is suppressed is kept as a
-- `suppressed` email that reserves nothing and is never sent (§7.5).
create function mail.enqueue_email(p_account_id uuid, p_api_key_id uuid, p_idempotency_key text,
                                   p_request_hash text, p_email jsonb, p_payload jsonb)
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

  v_gate := mail.reserve_send(p_account_id, p_api_key_id, v_from, v_all);
  if not coalesce((v_gate ->> 'ok')::boolean, false) and v_gate ->> 'code' is distinct from 'suppressed' then
    return v_gate;
  end if;
  v_status := case when (v_gate ->> 'ok')::boolean then 'queued' else 'suppressed' end;

  insert into mail.emails (account_id, api_key_id, domain_id, from_address, to_addresses, cc_addresses,
                           bcc_addresses, reply_to, subject, tags, status, status_reason, idempotency_key,
                           request_hash, reserved_on, reserved_hour)
  values (p_account_id, p_api_key_id, (v_gate ->> 'domainId')::uuid, v_from, v_to, v_cc, v_bcc, v_reply,
          v_subject, v_tags, v_status, case when v_status = 'suppressed' then 'suppressed' end,
          p_idempotency_key, p_request_hash,
          (v_gate ->> 'reservedOn')::date, (v_gate ->> 'reservedHour')::timestamptz)
  returning id, public_id into v_id, v_public;
  if v_status = 'queued' then
    insert into mail.email_payloads (email_id, html, text, headers, attachments, size_bytes)
    values (v_id, nullif(p_payload ->> 'html', ''), nullif(p_payload ->> 'text', ''), v_headers, v_attach, v_size);
  end if;
  return jsonb_build_object('ok', true, 'id', v_public, 'status', v_status, 'replayed', false);
end;
$$;

-- ── 5. API keys at the door ─────────────────────────────────────────────────
-- By hash (MR7). A revoked key, a closed account or an unknown hash is
-- `unauthorized`. Each call takes a token from the key's bucket (§6: 10 a
-- second, bursts of 20); an empty bucket is `rate_limited` with the wait in
-- milliseconds. last_used_at moves at most once a minute.
create function mail.authenticate_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      mail.api_keys;
  v_state    text;
  v_settings mail.settings;
  v_tokens   double precision;
begin
  if coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_key from mail.api_keys where key_hash = p_key_hash for update;
  if v_key.id is null or v_key.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select a.state into v_state from mail.accounts a where a.id = v_key.account_id;
  if v_state is null or v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;

  v_tokens := least(v_settings.key_burst::double precision,
                    v_key.rl_tokens + greatest(extract(epoch from now() - v_key.rl_updated_at), 0)
                                      * v_settings.key_rate_per_second);
  if v_tokens < 1 then
    update mail.api_keys set rl_tokens = v_tokens, rl_updated_at = now() where id = v_key.id;
    return jsonb_build_object('ok', false, 'code', 'rate_limited',
                              'retryAfterMs', ceil((1 - v_tokens) / v_settings.key_rate_per_second * 1000)::integer);
  end if;
  update mail.api_keys
     set rl_tokens = v_tokens - 1,
         rl_updated_at = now(),
         last_used_at = case when last_used_at is null or last_used_at < now() - interval '1 minute'
                             then now() else last_used_at end
   where id = v_key.id;
  return jsonb_build_object('ok', true, 'keyId', v_key.id, 'accountId', v_key.account_id,
                            'permission', v_key.permission, 'domainId', v_key.domain_id);
end;
$$;

-- ── 6. Reading one email back (GET /emails/{id}) ────────────────────────────
-- Status, timestamps and the last event — never the body (MR3). Null when the
-- id is not this account's.
create function mail.get_email(p_account_id uuid, p_public_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', e.public_id, 'from', e.from_address, 'to', to_jsonb(e.to_addresses),
           'cc', to_jsonb(e.cc_addresses), 'bcc', to_jsonb(e.bcc_addresses), 'reply_to', to_jsonb(e.reply_to),
           'subject', e.subject, 'tags', e.tags, 'status', e.status, 'status_reason', e.status_reason,
           'created_at', e.created_at, 'scheduled_at', e.scheduled_at, 'sent_at', e.sent_at,
           'delivered_at', e.delivered_at, 'bounced_at', e.bounced_at, 'complained_at', e.complained_at,
           'failed_at', e.failed_at, 'last_event', e.last_event, 'last_event_at', e.last_event_at)
    from mail.emails e
   where e.account_id = p_account_id and e.public_id = p_public_id
$$;

-- ── 7. The worker's side ────────────────────────────────────────────────────

-- Settles an email that will not be sent: failed or suppressed, its
-- reservation given back.
create function mail.settle_unsent(p_email_id bigint, p_status text, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_email mail.emails;
begin
  select * into v_email from mail.emails where id = p_email_id;
  perform mail.release_reservation(p_email_id);
  if p_status = 'failed' then
    perform mail.bump_usage(v_email.account_id, mail.lagos_day(now()), 'failed', v_email.recipient_count);
  end if;
  update mail.emails
     set status = p_status, status_reason = p_reason, claimed_by = null, claimed_at = null,
         failed_at = case when p_status = 'failed' then now() else failed_at end, updated_at = now()
   where id = p_email_id;
end;
$$;

-- MR2 at send time: what may have changed since the email was queued. Null
-- when it may go; otherwise the status and reason to settle it with.
create function mail.send_gate(p_email_id bigint)
returns table (status text, reason text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_email   mail.emails;
  v_account mail.accounts;
begin
  select * into v_email from mail.emails where id = p_email_id;
  select * into v_account from mail.accounts where id = v_email.account_id;
  if v_account.id is null or v_account.state not in ('sandbox', 'active') or v_account.ses_status = 'disabled'
     or v_account.tenant_ready_at is null then
    return query select 'failed'::text, 'account_paused'::text;
    return;
  end if;
  if not exists (select 1 from mail.domains d
                  where d.id = v_email.domain_id and d.account_id = v_email.account_id and d.status = 'verified') then
    return query select 'failed'::text, 'domain_not_verified'::text;
    return;
  end if;
  if v_email.api_key_id is not null and exists (select 1 from mail.api_keys k
                                                 where k.id = v_email.api_key_id and k.revoked_at is not null) then
    return query select 'failed'::text, 'key_revoked'::text;
    return;
  end if;
  if exists (select 1 from mail.suppressions s
              where s.account_id = v_email.account_id
                and s.address in (select mail.address_of(m)
                                    from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m)) then
    return query select 'suppressed'::text, 'suppressed'::text;
    return;
  end if;
  return;
end;
$$;

-- Claims up to p_limit queued emails that are due (FOR UPDATE SKIP LOCKED),
-- asks the gate again for each (MR2), and answers what the worker needs to
-- send them — tenant and configuration set included (MR1). A claim older than
-- ten minutes belongs to a worker that stopped and is queued again: a send is
-- at-least-once, as the shop's outbox is. `p_paid_only` keeps free and
-- sandbox accounts waiting when the SES account's day is nearly spent (§4.4).
create function mail.claim_sends(p_worker text, p_limit integer, p_paid_only boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.settings;
  v_row      record;
  v_gate     record;
  v_payload  mail.email_payloads;
  v_out      jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 100 then
    raise exception 'claim_sends: a worker name and a limit of 1 to 100' using errcode = '22023';
  end if;
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;

  -- Lost claims. After the last attempt the outcome stays unknown, so the
  -- reservation is kept: it may have gone out.
  update mail.emails
     set status = case when attempts >= v_settings.max_send_attempts then 'failed' else 'queued' end,
         status_reason = case when attempts >= v_settings.max_send_attempts then 'worker_lost' else status_reason end,
         failed_at = case when attempts >= v_settings.max_send_attempts then now() else failed_at end,
         claimed_by = null, claimed_at = null, next_attempt_at = now(), updated_at = now()
   where status = 'sending' and claimed_at < now() - interval '10 minutes';

  for v_row in
    select e.id, e.public_id, e.from_address, e.to_addresses, e.cc_addresses, e.bcc_addresses, e.reply_to,
           e.subject, e.tags, e.recipient_count, e.attempts, a.short_id, a.ses_tenant, a.config_set
      from mail.emails e
      join mail.accounts a on a.id = e.account_id
      join mail.plans p on p.code = a.plan_code
     where e.status = 'queued' and e.next_attempt_at <= now() and e.scheduled_at <= now()
       and (not coalesce(p_paid_only, false) or (p.price_kobo > 0 and a.state = 'active'))
     order by e.next_attempt_at, e.id
     limit p_limit
     for update of e skip locked
  loop
    select * into v_gate from mail.send_gate(v_row.id);
    if v_gate.status is not null then
      perform mail.settle_unsent(v_row.id, v_gate.status, v_gate.reason);
      continue;
    end if;
    select * into v_payload from mail.email_payloads where email_id = v_row.id;
    if v_payload.email_id is null then
      perform mail.settle_unsent(v_row.id, 'failed', 'payload_missing');
      continue;
    end if;
    update mail.emails
       set status = 'sending', claimed_by = p_worker, claimed_at = now(), attempts = attempts + 1,
           updated_at = now()
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'publicId', v_row.public_id, 'accountShortId', v_row.short_id,
      'tenant', v_row.ses_tenant, 'configurationSet', v_row.config_set,
      'from', v_row.from_address, 'to', to_jsonb(v_row.to_addresses), 'cc', to_jsonb(v_row.cc_addresses),
      'bcc', to_jsonb(v_row.bcc_addresses), 'replyTo', to_jsonb(v_row.reply_to),
      'subject', v_row.subject, 'tags', v_row.tags, 'recipientCount', v_row.recipient_count,
      'attempt', v_row.attempts + 1, 'html', v_payload.html, 'text', v_payload.text,
      'headers', v_payload.headers, 'attachments', v_payload.attachments));
  end loop;
  return v_out;
end;
$$;

-- What SES said to one claimed send. Only the worker holding the claim may
-- record it. Outcomes:
--   sent      — SES's message id; counted as sent.
--   throttled — SES's send rate (§4.4): queued again, the attempt not counted.
--   retry     — no answer, or SES unwell: queued again; after the last
--               attempt it fails and its reservation is given back.
--   failed    — SES refused this message for good; the reservation is given back.
create function mail.record_send_result(p_email_id bigint, p_worker text, p_outcome text,
                                        p_message_id text default null, p_error_code text default null,
                                        p_retry_after_seconds integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    mail.emails;
  v_settings mail.settings;
  v_wait     integer := least(greatest(coalesce(p_retry_after_seconds, 30), 1), 3600);
  v_code     text := left(regexp_replace(lower(coalesce(p_error_code, '')), '[^a-z_]', '_', 'g'), 60);
begin
  if p_outcome is null or p_outcome not in ('sent', 'throttled', 'retry', 'failed') then
    raise exception 'record_send_result: % is not an outcome', p_outcome using errcode = '22023';
  end if;
  select * into v_email from mail.emails where id = p_email_id for update;
  if v_email.id is null or v_email.claimed_by is distinct from p_worker then
    return jsonb_build_object('ok', false, 'code', 'not_claimed');
  end if;

  if p_outcome = 'sent' then
    if coalesce(btrim(p_message_id), '') = '' or char_length(p_message_id) > 200 then
      raise exception 'record_send_result: a sent email needs SES''s message id' using errcode = '22023';
    end if;
    -- An SNS event may have arrived first and moved the status on: keep it.
    update mail.emails
       set status = case when status = 'sending' then 'sent' else status end,
           ses_message_id = p_message_id, sent_at = coalesce(sent_at, now()),
           claimed_by = null, claimed_at = null, updated_at = now()
     where id = p_email_id;
    perform mail.bump_usage(v_email.account_id, mail.lagos_day(now()), 'sent', v_email.recipient_count);
    return jsonb_build_object('ok', true, 'status', 'sent');
  end if;

  if p_outcome = 'throttled' then
    update mail.emails
       set status = 'queued', attempts = greatest(attempts - 1, 0), next_attempt_at = now() + make_interval(secs => v_wait),
           claimed_by = null, claimed_at = null, updated_at = now()
     where id = p_email_id;
    return jsonb_build_object('ok', true, 'status', 'queued');
  end if;

  select * into v_settings from mail.settings where id;
  if p_outcome = 'retry' and v_email.attempts < coalesce(v_settings.max_send_attempts, 0) then
    update mail.emails
       set status = 'queued', status_reason = nullif(v_code, ''),
           -- 30 s, 1, 2, 4… minutes: the attempt number backs it off.
           next_attempt_at = now() + make_interval(secs => greatest(v_wait, least(30 * (2 ^ greatest(v_email.attempts - 1, 0)), 3600))),
           claimed_by = null, claimed_at = null, updated_at = now()
     where id = p_email_id;
    return jsonb_build_object('ok', true, 'status', 'queued');
  end if;

  perform mail.settle_unsent(p_email_id, 'failed',
                             case when p_outcome = 'retry' then 'retries_exhausted' else coalesce(nullif(v_code, ''), 'ses_refused') end);
  return jsonb_build_object('ok', true, 'status', 'failed');
end;
$$;

-- ── 8. Events from SES (§4.2) ───────────────────────────────────────────────
-- One SES event for one email, found by SES's message id — or, when the
-- event beats record_send_result, by the email id our EmailTags carry. False
-- when the email is not ours (or already purged). Status precedence, the
-- shop's rule (migration 34) with Mail's statuses: bounced (and failed) beat
-- complained beat delivered beat sent; a late bounce wins; nothing moves a
-- status back. A complaint is recorded and counted but is not a bounce. A
-- permanent bounce and a complaint put the address on the account's list
-- (p_suppress: lower-case addresses, never logged). A repeated event (same
-- p_event_key) changes nothing.
create function mail.record_send_event(p_message_id text, p_email_public_id uuid, p_event text,
                                       p_event_key text, p_occurred_at timestamptz, p_detail jsonb,
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
  values (v_email.id, v_email.account_id, p_event, nullif(left(p_event_key, 200), ''), v_at,
          mail.sanitise_detail(p_detail))
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

  v_reason := case
                when p_event = 'complaint' then 'complaint'
                when p_event = 'bounce' and coalesce(p_detail ->> 'bounceType', '') = 'Permanent' then 'bounce'
              end;
  if v_reason is not null then
    insert into mail.suppressions (account_id, address, reason, source)
    select v_email.account_id, a, v_reason, 'ses'
      from unnest(coalesce(p_suppress, '{}')) a
     where a = lower(a) and a ~ '^[^@\s<>]+@[^@\s<>]+$'
       and a in (select mail.address_of(m)
                   from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m)
    on conflict (account_id, address) do nothing;
  end if;
  return true;
end;
$$;

-- ── 9. Housekeeping ─────────────────────────────────────────────────────────
-- MR3: a body is deleted 72 hours after its email left the queue — sent,
-- failed, suppressed or canceled — on the hour after that.
create function mail.purge_payloads()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from mail.email_payloads p
     using mail.emails e
     where e.id = p.email_id
       and e.status not in ('queued', 'sending')
       and coalesce(e.sent_at, e.failed_at, e.canceled_at, e.updated_at) < now() - interval '72 hours'
    returning 1)
  select count(*)::integer from gone
$$;

-- The rolling budget only ever reads the last 24 hours.
create function mail.purge_send_budget()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from mail.send_budget_hourly where hour < now() - interval '48 hours' returning 1)
  select count(*)::integer from gone
$$;

-- cron.schedule replaces a job of the same name, so this is safe to run again.
select cron.schedule('mail-purge-payloads', '0 * * * *', 'select mail.purge_payloads()');
select cron.schedule('mail-purge-send-budget', '7 * * * *', 'select mail.purge_send_budget()');

-- ── 10. Row-level security ──────────────────────────────────────────────────
alter table mail.emails             enable row level security;
alter table mail.email_payloads     enable row level security;
alter table mail.email_events       enable row level security;
alter table mail.suppressions       enable row level security;
alter table mail.usage_daily        enable row level security;
alter table mail.send_budget_hourly enable row level security;   -- no policies: functions only

create policy emails_member_read on mail.emails for select to authenticated
  using (mail.has_role(account_id));
-- "View email" (MR3): bodies for the people who build with the account.
create policy email_payloads_developer_read on mail.email_payloads for select to authenticated
  using (exists (select 1 from mail.emails e
                  where e.id = email_id
                    and mail.has_role(e.account_id, array['owner', 'admin', 'developer'])));
create policy email_events_member_read on mail.email_events for select to authenticated
  using (mail.has_role(account_id));
create policy suppressions_member_read on mail.suppressions for select to authenticated
  using (mail.has_role(account_id));
create policy usage_daily_member_read on mail.usage_daily for select to authenticated
  using (mail.has_role(account_id));

-- ── 11. Grants ──────────────────────────────────────────────────────────────
revoke all on mail.emails, mail.email_payloads, mail.email_events, mail.suppressions, mail.usage_daily,
  mail.send_budget_hourly from public, anon, authenticated, service_role;
grant select (id, public_id, account_id, api_key_id, domain_id, from_address, to_addresses, cc_addresses,
              bcc_addresses, reply_to, recipient_count, subject, tags, status, status_reason, idempotency_key,
              ses_message_id, scheduled_at, attempts, sent_at, delivered_at, bounced_at, complained_at, failed_at,
              canceled_at, last_event, last_event_at, created_at, updated_at)
  on mail.emails to authenticated;
grant select on mail.email_payloads, mail.email_events, mail.suppressions, mail.usage_daily to authenticated;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.address_of(text) from public, anon, authenticated, service_role;
revoke all on function mail.text_array(jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.is_mailbox(text) from public, anon, authenticated, service_role;
revoke all on function mail.lagos_day(timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.bump_usage(uuid, date, text, integer) from public, anon, authenticated, service_role;
revoke all on function mail.sanitise_detail(jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.effective_caps(mail.accounts) from public, anon, authenticated, service_role;
revoke all on function mail.release_reservation(bigint) from public, anon, authenticated, service_role;
revoke all on function mail.reserve_send(uuid, uuid, text, text[]) from public, anon, authenticated, service_role;
revoke all on function mail.enqueue_email(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.authenticate_key(text) from public, anon, authenticated, service_role;
revoke all on function mail.get_email(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.settle_unsent(bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.send_gate(bigint) from public, anon, authenticated, service_role;
revoke all on function mail.claim_sends(text, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function mail.record_send_result(bigint, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_send_event(text, uuid, text, text, timestamptz, jsonb, integer, text[])
  from public, anon, authenticated, service_role;
revoke all on function mail.purge_payloads() from public, anon, authenticated, service_role;
revoke all on function mail.purge_send_budget() from public, anon, authenticated, service_role;

-- The API (apps/mail, secret key): the door and the queue.
grant execute on function mail.authenticate_key(text) to service_role;
grant execute on function mail.enqueue_email(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function mail.get_email(uuid, uuid) to service_role;
-- The worker and the SNS endpoint (secret key).
grant execute on function mail.claim_sends(text, integer, boolean) to service_role;
grant execute on function mail.record_send_result(bigint, text, text, text, text, integer) to service_role;
grant execute on function mail.record_send_event(text, uuid, text, text, timestamptz, jsonb, integer, text[])
  to service_role;
