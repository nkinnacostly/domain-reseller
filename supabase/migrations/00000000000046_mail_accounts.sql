-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 46: MyDomainsHub Mail — accounts and their members
-- (docs/MAIL-SPEC.md §7.2, §9, §10: the dashboard's Overview and Settings).
--
-- What the dashboard needs that migrations 43–45 do not give it:
--
--   account_usage          — this month's and today's sends against the caps
--                            that apply (mail.effective_caps, which reads
--                            mail.settings — a table no API role may read).
--   account_members        — the members with their sign-in addresses (auth.users
--                            is not readable through the API).
--   update_account_profile — name, website, what it sends, expected volume.
--   create_invite          — an invitation, stored as a hash of its token
--   revoke_invite            (§9: 7-day expiry); the token never reaches the
--   invite_preview           database. Accepting needs the invited address,
--   accept_invite            confirmed, signed in.
--   change_member_role     — owner / admin / developer / viewer, as below.
--   remove_member
--   leave_account
--   transfer_ownership     — to an existing member; the owner becomes an admin.
--   e2e_set_plan           — e2e accounts only (service_role): the Free plan
--                            has one seat, so the invite journey needs another.
--
-- Who may do what with members (the owner is the one person who may manage
-- admins, so an admin can never remove or demote another admin):
--
--   owner     — invite, re-role and remove admins, developers and viewers;
--               transfer ownership. Cannot leave (transfer first).
--   admin     — invite, re-role and remove developers and viewers; edit the
--               profile. May leave.
--   developer, viewer — may leave.
--
-- Seats: members plus pending invites never pass the plan's max_members (§8).
-- Every change is written to account_audit_log (ids, roles and field names —
-- never an address or a token, §9). Every function is revoked from public,
-- anon, authenticated and service_role, then granted to exactly one role;
-- supabase/tests/mail_accounts.sql checks it all.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Helpers (no API role may call them) ──────────────────────────────────

-- The caller's role in an account, or null.
create function mail.caller_role(p_account_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from mail.members m
   where m.account_id = p_account_id and m.user_id = (select auth.uid())
$$;

-- Seats taken: members, plus invites still waiting when p_with_invites.
create function mail.seats_taken(p_account_id uuid, p_with_invites boolean)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from mail.members m where m.account_id = p_account_id)::integer
       + case when p_with_invites then
           (select count(*) from mail.invites i
             where i.account_id = p_account_id and i.accepted_at is null and i.revoked_at is null
               and i.expires_at > now())::integer
         else 0 end
$$;

-- An invitation is for an address the table would accept.
create function mail.is_invite_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_email) <= 254 and p_email = lower(p_email)
                  and p_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$', false)
$$;

-- ── 2. Reads for the dashboard ──────────────────────────────────────────────

-- §8, §10 Overview: caps that apply today (the sandbox's, the warm-up's, the
-- plan's or an admin's override) and what has been counted against them, by
-- the Lagos day — exactly what reserve_send counts (`queued`, in recipients).
create function mail.account_usage(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account mail.accounts;
  v_caps    record;
  v_today   date := mail.lagos_day(now());
  v_month   date := date_trunc('month', mail.lagos_day(now())::timestamp)::date;
  v_day     jsonb;
  v_mon     jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if mail.caller_role(p_account_id) is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_account from mail.accounts where id = p_account_id;
  select * into v_caps from mail.effective_caps(v_account);

  select jsonb_build_object(
           'queued', coalesce(sum(u.queued) filter (where u.day = v_today), 0),
           'sent', coalesce(sum(u.sent) filter (where u.day = v_today), 0),
           'delivered', coalesce(sum(u.delivered) filter (where u.day = v_today), 0),
           'bounced', coalesce(sum(u.bounced) filter (where u.day = v_today), 0),
           'complained', coalesce(sum(u.complained) filter (where u.day = v_today), 0),
           'failed', coalesce(sum(u.failed) filter (where u.day = v_today), 0)),
         jsonb_build_object(
           'queued', coalesce(sum(u.queued), 0),
           'sent', coalesce(sum(u.sent), 0),
           'delivered', coalesce(sum(u.delivered), 0),
           'bounced', coalesce(sum(u.bounced), 0),
           'complained', coalesce(sum(u.complained), 0),
           'failed', coalesce(sum(u.failed), 0))
    into v_day, v_mon
    from mail.usage_daily u
   where u.account_id = p_account_id and u.day >= v_month and u.day <= v_today;

  return jsonb_build_object(
    'ok', true, 'day', v_today, 'monthStart', v_month, 'planCode', v_account.plan_code,
    'caps', jsonb_build_object('daily', v_caps.daily, 'monthly', v_caps.monthly),
    'today', v_day, 'month', v_mon);
end;
$$;

-- §10 Settings: the account's members and the address each signs in with.
-- Members see each other; nobody else sees anyone.
create function mail.account_members(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if mail.caller_role(p_account_id) is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', m.user_id,
             'email', u.email,
             'name', left(nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                                u.raw_user_meta_data ->> 'name', '')), ''), 100),
             'role', m.role,
             'joinedAt', m.created_at)
           order by case m.role when 'owner' then 0 when 'admin' then 1 when 'developer' then 2 else 3 end,
                    m.created_at, m.user_id)
      from mail.members m
      left join auth.users u on u.id = m.user_id
     where m.account_id = p_account_id), '[]'::jsonb));
