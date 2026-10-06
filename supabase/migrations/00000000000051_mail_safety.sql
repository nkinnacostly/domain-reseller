-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 51: MyDomainsHub Mail — trust and safety, and Mail's admin area
-- (docs/MAIL-SPEC.md §4.4, §7, §10, §11, MR5; M5: the shop's admins, gate
-- and audit log, docs/ADMIN-SPEC.md §2–§3).
--
-- Safety, in SQL:
--
--   thresholds   — mail.run_safety_checks (the worker, every 15 minutes):
--                  per account over the last 7 Lagos days with at least 500
--                  sends, a warning at bounces ≥ 2% or complaints ≥ 0.05%, a
--                  pause at ≥ 4% or ≥ 0.08% (§7.4; the numbers live in
--                  mail.settings). A pause stops the account in our own gate
--                  at once (state `paused`) and asks for SES's
--                  `UpdateReputationEntityCustomerManagedStatus DISABLED`
--                  in mail.tenant_actions — the worker holds only the sender
--                  key, so apps/mail applies it with the manager key. Pauses
--                  are never lifted by code (MR5): only an owner's audited
--                  resume, with a fresh code.
--   warm-up      — mail.advance_warmup (pg_cron, daily): an approved account's
--                  warm-up day moves on while its 7-day bounces stay under 2%
--                  and complaints under 0.05%, so its cap doubles (§7.3).
--   cap notices  — reserve_send records 80% and 100% of a day's or a month's
--                  cap in mail.cap_notices, once each, for the dashboard (§8).
--   watch        — mail.reputation_readings: the account-wide CloudWatch
--                  reputation the worker reads (§7.8).
--   alerts       — mail.alert_conditions, joined into the shop's
--                  current_alert_conditions (live side), so the shop's
--                  gateway sends them to Telegram as it does its own (§11).
--   retention    — mail.purge_old_emails (pg_cron, daily) by each plan's log
--                  retention (§8, §9); purge_payloads stays hourly (MR3).
--
-- The admin area (§10): `admin_mail_*` wrappers in public, beside the shop's,
-- on the shop's gate (admin_session, admin_gate, admin_tier — which gains the
-- five `mail.*` actions), recording to admin_audit_log; and admin reads,
-- each starting with admin_session. A test-only admin (an e2e user) sees and
-- acts on e2e accounts only; resume and cap overrides are never theirs.
--
-- Every function is revoked from public, anon, authenticated and service_role
-- and granted to exactly one role, or none; supabase/tests/mail_safety.sql,
-- mail_sending.sql check 16 and the shop's admin ACL maps check it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings: the thresholds (§7.3, §7.4, §7.8, §4.4) ────────────────────
-- Rates in parts per million: 2% is 20,000, 0.05% is 500. Read by the
-- functions only, like the rest of mail.settings.
alter table mail.settings
  add column bounce_warn_ppm       integer not null default 20000 check (bounce_warn_ppm between 1 and 1000000),
  add column complaint_warn_ppm    integer not null default 500 check (complaint_warn_ppm between 1 and 1000000),
  add column bounce_pause_ppm      integer not null default 40000 check (bounce_pause_ppm between 1 and 1000000),
  add column complaint_pause_ppm   integer not null default 800 check (complaint_pause_ppm between 1 and 1000000),
  add column threshold_window_days integer not null default 7 check (threshold_window_days between 1 and 30),
  add column threshold_min_sends   integer not null default 500 check (threshold_min_sends > 0),
  -- §4.4, §11: an alert once the SES account's 24-hour quota is this full.
  add column quota_alert_pct       integer not null default 80 check (quota_alert_pct between 50 and 100);
alter table mail.settings
  add constraint settings_thresholds_ordered
  check (bounce_warn_ppm < bounce_pause_ppm and complaint_warn_ppm < complaint_pause_ppm);

-- ── 2. Accounts: where a pause came from, and the warm-up's last look ───────
alter table mail.accounts
  -- The state a pause interrupted; a resume goes back to it.
  add column pre_pause_state   text check (pre_pause_state is null or pre_pause_state in ('sandbox', 'active')),
  -- The Lagos day advance_warmup last judged this account: once a day.
  add column warmup_checked_on date;

-- ── 3. Findings (§7.4, §9, §10) ─────────────────────────────────────────────
-- Our own: the threshold's warnings and pauses, and an admin's pause. (SES's
-- findings arrive through the events endpoint, in the events package's own
-- table; the admin reads both before a resume, MR5.) A pause finding closes
-- only with an owner's resume; a warning closes itself when the rates fall.
-- Members may read their account's (the reason for a pause is theirs to see);
-- who resolved it is ours.
create table mail.safety_findings (
  id           bigint generated always as identity primary key,
  account_id   uuid not null references mail.accounts (id) on delete cascade,
  source       text not null check (source in ('threshold', 'admin')),
  kind         text not null check (kind ~ '^[a-z][a-z0-9_]{1,59}$'),
  severity     text not null check (severity in ('warning', 'pause')),
  detail       jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  text check (resolved_by is null or char_length(resolved_by) between 1 and 60),
  resolution   text check (resolution is null or resolution in ('cleared', 'resumed', 'closed')),
  constraint safety_findings_resolved check ((resolved_at is null) = (resolution is null))
);
create unique index safety_findings_one_open
  on mail.safety_findings (account_id, source, kind) where resolved_at is null;
create index safety_findings_account on mail.safety_findings (account_id, opened_at desc);
create index safety_findings_open on mail.safety_findings (opened_at) where resolved_at is null;

