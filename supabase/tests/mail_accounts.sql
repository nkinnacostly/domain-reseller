-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 46 (MyDomainsHub Mail, accounts and members), tried as the
-- database owner and as `anon`, `authenticated` and `service_role`. People
-- are made up inside the transaction with e2e-*@example.com addresses. Each
-- check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_accounts.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Claims for a signed-in person (or none: anon), at an assurance level.
create function pg_temp.ma_as(p_uid uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
    execute 'set local role authenticated';
  end if;
end $f$;

-- A function's answer must carry exactly this code (a NULL never passes).
create function pg_temp.ma_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.ma_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

do $$
declare
  v_tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner    uuid := gen_random_uuid();
  u_admin    uuid := gen_random_uuid();
  u_dev      uuid := gen_random_uuid();
  u_view     uuid := gen_random_uuid();
  u_none     uuid := gen_random_uuid();
  u_new      uuid := gen_random_uuid();
  u_new2     uuid := gen_random_uuid();
  u_unconf   uuid := gen_random_uuid();
  e_new      text;
  e_new2     text;
  e_unconf   text;
  v_acct     uuid;
  v_other    uuid;
  v_j        jsonb;
  v_inv      uuid;
  v_inv2     uuid;
  h_new      text := encode(extensions.digest('token-new-' || gen_random_uuid()::text, 'sha256'), 'hex');
  h_new2     text := encode(extensions.digest('token-new2-' || gen_random_uuid()::text, 'sha256'), 'hex');
  h_admin    text := encode(extensions.digest('token-admin-' || gen_random_uuid()::text, 'sha256'), 'hex');
  h_unconf   text := encode(extensions.digest('token-unconf-' || gen_random_uuid()::text, 'sha256'), 'hex');
  v_n        integer;
  v_day      date := mail.lagos_day(now());
  v_row      record;
  v_want     text;
  v_expected jsonb;
  v_passed   integer := 0;
begin
  e_new := 'e2e-m46-n-' || v_tag || '@example.com';
  e_new2 := 'e2e-m46-m-' || v_tag || '@example.com';
  e_unconf := 'e2e-m46-u-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (u_owner, 'authenticated', 'authenticated', 'e2e-m46-o-' || v_tag || '@example.com', now(),
     '{"full_name": "Ada Owner"}', now(), now()),
    (u_admin, 'authenticated', 'authenticated', 'e2e-m46-a-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_dev,   'authenticated', 'authenticated', 'e2e-m46-d-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_view,  'authenticated', 'authenticated', 'e2e-m46-v-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_none,  'authenticated', 'authenticated', 'e2e-m46-s-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_new,   'authenticated', 'authenticated', e_new, now(), '{"name": "Nkem New"}', now(), now()),
    (u_new2,  'authenticated', 'authenticated', e_new2, now(), '{}', now(), now()),
    (u_unconf, 'authenticated', 'authenticated', e_unconf, null, '{}', now(), now());

  perform pg_temp.ma_as(u_owner);
  v_acct := (mail.create_account('m46 ' || v_tag, 'https://m46.example', 'Receipts', 500) ->> 'accountId')::uuid;
  execute 'reset role';
  -- Pro has ten seats: room for the roles below and the invites.
  update mail.accounts set plan_code = 'pro' where id = v_acct;
  insert into mail.members (account_id, user_id, role) values
    (v_acct, u_admin, 'admin'), (v_acct, u_dev, 'developer'), (v_acct, u_view, 'viewer');

  -- ── 1. Signed out, nobody reaches any of it.
  perform pg_temp.ma_as(null);
  begin
    perform mail.account_usage(v_acct);
    raise exception 'FAILED 1: anon could call account_usage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.accept_invite(h_new);
    raise exception 'FAILED 1: anon could call accept_invite';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 2. account_usage: the sandbox's cap, the plan's month, the Lagos day's counts.
  insert into mail.usage_daily (account_id, day, queued, sent, delivered, bounced) values
    (v_acct, mail.lagos_day(now()), 7, 6, 5, 1);
  v_n := 7;
  -- Yesterday counts towards the month unless today is the 1st (Lagos).
  if mail.lagos_day(now()) > date_trunc('month', mail.lagos_day(now())::timestamp)::date then
    insert into mail.usage_daily (account_id, day, queued, sent) values
      (v_acct, mail.lagos_day(now()) - 1, 10, 10);
    v_n := 17;
  end if;
  perform pg_temp.ma_as(u_view);
  v_j := mail.account_usage(v_acct);
  perform pg_temp.ma_ok(v_j, 'FAILED 2: a viewer reads usage');
  if (v_j -> 'caps' ->> 'daily')::integer <> 100 or (v_j -> 'caps' ->> 'monthly')::integer <> 150000
     or (v_j -> 'today' ->> 'queued')::integer <> 7 or (v_j -> 'today' ->> 'delivered')::integer <> 5
     or (v_j -> 'month' ->> 'queued')::integer <> v_n
     or v_j ->> 'planCode' <> 'pro' or (v_j ->> 'day')::date <> v_day then
    raise exception 'FAILED 2: usage is not the sandbox''s cap and the counts (%)', v_j;
  end if;
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.account_usage(v_acct), 'not_found', 'FAILED 2: a stranger reads usage');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 3. account_members: members see each other, owner first; strangers nobody.
  perform pg_temp.ma_as(u_dev);
  v_j := mail.account_members(v_acct);
  perform pg_temp.ma_ok(v_j, 'FAILED 3: a developer lists members');
  if jsonb_array_length(v_j -> 'members') <> 4
     or v_j -> 'members' -> 0 ->> 'role' <> 'owner'
     or v_j -> 'members' -> 0 ->> 'name' <> 'Ada Owner'
     or v_j -> 'members' -> 0 ->> 'email' <> 'e2e-m46-o-' || v_tag || '@example.com'
     or v_j -> 'members' -> 1 ->> 'role' <> 'admin' then
    raise exception 'FAILED 3: the member list is wrong (%)', v_j;
  end if;
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.account_members(v_acct), 'not_found', 'FAILED 3: a stranger lists members');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 4. The profile: owners and admins edit it; an unchanged save writes no log row.
  perform pg_temp.ma_as(u_dev);
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, 'X'), 'forbidden', 'FAILED 4: a developer edited');
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, 'X'), 'not_found', 'FAILED 4: a stranger edited');
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, '  '), 'validation', 'FAILED 4: a blank name');
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, 'X', repeat('w', 201)), 'validation',
                          'FAILED 4: a long website');
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, 'X', null, null, -1), 'validation',
                          'FAILED 4: a negative volume');
  v_j := mail.update_account_profile(v_acct, ' Acme ' || v_tag || ' ', 'https://acme.example', 'Receipts', 500);
  perform pg_temp.ma_ok(v_j, 'FAILED 4: an admin''s edit');
  if v_j -> 'changed' <> '["name", "website"]'::jsonb then
    raise exception 'FAILED 4: changed fields %', v_j;
  end if;
  v_j := mail.update_account_profile(v_acct, 'Acme ' || v_tag, 'https://acme.example', 'Receipts', 500);
  if v_j -> 'changed' <> '[]'::jsonb then raise exception 'FAILED 4: a no-op changed %', v_j; end if;
  execute 'reset role';
  if (select name from mail.accounts where id = v_acct) <> 'Acme ' || v_tag
     or (select count(*) from mail.account_audit_log
          where account_id = v_acct and action = 'account.updated'
            and actor_user_id = u_admin and detail = '{"fields": ["name", "website"]}') <> 1
     or (select count(*) from mail.account_audit_log where account_id = v_acct and action = 'account.updated') <> 1 then
    raise exception 'FAILED 4: the edit is not saved and logged once';
  end if;
  v_passed := v_passed + 1;

  -- ── 5. Invites: owners and admins; admins never an admin; addresses and hashes checked.
  perform pg_temp.ma_as(u_view);
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', h_new), 'forbidden', 'FAILED 5: a viewer invited');
  perform pg_temp.ma_as(u_dev);
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', h_new), 'forbidden', 'FAILED 5: a developer invited');
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', h_new), 'not_found', 'FAILED 5: a stranger invited');
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'admin', h_new), 'forbidden', 'FAILED 5: an admin invited an admin');
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'owner', h_new), 'validation', 'FAILED 5: an owner invite');
  perform pg_temp.ma_code(mail.create_invite(v_acct, upper(e_new), 'viewer', h_new), 'validation',
                          'FAILED 5: an address not lower-cased');
  perform pg_temp.ma_code(mail.create_invite(v_acct, 'not-an-address', 'viewer', h_new), 'validation',
                          'FAILED 5: not an address');
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', 'the-raw-token'), 'validation',
                          'FAILED 5: a token instead of its hash');
  perform pg_temp.ma_code(mail.create_invite(v_acct, 'e2e-m46-d-' || v_tag || '@example.com', 'viewer', h_new),
                          'already_member', 'FAILED 5: a member invited');
  v_j := mail.create_invite(v_acct, e_new, 'developer', h_new);
  perform pg_temp.ma_ok(v_j, 'FAILED 5: an admin invites a developer');
  v_inv := (v_j ->> 'inviteId')::uuid;
  if (v_j ->> 'expiresAt')::timestamptz not between now() + interval '7 days' - interval '1 minute'
                                                and now() + interval '7 days' + interval '1 minute' then
    raise exception 'FAILED 5: an invite lasts seven days (%)', v_j;
  end if;
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', h_new2), 'already_invited',
                          'FAILED 5: a second invite to one address');
  perform pg_temp.ma_as(u_owner);
  v_inv2 := (mail.create_invite(v_acct, e_new2, 'admin', h_admin) ->> 'inviteId')::uuid;
  if v_inv2 is null then raise exception 'FAILED 5: the owner invites an admin'; end if;
  execute 'reset role';
  if not exists (select 1 from mail.account_audit_log l where l.account_id = v_acct and l.action = 'invite.created'
                   and l.target = v_inv::text and l.detail = '{"role": "developer"}' and l.actor_user_id = u_admin)
     or exists (select 1 from mail.account_audit_log l where l.account_id = v_acct
                  and (l.detail::text like '%' || e_new || '%' or l.detail::text like '%' || h_new || '%')) then
    raise exception 'FAILED 5: the invite is not logged by role alone';
  end if;
  v_passed := v_passed + 1;

  -- ── 6. Seats: members and waiting invites never pass the plan's max_members.
  update mail.accounts set plan_code = 'starter' where id = v_acct;   -- 3 seats; 4 members already
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_unconf, 'viewer', h_unconf), 'member_limit',
                          'FAILED 6: an invite past the plan''s seats');
  if (mail.create_invite(v_acct, e_unconf, 'viewer', h_unconf) ->> 'max')::integer <> 3 then
    raise exception 'FAILED 6: the refusal does not name the seats';
  end if;
  execute 'reset role';
  update mail.accounts set plan_code = 'pro' where id = v_acct;
  v_passed := v_passed + 1;

  -- ── 7. Revoking: admins never an admin's invite; the owner may; twice is harmless.
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.revoke_invite(v_inv2), 'forbidden', 'FAILED 7: an admin revoked an admin invite');
  perform pg_temp.ma_as(u_view);
  perform pg_temp.ma_code(mail.revoke_invite(v_inv2), 'forbidden', 'FAILED 7: a viewer revoked');
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.revoke_invite(v_inv2), 'not_found', 'FAILED 7: a stranger revoked');
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_ok(mail.revoke_invite(v_inv2), 'FAILED 7: the owner revokes');
  if (mail.revoke_invite(v_inv2) ->> 'already')::boolean is not true then
    raise exception 'FAILED 7: a second revoke';
  end if;
  execute 'reset role';
  if (select count(*) from mail.account_audit_log where target = v_inv2::text and action = 'invite.revoked') <> 1 then
    raise exception 'FAILED 7: the revoke is not logged once';
  end if;
  v_passed := v_passed + 1;

  -- ── 8. Preview and accept: only the invited address, confirmed; once.
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.invite_preview(h_new), 'wrong_email', 'FAILED 8: a stranger previewed');
  perform pg_temp.ma_code(mail.accept_invite(h_new), 'wrong_email', 'FAILED 8: a stranger accepted');
  perform pg_temp.ma_code(mail.accept_invite(repeat('0', 64)), 'not_found', 'FAILED 8: an unknown token');
  perform pg_temp.ma_code(mail.accept_invite('not-a-hash'), 'not_found', 'FAILED 8: not a hash');
  perform pg_temp.ma_as(u_new2);
  perform pg_temp.ma_code(mail.accept_invite(h_admin), 'not_found', 'FAILED 8: a revoked invite accepted');
  perform pg_temp.ma_as(u_new);
  v_j := mail.invite_preview(h_new);
  perform pg_temp.ma_ok(v_j, 'FAILED 8: the invitee previews');
  if v_j ->> 'accountName' <> 'Acme ' || v_tag or v_j ->> 'role' <> 'developer' then
    raise exception 'FAILED 8: the preview says %', v_j;
  end if;
  v_j := mail.accept_invite(h_new);
  perform pg_temp.ma_ok(v_j, 'FAILED 8: the invitee accepts');
  perform pg_temp.ma_code(mail.accept_invite(h_new), 'already_member', 'FAILED 8: accepted twice');
  perform pg_temp.ma_code(mail.invite_preview(h_new), 'already_member', 'FAILED 8: preview after accepting');
  execute 'reset role';
  if not exists (select 1 from mail.members where account_id = v_acct and user_id = u_new and role = 'developer')
     or (select accepted_at from mail.invites where id = v_inv) is null
     or (select count(*) from mail.account_audit_log where account_id = v_acct and actor_user_id = u_new
           and action in ('invite.accepted', 'member.added')) <> 2 then
    raise exception 'FAILED 8: the invitee is not a developer, logged';
  end if;
  -- An unconfirmed address cannot accept, even its own invite.
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_ok(mail.create_invite(v_acct, e_unconf, 'viewer', h_unconf), 'FAILED 8: invite unconfirmed');
  perform pg_temp.ma_as(u_unconf);
  perform pg_temp.ma_code(mail.accept_invite(h_unconf), 'wrong_email', 'FAILED 8: an unconfirmed address accepted');
  execute 'reset role';
  -- Expired: refused, and the seat is free again.
  update mail.invites set expires_at = now() - interval '1 second' where token_hash = h_unconf;
  update auth.users set email_confirmed_at = now() where id = u_unconf;
  perform pg_temp.ma_as(u_unconf);
  perform pg_temp.ma_code(mail.accept_invite(h_unconf), 'expired', 'FAILED 8: an expired invite accepted');
  perform pg_temp.ma_code(mail.invite_preview(h_unconf), 'expired', 'FAILED 8: an expired preview');
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 9. A plan that shrank after the invite: the seat is checked again at accept.
  update mail.invites set expires_at = now() + interval '1 day' where token_hash = h_unconf;
  update mail.accounts set plan_code = 'starter' where id = v_acct;
  perform pg_temp.ma_as(u_unconf);
  perform pg_temp.ma_code(mail.accept_invite(h_unconf), 'member_limit', 'FAILED 9: accepted past the seats');
  execute 'reset role';
  update mail.accounts set plan_code = 'pro' where id = v_acct;
  v_passed := v_passed + 1;

  -- ── 10. Roles: the owner manages admins; admins only developers and viewers.
  perform pg_temp.ma_as(u_view);
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_dev, 'viewer'), 'forbidden', 'FAILED 10: a viewer re-roled');
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_dev, 'admin'), 'forbidden', 'FAILED 10: an admin made an admin');
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_owner, 'viewer'), 'owner_role', 'FAILED 10: the owner re-roled');
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_none, 'viewer'), 'not_a_member', 'FAILED 10: a stranger re-roled');
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_dev, 'owner'), 'validation', 'FAILED 10: made an owner');
  perform pg_temp.ma_ok(mail.change_member_role(v_acct, u_new, 'viewer'), 'FAILED 10: an admin re-roles a developer');
  if (mail.change_member_role(v_acct, u_new, 'viewer') ->> 'already')::boolean is not true then
    raise exception 'FAILED 10: the same role again';
  end if;
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_ok(mail.change_member_role(v_acct, u_admin, 'developer'), 'FAILED 10: the owner demotes an admin');
  perform pg_temp.ma_ok(mail.change_member_role(v_acct, u_admin, 'admin'), 'FAILED 10: the owner promotes');
  execute 'reset role';
  if (select role from mail.members where account_id = v_acct and user_id = u_new) <> 'viewer'
     or (select count(*) from mail.account_audit_log where account_id = v_acct and action = 'member.role_changed'
           and target = u_new::text and detail = '{"from": "developer", "to": "viewer"}') <> 1 then
    raise exception 'FAILED 10: the role change is not saved and logged';
  end if;
  v_passed := v_passed + 1;

  -- ── 11. Removing: never the owner or yourself; admins only developers and viewers.
  perform pg_temp.ma_as(u_dev);
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_view), 'forbidden', 'FAILED 11: a developer removed');
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_owner), 'owner_role', 'FAILED 11: the owner removed');
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_admin), 'use_leave', 'FAILED 11: removed oneself');
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values (v_acct, u_new2, 'admin');
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_new2), 'forbidden', 'FAILED 11: an admin removed an admin');
  perform pg_temp.ma_ok(mail.remove_member(v_acct, u_new), 'FAILED 11: an admin removes a viewer');
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_new), 'not_a_member', 'FAILED 11: removed twice');
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_ok(mail.remove_member(v_acct, u_new2), 'FAILED 11: the owner removes an admin');
  execute 'reset role';
  if exists (select 1 from mail.members where account_id = v_acct and user_id in (u_new, u_new2))
     or (select count(*) from mail.account_audit_log where account_id = v_acct and action = 'member.removed') <> 2 then
    raise exception 'FAILED 11: removals are not done and logged';
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Leaving: anyone but the owner.
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_code(mail.leave_account(v_acct), 'owner_must_transfer', 'FAILED 12: the owner left');
  perform pg_temp.ma_as(u_none);
  perform pg_temp.ma_code(mail.leave_account(v_acct), 'not_found', 'FAILED 12: a stranger left');
  perform pg_temp.ma_as(u_view);
  perform pg_temp.ma_ok(mail.leave_account(v_acct), 'FAILED 12: a viewer leaves');
  perform pg_temp.ma_code(mail.leave_account(v_acct), 'not_found', 'FAILED 12: left twice');
  execute 'reset role';
  if exists (select 1 from mail.members where account_id = v_acct and user_id = u_view)
     or (select count(*) from mail.account_audit_log where account_id = v_acct and action = 'member.left'
           and target = u_view::text) <> 1 then
    raise exception 'FAILED 12: leaving is not done and logged';
  end if;
  v_passed := v_passed + 1;

  -- ── 13. Transferring ownership: the owner, to a member under the ownership limit;
  -- with two-factor on, only in a session that entered a code.
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_dev), 'forbidden', 'FAILED 13: an admin transferred');
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_owner), 'validation', 'FAILED 13: to oneself');
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_none), 'not_a_member', 'FAILED 13: to a stranger');
  -- u_dev owns three open accounts already.
  perform pg_temp.ma_as(u_dev);
  v_other := (mail.create_account('m46 dev 1 ' || v_tag) ->> 'accountId')::uuid;
  perform mail.create_account('m46 dev 2 ' || v_tag);
  perform mail.create_account('m46 dev 3 ' || v_tag);
  perform pg_temp.ma_as(u_owner);
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_dev), 'limit', 'FAILED 13: past the ownership limit');
  execute 'reset role';
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), u_owner, 'm46 ' || v_tag, 'totp', 'verified', now(), now());
  perform pg_temp.ma_as(u_owner, 'aal1');
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_admin), 'needs_aal2', 'FAILED 13: two-factor without a code');
  perform pg_temp.ma_as(u_owner, 'aal2');
  perform pg_temp.ma_ok(mail.transfer_ownership(v_acct, u_admin), 'FAILED 13: the owner transfers');
  perform pg_temp.ma_code(mail.transfer_ownership(v_acct, u_admin), 'forbidden', 'FAILED 13: the old owner again');
  execute 'reset role';
  if (select role from mail.members where account_id = v_acct and user_id = u_admin) <> 'owner'
     or (select role from mail.members where account_id = v_acct and user_id = u_owner) <> 'admin'
     or (select count(*) from mail.account_audit_log where account_id = v_acct
           and action = 'account.ownership_transferred' and target = u_admin::text
           and detail ->> 'from' = u_owner::text) <> 1 then
    raise exception 'FAILED 13: the transfer is not done and logged';
  end if;
  v_passed := v_passed + 1;

  -- ── 14. A closed account takes no changes.
  update mail.accounts set state = 'closed' where id = v_acct;
  perform pg_temp.ma_as(u_admin);
  perform pg_temp.ma_code(mail.update_account_profile(v_acct, 'Closed'), 'account_closed', 'FAILED 14: edit closed');
  perform pg_temp.ma_code(mail.create_invite(v_acct, e_new, 'viewer', h_new2), 'account_closed', 'FAILED 14: invite closed');
  perform pg_temp.ma_code(mail.change_member_role(v_acct, u_dev, 'viewer'), 'account_closed', 'FAILED 14: re-role closed');
  perform pg_temp.ma_code(mail.remove_member(v_acct, u_dev), 'account_closed', 'FAILED 14: remove closed');
  perform pg_temp.ma_as(u_unconf);
  perform pg_temp.ma_code(mail.accept_invite(h_unconf), 'not_found', 'FAILED 14: joined a closed account');
  execute 'reset role';
  update mail.accounts set state = 'sandbox' where id = v_acct;
  v_passed := v_passed + 1;

  -- ── 15. e2e_set_plan: the service role, and e2e accounts only.
  perform pg_temp.ma_as(u_owner);
  begin
    perform mail.e2e_set_plan(v_acct, 'pro');
    raise exception 'FAILED 15: authenticated could call e2e_set_plan';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated', 'authenticated', 'm46-real-' || v_tag || '@mydomainshub.com',
          now(), now(), now())
  returning id into u_none;
  insert into mail.members (account_id, user_id, role) values (v_other, u_none, 'viewer');
  execute 'set local role service_role';
  perform pg_temp.ma_code(mail.e2e_set_plan(v_other, 'pro'), 'not_e2e', 'FAILED 15: a real member''s account');
  perform pg_temp.ma_code(mail.e2e_set_plan(v_acct, 'nope'), 'validation', 'FAILED 15: no such plan');
  perform pg_temp.ma_ok(mail.e2e_set_plan(v_acct, 'starter'), 'FAILED 15: an e2e account');
  execute 'reset role';
  if (select plan_code from mail.accounts where id = v_acct) <> 'starter'
     or (select plan_code from mail.accounts where id = v_other) <> 'free' then
    raise exception 'FAILED 15: plans are not as set';
  end if;
  v_passed := v_passed + 1;

  -- ── 16. Migration 46's functions: each granted to exactly the role it names;
  -- every security definer function in mail has an empty search_path.
  v_expected := '{
    "caller_role":"none", "seats_taken":"none", "is_invite_email":"none",
    "account_usage":"authenticated", "account_members":"authenticated",
    "update_account_profile":"authenticated", "create_invite":"authenticated",
    "revoke_invite":"authenticated", "invite_preview":"authenticated", "accept_invite":"authenticated",
    "change_member_role":"authenticated", "remove_member":"authenticated", "leave_account":"authenticated",
    "transfer_ownership":"authenticated", "e2e_set_plan":"service_role"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 16: mail.% is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 16: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 16: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'mail'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')) then
    raise exception 'FAILED 16: a security definer function in mail has no empty search_path';
  end if;
  -- Still no API role writes a mail table, and the token hash stays closed.
  for v_row in select c.oid, c.relname from pg_class c where c.relnamespace = 'mail'::regnamespace and c.relkind = 'r' loop
    if has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate') then
      raise exception 'FAILED 16: mail.% is writable by authenticated', v_row.relname;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'mail.invites', 'token_hash', 'select') then
    raise exception 'FAILED 16: invite token hashes are readable';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 46: % checks passed', v_passed;
end;
$$;

rollback;