end;
$$;

-- ── 3. The account's profile (§7.1, §7.2: a complete profile is one of the
-- three things that let an account leave the sandbox) ───────────────────────
create function mail.update_account_profile(p_account_id uuid, p_name text,
                                            p_website text default null,
                                            p_use_case text default null,
                                            p_expected_monthly_volume integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_role    text;
  v_account mail.accounts;
  v_website text := nullif(btrim(p_website), '');
  v_use     text := nullif(btrim(p_use_case), '');
  v_fields  text[] := '{}';
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
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;
  if v_website is not null and char_length(v_website) > 200 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'website');
  end if;
  if v_use is not null and char_length(v_use) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'use_case');
  end if;
  if p_expected_monthly_volume is not null and p_expected_monthly_volume < 0 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'expected_monthly_volume');
  end if;

  if v_account.name is distinct from btrim(p_name) then v_fields := array_append(v_fields, 'name'); end if;
  if v_account.website is distinct from v_website then v_fields := array_append(v_fields, 'website'); end if;
  if v_account.use_case is distinct from v_use then v_fields := array_append(v_fields, 'use_case'); end if;
  if v_account.expected_monthly_volume is distinct from p_expected_monthly_volume then
    v_fields := array_append(v_fields, 'expected_monthly_volume');
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', true, 'changed', '[]'::jsonb);
  end if;

  update mail.accounts
     set name = btrim(p_name), website = v_website, use_case = v_use,
         expected_monthly_volume = p_expected_monthly_volume, updated_at = now()
   where id = p_account_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'account.updated', p_account_id::text,
          jsonb_build_object('fields', to_jsonb(v_fields)));
  return jsonb_build_object('ok', true, 'changed', to_jsonb(v_fields));
end;
$$;

-- ── 4. Invitations (§9: a hash of the token, seven days) ────────────────────
-- The app makes the token, shows the link once and sends only the token's
-- SHA-256 here. The address is lower-cased by the app; the audit row keeps
-- the role, never the address.
create function mail.create_invite(p_account_id uuid, p_email text, p_role text, p_token_hash text)
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

create function mail.revoke_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_invite mail.invites;
  v_role   text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_invite from mail.invites where id = p_invite_id for update;
  if v_invite.id is not null then
    v_role := mail.caller_role(v_invite.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') or (v_role = 'admin' and v_invite.role = 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'accepted');
  end if;
  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', true, 'inviteId', v_invite.id, 'already', true);
  end if;
  update mail.invites set revoked_at = now() where id = v_invite.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_invite.account_id, 'user', v_user, 'invite.revoked', v_invite.id::text,
          jsonb_build_object('role', v_invite.role));
  return jsonb_build_object('ok', true, 'inviteId', v_invite.id);
end;
$$;

