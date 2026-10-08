-- MyDomainsHub Mail: the notification emails (docs/MAIL-SPEC.md §15, "the Mail
-- notifications package"). Each is queued in the shop's outbox (migration 31)
-- in the same transaction as what it reports, and sent by the gateway through
-- the shop's own SES identity (no-reply@notify.mydomainshub.com) — never
-- through Mail's sending path, so a paused account still hears that it is
-- paused. The gateway renders each kind from @dr/shared/email under
-- "MyDomainsHub Mail" and links to emails.mydomainshub.com.
--
--   mail_invite            the invited address        an owner or admin invites someone
--   mail_cap_reached       owner and admins           80% and 100% of a day's or month's cap (§8)
--   mail_past_due          owner                      a renewal payment has not come in (§8)
--   mail_plan_lapsed       owner                      past due beyond its grace: the Free plan (§8)
--   mail_webhook_disabled  owner and admins           an endpoint turned off for failing (§6)
--   mail_account_paused    owner and admins           our threshold, SES or an admin paused sending (§7.4)
--   mail_sending_warning   owner and admins           a threshold warning, or a high-impact SES finding (§4.2)
--
-- All are transactional: they are about the account itself and cannot be
-- switched off. Addresses come from the members' sign-ins at queue time; e2e
-- accounts' members have reserved addresses, so theirs are queued as skipped
-- (queue_email), which is how a test sees what was queued. Mail has no test
-- mode, so every row is on the live side.
--
-- An invite's email carries the one-time link, as the inviter's copy does
-- (migration 46: it works only for the invited, confirmed address). The token
-- is in the outbox only until the email is sent or given up, then removed.

-- ── 1. To the account's members ─────────────────────────────────────────────

create function mail.notify_members(p_account_id uuid, p_roles text[], p_kind text, p_key text,
                                    p_data jsonb default '{}')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account mail.accounts;
  v_member  record;
  v_count   integer := 0;
begin
  select * into v_account from mail.accounts where id = p_account_id;
  if v_account.id is null or v_account.state = 'closed' then
    return 0;
  end if;
  for v_member in
    select m.user_id from mail.members m
     where m.account_id = p_account_id and m.role = any (p_roles)
     order by m.created_at
  loop
    if public.queue_email(p_kind, 'transactional', v_member.user_id,
                          'mail:' || p_key || ':' || v_member.user_id::text,
                          coalesce(p_data, '{}'::jsonb)
                            || jsonb_build_object('accountId', v_account.id, 'accountName', v_account.name),
                          null, null, false) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ── 2. Caps (§8: "at 80% of a cap, an email and a banner") ──────────────────
-- reserve_send writes one cap_notices row per account, cap, period and level,
-- the first time the account reaches it; the email follows that row.

create function mail.email_cap_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
begin
  select p.name into v_plan from mail.accounts a join mail.plans p on p.code = a.plan_code
   where a.id = new.account_id;
  perform mail.notify_members(new.account_id, array['owner', 'admin'], 'mail_cap_reached',
    'cap:' || new.account_id::text || ':' || new.scope || ':' || new.period_start::text || ':' || new.level::text,
    jsonb_build_object('scope', new.scope, 'level', new.level, 'cap', new.cap, 'used', new.used,
                       'periodStart', new.period_start::text, 'plan', v_plan));
  return null;
end;
$$;

create trigger cap_notices_email after insert on mail.cap_notices
  for each row execute function mail.email_cap_notice();

-- ── 3. What the account's log records (billing, webhooks, pauses) ───────────
-- One hook on the append-only log, so every path that pauses an account or
-- moves a plan is covered: the threshold, SES and an admin all write
-- `account.paused`; the billing sweep writes `billing.past_due` and
-- `billing.lapsed`; the delivery worker writes `webhook.disabled` (system,
-- reason `failing`) — a customer turning one off is not told by email.

create function mail.email_from_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub   mail.subscriptions;
  v_plan  text;
  v_hook  mail.webhooks;
  v_key   text := 'audit:' || new.id::text;
begin
  if new.action = 'billing.past_due' and new.actor = 'system' then
    select * into v_sub from mail.subscriptions s
     where s.account_id = new.account_id and s.status = 'past_due'
     order by s.updated_at desc limit 1;
    select p.name into v_plan from mail.plans p where p.code = coalesce(v_sub.plan_code, new.detail ->> 'plan');
    perform mail.notify_members(new.account_id, array['owner'], 'mail_past_due', v_key,
      jsonb_strip_nulls(jsonb_build_object(
        'plan', v_plan,
        'amountKobo', v_sub.amount_kobo,
        'pastDueUntil', mail.iso_time(v_sub.past_due_until))));
  elsif new.action = 'billing.lapsed' and new.actor = 'system' then
    select p.name into v_plan from mail.plans p where p.code = new.detail ->> 'from';
    perform mail.notify_members(new.account_id, array['owner'], 'mail_plan_lapsed', v_key,
      jsonb_strip_nulls(jsonb_build_object('plan', v_plan)));
  elsif new.action = 'webhook.disabled' and new.actor = 'system' and new.detail ->> 'reason' = 'failing' then
    select * into v_hook from mail.webhooks w where w.id::text = new.target;
    perform mail.notify_members(new.account_id, array['owner', 'admin'], 'mail_webhook_disabled', v_key,
      jsonb_strip_nulls(jsonb_build_object(
        'endpoint', mail.webhook_host(v_hook.url),
        'failingSince', new.detail ->> 'failingSince')));
    update mail.webhooks set owner_notice_due = false, updated_at = now()
     where id = v_hook.id and owner_notice_due;
  elsif new.action = 'account.paused' then
    perform mail.notify_members(new.account_id, array['owner', 'admin'], 'mail_account_paused', v_key,
      jsonb_strip_nulls(jsonb_build_object(
        'reason', coalesce(new.detail ->> 'reason', case when new.actor = 'admin' then 'admin' end),
        'bouncePpm', (new.detail ->> 'bouncePpm')::integer,
        'complaintPpm', (new.detail ->> 'complaintPpm')::integer,
        'windowDays', (new.detail ->> 'windowDays')::integer)));
  end if;
  return null;
end;
$$;

create trigger account_audit_log_email after insert on mail.account_audit_log
  for each row
  when (new.action in ('billing.past_due', 'billing.lapsed', 'webhook.disabled', 'account.paused'))
  execute function mail.email_from_audit();

-- The endpoint's host only: its path and query may hold the customer's own
-- secrets (a token in the URL), and the host is enough to know which one.
create function mail.webhook_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(substring(coalesce(p_url, '') from '^https?://(?:[^@/]*@)?([^/:?#]+)')), '')
$$;