-- ── 4. SES-side pauses to apply (§7.4, §4.3, MR5) ───────────────────────────
-- The customer-managed sending status of an account's tenant, as we want SES
-- to hold it. Written here by a threshold pause or an admin; applied by
-- apps/mail, which holds the manager key (the worker's sender key cannot), in
-- order per account. ENABLED only ever follows an owner's resume.
create table mail.tenant_actions (
  id               bigint generated always as identity primary key,
  account_id       uuid not null references mail.accounts (id) on delete cascade,
  sending_status   text not null check (sending_status in ('DISABLED', 'ENABLED')),
  why              text not null check (why in ('threshold', 'admin_pause', 'admin_resume')),
  finding_id       bigint references mail.safety_findings (id) on delete set null,
  requested_by     text not null check (char_length(requested_by) between 1 and 60),
  requested_at     timestamptz not null default now(),
  state            text not null default 'pending' check (state in ('pending', 'claimed', 'applied', 'canceled')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null default now(),
  claimed_by       text check (claimed_by is null or char_length(claimed_by) between 1 and 100),
  claimed_at       timestamptz,
  applied_at       timestamptz,
  -- SES's status and error type only (e.g. "HTTP 404 NotFoundException"), never its text.
  last_error       text check (last_error is null or last_error ~ '^[A-Za-z0-9 _.:-]{1,120}$'),
  constraint tenant_actions_why check (
    (sending_status = 'DISABLED' and why in ('threshold', 'admin_pause'))
    or (sending_status = 'ENABLED' and why = 'admin_resume'))
);
create index tenant_actions_due on mail.tenant_actions (next_attempt_at, id) where state in ('pending', 'claimed');
create index tenant_actions_account on mail.tenant_actions (account_id, id desc);

-- ── 5. The account-wide watch (§7.8) ────────────────────────────────────────
-- CloudWatch's Reputation.BounceRate and Reputation.ComplaintRate for the
-- whole SES account (the shop's email included), as the worker read them.
create table mail.reputation_readings (
  id             bigint generated always as identity primary key,
  read_at        timestamptz not null default now(),
  outcome        text not null check (outcome in ('ok', 'no_data', 'failed')),
  bounce_ppm     integer check (bounce_ppm between 0 and 1000000),
  complaint_ppm  integer check (complaint_ppm between 0 and 1000000),
  metric_at      timestamptz,
  constraint reputation_readings_ok check (outcome <> 'ok' or bounce_ppm is not null or complaint_ppm is not null)
);
create index reputation_readings_recent on mail.reputation_readings (read_at desc);

-- ── 6. Cap notices (§8: "at 80% of a cap, an email and a banner") ───────────
-- One row per account, cap, period and level, written by reserve_send the
-- first time the account reaches it. Members read their own.
create table mail.cap_notices (
  account_id    uuid not null references mail.accounts (id) on delete cascade,
  scope         text not null check (scope in ('day', 'month')),
  period_start  date not null,
  level         smallint not null check (level in (80, 100)),
  cap           integer not null check (cap >= 0),
  used          integer not null check (used >= 0),
  created_at    timestamptz not null default now(),
  primary key (account_id, scope, period_start, level)
);

-- ── 7. Small helpers (no API role may call them) ────────────────────────────

-- p_n out of p_sent, in parts per million; null with nothing sent.
create function mail.rate_ppm(p_n bigint, p_sent bigint)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_sent, 0) > 0
              then least(floor(greatest(coalesce(p_n, 0), 0) * 1000000.0 / p_sent), 1000000)::integer end
$$;

-- 43,000 ppm → '4.3%'; 523 → '0.052%'.
create function mail.ppm_text(p_ppm integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_ppm is null then 'unknown'
              else rtrim(to_char(p_ppm / 10000.0, 'FM9990.999'), '.') || '%' end
$$;

-- What the account sent, and what bounced and was complained about, over its
-- last p_days Lagos days (today included), in recipients, from usage_daily.
create function mail.window_usage(p_account_id uuid, p_days integer,
                                  out sent bigint, out bounced bigint, out complained bigint)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(u.sent), 0)::bigint, coalesce(sum(u.bounced), 0)::bigint,
         coalesce(sum(u.complained), 0)::bigint
    from mail.usage_daily u
   where u.account_id = p_account_id
     and u.day > mail.lagos_day(now()) - greatest(coalesce(p_days, 7), 1)
$$;

-- §7.2 (b): the profile §7.1 asks for. As isProfileComplete in apps/mail.
create function mail.profile_complete(p_account mail.accounts)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(btrim(p_account.name)) > 0
                  and char_length(btrim(coalesce(p_account.website, ''))) > 0
                  and char_length(btrim(coalesce(p_account.use_case, ''))) > 0
                  and p_account.expected_monthly_volume is not null, false)
$$;

-- Opens a finding, or refreshes the detail of the one already open.
create function mail.open_finding(p_account_id uuid, p_source text, p_kind text, p_severity text,
                                  p_detail jsonb)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into mail.safety_findings (account_id, source, kind, severity, detail)
  values (p_account_id, p_source, p_kind, p_severity, coalesce(p_detail, '{}'))
  on conflict (account_id, source, kind) where resolved_at is null
  do update set detail = excluded.detail
  returning id into v_id;
  return v_id;
end;
$$;

-- Asks for the tenant's customer-managed sending status (§7.4). Nothing for
-- an e2e account (it has no real tenant) or a tenant not made yet. A pause
-- already asked for or held is not asked twice; a resume first withdraws a
-- pause apps/mail has not picked up, and asks SES only to undo one it has.
create function mail.queue_tenant_action(p_account mail.accounts, p_status text, p_why text,
                                         p_finding_id bigint, p_by text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_latest mail.tenant_actions;
  v_id     bigint;
begin
  if p_account.id is null or p_account.is_e2e or p_account.tenant_ready_at is null
     or mail.is_e2e_account(p_account.id) then
    return null;
  end if;
  if p_status = 'ENABLED' then
    update mail.tenant_actions set state = 'canceled', claimed_by = null, claimed_at = null
     where account_id = p_account.id and state = 'pending' and sending_status = 'DISABLED';
  end if;
  select * into v_latest from mail.tenant_actions
   where account_id = p_account.id and state <> 'canceled'
   order by id desc limit 1;
  if v_latest.id is not null and v_latest.sending_status = p_status then
    return v_latest.id;
  end if;
  -- SES holds ENABLED until we disable it: a resume with nothing disabled asks for nothing.
  if p_status = 'ENABLED' and v_latest.id is null then
    return null;
  end if;
  insert into mail.tenant_actions (account_id, sending_status, why, finding_id, requested_by)
  values (p_account.id, p_status, p_why, p_finding_id, left(coalesce(p_by, 'system'), 60))
  returning id into v_id;
  return v_id;
end;
$$;

-- Whether the newest SES-side change we asked for an account is a pause. While
-- it is, SES's `disabled` for the tenant (the events endpoint records it) is
-- our own pause echoed back, not AWS's: a resume may undo it, and no alert
-- says SES paused the account.
create function mail.asked_ses_to_pause(p_account_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select t.sending_status = 'DISABLED' from mail.tenant_actions t
                    where t.account_id = p_account_id and t.state <> 'canceled'
                    order by t.id desc limit 1), false)
$$;

-- §8: a notice at 80% and at 100% of a cap, once per account, cap, period and
-- level. A send refused at the cap is the 100% notice too.
create function mail.note_cap_use(p_account_id uuid, p_scope text, p_period date, p_cap integer,
                                  p_used bigint, p_refused boolean)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(p_cap, 0) <= 0 then
    return;
  end if;
  if coalesce(p_refused, false) or coalesce(p_used, 0) >= p_cap then
    insert into mail.cap_notices (account_id, scope, period_start, level, cap, used)
    values (p_account_id, p_scope, p_period, 100, p_cap, least(greatest(coalesce(p_used, 0), 0), 2147483647))
    on conflict do nothing;
  end if;
  if coalesce(p_used, 0) * 100 >= p_cap::bigint * 80 then
    insert into mail.cap_notices (account_id, scope, period_start, level, cap, used)
    values (p_account_id, p_scope, p_period, 80, p_cap, least(greatest(coalesce(p_used, 0), 0), 2147483647))
    on conflict do nothing;
  end if;
end;
$$;

-- ── 8. reserve_send, as migration 44, plus the cap notices (§8) ─────────────
-- Unchanged otherwise: the gate of MR2 and the caps reserved atomically.
create or replace function mail.reserve_send(p_account_id uuid, p_api_key_id uuid, p_from_address text,
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
  -- §8: 80% and 100% of today's and this month's caps, noted once each.
  perform mail.note_cap_use(p_account_id, 'day', v_today, v_caps.daily, v_day_used + v_n, false);
  perform mail.note_cap_use(p_account_id, 'month', v_month, v_caps.monthly, v_mon_used + v_n, false);
  return jsonb_build_object('ok', true, 'domainId', v_domain.id, 'recipients', v_n,
                            'reservedOn', v_today, 'reservedHour', v_hour);
end;
$$;

-- ── 9. Thresholds (§7.4) ────────────────────────────────────────────────────
-- One account, judged now. Only a sandbox or active account is judged: a
-- paused one stays paused until an owner resumes it (MR5), and a pause is
-- never lifted here.
create function mail.evaluate_account(p_account_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_settings mail.settings;
  v_account  mail.accounts;
  v_use      record;
  v_bppm     integer;
  v_cppm     integer;
  v_detail   jsonb;
  v_pause    text[] := '{}';
  v_warn     text[] := '{}';
  v_kind     text;
  v_finding  bigint;
  v_first    bigint;
  v_action   bigint;
begin
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null or v_account.state not in ('sandbox', 'active') then
    return jsonb_build_object('evaluated', false);
  end if;

  select * into v_use from mail.window_usage(p_account_id, v_settings.threshold_window_days);
  v_bppm := mail.rate_ppm(v_use.bounced, v_use.sent);
  v_cppm := mail.rate_ppm(v_use.complained, v_use.sent);
  v_detail := jsonb_build_object('windowDays', v_settings.threshold_window_days, 'sent', v_use.sent,
                                 'bounced', v_use.bounced, 'complained', v_use.complained,
                                 'bouncePpm', v_bppm, 'complaintPpm', v_cppm, 'evaluatedAt', now());

  if v_use.sent >= v_settings.threshold_min_sends then
    if v_bppm >= v_settings.bounce_pause_ppm then v_pause := array_append(v_pause, 'bounce_pause'); end if;
    if v_cppm >= v_settings.complaint_pause_ppm then v_pause := array_append(v_pause, 'complaint_pause'); end if;
    if v_bppm >= v_settings.bounce_warn_ppm then v_warn := array_append(v_warn, 'bounce_warning'); end if;
    if v_cppm >= v_settings.complaint_warn_ppm then v_warn := array_append(v_warn, 'complaint_warning'); end if;
  end if;

  -- Warnings follow the rates: open while they hold, closed when they do not.
  foreach v_kind in array v_warn loop
    perform mail.open_finding(p_account_id, 'threshold', v_kind, 'warning', v_detail);
  end loop;
  update mail.safety_findings
     set resolved_at = now(), resolved_by = 'system', resolution = 'cleared'
   where account_id = p_account_id and source = 'threshold' and severity = 'warning'
     and resolved_at is null and not (kind = any (v_warn));

  if cardinality(v_pause) = 0 then
    return jsonb_build_object('evaluated', true, 'paused', false, 'warnings', cardinality(v_warn),
                              'sent', v_use.sent, 'bouncePpm', v_bppm, 'complaintPpm', v_cppm);
  end if;

  foreach v_kind in array v_pause loop
    v_finding := mail.open_finding(p_account_id, 'threshold', v_kind, 'pause', v_detail);
    v_first := coalesce(v_first, v_finding);
  end loop;
  update mail.accounts
     set pre_pause_state = state, state = 'paused',
         state_reason = case when 'bounce_pause' = any (v_pause) then 'paused_bounce_rate'
                             else 'paused_complaint_rate' end,
         updated_at = now()
   where id = p_account_id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (p_account_id, 'system', 'account.paused', p_account_id::text,
          jsonb_build_object('reason', case when 'bounce_pause' = any (v_pause) then 'bounce_rate'
                                            else 'complaint_rate' end,
                             'sent', v_use.sent, 'bouncePpm', v_bppm, 'complaintPpm', v_cppm,
                             'windowDays', v_settings.threshold_window_days));
  v_action := mail.queue_tenant_action(v_account, 'DISABLED', 'threshold', v_first, 'system');
  return jsonb_build_object('evaluated', true, 'paused', true, 'findingId', v_first, 'tenantActionId', v_action,
                            'sent', v_use.sent, 'bouncePpm', v_bppm, 'complaintPpm', v_cppm);
end;
$$;

-- The worker's 15-minute run (§7.4, §7.8): the account-wide reading it took
-- from CloudWatch (or why it has none), then every sending account judged.
-- e2e accounts are left to their own helper. Answers what the worker needs:
-- how many SES-side changes wait for apps/mail.
create function mail.run_safety_checks(p_outcome text, p_bounce_ppm integer default null,
                                       p_complaint_ppm integer default null, p_metric_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings  mail.settings;
  v_row       record;
  v_result    jsonb;
  v_evaluated integer := 0;
  v_paused    integer := 0;
begin
  if p_outcome is null or p_outcome not in ('ok', 'no_data', 'failed') then
    raise exception 'run_safety_checks: % is not an outcome', p_outcome using errcode = '22023';
  end if;
  if (p_bounce_ppm is not null and p_bounce_ppm not between 0 and 1000000)
     or (p_complaint_ppm is not null and p_complaint_ppm not between 0 and 1000000)
     or (p_outcome = 'ok' and p_bounce_ppm is null and p_complaint_ppm is null)
     or (p_outcome <> 'ok' and (p_bounce_ppm is not null or p_complaint_ppm is not null)) then
    raise exception 'run_safety_checks: rates in parts per million, with an ok reading only' using errcode = '22023';
  end if;
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;

  insert into mail.reputation_readings (outcome, bounce_ppm, complaint_ppm, metric_at)
  values (p_outcome, p_bounce_ppm, p_complaint_ppm, case when p_metric_at is not null then least(p_metric_at, now()) end);

  for v_row in
    select a.id from mail.accounts a
     where a.state in ('sandbox', 'active') and not a.is_e2e
       and exists (select 1 from mail.usage_daily u
                    where u.account_id = a.id and u.sent > 0
                      and u.day > mail.lagos_day(now()) - v_settings.threshold_window_days)
     order by a.id
  loop
    v_result := mail.evaluate_account(v_row.id);
    if coalesce((v_result ->> 'evaluated')::boolean, false) then v_evaluated := v_evaluated + 1; end if;
    if coalesce((v_result ->> 'paused')::boolean, false) then v_paused := v_paused + 1; end if;
  end loop;

  -- Warnings of accounts with nothing sent in the window close too.
  update mail.safety_findings f
     set resolved_at = now(), resolved_by = 'system', resolution = 'cleared'
   where f.source = 'threshold' and f.severity = 'warning' and f.resolved_at is null
     and not exists (select 1 from mail.usage_daily u
                      where u.account_id = f.account_id and u.sent > 0
                        and u.day > mail.lagos_day(now()) - v_settings.threshold_window_days);

  return jsonb_build_object(
    'evaluated', v_evaluated, 'paused', v_paused,
    'openWarnings', (select count(*) from mail.safety_findings
                      where severity = 'warning' and resolved_at is null),
    'pendingTenantActions', (select count(*) from mail.tenant_actions where state in ('pending', 'claimed')));
end;
$$;

-- ── 10. SES-side changes, applied by apps/mail (§4.3, §7.4) ─────────────────
-- Due actions, the oldest first and one at a time per account, so a resume
-- never overtakes the pause before it. A claim older than five minutes
-- belongs to a caller that stopped.
create function mail.claim_tenant_actions(p_worker text, p_limit integer default 10)
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
     or p_limit not between 1 and 20 then
    raise exception 'claim_tenant_actions: a worker name and a limit of 1 to 20' using errcode = '22023';
  end if;
  update mail.tenant_actions
     set state = 'pending', claimed_by = null, claimed_at = null
   where state = 'claimed' and claimed_at < now() - interval '5 minutes';

  for v_row in
    select t.id, t.account_id, t.sending_status, t.why, t.requested_by, t.attempts, a.ses_tenant, a.short_id
      from mail.tenant_actions t
      join mail.accounts a on a.id = t.account_id
     where t.state = 'pending' and t.next_attempt_at <= now()
       and not exists (select 1 from mail.tenant_actions e
                        where e.account_id = t.account_id and e.id < t.id and e.state in ('pending', 'claimed'))
     order by t.id
     limit p_limit
     for update of t skip locked
  loop
    update mail.tenant_actions
       set state = 'claimed', claimed_by = p_worker, claimed_at = now(), attempts = attempts + 1
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'accountId', v_row.account_id, 'accountShortId', v_row.short_id,
      'tenant', v_row.ses_tenant, 'sendingStatus', v_row.sending_status, 'why', v_row.why,
      'requestedBy', v_row.requested_by, 'attempt', v_row.attempts + 1));
  end loop;
  return v_out;
end;
$$;

-- What SES said. `applied`; or `retry` — SES unwell, refused or unreachable:
-- tried again after 1, 2, 4… minutes (at most an hour), and alerted on after
-- 15 minutes, because a pause SES does not hold is our gate's alone.
create function mail.record_tenant_action(p_action_id bigint, p_worker text, p_outcome text,
                                          p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action mail.tenant_actions;
  v_error  text := nullif(left(btrim(regexp_replace(coalesce(p_error, ''), '[^A-Za-z0-9 _.:-]', ' ', 'g')), 120), '');
begin
  if p_outcome is null or p_outcome not in ('applied', 'retry') then
    raise exception 'record_tenant_action: % is not an outcome', p_outcome using errcode = '22023';
  end if;
  select * into v_action from mail.tenant_actions where id = p_action_id for update;
  if v_action.id is null or v_action.state <> 'claimed' or v_action.claimed_by is distinct from p_worker then
    return jsonb_build_object('ok', false, 'code', 'not_claimed');
  end if;
  if p_outcome = 'applied' then
    update mail.tenant_actions
       set state = 'applied', applied_at = now(), claimed_by = null, claimed_at = null, last_error = null
     where id = p_action_id;
    return jsonb_build_object('ok', true, 'state', 'applied');
  end if;
  update mail.tenant_actions
     set state = 'pending', claimed_by = null, claimed_at = null, last_error = v_error,
         next_attempt_at = now() + make_interval(mins => least(2 ^ greatest(v_action.attempts - 1, 0), 60)::integer)
   where id = p_action_id;
  return jsonb_build_object('ok', true, 'state', 'pending');
end;
$$;

-- ── 11. SES's own findings (§4.2), for the admin to read ──────────────────
-- The events endpoint records SES's findings (sending paused, Advisor
-- recommendations) in mail.findings, a table of the events package. This
-- migration does not depend on it: the admin's account page reads it when it
-- is there, by name, and shows nothing of it otherwise.
create function mail.ses_findings_of(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if to_regclass('mail.findings') is null then
    return '[]'::jsonb;
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', f.id, 'source', f.source, 'kind', f.kind, 'impact', f.impact, 'summary', f.summary,
             'openedAt', f.opened_at, 'resolvedAt', f.resolved_at)
           order by f.resolved_at is not null, f.opened_at desc), '[]'::jsonb)
      from (select * from mail.findings x where x.account_id = $1
             order by x.resolved_at is not null, x.opened_at desc limit 50) f
  $q$ into v_out using p_account_id;
  return v_out;
