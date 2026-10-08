-- MyDomainsHub Mail: invite emails cannot be a relay (security audit,
-- 8 Oct 2026: high). Migration 58 sent an email for every invite, from the
-- shop's own identity, outside Mail's caps and pauses, with the inviter's
-- free-text name in it; create_invite then revoke_invite freed the seat at
-- once, so an account could email anyone, without end.
--
--   * An account makes at most invite_daily_cap invites a day and
--     invite_monthly_cap a month, counting revoked and expired ones.
--   * email_invite names the inviter by their confirmed address, not
--     profiles.full_name, and sends nothing for a paused account.
--   * The subject no longer carries the account's name (@dr/shared/email,
--     mail_invite@2).

alter table mail.settings
  add column invite_daily_cap   integer not null default 10 check (invite_daily_cap between 1 and 1000),
  add column invite_monthly_cap integer not null default 50 check (invite_monthly_cap between 1 and 10000);

create or replace function mail.create_invite(p_account_id uuid, p_email text, p_role text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_role    text;
  v_account mail.accounts;
  v_max     integer;
  v_id      uuid;
  v_expires timestamptz;
  v_settings mail.settings;
  v_day     integer;
  v_month   integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if p_role is null or p_role not in ('admin', 'developer', 'viewer') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'role');
  end if;
  if v_role = 'admin' and p_role = 'admin' then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if not mail.is_invite_email(p_email) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'email');
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'token');
  end if;

  -- One account at a time from here, so two invites cannot share a seat.
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if exists (select 1 from mail.members m join auth.users u on u.id = m.user_id
              where m.account_id = p_account_id and lower(u.email) = p_email) then
    return jsonb_build_object('ok', false, 'code', 'already_member');
  end if;
  if exists (select 1 from mail.invites i
              where i.account_id = p_account_id and i.email = p_email and i.accepted_at is null
                and i.revoked_at is null and i.expires_at > now()) then
    return jsonb_build_object('ok', false, 'code', 'already_invited');
  end if;
  -- Security audit, 8 Oct 2026: every invite is an email from our own
  -- identity, so an account makes at most so many a day and a month —
  -- revoked and expired ones included, so revoking cannot reset the count.
  select * into v_settings from mail.settings where id;
  select count(*) filter (where i.created_at > now() - interval '24 hours'), count(*)
    into v_day, v_month
    from mail.invites i
   where i.account_id = p_account_id and i.created_at > now() - interval '30 days';
  if v_day >= v_settings.invite_daily_cap or v_month >= v_settings.invite_monthly_cap then
    return jsonb_build_object('ok', false, 'code', 'too_many_invites',
                              'max', case when v_day >= v_settings.invite_daily_cap
                                          then v_settings.invite_daily_cap else v_settings.invite_monthly_cap end,
                              'per', case when v_day >= v_settings.invite_daily_cap then 'day' else 'month' end);
  end if;
  select p.max_members into v_max from mail.plans p where p.code = v_account.plan_code;
  if mail.seats_taken(p_account_id, true) >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'member_limit', 'max', coalesce(v_max, 0));
  end if;

  insert into mail.invites (account_id, email, role, token_hash, invited_by)
  values (p_account_id, p_email, p_role, p_token_hash, v_user)
  returning id, expires_at into v_id, v_expires;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'invite.created', v_id::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', true, 'inviteId', v_id, 'expiresAt', v_expires);
end;
$$;

create or replace function mail.email_invite(p_invite_id uuid, p_token text)
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
  -- A paused account sends nothing from our identity either: the inviter
  -- can still copy the link.
  if v_account.state = 'paused' then
    return jsonb_build_object('ok', false, 'code', 'account_paused');
  end if;

  -- Who invited them: their confirmed sign-in address, never free text a
  -- user can write (profiles.full_name), so an invite cannot carry a
  -- message of the inviter's choosing (security audit, 8 Oct 2026).
  select lower(u.email) into v_from from auth.users u where u.id = v_user;
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