-- ── 4. Warnings before a pause (§7.4, §4.2) ─────────────────────────────────
-- A threshold warning (its rates near the pause line), and an SES finding of
-- high impact (AWS's own words, addresses already struck out). SES's
-- low-impact advice stays on the dashboard. A pause has its own email above.

create function mail.email_safety_warning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.settings;
begin
  select * into v_settings from mail.settings where id;
  perform mail.notify_members(new.account_id, array['owner', 'admin'], 'mail_sending_warning',
    'warning:' || new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'threshold',
      'kind', new.kind,
      'bouncePpm', (new.detail ->> 'bouncePpm')::integer,
      'complaintPpm', (new.detail ->> 'complaintPpm')::integer,
      'windowDays', (new.detail ->> 'windowDays')::integer,
      -- The line at which this rate pauses sending, from the settings the
      -- threshold reads (N5b: no number in the template).
      'pausePpm', case new.kind when 'bounce_warning' then v_settings.bounce_pause_ppm
                                when 'complaint_warning' then v_settings.complaint_pause_ppm end)));
  return null;
end;
$$;

create trigger safety_findings_email after insert on mail.safety_findings
  for each row when (new.severity = 'warning' and new.source = 'threshold')
  execute function mail.email_safety_warning();

create function mail.email_ses_finding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform mail.notify_members(new.account_id, array['owner', 'admin'], 'mail_sending_warning',
    'finding:' || new.id::text,
    jsonb_strip_nulls(jsonb_build_object('source', 'ses', 'kind', new.kind, 'summary', new.summary)));
  return null;