exception when undefined_table or undefined_column then
  return '[]'::jsonb;
end;
$$;

-- ── 12. Warm-up (§7.3) ──────────────────────────────────────────────────────
-- Once a Lagos day: an approved account still warming up moves on a day —
-- doubling its cap — when it sent in the last 7 days and its bounces stayed
-- under 2% and its complaints under 0.05%. An account that sends nothing
-- does not warm up (no evidence either way); an admin's daily override ends
-- the warm-up's say, as effective_caps reads it.
create function mail.advance_warmup()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.settings;
  v_today    date := mail.lagos_day(now());
  v_row      record;
  v_use      record;
  v_plan     integer;
  v_n        integer := 0;
begin
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  for v_row in
    select a.id, a.warmup_day, coalesce(a.daily_cap_override, p.daily_cap) as daily_cap
      from mail.accounts a join mail.plans p on p.code = a.plan_code
     where a.state = 'active' and a.warmup_day is not null and a.daily_cap_override is null
       and (a.warmup_checked_on is null or a.warmup_checked_on < v_today)
     for update of a skip locked
  loop
    v_plan := v_row.daily_cap;
    if v_settings.warmup_start_cap::bigint * (2::bigint ^ least(v_row.warmup_day, 30)) < v_plan
       and v_row.warmup_day < 60 then
      select * into v_use from mail.window_usage(v_row.id, v_settings.threshold_window_days);
      if v_use.sent > 0
         and mail.rate_ppm(v_use.bounced, v_use.sent) < v_settings.bounce_warn_ppm
         and mail.rate_ppm(v_use.complained, v_use.sent) < v_settings.complaint_warn_ppm then
        update mail.accounts set warmup_day = warmup_day + 1, warmup_checked_on = v_today, updated_at = now()
         where id = v_row.id;
        v_n := v_n + 1;
        continue;
      end if;
    end if;
    update mail.accounts set warmup_checked_on = v_today where id = v_row.id;
  end loop;
  return v_n;
end;
$$;

-- ── 13. Retention (§8, §9, MR3, MR4) ────────────────────────────────────────
-- An email and its events go once the plan's log retention has passed since
-- its last activity; one still queued or sending stays. In batches, so one
-- large account cannot hold the job's transaction open for long.
create function mail.purge_old_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan  record;
  v_cut   timestamptz;
  v_batch integer;
  v_total integer := 0;
begin
  for v_plan in select code, log_retention_days from mail.plans order by code loop
    v_cut := now() - make_interval(days => v_plan.log_retention_days);
    for i in 1..200 loop
      delete from mail.emails e
       where e.id in (
         select x.id from mail.emails x join mail.accounts a on a.id = x.account_id
          where a.plan_code = v_plan.code
            and x.created_at < v_cut
            and coalesce(x.sent_at, x.created_at) < v_cut
            and coalesce(x.last_event_at, x.created_at) < v_cut
            and x.status not in ('queued', 'sending')
          limit 5000);
      get diagnostics v_batch = row_count;
      v_total := v_total + v_batch;
      exit when v_batch < 5000;
    end loop;
  end loop;
  return v_total;
end;
$$;

-- What the safety records need no longer: readings after 90 days; settled
-- SES actions, closed findings and cap notices after 400.
create function mail.purge_safety_records()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n     integer;
  v_total integer := 0;