-- What an invitation is for, shown to the person it was sent to — signed in
-- with that address, confirmed — before they accept. Anyone else learns only
-- that it is not theirs.
create function mail.invite_preview(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user      uuid := auth.uid();
  v_invite    mail.invites;
  v_account   mail.accounts;
  v_email     text;
  v_confirmed timestamptz;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_invite from mail.invites where token_hash = p_token_hash;
  if v_invite.id is not null then
    select * into v_account from mail.accounts where id = v_invite.account_id;
  end if;
  if v_invite.id is null or v_invite.revoked_at is not null or v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_user;
  if v_email is distinct from v_invite.email or v_confirmed is null then
    return jsonb_build_object('ok', false, 'code', 'wrong_email');
  end if;
  if exists (select 1 from mail.members m where m.account_id = v_invite.account_id and m.user_id = v_user) then
    return jsonb_build_object('ok', false, 'code', 'already_member', 'accountId', v_invite.account_id);
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'accepted');
  end if;
  if v_invite.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  return jsonb_build_object('ok', true, 'accountId', v_account.id, 'accountName', v_account.name,
                            'role', v_invite.role, 'expiresAt', v_invite.expires_at);
end;
$$;

create function mail.accept_invite(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := auth.uid();
  v_invite    mail.invites;
  v_account   mail.accounts;
  v_email     text;
  v_confirmed timestamptz;
  v_max       integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_invite from mail.invites where token_hash = p_token_hash for update;
  if v_invite.id is not null then
    select * into v_account from mail.accounts where id = v_invite.account_id for update;
  end if;
  if v_invite.id is null or v_invite.revoked_at is not null or v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_user;
  if v_email is distinct from v_invite.email or v_confirmed is null then
    return jsonb_build_object('ok', false, 'code', 'wrong_email');
  end if;
  if exists (select 1 from mail.members m where m.account_id = v_invite.account_id and m.user_id = v_user) then
    return jsonb_build_object('ok', false, 'code', 'already_member', 'accountId', v_invite.account_id);
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'code', 'accepted');
  end if;
  if v_invite.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  -- The invite held a seat; a plan that shrank since may have none left.
  select p.max_members into v_max from mail.plans p where p.code = v_account.plan_code;
  if mail.seats_taken(v_account.id, false) >= coalesce(v_max, 0) then
    return jsonb_build_object('ok', false, 'code', 'member_limit', 'max', coalesce(v_max, 0));
  end if;

  insert into mail.members (account_id, user_id, role, invited_by)
  values (v_account.id, v_user, v_invite.role, v_invite.invited_by);
  update mail.invites set accepted_at = now() where id = v_invite.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_account.id, 'user', v_user, 'invite.accepted', v_invite.id::text,
          jsonb_build_object('role', v_invite.role)),
         (v_account.id, 'user', v_user, 'member.added', v_user::text,
          jsonb_build_object('role', v_invite.role, 'invite', v_invite.id));
  return jsonb_build_object('ok', true, 'accountId', v_account.id, 'role', v_invite.role);
end;
$$;

-- ── 5. Members ──────────────────────────────────────────────────────────────

create function mail.change_member_role(p_account_id uuid, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_role    text;
  v_target  text;
  v_state   text;
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
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  select m.role into v_target from mail.members m where m.account_id = p_account_id and m.user_id = p_user_id;
  if v_target is null then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;
  -- The owner's role changes only by a transfer.
  if v_target = 'owner' then
    return jsonb_build_object('ok', false, 'code', 'owner_role');
  end if;
  if v_role = 'admin' and (v_target not in ('developer', 'viewer') or p_role not in ('developer', 'viewer')) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_target = p_role then
    return jsonb_build_object('ok', true, 'role', p_role, 'already', true);
  end if;
  update mail.members set role = p_role where account_id = p_account_id and user_id = p_user_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'member.role_changed', p_user_id::text,
          jsonb_build_object('from', v_target, 'to', p_role));
  return jsonb_build_object('ok', true, 'role', p_role);
end;
$$;