end;
$$;

create trigger findings_email after insert on mail.findings
  for each row when (new.source = 'ses' and new.impact = 'high' and new.kind <> 'sending_paused')
  execute function mail.email_ses_finding();

-- ── 5. Invites (§9, §10) ────────────────────────────────────────────────────
-- Called by apps/mail straight after create_invite, as the inviter, with the
-- token it made: SQL keeps only the hash, so the caller proves it holds the
-- token for this invite. Owners and admins of its account, a live invite, once.

create function mail.email_invite(p_invite_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_invite  mail.invites;
  v_account mail.accounts;
  v_role    text;
  v_from    text;
  v_skip    boolean;
  v_id      uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_invite from mail.invites where id = p_invite_id;
  if v_invite.id is not null then
    v_role := mail.caller_role(v_invite.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{43}$'
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_invite.token_hash then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_account from mail.accounts where id = v_invite.account_id;
  if v_invite.accepted_at is not null or v_invite.revoked_at is not null
     or v_invite.expires_at <= now() or v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- Who invited them, as they would recognise it: their name, else their address.
  select coalesce(nullif(btrim(p.full_name), ''), p.email::text) into v_from
    from public.profiles p where p.id = v_user;
  v_skip := public.is_reserved_email(v_invite.email);
  insert into public.email_outbox (kind, category, to_email, data, dedupe_key, test_mode, status, skip_reason)
  values ('mail_invite', 'transactional', v_invite.email,
          jsonb_strip_nulls(jsonb_build_object(
            'accountId', v_account.id, 'accountName', v_account.name, 'invitedBy', v_from,
            'role', v_invite.role, 'expiresAt', mail.iso_time(v_invite.expires_at),
            'token', case when v_skip then null else p_token end)),
          'mail:invite:' || v_invite.id::text, false,
          case when v_skip then 'skipped' else 'pending' end,
          case when v_skip then 'reserved_address' end)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'already_sent');
  end if;
  return jsonb_build_object('ok', true, 'queued', not v_skip);
end;
$$;

-- The token leaves the outbox once the invite email is sent or given up: a
-- copy of the table then invites nobody, as migration 46 promised.
create function public.email_outbox_forget_invite_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'mail_invite' and new.status in ('sent', 'skipped', 'failed') and new.data ? 'token' then
    new.data := new.data - 'token';
  end if;
  return new;
end;
$$;

create trigger email_outbox_forget_invite_token before insert or update on public.email_outbox
  for each row when (new.kind = 'mail_invite')
  execute function public.email_outbox_forget_invite_token();

-- ── 6. Grants ───────────────────────────────────────────────────────────────

revoke all on function mail.notify_members(uuid, text[], text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.email_cap_notice() from public, anon, authenticated, service_role;
revoke all on function mail.email_from_audit() from public, anon, authenticated, service_role;
revoke all on function mail.webhook_host(text) from public, anon, authenticated, service_role;
revoke all on function mail.email_safety_warning() from public, anon, authenticated, service_role;
revoke all on function mail.email_ses_finding() from public, anon, authenticated, service_role;
revoke all on function public.email_outbox_forget_invite_token() from public, anon, authenticated, service_role;
revoke all on function mail.email_invite(uuid, text) from public, anon, authenticated, service_role;
grant execute on function mail.email_invite(uuid, text) to authenticated;