begin
  delete from mail.reputation_readings where read_at < now() - interval '90 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from mail.tenant_actions
   where state in ('applied', 'canceled') and requested_at < now() - interval '400 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from mail.safety_findings
   where resolved_at < now() - interval '400 days'
     and not exists (select 1 from mail.tenant_actions t where t.finding_id = safety_findings.id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from mail.cap_notices where created_at < now() - interval '400 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end;
$$;

select cron.schedule('mail-purge-old-emails', '40 2 * * *', 'select mail.purge_old_emails()');
select cron.schedule('mail-purge-safety', '50 2 * * *', 'select mail.purge_safety_records()');
-- 00:10 in Lagos: the day before is over.
select cron.schedule('mail-advance-warmup', '10 23 * * *', 'select mail.advance_warmup()');

-- ── 14. Alerts (§11), for the shop's Telegram ───────────────────────────────
-- Each a live-side ops alert with a stable key while it lasts. Summaries
-- carry the account's tenant name and counts, never a person's details.
-- A heartbeat may say how often it beats (`everyMinutes`); it is silent once
-- 15 minutes past that.
create function mail.alert_conditions()
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
$$;

-- The shop's alert list (migration 41's definition, unchanged) with Mail's
-- conditions on the live side. `create or replace` keeps its grants.
CREATE OR REPLACE FUNCTION public.current_alert_conditions(p_test_mode boolean)
 RETURNS TABLE(key text, severity text, kind text, summary text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
                  when 'transfer_domain' then 'Transfer'
                  when 'set_transfer_lock' then 'Transfer lock change'
                  when 'set_privacy' then 'Privacy change'
                  when 'update_contacts' then 'Contact change'
                  else 'Nameserver change'
                end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- The same for certificates (migration 39): never refunded or re-sent by itself.
  select 'ssl_job:' || j.id,
         'critical',
         'ssl_job_needs_attention',
         format('%s of the SSL certificate for %s%s needs a person (%s)',
                case j.kind
                  when 'ssl_initialize' then 'The order'
                  when 'ssl_configure' then 'The set-up'
                  when 'ssl_reissue' then 'The reissue'
                  else 'A job'
                end,
                c.common_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.ssl_jobs j
    join public.ssl_certificates c on c.id = j.certificate_id
    left join public.order_items oi on oi.id = c.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- A status word from the supplier we do not know, for a day.
  select 'ssl_status:' || c.id,
         'warning',
         'ssl_status_unrecognised',
         format('The supplier calls the SSL certificate for %s "%s", which we do not recognise — check it and teach the gateway the word',
                c.common_name, coalesce(c.supplier_status, ''))
    from public.ssl_certificates c
   where c.test_mode = p_test_mode
     and c.status_unrecognised_since < now() - interval '1 day'

  union all
  -- I5: paid, and not settled in time.
  select 'order_stuck:' || o.id,
         'critical',
         'order_stuck',
         format('Order %s was paid %s minutes ago and is still %s',
                o.order_number, floor(extract(epoch from now() - o.paid_at) / 60), o.status)
    from public.orders o
    cross join public.ops_settings s
   where o.test_mode = p_test_mode
     and o.status in ('paid', 'provisioning')
     and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
     -- A transfer waits days for the other registrar; only other lines are late (migration 26).
     and exists (
       select 1 from public.order_items oi2
        where oi2.order_id = o.id
          and oi2.status in ('pending', 'provisioning')
          and not (oi2.item_type = 'transfer' and exists (
            select 1 from public.domains d2
             where d2.order_item_id = oi2.id and d2.local_status = 'transfer_pending'))
     )

  union all
  -- Refunds a person must look at, or approve.
  select 'refund:' || r.id,
         case when r.status = 'held' then 'warning' else 'critical' end,
         'refund_' || r.status,
         format('Refund of ₦%s for order %s%s is %s%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number,
                coalesce(' (' || oi.domain || ')', ''),
                replace(r.status::text, '_', ' '),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')

  union all
  -- A refund that should have gone out 30 minutes ago: is the worker running?
  select 'refund_overdue:' || r.id,
         'critical',
         'refund_overdue',
         format('Refund of ₦%s for order %s has waited %s minutes to be sent%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.run_after) / 60),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status in ('queued', 'sending')
     and r.run_after < now() - interval '30 minutes'

  union all
  -- Accepted by Flutterwave but not completed after ten days.
  select 'refund_slow:' || r.id,
         'warning',
         'refund_slow',
         format('Refund of ₦%s for order %s was sent %s days ago and has not completed',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.submitted_at) / 86400))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status = 'submitted'
     and r.submitted_at < now() - interval '10 days'

  union all
  -- Money that arrived but could not be applied, or a refund that could not be queued.
  select 'incident:' || i.id,
         'critical',
         'payment_' || i.kind,
         format('Payment incident: %s%s',
                replace(i.kind, '_', ' '),
                coalesce(', order ' || o.order_number, ''))
    from public.payment_incidents i
    left join public.orders o on o.id = i.order_id
   where i.test_mode = p_test_mode and i.resolved_at is null

  union all
  -- The registry disagrees with us (§13.5).
  select 'drift:' || g.id,
         case when g.kind in ('supplier_may_renew', 'unknown_domain') then 'warning' else 'critical' end,
         'drift_' || g.kind,
         format('Registry check: %s — %s', g.domain_name, replace(g.kind, '_', ' '))
    from public.registry_drift g
   where g.test_mode = p_test_mode and g.resolved_at is null

  union all
  -- The registry has not been read successfully for three hours.
  select 'reconcile_stale:' || p_test_mode::text,
         'warning',
         'reconcile_stale',
         'The registry has not been reconciled successfully for over three hours'
   where exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode and r.started_at > now() - interval '7 days'
         )
     and not exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode
              and r.finished_at > now() - interval '3 hours'
              and r.error is null
         )

  union all
  -- FR-FLOAT-2, simplified: checkout refuses orders the float cannot cover.
  select 'float_low:' || p_test_mode::text,
         'warning',
         'float_low',
         format('Supplier balance is $%s, below the $%s alert level. Checkout refuses orders it cannot cover.',
                to_char(b.balance_usd, 'FM999,999,990.00'), to_char(s.float_alert_usd, 'FM999,990.00'))
    from (
      select balance_usd, taken_at from public.supplier_balance_snapshots
       where test_mode = p_test_mode order by taken_at desc limit 1
    ) b
    cross join public.ops_settings s
   where b.taken_at > now() - interval '2 hours'
     and b.balance_usd < s.float_alert_usd

  union all
  -- The weekly catalogue syncs inside the gateway (migrations 27 and 39): the
  -- last run failed or was refused, or nothing has succeeded for eight days.
  -- Prices then drift from the supplier's.
  select 'catalogue_sync:' || h.name,
         'warning',
         'catalogue_sync',
         case
           when h.detail ->> 'outcome' in ('failed', 'refused')
             then format('The supplier %s sync %s on %s — prices are not being updated',
                         case when h.name like 'ssl%' then 'SSL product' else 'catalogue' end,
                         h.detail ->> 'outcome', to_char(h.beat_at, 'DD Mon HH24:MI'))
           else format('The supplier %s has not synced for over eight days — prices are not being updated',
                       case when h.name like 'ssl%' then 'SSL product list' else 'catalogue' end)
         end
    from public.service_heartbeats h
   where p_test_mode = false
     and h.name in ('catalogue:production', 'ssl_catalogue:production')
     and (
       h.detail ->> 'outcome' in ('failed', 'refused')
       or coalesce((h.detail ->> 'lastSuccessAt')::timestamptz, h.beat_at - interval '9 days')
          < now() - interval '8 days'
     )

  union all
  -- FR-NT3: an ERRP notice that bounced is a compliance failure — the
  -- registrant must be reached another way. Raised for three days.
  select 'notice_bounced:' || c.id,
         'critical',
         'compliance_notice_bounced',
         format('The %s expiry notice for %s bounced — reach the registrant another way',
                case c.notice_type when 'errp_pre_35' then 'one-month'
                                   when 'errp_pre_7' then 'one-week'
                                   else 'after-expiry' end,
                c.domain_name)
    from public.compliance_notices c
    join public.email_outbox e on e.id = c.email_id
   where e.test_mode = p_test_mode
     and c.delivery_status = 'bounced'
     and c.delivery_checked_at > now() - interval '3 days'

  union all
  -- An email that could not be sent at all (migration 31).
  select 'email_failed:' || e.id,
         case when e.category = 'transactional' then 'warning' else 'critical' end,
         'email_failed',
         format('A %s email (%s%s) could not be sent: %s',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                coalesce(e.last_error, 'no reason given'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'failed'
     and e.updated_at > now() - interval '3 days'

  union all
  -- Emails not sent after half an hour: the gateway's sender is not running,
  -- has no credentials for its provider (EMAIL_PROVIDER), or the provider is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and its provider''s credentials (EMAIL_PROVIDER)',
                count(*))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status in ('pending', 'sending')
     and e.created_at < now() - interval '30 minutes'
  having count(*) > 0

  union all
  -- FR-D2: a preset the DNS check hid — customers no longer see it.
  select 'preset_hidden:' || p.id,
         'critical',
         'preset_hidden',
         format('Host preset %s is hidden: its nameservers stopped resolving on %s. Check the provider''s documentation, fix or retire it.',
                p.provider, to_char(p.check_failed_since, 'DD Mon'))
    from public.nameserver_presets p
   where p_test_mode = false and p.is_hidden and p.auto_hidden_at is not null

  union all
  -- …and one failing, not yet hidden.
  select 'preset_failing:' || p.id,
         'warning',
         'preset_failing',
         format('Host preset %s: its nameservers are not resolving (since %s). It is hidden after a day.',
                p.provider, to_char(p.check_failed_since, 'DD Mon HH24:MI'))
    from public.nameserver_presets p
   where p_test_mode = false and p.check_failed_since is not null and not p.is_hidden

  union all
  -- The quarterly re-verification against the provider's own documentation.
  select 'preset_stale:' || p.id,
         'warning',
         'preset_stale',
         format('Host preset %s was last verified against its documentation on %s — check it again and update verified_at.',
                p.provider, to_char(p.verified_at, 'DD Mon YYYY'))
    from public.nameserver_presets p
   where p_test_mode = false and not p.is_hidden and p.verified_at < now() - interval '90 days'

  union all
  -- FR-NT3: an ERRP or security email with no final delivery report a day
  -- after sending. SES pushes its reports (migration 34) and Brevo is read
  -- back; either way a missing one is not a delivery. Raised for three days.
  select 'email_unconfirmed:' || e.id,
         case when e.category = 'compliance' then 'critical' else 'warning' end,
         'email_unconfirmed',
         format('A %s email (%s%s) sent %s UTC has no delivery report — check the email provider''s log; it is not counted as delivered',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                to_char(e.sent_at at time zone 'UTC', 'DD Mon HH24:MI'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'sent'
     and e.category in ('compliance', 'security')
     and coalesce(e.delivery_status, 'deferred') = 'deferred'
     and e.sent_at < now() - interval '24 hours'
     and e.sent_at > now() - interval '4 days'

  union all
  -- A recipient reported one of our emails as spam (SES, migration 34).
  -- Complaints cost the sending domain its reputation, and SES now
  -- suppresses the address. Raised for three days.
  select 'email_complaint:' || e.id,
         'warning',
         'email_complaint',
         format('A %s email (%s%s) was reported as spam by its recipient — SES will not send to that address again until it leaves the account''s suppression list',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.complained_at > now() - interval '3 days'

  union all
  -- Migration 41: the supplier ledger's exceptions (§7.4).
  select l.key, l.severity, l.kind, l.summary from public.ledger_alert_conditions(p_test_mode) l

  union all
  -- Migration 41: changes to admin access and unusual admin activity (live only).
  select a.key, a.severity, a.kind, a.summary from public.admin_alert_conditions(p_test_mode) a

  union all
  -- Migration 41: pg_cron housekeeping and the ERRP notice job (live only).
  select c.key, c.severity, c.kind, c.summary from public.cron_alert_conditions(p_test_mode) c

  union all
  -- Migration 51: MyDomainsHub Mail's conditions (MAIL-SPEC §11), live side only.
  select m.key, m.severity, m.kind, m.summary from mail.alert_conditions() m where not p_test_mode
$function$;

-- ── 15. e2e (migration 45's rule: every member an e2e user) ─────────────────
-- Today's sends, bounces and complaints for a test account, so a journey can
-- meet a threshold without SES.
create function mail.e2e_seed_usage(p_account_id uuid, p_sent integer, p_bounced integer, p_complained integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not mail.is_e2e_account(p_account_id) then
    return jsonb_build_object('ok', false, 'code', 'not_e2e');
  end if;
  if coalesce(p_sent, -1) not between 0 and 1000000 or coalesce(p_bounced, -1) not between 0 and 1000000
     or coalesce(p_complained, -1) not between 0 and 1000000 then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  perform mail.bump_usage(p_account_id, mail.lagos_day(now()), 'sent', p_sent);
  perform mail.bump_usage(p_account_id, mail.lagos_day(now()), 'bounced', p_bounced);
  perform mail.bump_usage(p_account_id, mail.lagos_day(now()), 'complained', p_complained);
  return jsonb_build_object('ok', true);
end;
$$;

-- The threshold job, for one test account (the worker's run skips them).
create function mail.e2e_evaluate(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not mail.is_e2e_account(p_account_id) then
    return jsonb_build_object('ok', false, 'code', 'not_e2e');
  end if;
  return jsonb_build_object('ok', true) || mail.evaluate_account(p_account_id);
end;
$$;

-- ── 16. The admin's action map: the shop's, plus Mail's (§10, ADMIN-SPEC §2.2)
-- As migration 40's, with the five `mail.*` actions after it. Approve,
-- reject and pause are an operator's, and a test admin's on e2e accounts;
-- resume and cap overrides are the owner's, with a fresh code (MR5, D6).
create or replace function public.admin_tier(p_action text, out min_role text, out money boolean, out test_rule text)
language sql
immutable
set search_path = ''
as $$
  select t.min_role, t.money, t.test_rule
    from (values
      ('refund.approve',              'operator', true,  'test_target'),
      ('refund.retry',                'operator', true,  'test_target'),
      ('refund.record_manual',        'operator', true,  'test_target'),
      ('refund.cancel',               'owner',    true,  'never'),
      ('refund.flw_check',            'operator', false, 'test_target'),
      ('incident.resolve',            'operator', false, 'test_target'),
      ('incident.resolve_money',      'operator', true,  'test_target'),
      ('job.retry',                   'operator', true,  'test_target'),
      ('job.fail',                    'operator', true,  'test_target'),
      ('ssl_job.retry',               'operator', true,  'test_target'),
      ('ssl_job.fail',                'operator', true,  'test_target'),
      ('email.requeue',               'operator', false, 'reserved_target'),
      ('domain.deep_sync',            'operator', false, 'test_target'),
      ('domain.reveal_contacts',      'operator', false, 'reserved_target'),
      ('customer.search',             'operator', false, 'reserved_target'),
      ('customer.reveal',             'operator', false, 'reserved_target'),
      ('fx.activate',                 'owner',    true,  'never'),
      ('fx.reject',                   'owner',    true,  'never'),
      ('pricing.update',              'owner',    true,  'never'),
      ('settings.update',             'owner',    true,  'never'),
      ('settings.refund_limit_raise', 'owner',    true,  'never'),
      ('extension.flags',             'owner',    true,  'never'),
      ('ssl_product.sellable',        'owner',    true,  'never'),
      ('preset.draft_save',           'owner',    true,  'never'),
      ('preset.publish',              'owner',    true,  'never'),
      ('preset.show',                 'owner',    true,  'never'),
      ('preset.draft_check',          'owner',    false, 'never'),
      ('preset.draft_discard',        'owner',    false, 'never'),
      ('preset.hide',                 'operator', false, 'never'),
      ('topup.record',                'owner',    true,  'never'),
      ('topup.correct',               'owner',    true,  'never'),
      ('audit.redact',                'owner',    true,  'never'),
      ('supplier.balance',            'viewer',   false, 'test_target'),
      ('supplier.ledger_live',        'viewer',   false, 'test_target'),
      ('supplier.domain_lookup',      'operator', false, 'test_target'),
      ('supplier.domains_page',       'operator', false, 'test_target'),
      ('supplier.verification',       'operator', false, 'test_target'),
      ('supplier.ssl_lookup',         'operator', false, 'test_target'),
      ('supplier.transfer_query',     'operator', false, 'test_target'),
      ('supplier.renew_check',        'operator', false, 'test_target'),
      ('supplier.price_check',        'operator', false, 'never'),
      ('supplier.catalogue_preview',  'owner',    false, 'never'),
      ('supplier.ssl_catalogue_preview', 'owner', false, 'never'),
      ('supplier.catalogue_apply',    'owner',    true,  'never'),
      ('supplier.ssl_catalogue_apply', 'owner',   true,  'never'),
      -- Migration 51: MyDomainsHub Mail (MAIL-SPEC §7.2, §7.4, §10, MR5).
      ('mail.approve',                'operator', false, 'test_target'),
      ('mail.reject',                 'operator', false, 'test_target'),
      ('mail.pause',                  'operator', false, 'test_target'),
      ('mail.resume',                 'owner',    true,  'never'),
      ('mail.cap_override',           'owner',    true,  'never')
    ) as t (action, min_role, money, test_rule)
   where t.action = p_action
$$;

-- ── 17. Admin writes (§10): one audited wrapper per action ──────────────────
-- Each follows ADMIN-SPEC §3.1.1: identity raises (nothing recorded for a
-- stranger); replay by request key; the target read and locked; the gate
-- from admin_tier (role, code, hold, test rule — a test admin's target must
-- be an e2e account); the business checks; then the change, with an
-- `admin` row in the account's own security log (no admin's name in it).
-- The state_reason customers see is a code, never the admin's words.

-- §7.2: sandbox → active, once a domain is verified and the profile complete.
-- Warm-up starts at day 0 (§7.3).
create function public.admin_mail_approve_account(p_account_id uuid, p_reason text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action  constant text := 'mail.approve';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_account mail.accounts;
  v_e2e     boolean;
  v_side    text;
  v_domains integer;
  v_detail  jsonb;
  v_code    text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_account_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return public.admin_record(v_admin, c_action, null, 'mail_account', p_account_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_e2e := mail.is_e2e_account(v_account.id);
  v_side := case when v_e2e then 'test' else 'live' end;
  select count(*) into v_domains from mail.domains d where d.account_id = v_account.id and d.status = 'verified';
  v_detail := jsonb_build_object('before', jsonb_build_object('state', v_account.state, 'plan', v_account.plan_code),
                                 'checks', jsonb_build_object('verifiedDomains', v_domains,
                                                              'profileComplete', mail.profile_complete(v_account)));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_e2e), public.admin_reason_problem(p_reason));
  if v_code is null and v_account.state <> 'sandbox' then v_code := 'NOT_SANDBOX'; end if;
  if v_code is null and v_domains = 0 then v_code := 'NO_VERIFIED_DOMAIN'; end if;
  if v_code is null and not mail.profile_complete(v_account) then v_code := 'PROFILE_INCOMPLETE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
                               p_request_key, 'refused', v_code, null, v_detail);
  end if;

  update mail.accounts
     set state = 'active', state_reason = null, warmup_day = 0, warmup_checked_on = mail.lagos_day(now()),
         reviewed_by = v_admin.label, reviewed_at = now(), updated_at = now()
   where id = v_account.id;
  insert into mail.account_audit_log (account_id, actor, action, target)
  values (v_account.id, 'admin', 'account.approved', v_account.id::text);
  return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
    p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('state', 'active', 'warmupDay', 0)));
end;
$$;

-- §7.2: a sandbox account not approved is closed. Its open findings close with it.
create function public.admin_mail_reject_account(p_account_id uuid, p_reason text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action  constant text := 'mail.reject';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_account mail.accounts;
  v_e2e     boolean;
  v_side    text;
  v_detail  jsonb;
  v_code    text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_account_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return public.admin_record(v_admin, c_action, null, 'mail_account', p_account_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_e2e := mail.is_e2e_account(v_account.id);
  v_side := case when v_e2e then 'test' else 'live' end;
  v_detail := jsonb_build_object('before', jsonb_build_object('state', v_account.state, 'plan', v_account.plan_code));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_e2e), public.admin_reason_problem(p_reason));
  if v_code is null and v_account.state <> 'sandbox' then v_code := 'NOT_SANDBOX'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
                               p_request_key, 'refused', v_code, null, v_detail);
  end if;

  update mail.accounts
     set state = 'closed', state_reason = 'rejected_at_review', reviewed_by = v_admin.label, reviewed_at = now(),
         updated_at = now()
   where id = v_account.id;
  update mail.safety_findings
     set resolved_at = now(), resolved_by = v_admin.label, resolution = 'closed'
   where account_id = v_account.id and resolved_at is null;
  update mail.tenant_actions set state = 'canceled', claimed_by = null, claimed_at = null
   where account_id = v_account.id and state = 'pending';
  insert into mail.account_audit_log (account_id, actor, action, target)
  values (v_account.id, 'admin', 'account.rejected', v_account.id::text);
  return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
    p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('state', 'closed')));
end;
$$;

-- §7.7, §10: an admin's pause — our gate at once, SES's tenant next (apps/mail
-- applies the request), and a finding a resume must name (MR5).
create function public.admin_mail_pause_account(p_account_id uuid, p_reason text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action  constant text := 'mail.pause';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_account mail.accounts;
  v_e2e     boolean;
  v_side    text;
  v_detail  jsonb;
  v_code    text;
  v_finding bigint;
  v_action  bigint;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_account_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return public.admin_record(v_admin, c_action, null, 'mail_account', p_account_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_e2e := mail.is_e2e_account(v_account.id);
  v_side := case when v_e2e then 'test' else 'live' end;
  v_detail := jsonb_build_object('before', jsonb_build_object('state', v_account.state, 'sesStatus', v_account.ses_status));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_e2e), public.admin_reason_problem(p_reason));
  if v_code is null and v_account.state not in ('sandbox', 'active') then v_code := 'NOT_PAUSABLE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
                               p_request_key, 'refused', v_code, null, v_detail);
  end if;

  v_finding := mail.open_finding(v_account.id, 'admin', 'admin_pause', 'pause',
                                 jsonb_build_object('previousState', v_account.state));
  update mail.accounts
     set pre_pause_state = state, state = 'paused', state_reason = 'paused_by_admin', updated_at = now()
   where id = v_account.id;
  v_action := mail.queue_tenant_action(v_account, 'DISABLED', 'admin_pause', v_finding, v_admin.label);
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (v_account.id, 'admin', 'account.paused', v_account.id::text, jsonb_build_object('reason', 'admin'));
  return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
    p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('state', 'paused', 'findingId', v_finding,
                                                               'tenantActionId', v_action)));