create function mail.remove_member(p_account_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_role   text;
  v_target text;
  v_state  text;
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
  if p_user_id = v_user then
    return jsonb_build_object('ok', false, 'code', 'use_leave');
  end if;
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  select m.role into v_target from mail.members m where m.account_id = p_account_id and m.user_id = p_user_id;
  if v_target is null then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;
  if v_target = 'owner' then
    return jsonb_build_object('ok', false, 'code', 'owner_role');
  end if;
  if v_role = 'admin' and v_target not in ('developer', 'viewer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  delete from mail.members where account_id = p_account_id and user_id = p_user_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'member.removed', p_user_id::text, jsonb_build_object('role', v_target));
  return jsonb_build_object('ok', true);
end;
$$;

-- Anyone but the owner may leave; the owner transfers the account first.
create function mail.leave_account(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  perform 1 from mail.accounts a where a.id = p_account_id for update;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role = 'owner' then
    return jsonb_build_object('ok', false, 'code', 'owner_must_transfer');
  end if;
  delete from mail.members where account_id = p_account_id and user_id = v_user;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'member.left', v_user::text, jsonb_build_object('role', v_role));
  return jsonb_build_object('ok', true);
end;
$$;

-- To another member, who must not already own as many open accounts as a
-- person may (create_account's rule). The old owner stays, as an admin.
-- With two-factor on, the owner must have entered a code this session.
create function mail.transfer_ownership(p_account_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_role     text;
  v_target   text;
  v_state    text;
  v_settings mail.settings;
  v_owned    integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role <> 'owner' then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_user and f.status = 'verified')
     and coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    return jsonb_build_object('ok', false, 'code', 'needs_aal2');
  end if;
  if p_user_id is null or p_user_id = v_user then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'user');
  end if;
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  select m.role into v_target from mail.members m where m.account_id = p_account_id and m.user_id = p_user_id;
  if v_target is null then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;

  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  -- create_account's lock for the new owner, so a sign-up cannot pass the count meanwhile.
  perform pg_advisory_xact_lock(hashtextextended('mail.create_account:' || p_user_id::text, 0));
  select count(*) into v_owned
    from mail.members m join mail.accounts a on a.id = m.account_id
   where m.user_id = p_user_id and m.role = 'owner' and a.state <> 'closed';
  if v_owned >= v_settings.owned_accounts_max then
    return jsonb_build_object('ok', false, 'code', 'limit', 'max', v_settings.owned_accounts_max);
  end if;

  -- In this order: one owner per account (members_one_owner).
  update mail.members set role = 'admin' where account_id = p_account_id and user_id = v_user;
  update mail.members set role = 'owner' where account_id = p_account_id and user_id = p_user_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'account.ownership_transferred', p_user_id::text,
          jsonb_build_object('from', v_user, 'previousRole', v_target));
  return jsonb_build_object('ok', true);
end;
$$;

-- ── 6. e2e: a test account on another plan (migration 45's rule) ────────────
create function mail.e2e_set_plan(p_account_id uuid, p_plan_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not mail.is_e2e_account(p_account_id) then
    return jsonb_build_object('ok', false, 'code', 'not_e2e');
  end if;
  if not exists (select 1 from mail.plans p where p.code = p_plan_code) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'plan');
  end if;
  update mail.accounts set plan_code = p_plan_code, is_e2e = true, updated_at = now()
   where id = p_account_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── 7. Grants ───────────────────────────────────────────────────────────────
-- No table changes: every new write is one of these functions.
revoke all on function mail.caller_role(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.seats_taken(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function mail.is_invite_email(text) from public, anon, authenticated, service_role;
revoke all on function mail.account_usage(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.account_members(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.update_account_profile(uuid, text, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.create_invite(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.revoke_invite(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.invite_preview(text) from public, anon, authenticated, service_role;
revoke all on function mail.accept_invite(text) from public, anon, authenticated, service_role;
revoke all on function mail.change_member_role(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.remove_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.leave_account(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.transfer_ownership(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.e2e_set_plan(uuid, text) from public, anon, authenticated, service_role;

grant execute on function mail.account_usage(uuid) to authenticated;
grant execute on function mail.account_members(uuid) to authenticated;
grant execute on function mail.update_account_profile(uuid, text, text, text, integer) to authenticated;
grant execute on function mail.create_invite(uuid, text, text, text) to authenticated;
grant execute on function mail.revoke_invite(uuid) to authenticated;
grant execute on function mail.invite_preview(text) to authenticated;
grant execute on function mail.accept_invite(text) to authenticated;
grant execute on function mail.change_member_role(uuid, uuid, text) to authenticated;
grant execute on function mail.remove_member(uuid, uuid) to authenticated;
grant execute on function mail.leave_account(uuid) to authenticated;
grant execute on function mail.transfer_ownership(uuid, uuid) to authenticated;
grant execute on function mail.e2e_set_plan(uuid, text) to service_role;