end;
$$;

-- MR5: a pause ends only with the owner, a fresh code, a reason, and the
-- finding read — the resume names one of the account's open pause findings,
-- and closes them all. Never while AWS holds the tenant paused (SES reports
-- it disabled and the pause is not ours). The account goes back to the state
-- the pause interrupted; an active account warms up again from day 0 (§7.3).
-- SES is asked to undo our own pause only; until it says the tenant is
-- enabled again, reserve_send still refuses.
create function public.admin_mail_resume_account(p_account_id uuid, p_finding_id bigint, p_reason text,
                                                 p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action  constant text := 'mail.resume';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_account mail.accounts;
  v_e2e     boolean;
  v_side    text;
  v_detail  jsonb;
  v_code    text;
  v_open    bigint[];
  v_to      text;
  v_action  bigint;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_account_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return public.admin_record(v_admin, c_action, null, 'mail_account', p_account_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_e2e := mail.is_e2e_account(v_account.id);
  v_side := case when v_e2e then 'test' else 'live' end;
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from mail.safety_findings f
   where f.account_id = v_account.id and f.severity = 'pause' and f.resolved_at is null;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('state', v_account.state, 'sesStatus', v_account.ses_status,
                                 'stateReason', v_account.state_reason),
    'findingId', p_finding_id, 'openPauseFindings', to_jsonb(v_open));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_e2e), public.admin_reason_problem(p_reason));
  if v_code is null and v_account.state <> 'paused' then v_code := 'NOT_PAUSED'; end if;
  if v_code is null and v_account.ses_status = 'disabled' and not mail.asked_ses_to_pause(v_account.id) then
    v_code := 'SES_PAUSED';
  end if;
  if v_code is null and (case when cardinality(v_open) = 0 then p_finding_id is not null
                              else not coalesce(p_finding_id = any (v_open), false) end) then
    v_code := 'FINDING_MISMATCH';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
                               p_request_key, 'refused', v_code, null, v_detail);
  end if;

  v_to := coalesce(v_account.pre_pause_state, 'active');
  update mail.accounts
     set state = v_to, pre_pause_state = null, state_reason = null,
         warmup_day = case when v_to = 'active' and daily_cap_override is null then 0 else warmup_day end,
         warmup_checked_on = case when v_to = 'active' then mail.lagos_day(now()) else warmup_checked_on end,
         updated_at = now()
   where id = v_account.id;
  update mail.safety_findings
     set resolved_at = now(), resolved_by = v_admin.label, resolution = 'resumed'
   where id = any (v_open);
  v_action := mail.queue_tenant_action(v_account, 'ENABLED', 'admin_resume', p_finding_id, v_admin.label);
  insert into mail.account_audit_log (account_id, actor, action, target)
  values (v_account.id, 'admin', 'account.resumed', v_account.id::text);
  return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
    p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('state', v_to, 'tenantActionId', v_action)));
end;
$$;

-- §10 "plan override": the account's own daily and monthly caps, in
-- recipients (null keeps the plan's). A daily override ends the warm-up's
-- say (effective_caps) and never exceeds the SES budget Mail may use.
create function public.admin_mail_override_caps(p_account_id uuid, p_daily_cap integer, p_monthly_cap integer,
                                                p_reason text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action   constant text := 'mail.cap_override';
  v_admin    public.admins := public.admin_session('viewer', null, false);
  v_prior    jsonb;
  v_account  mail.accounts;
  v_settings mail.settings;
  v_e2e      boolean;
  v_side     text;
  v_detail   jsonb;
  v_code     text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_account_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null then
    return public.admin_record(v_admin, c_action, null, 'mail_account', p_account_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  select * into v_settings from mail.settings where id;
  v_e2e := mail.is_e2e_account(v_account.id);
  v_side := case when v_e2e then 'test' else 'live' end;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('dailyCap', v_account.daily_cap_override, 'monthlyCap', v_account.monthly_cap_override),
    'asked', jsonb_build_object('dailyCap', p_daily_cap, 'monthlyCap', p_monthly_cap));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_e2e), public.admin_reason_problem(p_reason));
  if v_code is null and v_account.state = 'closed' then v_code := 'ACCOUNT_CLOSED'; end if;
  if v_code is null and (
       (p_daily_cap is not null and p_daily_cap not between 1 and coalesce(v_settings.account_daily_budget, 0))
       or (p_monthly_cap is not null and p_monthly_cap not between 1 and 10000000)
       or (p_daily_cap is not null and p_monthly_cap is not null and p_daily_cap > p_monthly_cap)) then
    v_code := 'OUT_OF_RANGE';
  end if;
  if v_code is null and v_account.daily_cap_override is not distinct from p_daily_cap
     and v_account.monthly_cap_override is not distinct from p_monthly_cap then
    v_code := 'NO_CHANGE';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
                               p_request_key, 'refused', v_code, null, v_detail);
  end if;

  update mail.accounts
     set daily_cap_override = p_daily_cap, monthly_cap_override = p_monthly_cap, updated_at = now()
   where id = v_account.id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (v_account.id, 'admin', 'account.caps_changed', v_account.id::text,
          jsonb_build_object('dailyCap', p_daily_cap, 'monthlyCap', p_monthly_cap));
  return public.admin_record(v_admin, c_action, v_side, 'mail_account', p_account_id::text, v_e2e, p_reason,
    p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('dailyCap', p_daily_cap, 'monthlyCap', p_monthly_cap)));
end;
$$;

-- ── 18. Admin reads (§10, ADMIN-SPEC D4) ────────────────────────────────────
-- Each starts with admin_session (a stranger raises, nothing recorded). A
-- test admin sees e2e accounts only, and never the live SES account. The
-- owner's address is masked (MR4); every other column is the business's own.

-- The overview: how many accounts sit where, and what needs a person.
create function public.admin_mail_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_out   jsonb;
begin
  select jsonb_build_object(
    'testOnly', v_admin.test_only,
    'accounts', jsonb_build_object(
      'sandbox', count(*) filter (where v.state = 'sandbox'),
      'active', count(*) filter (where v.state = 'active'),
      'paused', count(*) filter (where v.state = 'paused'),
      'closed', count(*) filter (where v.state = 'closed'),
      'sesPaused', count(*) filter (where v.ses_status = 'disabled' and v.state <> 'closed')),
    'reviewReady', count(*) filter (
      where v.state = 'sandbox' and mail.profile_complete(v)
        and exists (select 1 from mail.domains d where d.account_id = v.id and d.status = 'verified')))
    into v_out
    from mail.accounts v
   where not v_admin.test_only or mail.is_e2e_account(v.id);
  return v_out || jsonb_build_object(
    'findings', (select jsonb_build_object(
                   'pause', count(*) filter (where f.severity = 'pause'),
                   'warning', count(*) filter (where f.severity = 'warning'))
                   from mail.safety_findings f
                  where f.resolved_at is null
                    and (not v_admin.test_only or mail.is_e2e_account(f.account_id))),
    'pendingTenantActions', (select count(*) from mail.tenant_actions t
                              where t.state in ('pending', 'claimed')
                                and (not v_admin.test_only or mail.is_e2e_account(t.account_id))));
end;
$$;

-- The review queue (§7.2): every sandbox account, the ready ones first.
create function public.admin_mail_review_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
begin
  return coalesce((
    select jsonb_agg(q.row order by q.ready desc, q.created_at, q.id)
      from (
        select a.id, a.created_at,
               mail.profile_complete(a) and d.verified > 0 as ready,
               jsonb_build_object(
                 'id', a.id, 'shortId', a.short_id, 'tenant', a.ses_tenant, 'name', a.name,
                 'website', a.website, 'useCase', a.use_case, 'expectedMonthlyVolume', a.expected_monthly_volume,
                 'planCode', a.plan_code, 'createdAt', a.created_at, 'sesStatus', a.ses_status,
                 'tenantReady', a.tenant_ready_at is not null,
                 'ownerEmail', public.admin_mask_email(o.email),
                 'verifiedDomains', d.verified, 'pendingDomains', d.pending,
                 'profileComplete', mail.profile_complete(a),
                 'ready', mail.profile_complete(a) and d.verified > 0) as row
          from mail.accounts a
          left join lateral (select u.email::text as email from mail.members m join auth.users u on u.id = m.user_id
                              where m.account_id = a.id and m.role = 'owner' limit 1) o on true
          cross join lateral (select count(*) filter (where x.status = 'verified') as verified,
                                     count(*) filter (where x.status = 'pending') as pending
                                from mail.domains x where x.account_id = a.id) d
         where a.state = 'sandbox' and (not v_admin.test_only or mail.is_e2e_account(a.id))
         order by a.created_at
         limit 200) q), '[]'::jsonb);
end;
$$;

-- Accounts (§10): by state, or by tenant name, short id or business name.
create function public.admin_mail_accounts(p_state text default null, p_query text default null,
                                           p_offset integer default 0, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_query text := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_like  text;
  v_today date := mail.lagos_day(now());
  v_month date := date_trunc('month', mail.lagos_day(now())::timestamp)::date;
  v_total integer;
  v_rows  jsonb;
begin
  if (p_state is not null and p_state not in ('sandbox', 'active', 'paused', 'closed'))
     or coalesce(p_offset, -1) < 0 or coalesce(p_limit, 0) not between 1 and 100
     or char_length(coalesce(v_query, '')) > 100 then
    raise exception using errcode = '22023', message = 'admin:bad_filter';
  end if;
  v_like := '%' || replace(replace(replace(coalesce(v_query, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*) into v_total
    from mail.accounts a
   where (not v_admin.test_only or mail.is_e2e_account(a.id))
     and (p_state is null or a.state = p_state)
     and (v_query is null or a.short_id = v_query or a.ses_tenant = v_query or lower(a.name) like v_like);

  select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id), '[]'::jsonb) into v_rows
    from (
      select a.id, a.created_at,
             jsonb_build_object(
               'id', a.id, 'shortId', a.short_id, 'tenant', a.ses_tenant, 'name', a.name,
               'planCode', a.plan_code, 'state', a.state, 'stateReason', a.state_reason,
               'sesStatus', a.ses_status, 'createdAt', a.created_at,
               'caps', jsonb_build_object('daily', c.daily, 'monthly', c.monthly),
               'today', coalesce((select u.queued from mail.usage_daily u where u.account_id = a.id and u.day = v_today), 0),
               'month', coalesce((select sum(u.queued) from mail.usage_daily u
                                   where u.account_id = a.id and u.day >= v_month and u.day <= v_today), 0),
               'openFindings', (select jsonb_build_object(
                                         'pause', count(*) filter (where f.severity = 'pause'),
                                         'warning', count(*) filter (where f.severity = 'warning'))
                                  from mail.safety_findings f where f.account_id = a.id and f.resolved_at is null)) as row
        from mail.accounts a
        cross join lateral mail.effective_caps(a) c
       where (not v_admin.test_only or mail.is_e2e_account(a.id))
         and (p_state is null or a.state = p_state)
         and (v_query is null or a.short_id = v_query or a.ses_tenant = v_query or lower(a.name) like v_like)
       order by a.created_at desc, a.id
      offset p_offset limit p_limit) r;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

-- One account (§10): profile, usage against its caps, 7- and 30-day rates
-- against our levels, findings, SES-side changes, domains and cap notices.
-- Null when there is no such account — or none this admin may see.
create function public.admin_mail_account(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin    public.admins := public.admin_session('viewer', null, false);
  v_account  mail.accounts;
  v_settings mail.settings;
  v_plan     mail.plans;
  v_caps     record;
  v_today    date := mail.lagos_day(now());
  v_month    date := date_trunc('month', mail.lagos_day(now())::timestamp)::date;
  v_w7       record;
  v_w30      record;
  v_owner    text;
begin
  select * into v_account from mail.accounts where id = p_account_id;
  if v_account.id is null or (v_admin.test_only and not mail.is_e2e_account(v_account.id)) then
    return null;
  end if;
  select * into v_settings from mail.settings where id;
  select * into v_plan from mail.plans where code = v_account.plan_code;
  select * into v_caps from mail.effective_caps(v_account);
  select * into v_w7 from mail.window_usage(v_account.id, v_settings.threshold_window_days);
  select * into v_w30 from mail.window_usage(v_account.id, 30);
  select u.email::text into v_owner from mail.members m join auth.users u on u.id = m.user_id
   where m.account_id = v_account.id and m.role = 'owner' limit 1;

  return jsonb_build_object(
    'id', v_account.id, 'shortId', v_account.short_id, 'tenant', v_account.ses_tenant,
    'name', v_account.name, 'website', v_account.website, 'useCase', v_account.use_case,
    'expectedMonthlyVolume', v_account.expected_monthly_volume,
    'planCode', v_account.plan_code, 'planName', v_plan.name,
    'state', v_account.state, 'stateReason', v_account.state_reason, 'prePauseState', v_account.pre_pause_state,
    'sesStatus', v_account.ses_status, 'tenantReadyAt', v_account.tenant_ready_at,
    'isE2e', mail.is_e2e_account(v_account.id), 'createdAt', v_account.created_at,
    'reviewedBy', v_account.reviewed_by, 'reviewedAt', v_account.reviewed_at,
    'ownerEmail', public.admin_mask_email(v_owner),
    'members', (select count(*) from mail.members m where m.account_id = v_account.id),
    'profileComplete', mail.profile_complete(v_account),
    'caps', jsonb_build_object(
      'daily', v_caps.daily, 'monthly', v_caps.monthly,
      'planDaily', v_plan.daily_cap, 'planMonthly', v_plan.monthly_cap,
      'dailyOverride', v_account.daily_cap_override, 'monthlyOverride', v_account.monthly_cap_override,
      'warmupDay', v_account.warmup_day,
      'warmupCap', case when v_account.warmup_day is not null
                        then least(v_settings.warmup_start_cap::bigint * (2::bigint ^ least(v_account.warmup_day, 30)),
                                   2147483647)::bigint end,
      'sandboxDaily', v_settings.sandbox_daily_cap),
    'usage', jsonb_build_object(
      'today', (select jsonb_build_object('queued', coalesce(sum(u.queued), 0), 'sent', coalesce(sum(u.sent), 0),
                                          'delivered', coalesce(sum(u.delivered), 0), 'bounced', coalesce(sum(u.bounced), 0),
                                          'complained', coalesce(sum(u.complained), 0), 'failed', coalesce(sum(u.failed), 0))
                  from mail.usage_daily u where u.account_id = v_account.id and u.day = v_today),
      'month', (select jsonb_build_object('queued', coalesce(sum(u.queued), 0), 'sent', coalesce(sum(u.sent), 0),
                                          'delivered', coalesce(sum(u.delivered), 0), 'bounced', coalesce(sum(u.bounced), 0),
                                          'complained', coalesce(sum(u.complained), 0), 'failed', coalesce(sum(u.failed), 0))
                  from mail.usage_daily u
                 where u.account_id = v_account.id and u.day >= v_month and u.day <= v_today)),
    'window', jsonb_build_object(
      'days', v_settings.threshold_window_days, 'sent', v_w7.sent, 'bounced', v_w7.bounced,
      'complained', v_w7.complained, 'bouncePpm', mail.rate_ppm(v_w7.bounced, v_w7.sent),
      'complaintPpm', mail.rate_ppm(v_w7.complained, v_w7.sent)),
    'window30', jsonb_build_object(
      'days', 30, 'sent', v_w30.sent, 'bounced', v_w30.bounced, 'complained', v_w30.complained,
      'bouncePpm', mail.rate_ppm(v_w30.bounced, v_w30.sent),
      'complaintPpm', mail.rate_ppm(v_w30.complained, v_w30.sent)),
    'thresholds', jsonb_build_object(
      'bounceWarnPpm', v_settings.bounce_warn_ppm, 'complaintWarnPpm', v_settings.complaint_warn_ppm,
      'bouncePausePpm', v_settings.bounce_pause_ppm, 'complaintPausePpm', v_settings.complaint_pause_ppm,
      'minSends', v_settings.threshold_min_sends, 'windowDays', v_settings.threshold_window_days),
    'sesFindings', mail.ses_findings_of(v_account.id),
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'source', f.source, 'kind', f.kind, 'severity', f.severity, 'detail', f.detail,
               'openedAt', f.opened_at, 'resolvedAt', f.resolved_at, 'resolvedBy', f.resolved_by,
               'resolution', f.resolution) order by f.resolved_at is not null, f.opened_at desc)
        from (select * from mail.safety_findings x where x.account_id = v_account.id
               order by x.resolved_at is not null, x.opened_at desc limit 50) f), '[]'::jsonb),
    'tenantActions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'sendingStatus', t.sending_status, 'why', t.why, 'state', t.state,
               'attempts', t.attempts, 'requestedBy', t.requested_by, 'requestedAt', t.requested_at,
               'appliedAt', t.applied_at, 'lastError', t.last_error) order by t.id desc)
        from (select * from mail.tenant_actions x where x.account_id = v_account.id order by x.id desc limit 20) t),
      '[]'::jsonb),
    'domains', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'name', d.name, 'status', d.status, 'verifiedAt', d.verified_at,
               'lastCheckedAt', d.last_checked_at, 'createdAt', d.created_at) order by d.created_at desc)
        from (select * from mail.domains x where x.account_id = v_account.id order by x.created_at desc limit 100) d),
      '[]'::jsonb),
    'capNotices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'scope', n.scope, 'periodStart', n.period_start, 'level', n.level, 'cap', n.cap, 'used', n.used,
               'createdAt', n.created_at) order by n.created_at desc)
        from (select * from mail.cap_notices x where x.account_id = v_account.id order by x.created_at desc limit 10) n),
      '[]'::jsonb));
end;
$$;

-- Domains across accounts (§10).
create function public.admin_mail_domains(p_status text default null, p_query text default null,
                                          p_offset integer default 0, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_query text := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_like  text;
  v_total integer;
  v_rows  jsonb;
begin
  if (p_status is not null and p_status not in ('pending', 'verified', 'failed', 'removed'))
     or coalesce(p_offset, -1) < 0 or coalesce(p_limit, 0) not between 1 and 100
     or char_length(coalesce(v_query, '')) > 253 then
    raise exception using errcode = '22023', message = 'admin:bad_filter';
  end if;
  v_like := '%' || replace(replace(replace(coalesce(v_query, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*) into v_total
    from mail.domains d
   where (not v_admin.test_only or mail.is_e2e_account(d.account_id))
     and (p_status is null or d.status = p_status)
     and (v_query is null or d.name like v_like);

  select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id), '[]'::jsonb) into v_rows
    from (
      select d.id, d.created_at,
             jsonb_build_object(
               'id', d.id, 'name', d.name, 'status', d.status, 'accountId', d.account_id,
               'accountTenant', a.ses_tenant, 'accountName', a.name, 'accountState', a.state,
               'verifiedAt', d.verified_at, 'lastCheckedAt', d.last_checked_at, 'createdAt', d.created_at,
               'failedReason', d.failed_reason) as row
        from mail.domains d join mail.accounts a on a.id = d.account_id
       where (not v_admin.test_only or mail.is_e2e_account(d.account_id))
         and (p_status is null or d.status = p_status)
         and (v_query is null or d.name like v_like)
       order by d.created_at desc, d.id
      offset p_offset limit p_limit) r;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

-- The account-wide SES health (§4.4, §7.8, §11): the 24-hour quota and send
-- rate as the worker last read them, Mail's own budget, CloudWatch's
-- reputation, the worker's heartbeats and the event stream. The whole live
-- account: a test admin is refused.
create function public.admin_mail_ses_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin    public.admins := public.admin_session('viewer', null, false);
  v_settings mail.settings;
  v_quota    public.service_heartbeats;
begin
  if v_admin.test_only then
    raise exception using errcode = '42501', message = 'admin:test_admin';
  end if;
  select * into v_settings from mail.settings where id;
  select * into v_quota from public.service_heartbeats where name = 'mail-worker:quota';
  return jsonb_build_object(
    'quota', case when v_quota.name is null then null else jsonb_build_object(
               'readAt', v_quota.beat_at,
               'max24HourSend', v_quota.detail -> 'max24HourSend',
               'sentLast24Hours', v_quota.detail -> 'sentLast24Hours',
               'maxSendRate', v_quota.detail -> 'maxSendRate',
               'share', v_quota.detail -> 'share',
               'holdFree', v_quota.detail -> 'holdFree') end,
    'quotaAlertPct', v_settings.quota_alert_pct,
    'budget', jsonb_build_object(
      'dailyBudget', v_settings.account_daily_budget,
      'reserved24h', (select coalesce(sum(b.recipients), 0) from mail.send_budget_hourly b
                       where b.hour > date_trunc('hour', now()) - interval '24 hours')),
    'reputation', jsonb_build_object(
      'latest', (select jsonb_build_object('readAt', r.read_at, 'metricAt', r.metric_at,
                                           'bouncePpm', r.bounce_ppm, 'complaintPpm', r.complaint_ppm)
                   from mail.reputation_readings r where r.outcome = 'ok' order by r.read_at desc limit 1),
      'lastReadAt', (select max(r.read_at) from mail.reputation_readings r),
      'lastOutcome', (select r.outcome from mail.reputation_readings r order by r.read_at desc limit 1),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('readAt', r.read_at, 'outcome', r.outcome,
                                                              'bouncePpm', r.bounce_ppm, 'complaintPpm', r.complaint_ppm)
                                           order by r.read_at)
                            from (select * from mail.reputation_readings x
                                   where x.read_at > now() - interval '7 days'
                                   order by x.read_at desc limit 96) r), '[]'::jsonb),
      'bounceWarnPpm', v_settings.bounce_warn_ppm, 'complaintWarnPpm', v_settings.complaint_warn_ppm,
      'bouncePausePpm', v_settings.bounce_pause_ppm, 'complaintPausePpm', v_settings.complaint_pause_ppm),
    'heartbeats', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', h.name, 'beatAt', h.beat_at,
               'silent', h.beat_at < now() - make_interval(mins => 15 + case when h.detail ->> 'everyMinutes' ~ '^\d{1,4}$'
                                                                       then (h.detail ->> 'everyMinutes')::integer else 0 end))
             order by h.name)
        from public.service_heartbeats h where h.name like 'mail-worker:%'), '[]'::jsonb),
    'events', jsonb_build_object(
      'lastReceivedAt', (select max(v.received_at) from mail.email_events v),
      'sentLastHour', (select count(*) from mail.emails e where e.sent_at > now() - interval '1 hour')),
    'pendingTenantActions', (select count(*) from mail.tenant_actions t where t.state in ('pending', 'claimed')));
end;
$$;

-- The audit log, Mail's actions only (§10). A test admin reads test rows only.
create function public.admin_mail_audit(p_action text default null, p_offset integer default 0,
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
  v_rows  jsonb;
begin
  if (p_action is not null and p_action !~ '^mail\.[a-z_]{1,40}$')
     or coalesce(p_offset, -1) < 0 or coalesce(p_limit, 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'admin:bad_filter';
  end if;
  select count(*) into v_total
    from public.admin_audit_log l
   where l.action like 'mail.%' and (p_action is null or l.action = p_action)
     and (not v_admin.test_only or l.test_actor);
  select coalesce(jsonb_agg(r.row order by r.id desc), '[]'::jsonb) into v_rows
    from (
      select l.id,
             jsonb_build_object(
               'id', l.id, 'createdAt', l.created_at, 'adminLabel', l.admin_label, 'adminRole', l.admin_role,
               'testActor', l.test_actor, 'action', l.action, 'side', l.side, 'targetType', l.target_type,
               'targetId', l.target_id, 'outcome', l.outcome, 'errorCode', l.error_code, 'reason', l.reason,
               'redacted', l.redacted_at is not null, 'detail', l.detail) as row
        from public.admin_audit_log l
       where l.action like 'mail.%' and (p_action is null or l.action = p_action)
         and (not v_admin.test_only or l.test_actor)
       order by l.id desc
      offset p_offset limit p_limit) r;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

-- ── 19. Row-level security ──────────────────────────────────────────────────
alter table mail.safety_findings     enable row level security;
alter table mail.tenant_actions      enable row level security;   -- no policies: functions only
alter table mail.reputation_readings enable row level security;   -- no policies: functions only
alter table mail.cap_notices         enable row level security;

create policy safety_findings_member_read on mail.safety_findings for select to authenticated
  using (mail.has_role(account_id));
create policy cap_notices_member_read on mail.cap_notices for select to authenticated
  using (mail.has_role(account_id));

-- ── 20. Grants ──────────────────────────────────────────────────────────────
revoke all on mail.safety_findings, mail.tenant_actions, mail.reputation_readings, mail.cap_notices
  from public, anon, authenticated, service_role;
grant select (id, account_id, source, kind, severity, detail, opened_at, resolved_at, resolution)
  on mail.safety_findings to authenticated;
grant select on mail.cap_notices to authenticated;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.rate_ppm(bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function mail.ppm_text(integer) from public, anon, authenticated, service_role;
revoke all on function mail.window_usage(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function mail.profile_complete(mail.accounts) from public, anon, authenticated, service_role;
revoke all on function mail.open_finding(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.queue_tenant_action(mail.accounts, text, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.asked_ses_to_pause(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.note_cap_use(uuid, text, date, integer, bigint, boolean)
  from public, anon, authenticated, service_role;
revoke all on function mail.reserve_send(uuid, uuid, text, text[]) from public, anon, authenticated, service_role;
revoke all on function mail.evaluate_account(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.run_safety_checks(text, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function mail.claim_tenant_actions(text, integer) from public, anon, authenticated, service_role;
revoke all on function mail.record_tenant_action(bigint, text, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.ses_findings_of(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.advance_warmup() from public, anon, authenticated, service_role;
revoke all on function mail.purge_old_emails() from public, anon, authenticated, service_role;
revoke all on function mail.purge_safety_records() from public, anon, authenticated, service_role;
revoke all on function mail.alert_conditions() from public, anon, authenticated, service_role;
revoke all on function mail.e2e_seed_usage(uuid, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function mail.e2e_evaluate(uuid) from public, anon, authenticated, service_role;

revoke all on function public.admin_mail_approve_account(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_reject_account(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_pause_account(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_resume_account(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_override_caps(uuid, integer, integer, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_overview() from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_review_queue() from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_accounts(text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_account(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_domains(text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_ses_health() from public, anon, authenticated, service_role;
revoke all on function public.admin_mail_audit(text, integer, integer) from public, anon, authenticated, service_role;

-- The worker (secret key): its 15-minute run.
grant execute on function mail.run_safety_checks(text, integer, integer, timestamptz) to service_role;
-- apps/mail (secret key, manager key beside it): the SES-side changes.
grant execute on function mail.claim_tenant_actions(text, integer) to service_role;
grant execute on function mail.record_tenant_action(bigint, text, text, text) to service_role;
-- e2e only (migration 45's rule).
grant execute on function mail.e2e_seed_usage(uuid, integer, integer, integer) to service_role;
grant execute on function mail.e2e_evaluate(uuid) to service_role;
-- The admin area: the session client, through the gate.
grant execute on function public.admin_mail_approve_account(uuid, text, uuid) to authenticated;
grant execute on function public.admin_mail_reject_account(uuid, text, uuid) to authenticated;
grant execute on function public.admin_mail_pause_account(uuid, text, uuid) to authenticated;
grant execute on function public.admin_mail_resume_account(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.admin_mail_override_caps(uuid, integer, integer, text, uuid) to authenticated;
grant execute on function public.admin_mail_overview() to authenticated;
grant execute on function public.admin_mail_review_queue() to authenticated;
grant execute on function public.admin_mail_accounts(text, text, integer, integer) to authenticated;
grant execute on function public.admin_mail_account(uuid) to authenticated;
grant execute on function public.admin_mail_domains(text, text, integer, integer) to authenticated;
grant execute on function public.admin_mail_ses_health() to authenticated;
grant execute on function public.admin_mail_audit(text, integer, integer) to authenticated;
