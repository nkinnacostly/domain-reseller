-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 40: the admin dashboard's authority (docs/ADMIN-SPEC.md §2–§3.1,
-- ADR-006, signed off by the owner on 2 Oct 2026).
--
-- Admins are rows in `public.admins`, read in SQL on every request — no JWT
-- claim, no access-token hook, no RLS bypass (D1, D5). `admin_session()`
-- checks who is asking: an admin row, AAL2, a session whose factor is one of
-- the admin's pinned authenticators, a strong sign-in (password or Google),
-- and a code within the freshness window. `admin_tier()` holds the only copy
-- of each action's role, money tier and test-admin rule; `admin_gate()`
-- applies it. Callers never pass a role or a freshness (D2).
--
-- Every write the dashboard can make is an `admin_*` SECURITY DEFINER
-- wrapper, granted to `authenticated` only and called with the session
-- client, that records an append-only audit row — refusals included — and
-- answers JSON. The refund and incident functions underneath stay revoked
-- from `service_role` (D3), so a leaked secret key still cannot approve a
-- refund. Every function here is revoked from public, anon, authenticated
-- and service_role and then granted to at most one role (§3.0);
-- supabase/tests/admin.sql checks that loop.
--
-- Deploy with migration 41, before the gateway and the web (§9).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Admins and their change log ──────────────────────────────────────────

create table public.admins (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  label          text not null unique check (label ~ '^[a-z][a-z0-9_-]{1,30}$'), -- used as p_by; never an email
  role           text not null check (role in ('owner', 'operator', 'viewer')),
  mfa_factor_ids uuid[] not null check (cardinality(mfa_factor_ids) between 1 and 5), -- every pinned TOTP factor
  test_only      boolean not null default false,
  added_by       text not null check (char_length(trim(added_by)) > 0),
  added_at       timestamptz not null default now(),
  revoked_at     timestamptz,
  constraint admins_test_not_owner check (not (test_only and role = 'owner'))
);
alter table public.admins enable row level security;            -- no policies
revoke all on public.admins from public, anon, authenticated, service_role;

create table public.admin_changes (                              -- written only by the trigger below
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  op           text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  label        text not null,
  role         text,
  test_only    boolean not null,
  factor_count integer,
  revoked      boolean not null,
  db_user      text not null default current_user
);
alter table public.admin_changes enable row level security;
revoke all on public.admin_changes from public, anon, authenticated, service_role;

-- A pinned factor must be one of this user's verified authenticators (D7). A
-- leaked secret key can enrol a factor through the Auth admin API; it cannot
-- add it here. Checked only when the pins change, so a person whose device
-- was removed can still be revoked.
create function public.admins_factor_is_theirs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.user_id = old.user_id
     and new.mfa_factor_ids = old.mfa_factor_ids then
    return new;
  end if;
  if exists (
    select 1 from unnest(new.mfa_factor_ids) as pinned(id)
     where not exists (
       select 1 from auth.mfa_factors f
        where f.id = pinned.id and f.user_id = new.user_id
          and f.status = 'verified' and f.factor_type = 'totp')
  ) then
    raise exception 'admins: every pinned factor must be a verified authenticator of that user'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- One change-log row per insert, update or delete: the label, role, flags and
-- how many devices are pinned — never the factor ids or an email. A change to
-- a non-test admin raises a critical alert (admin_alert_conditions, migration
-- 41), so anyone with SQL access is seen. `db_user` is the session's login
-- role: the definer would always be the owner.
create function public.admins_log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.admins;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  insert into public.admin_changes (op, label, role, test_only, factor_count, revoked, db_user)
  values (tg_op, v_row.label, v_row.role, v_row.test_only, cardinality(v_row.mfa_factor_ids),
          v_row.revoked_at is not null or tg_op = 'DELETE', session_user);
  return null;
end;
$$;

create function public.admin_changes_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'the admin change log is never rewritten';
end;
$$;

create trigger admins_factor_is_theirs
  before insert or update on public.admins
  for each row execute function public.admins_factor_is_theirs();
create trigger admins_log_change
  after insert or update or delete on public.admins
  for each row execute function public.admins_log_change();
create trigger admin_changes_final
  before update or delete on public.admin_changes
  for each row execute function public.admin_changes_final();
create trigger admin_changes_no_truncate
  before truncate on public.admin_changes
  for each statement execute function public.admin_changes_final();

-- ── 2. The audit log ────────────────────────────────────────────────────────

create table public.admin_audit_log (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  admin_id         uuid not null,              -- no FK: the record outlives the account
  admin_label      text not null,
  admin_role       text not null,
  test_actor       boolean not null,
  session_hash     text,                       -- sha256 of the JWT session_id, hex; never the id, never an IP
  action           text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  side             text check (side in ('live', 'test', 'global')),
  target_type      text check (char_length(target_type) <= 40),
  target_id        text check (char_length(target_id) <= 200),
  target_test_mode boolean,
  reason           text check (char_length(reason) <= 500),
  redacted_at      timestamptz,
  outcome          text not null check (outcome in ('intent', 'ok', 'refused', 'failed')),
  error_code       text check (char_length(error_code) <= 60),
  error            text check (char_length(error) <= 300),
  detail           jsonb not null default '{}' check (pg_column_size(detail) <= 4096),
  parent_id        bigint,                     -- a gateway result points at its intent note (no FK; purged together)
  request_key      uuid,
  request_id       uuid                        -- only a well-formed uuid from x-request-id, else null
);
create unique index admin_audit_log_request_key_ok on public.admin_audit_log (request_key)
  where request_key is not null and outcome = 'ok';            -- a refusal frees its key
create unique index admin_audit_log_one_result on public.admin_audit_log (parent_id) where parent_id is not null;
create index admin_audit_log_created on public.admin_audit_log (created_at desc);
create index admin_audit_log_target  on public.admin_audit_log (target_type, target_id);
create index admin_audit_log_actor   on public.admin_audit_log (admin_id, action, created_at desc);
alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from public, anon, authenticated, service_role;
grant select on public.admin_audit_log to service_role;          -- read via adminDb only

create table public.admin_note_claims (
  audit_id   bigint primary key,
  claimed_at timestamptz not null default now()
);
alter table public.admin_note_claims enable row level security;
revoke all on public.admin_note_claims from public, anon, authenticated, service_role;

-- Nobody rewrites the record — not the secret key, not the owner. The one
-- update is a redaction of the typed reason by admin_redact_reason; the one
-- delete is the cron purge of test admins' rows after 30 days.
create function public.admin_audit_is_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'the admin audit log is never rewritten';
  end if;
  if tg_op = 'DELETE' then
    if old.test_actor and old.created_at < now() - interval '30 days' then
      return old;
    end if;
    raise exception 'the admin audit log is never rewritten';
  end if;
  if coalesce(current_setting('app.admin_redact', true), '') = old.id::text
     and new.reason is null
     and new.redacted_at is not null
     and (new.id, new.created_at, new.admin_id, new.admin_label, new.admin_role, new.test_actor,
          new.session_hash, new.action, new.side, new.target_type, new.target_id,
          new.target_test_mode, new.outcome, new.error_code, new.error, new.detail,
          new.parent_id, new.request_key, new.request_id)
         is not distinct from
         (old.id, old.created_at, old.admin_id, old.admin_label, old.admin_role, old.test_actor,
          old.session_hash, old.action, old.side, old.target_type, old.target_id,
          old.target_test_mode, old.outcome, old.error_code, old.error, old.detail,
          old.parent_id, old.request_key, old.request_id) then
    return new;
  end if;
  raise exception 'the admin audit log is never rewritten';
end;
$$;

create trigger admin_audit_is_final
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_is_final();
create trigger admin_audit_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_is_final();

-- A generic append-only guard, for the evidence tables here and in 41.
-- Revisions of e2e ledger rows may be purged by purge_test_ledger_entries.
create function public.append_only_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and tg_table_name = 'supplier_ledger_revisions' then
    if old.test_mode and coalesce(current_setting('app.ledger_purge', true), '') = 'on' then
      return old;
    end if;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$;

-- ── 3. The gate ──────────────────────────────────────────────────────────────

-- The only copy of the action map (§2.2). test_rule: `test_target` — a test
-- admin may act only on a test-mode target or the test side;
-- `reserved_target` — only on a reserved-email profile; `never`.
create function public.admin_tier(p_action text, out min_role text, out money boolean, out test_rule text)
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
      ('email.requeue',               'operator', false, 'test_target'),
      ('domain.deep_sync',            'operator', false, 'test_target'),
      ('domain.reveal_contacts',      'operator', false, 'test_target'),
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
      ('supplier.ssl_catalogue_apply', 'owner',   true,  'never')
    ) as t (action, min_role, money, test_rule)
   where t.action = p_action
$$;

-- Who is asking (§2.2). Raises `admin:*` with errcode 42501, so nothing is
-- recorded for a stranger. Freshness comes from the JWT's own `amr` (D8).
create function public.admin_session(p_min_role text default 'viewer',
                                     p_fresh_minutes integer default null,
                                     p_check_hold boolean default false)
returns public.admins
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_claims  jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_amr     jsonb := case when jsonb_typeof(coalesce(auth.jwt(), '{}'::jsonb) -> 'amr') = 'array'
                          then auth.jwt() -> 'amr' else '[]'::jsonb end;
  v_admin   public.admins;
  v_sid     uuid;
  v_factor  uuid;
  v_totp_at timestamptz;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'admin:not_admin'; end if;
  select * into v_admin from public.admins where user_id = v_uid and revoked_at is null;
  if not found then raise exception using errcode = '42501', message = 'admin:not_admin'; end if;
  if (case v_admin.role when 'owner' then 3 when 'operator' then 2 else 1 end)
     < (case coalesce(p_min_role, 'owner') when 'viewer' then 1 when 'operator' then 2 when 'owner' then 3 else 99 end) then
    raise exception using errcode = '42501', message = 'admin:role';
  end if;
  if coalesce(v_claims ->> 'aal', '') <> 'aal2' then
    raise exception using errcode = '42501', message = 'admin:needs_code';
  end if;
  begin v_sid := (v_claims ->> 'session_id')::uuid; exception when others then v_sid := null; end;
  select s.factor_id into v_factor from auth.sessions s
   where s.id = v_sid and s.user_id = v_uid and s.aal = 'aal2'
     and (s.not_after is null or s.not_after > now());
  if not found then raise exception using errcode = '42501', message = 'admin:needs_code'; end if;
  if v_factor is null or not (v_factor = any (v_admin.mfa_factor_ids))
     or not exists (select 1 from auth.mfa_factors f where f.id = v_factor and f.user_id = v_uid
                      and f.status = 'verified' and f.factor_type = 'totp') then
    raise exception using errcode = '42501', message = 'admin:factor_mismatch';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_amr) e where e ->> 'method' in ('password', 'oauth')) then
    raise exception using errcode = '42501', message = 'admin:weak_sign_in';
  end if;
  select to_timestamp(max((e ->> 'timestamp')::double precision)) into v_totp_at
    from jsonb_array_elements(v_amr) e where e ->> 'method' = 'totp';
  if v_totp_at is null or v_totp_at < now() - make_interval(mins => coalesce(p_fresh_minutes, 720)) then
    raise exception using errcode = '42501', message = 'admin:needs_code';
  end if;
  if coalesce(p_check_hold, false) and exists (select 1 from public.profiles p where p.id = v_uid
       and p.password_reset_at > now() - interval '24 hours') then
    raise exception using errcode = '42501', message = 'admin:held';
  end if;
  return v_admin;
end;
$$;

-- The first refusal for this admin and action, or null (§2.2). Refusals here
-- are recorded by the caller: the admin is known by now.
create function public.admin_gate(p_admin public.admins, p_action text, p_target_ok_for_test boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tier    record;
  v_amr     jsonb := case when jsonb_typeof(coalesce(auth.jwt(), '{}'::jsonb) -> 'amr') = 'array'
                          then auth.jwt() -> 'amr' else '[]'::jsonb end;
  v_totp_at timestamptz;
begin
  select * into v_tier from public.admin_tier(p_action);
  if v_tier.min_role is null then
    return 'UNKNOWN_ACTION';
  end if;
  -- An action a test admin may never take says so first, whatever the role.
  if p_admin.test_only and v_tier.test_rule = 'never' then
    return 'TEST_ADMIN';
  end if;
  if (case p_admin.role when 'owner' then 3 when 'operator' then 2 else 1 end)
     < (case v_tier.min_role when 'viewer' then 1 when 'operator' then 2 else 3 end) then
    return 'ROLE';
  end if;
  if v_tier.money then
    -- D6: a code typed into the dialog moments ago, never a 12-hour-old one.
    select to_timestamp(max((e ->> 'timestamp')::double precision)) into v_totp_at
      from jsonb_array_elements(v_amr) e where e ->> 'method' = 'totp';
    if v_totp_at is null or v_totp_at < now() - interval '5 minutes' then
      return 'NEEDS_CODE';
    end if;
    if exists (select 1 from public.profiles p where p.id = p_admin.user_id
                 and p.password_reset_at > now() - interval '24 hours') then
      return 'HELD';
    end if;
  end if;
  if p_admin.test_only and not coalesce(p_target_ok_for_test, false) then
    return 'TEST_ADMIN';
  end if;
  return null;
end;
$$;

-- For the proxy and the sidebar: a word, never an error (§2.3).
create function public.admin_status()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_session('viewer', null, false);
  return 'ok';
exception when others then
  return case sqlerrm
           when 'admin:needs_code' then 'needs_code'
           when 'admin:factor_mismatch' then 'factor_mismatch'
           when 'admin:weak_sign_in' then 'weak_sign_in'
           else 'not_admin'
         end;
end;
$$;

-- Who this admin is, for the web's principal; raises the admin:* code.
-- factorId is the session's factor: adminMoneyAction verifies the dialog's
-- code against it.
create function public.admin_whoami(p_fresh_minutes integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin   public.admins := public.admin_session('viewer', p_fresh_minutes, false);
  v_claims  jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_factor  uuid;
  v_totp_at timestamptz;
begin
  select s.factor_id into v_factor from auth.sessions s
   where s.id = (v_claims ->> 'session_id')::uuid and s.user_id = v_admin.user_id;
  select to_timestamp(max((e ->> 'timestamp')::double precision)) into v_totp_at
    from jsonb_array_elements(case when jsonb_typeof(v_claims -> 'amr') = 'array'
                                   then v_claims -> 'amr' else '[]'::jsonb end) e
   where e ->> 'method' = 'totp';
  return jsonb_build_object(
    'userId', v_admin.user_id,
    'label', v_admin.label,
    'role', v_admin.role,
    'testOnly', v_admin.test_only,
    'sessionHash', encode(sha256(convert_to(coalesce(v_claims ->> 'session_id', ''), 'UTF8')), 'hex'),
    'factorId', v_factor,
    'codeAt', v_totp_at);
end;
$$;

-- ── 4. Recording ─────────────────────────────────────────────────────────────

-- A committed `ok` answer for this request key, or null. Run under a lock on
-- the key, before the target row is read, so a double submit waits and then
-- replays instead of acting twice.
create function public.admin_replay(p_request_key uuid, p_admin_id uuid, p_action text, p_target_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.admin_audit_log;
begin
  if p_request_key is null then
    raise exception using errcode = '22023', message = 'admin:request_key';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key::text, 7));
  select * into v_row from public.admin_audit_log
   where request_key = p_request_key and outcome = 'ok';
  if not found then
    return null;
  end if;
  if v_row.admin_id <> p_admin_id
     or v_row.target_id is distinct from p_target_id
     or (v_row.action <> p_action
         -- A limit change is recorded as a raise or an update: the same request either way.
         and not (p_action = 'settings.update' and v_row.action = 'settings.refund_limit_raise')) then
    raise exception using errcode = '22023', message = 'admin:request_key_mismatch';
  end if;
  return jsonb_build_object('ok', true, 'auditId', v_row.id, 'after', v_row.detail -> 'after',
                            'replayed', true);
end;
$$;

create function public.admin_record(p_admin public.admins, p_action text, p_side text,
                                    p_target_type text, p_target_id text, p_target_test_mode boolean,
                                    p_reason text, p_request_key uuid, p_outcome text, p_code text,
                                    p_error text, p_detail jsonb, p_parent_id bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_detail     jsonb := coalesce(p_detail, '{}'::jsonb);
  v_id         bigint;
begin
  begin
    v_request_id := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id';
  exception when others then
    v_request_id := null;
  end;
  if pg_column_size(v_detail) > 4096 then
    v_detail := jsonb_build_object('truncated', true);
  end if;
  insert into public.admin_audit_log (
    admin_id, admin_label, admin_role, test_actor, session_hash, action, side, target_type,
    target_id, target_test_mode, reason, outcome, error_code, error, detail, parent_id,
    request_key, request_id)
  values (
    p_admin.user_id, p_admin.label, p_admin.role, p_admin.test_only,
    encode(sha256(convert_to(coalesce(auth.jwt() ->> 'session_id', ''), 'UTF8')), 'hex'),
    p_action, p_side, left(p_target_type, 40), left(p_target_id, 200), p_target_test_mode,
    nullif(left(trim(coalesce(p_reason, '')), 500), ''),
    p_outcome, left(p_code, 60), left(p_error, 300), v_detail, p_parent_id,
    p_request_key, v_request_id)
  returning id into v_id;
  return jsonb_build_object('ok', p_outcome in ('ok', 'intent'), 'auditId', v_id, 'code', p_code,
                            'message', null, 'after', v_detail -> 'after');
end;
$$;

-- 10–500 characters, after trimming (typed under "Don't include personal details").
create function public.admin_reason_problem(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when char_length(trim(coalesce(p_reason, ''))) between 10 and 500 then null else 'REASON' end
$$;

-- `a•••@gmail.com`, the format maskEmail() in features/admin/lib/format.ts uses.
create function public.admin_mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p_email is null then null
           when position('@' in p_email) = 0 then '•••'
           else left(split_part(p_email, '@', 1), 1) || '•••@' || split_part(p_email, '@', 2)
         end
$$;

-- An intent note for a gateway-backed action (D22). The gateway claims it
-- with its service key before it calls anyone; the tier comes from SQL.
create function public.admin_note(p_action text, p_side text, p_target_type text, p_target_id text,
                                  p_detail jsonb default '{}', p_reason text default null,
                                  p_request_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_code  text;
  v_test  boolean := case p_side when 'test' then true when 'live' then false end;
begin
  if not (p_action like 'supplier.%' or p_action in ('refund.flw_check', 'preset.draft_check'))
     or (select t.min_role from public.admin_tier(p_action) t) is null then
    raise exception using errcode = '22023', message = 'admin:unknown_action';
  end if;
  if p_side is null or p_side not in ('live', 'test', 'global') then
    raise exception using errcode = '22023', message = 'admin:bad_side';
  end if;
  v_code := public.admin_gate(v_admin, p_action, p_side = 'test');
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then
    v_code := 'REASON';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, p_action, p_side, p_target_type, p_target_id, v_test,
                               p_reason, p_request_key, 'refused', v_code, null, p_detail);
  end if;
  return public.admin_record(v_admin, p_action, p_side, p_target_type, p_target_id, v_test,
                             p_reason, p_request_key, 'intent', null, null, p_detail);
end;
$$;

-- The gateway's half of D22: the note must exist, be an unused intent for
-- this route's action, label, side and target, and be under a minute old.
create function public.admin_claim_note(p_audit_id bigint, p_action text, p_label text, p_side text,
                                        p_target_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.admin_audit_log;
begin
  select * into v_row from public.admin_audit_log where id = p_audit_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_row.outcome <> 'intent' then return jsonb_build_object('ok', false, 'code', 'NOT_INTENT'); end if;
  if v_row.action is distinct from p_action then
    return jsonb_build_object('ok', false, 'code', 'ACTION_MISMATCH');
  end if;
  if v_row.admin_label is distinct from p_label then
    return jsonb_build_object('ok', false, 'code', 'LABEL_MISMATCH');
  end if;
  if v_row.side is distinct from p_side then
    return jsonb_build_object('ok', false, 'code', 'SIDE_MISMATCH');
  end if;
  if v_row.target_id is distinct from p_target_id then
    return jsonb_build_object('ok', false, 'code', 'TARGET_MISMATCH');
  end if;
  if v_row.created_at <= now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  if v_row.test_actor and coalesce(p_side, '') in ('live', 'global') then
    return jsonb_build_object('ok', false, 'code', 'TEST_ADMIN');
  end if;
  -- Revoked in the last minute: the note dies with the access.
  if not exists (select 1 from public.admins a where a.user_id = v_row.admin_id and a.revoked_at is null) then
    return jsonb_build_object('ok', false, 'code', 'REVOKED');
  end if;
  insert into public.admin_note_claims (audit_id) values (p_audit_id) on conflict do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'USED');
  end if;
  -- The note's detail goes back with the claim: a route acts on what the
  -- admin noted, never on its own query string (D23).
  return jsonb_build_object('ok', true, 'auditId', v_row.id, 'testActor', v_row.test_actor,
                            'detail', v_row.detail);
end;
$$;

-- What the gateway did with a claimed note: one result row per note.
create function public.admin_note_result(p_audit_id bigint, p_outcome text, p_code text, p_detail jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.admin_audit_log;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_id     bigint;
begin
  if not exists (select 1 from public.admin_note_claims c where c.audit_id = p_audit_id) then
    raise exception using errcode = '22023', message = 'admin:not_claimed';
  end if;
  if p_outcome is null or p_outcome not in ('ok', 'refused', 'failed') then
    raise exception using errcode = '22023', message = 'admin:bad_outcome';
  end if;
  select * into v_parent from public.admin_audit_log where id = p_audit_id;
  if pg_column_size(v_detail) > 4096 then
    v_detail := jsonb_build_object('truncated', true);
  end if;
  insert into public.admin_audit_log (
    admin_id, admin_label, admin_role, test_actor, session_hash, action, side, target_type,
    target_id, target_test_mode, outcome, error_code, detail, parent_id)
  values (
    v_parent.admin_id, v_parent.admin_label, v_parent.admin_role, v_parent.test_actor,
    v_parent.session_hash, v_parent.action, v_parent.side, v_parent.target_type,
    v_parent.target_id, v_parent.target_test_mode, p_outcome, left(nullif(p_code, ''), 60), v_detail, p_audit_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- audit.redact (owner, money): removes the typed reason, nothing else (§2.5).
create function public.admin_redact_reason(p_audit_id bigint, p_why text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_action constant text := 'audit.redact';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_row    public.admin_audit_log;
  v_code   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_audit_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_row from public.admin_audit_log where id = p_audit_id;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'audit', p_audit_id::text, null, p_why,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_why));
  if v_code is null and v_row.reason is null then v_code := 'NO_REASON'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'audit', p_audit_id::text, null, p_why,
                               p_request_key, 'refused', v_code, null, '{}');
  end if;
  perform set_config('app.admin_redact', p_audit_id::text, true);
  update public.admin_audit_log set reason = null, redacted_at = now() where id = p_audit_id;
  perform set_config('app.admin_redact', '', true);
  return public.admin_record(v_admin, c_action, 'global', 'audit', p_audit_id::text, null, p_why,
                             p_request_key, 'ok', null, null,
                             jsonb_build_object('after', jsonb_build_object('redacted', true)));
end;
$$;

-- Test admins' rows go after 30 days, by cron only (D15).
create function public.purge_test_admin_audit()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.admin_note_claims c
   using public.admin_audit_log a
   where a.id = c.audit_id and a.test_actor and a.created_at < now() - interval '30 days';
  delete from public.admin_audit_log
   where test_actor and created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select cron.schedule('admin-audit-purge', '47 3 * * *', 'select public.purge_test_admin_audit()');

-- ── 5. The e2e admin ────────────────────────────────────────────────────────

-- A `test_only` operator for a reserved e2e user with a verified
-- authenticator; never the owner, never a real address (§2.7).
create function public.grant_test_admin(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text;
  v_factors uuid[];
  v_label   text := 'e2e-' || left(p_user_id::text, 8);
begin
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if v_email is null or v_email !~ '^e2e-[^@]+@example\.com$' or not public.is_reserved_email(v_email) then
    raise exception 'grant_test_admin: only an e2e-*@example.com user' using errcode = '42501';
  end if;
  select array_agg(f.id order by f.created_at) into v_factors
    from auth.mfa_factors f
   where f.user_id = p_user_id and f.factor_type = 'totp' and f.status = 'verified';
  if coalesce(cardinality(v_factors), 0) = 0 then
    raise exception 'grant_test_admin: the user needs a verified authenticator' using errcode = '42501';
  end if;
  if exists (select 1 from public.admins a where a.user_id = p_user_id and not a.test_only) then
    raise exception 'grant_test_admin: that user is a real admin' using errcode = '42501';
  end if;
  insert into public.admins (user_id, label, role, mfa_factor_ids, test_only, added_by)
  values (p_user_id, v_label, 'operator', v_factors[1:5], true, 'e2e')
  on conflict (user_id) do update
    set mfa_factor_ids = excluded.mfa_factor_ids, revoked_at = null
  where public.admins.test_only;
  return v_label;
end;
$$;

-- ── 6. Supporting tables ────────────────────────────────────────────────────

-- D23: what the gateway read from Flutterwave about a refund, before a person
-- may record it as paid by hand. Append-only.
create table public.flw_refund_checks (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  test_mode       boolean not null,
  target_type     text not null check (target_type in ('refund', 'incident')),
  target_id       text not null check (char_length(target_id) <= 64),
  flw_refund_id   text not null check (flw_refund_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  tx_id           text check (char_length(tx_id) <= 64),
  amount_kobo     bigint,
  currency        text check (char_length(currency) <= 8),
  status          text check (char_length(status) <= 60),
  disburse_status text check (char_length(disburse_status) <= 60),
  state           text not null check (state in ('done', 'failed', 'pending')),
  audit_id        bigint
);
create index flw_refund_checks_target on public.flw_refund_checks (target_type, target_id, created_at desc);
alter table public.flw_refund_checks enable row level security;
revoke all on public.flw_refund_checks from public, anon, authenticated, service_role;
grant select on public.flw_refund_checks to service_role;
create trigger flw_refund_checks_final
  before update or delete on public.flw_refund_checks
  for each row execute function public.append_only_final();
create trigger flw_refund_checks_no_truncate
  before truncate on public.flw_refund_checks
  for each statement execute function public.append_only_final();

-- One check per note: a second read under the same note is refused.
create unique index flw_refund_checks_one_per_note on public.flw_refund_checks (audit_id)
  where audit_id is not null;

-- Written only for a refund.flw_check note claimed in the last two minutes on
-- the same side, for the Flutterwave refund the note names (its target) and the
-- refund or incident it was written for (its detail), once per note (D23).
create function public.record_flw_refund_check(p_audit_id bigint, p_test_mode boolean, p_target_type text,
                                               p_target_id text, p_flw_refund_id text, p_tx_id text,
                                               p_amount_kobo bigint, p_currency text, p_status text,
                                               p_disburse_status text, p_state text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note    public.admin_audit_log;
  v_claimed timestamptz;
  v_id      bigint;
begin
  select c.claimed_at into v_claimed from public.admin_note_claims c where c.audit_id = p_audit_id;
  select a.* into v_note from public.admin_audit_log a where a.id = p_audit_id;
  if v_claimed is null or v_note.id is null or v_note.action <> 'refund.flw_check'
     or v_note.side is distinct from (case when p_test_mode then 'test' else 'live' end)
     or v_claimed <= now() - interval '2 minutes' then
    raise exception using errcode = '22023', message = 'admin:not_claimed';
  end if;
  -- The note's target is the Flutterwave refund read; its detail names the one
  -- refund or incident the read is evidence for. Nothing comes from the caller alone.
  if v_note.target_id is distinct from p_flw_refund_id
     or coalesce(p_target_type, '') not in ('refund', 'incident')
     or (v_note.detail ->> case p_target_type when 'refund' then 'refund_id' else 'incident_id' end)
        is distinct from p_target_id
     or (v_note.detail ? 'refund_id') = (v_note.detail ? 'incident_id') then
    raise exception using errcode = '22023', message = 'admin:target_mismatch';
  end if;
  if exists (select 1 from public.flw_refund_checks f where f.audit_id = p_audit_id) then
    raise exception using errcode = '22023', message = 'admin:check_recorded';
  end if;
  insert into public.flw_refund_checks (test_mode, target_type, target_id, flw_refund_id, tx_id,
                                        amount_kobo, currency, status, disburse_status, state, audit_id)
  values (p_test_mode, p_target_type, p_target_id, p_flw_refund_id, nullif(left(p_tx_id, 64), ''), p_amount_kobo,
          nullif(left(p_currency, 8), ''), left(p_status, 60), nullif(left(p_disburse_status, 60), ''), p_state,
          p_audit_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- D21: a preset's primary source must be the provider's own documentation.
-- Adding a host is done in the SQL editor (DEPLOY §6).
create table public.nameserver_preset_sources (
  provider text not null,
  host     text not null check (host ~ '^[a-z0-9.-]+$'),
  primary key (provider, host)
);
alter table public.nameserver_preset_sources enable row level security;
revoke all on public.nameserver_preset_sources from public, anon, authenticated, service_role;
grant select on public.nameserver_preset_sources to service_role;
insert into public.nameserver_preset_sources (provider, host) values
  ('Vercel', 'vercel.com'),
  ('Hostinger', 'www.hostinger.com'),
  ('Truehost Nigeria', 'truehost.com.ng'),
  ('Cloudflare', 'developers.cloudflare.com'),
  ('Netlify', 'docs.netlify.com');

-- D21: a change to a preset is a draft; the live preset changes only when an
-- owner publishes a draft that passed a public-DNS check.
create table public.nameserver_preset_drafts (
  id               uuid primary key default gen_random_uuid(),
  preset_id        uuid references public.nameserver_presets (id) on delete cascade,  -- null for a new preset
  provider         text not null check (char_length(provider) between 2 and 60),
  nameservers      text[] not null default '{}' check (public.are_hostnames(nameservers)),
  source_url       text not null check (source_url ~ '^https://' and char_length(source_url) <= 500),
  notes            text check (char_length(notes) <= 500),
  assigns_per_zone boolean not null default false,
  saved_by         text not null,
  saved_at         timestamptz not null default now(),
  check_ok         boolean,
  checked_at       timestamptz,
  check_detail     jsonb,
  published_at     timestamptz,
  discarded_at     timestamptz
);
create unique index nameserver_preset_drafts_one_open on public.nameserver_preset_drafts (lower(provider))
  where published_at is null and discarded_at is null;
alter table public.nameserver_preset_drafts enable row level security;
revoke all on public.nameserver_preset_drafts from public, anon, authenticated, service_role;
grant select on public.nameserver_preset_drafts to service_role;

-- Open drafts the gateway's preset checker looks up in public DNS.
create function public.preset_drafts_for_check()
returns table (draft_id uuid, provider text, nameservers text[])
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.provider, d.nameservers
    from public.nameserver_preset_drafts d
   where d.published_at is null and d.discarded_at is null
     and not d.assigns_per_zone and cardinality(d.nameservers) > 0
   order by d.checked_at nulls first, d.saved_at
$$;

create function public.record_preset_draft_check(p_draft_id uuid, p_ok boolean, p_detail jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.nameserver_preset_drafts
     set check_ok = coalesce(p_ok, false), checked_at = now(), check_detail = coalesce(p_detail, '{}')
   where id = p_draft_id and published_at is null and discarded_at is null;
  if not found then
    return 'closed';
  end if;
  return case when coalesce(p_ok, false) then 'ok' else 'failing' end;
end;
$$;

-- ── 7. The write wrappers (§3.1.1, §3.1.2) ──────────────────────────────────
-- Each: identity first (raises, not audited); a replay of a committed answer;
-- the target, locked; the gate and the business guards, each refusal
-- recorded; the underlying function, its failure recorded; the result
-- recorded with before and after. p_by is always the admin's label.

create function public.admin_approve_refund(p_refund_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'refund.approve';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_refund public.refunds;
  v_line   public.order_items;
  v_ops    public.ops_settings;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_refund_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'refund', p_refund_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_refund.test_mode then 'test' else 'live' end;
  select * into v_ops from public.ops_settings where id;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('status', v_refund.status, 'amount_kobo', v_refund.amount_kobo,
                                 'last_error_code', v_refund.last_error_code),
    'limits', jsonb_build_object('single_kobo', v_ops.auto_refund_max_kobo,
                                 'daily_kobo', v_ops.auto_refund_daily_max_kobo));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_refund.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_refund.status <> 'held' then v_code := 'NOT_HELD'; end if;
  if v_code is null and v_refund.order_item_id is not null then
    select * into v_line from public.order_items where id = v_refund.order_item_id for update;
    if coalesce(v_line.status::text, '') <> 'failed' then v_code := 'LINE_NOT_FAILED'; end if;
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.approve_refund(p_refund_id, v_admin.label);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('status', r.status, 'approved_by', r.approved_by)
                                               from public.refunds r where r.id = p_refund_id)));
end $$;

create function public.admin_retry_refund(p_refund_id uuid, p_checked_provider boolean, p_reason text,
                                          p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'refund.retry';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_refund public.refunds;
  v_line   public.order_items;
  v_ops    public.ops_settings;
  v_last   public.refund_events;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_refund_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'refund', p_refund_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_refund.test_mode then 'test' else 'live' end;
  select * into v_ops from public.ops_settings where id;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('status', v_refund.status, 'amount_kobo', v_refund.amount_kobo,
                                 'last_error_code', v_refund.last_error_code,
                                 'provider_refund_id', v_refund.provider_refund_id),
    'limits', jsonb_build_object('single_kobo', v_ops.auto_refund_max_kobo,
                                 'daily_kobo', v_ops.auto_refund_daily_max_kobo),
    'bypasses_limits', true);
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_refund.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_refund.status not in ('failed', 'needs_attention', 'cancelled') then
    v_code := 'NOT_RETRYABLE';
  end if;
  if v_code is null and v_refund.status = 'cancelled' and v_admin.role <> 'owner' then
    v_code := 'OWNER_ONLY';
  end if;
  if v_code is null and v_refund.order_item_id is not null then
    select * into v_line from public.order_items where id = v_refund.order_item_id for update;
    if coalesce(v_line.status::text, '') <> 'failed' then v_code := 'LINE_NOT_FAILED'; end if;
  end if;
  if v_code is null and v_refund.status = 'cancelled' then
    select * into v_last from public.refund_events e
     where e.refund_id = p_refund_id order by e.created_at desc, e.id desc limit 1;
    if v_last.event = 'cancelled'
       and coalesce(v_last.detail ->> 'why', '') in ('registration retried', 'certificate order retried') then
      v_code := 'LINE_RETRIED';
    end if;
  end if;
  if v_code is null and (v_refund.provider_called_at is not null or v_refund.provider_refund_id is not null)
     and not coalesce(p_checked_provider, false) then
    v_code := 'CHECK_PROVIDER';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.retry_refund(p_refund_id, v_admin.label);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('status', r.status, 'approved_by', r.approved_by)
                                               from public.refunds r where r.id = p_refund_id)));
end $$;

create function public.admin_cancel_refund(p_refund_id uuid, p_no_money_moved boolean, p_checked_provider boolean,
                                           p_note text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'refund.cancel';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_refund public.refunds;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_refund_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'refund', p_refund_id::text, null, p_note,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_refund.test_mode then 'test' else 'live' end;
  v_detail := jsonb_build_object('before', jsonb_build_object(
    'status', v_refund.status, 'amount_kobo', v_refund.amount_kobo, 'last_error_code', v_refund.last_error_code));
  v_code := public.admin_gate(v_admin, c_action, v_refund.test_mode);
  if v_code is null and (public.admin_reason_problem(p_note) is not null or char_length(trim(p_note)) > 300) then
    v_code := 'REASON';
  end if;
  if v_code is null and not coalesce(p_no_money_moved, false) then v_code := 'CONFIRM_NO_MONEY'; end if;
  if v_code is null and v_refund.status not in ('queued', 'held', 'failed', 'needs_attention') then
    v_code := 'NOT_CANCELLABLE';
  end if;
  if v_code is null and (v_refund.provider_called_at is not null or v_refund.provider_refund_id is not null)
     and not coalesce(p_checked_provider, false) then
    v_code := 'CHECK_PROVIDER';
  end if;
  if v_code is null and v_refund.provider_refund_id is not null
     and not (v_refund.status = 'failed' and coalesce(v_refund.last_error_code, '') = 'PROVIDER_REFUND_FAILED') then
    v_code := 'HAS_PROVIDER_REFUND';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_note, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.cancel_refund(p_refund_id, v_admin.label, left(trim(p_note), 300));
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_note, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
    p_note, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('status', 'cancelled')));
end $$;

-- Recomputes refundState (apps/gateway/src/payments/flutterwave.ts) from the
-- stored facts: the gateway's verdict and the facts must agree.
create function public.admin_flw_check_done(p_check public.flw_refund_checks)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_check.state = 'done'
         and lower(coalesce(p_check.status, '')) <> 'failed'
         and lower(coalesce(p_check.disburse_status, '')) <> 'failed'
         and (lower(coalesce(p_check.status, '')) like 'completed-%'
              or lower(coalesce(p_check.disburse_status, '')) in ('completed', 'successful', 'success')),
         false)
$$;

create function public.admin_record_manual_refund(p_refund_id uuid, p_check_id bigint, p_provider_refund_id text,
                                                  p_checked_provider boolean, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'refund.record_manual';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_refund public.refunds;
  v_line   public.order_items;
  v_check  public.flw_refund_checks;
  v_tx     text;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_refund_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'refund', p_refund_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_refund.test_mode then 'test' else 'live' end;
  select p.provider_reference into v_tx from public.payments p where p.id = v_refund.payment_id;
  select * into v_check from public.flw_refund_checks c where c.id = p_check_id;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('status', v_refund.status, 'amount_kobo', v_refund.amount_kobo),
    'reference', left(p_provider_refund_id, 64),
    'check', case when v_check.id is null then null
                  else jsonb_build_object('id', v_check.id, 'flw_refund_id', v_check.flw_refund_id,
                                          'tx_id', v_check.tx_id, 'amount_kobo', v_check.amount_kobo,
                                          'status', v_check.status, 'state', v_check.state,
                                          'checked_at', v_check.created_at) end);
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_refund.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and coalesce(p_provider_refund_id, '') !~ '^[A-Za-z0-9_-]{3,64}$' then
    v_code := 'BAD_REFERENCE';
  end if;
  if v_code is null and v_refund.status not in ('queued', 'held', 'failed', 'needs_attention', 'cancelled') then
    v_code := 'NOT_RECORDABLE';
  end if;
  if v_code is null and v_refund.status = 'cancelled' and v_admin.role <> 'owner' then
    v_code := 'OWNER_ONLY';
  end if;
  if v_code is null and v_refund.order_item_id is not null then
    select * into v_line from public.order_items where id = v_refund.order_item_id for update;
    if coalesce(v_line.status::text, '') <> 'failed' then v_code := 'LINE_NOT_FAILED'; end if;
  end if;
  if v_code is null and (v_refund.provider_called_at is not null or v_refund.provider_refund_id is not null)
     and not coalesce(p_checked_provider, false) then
    v_code := 'CHECK_PROVIDER';
  end if;
  -- D23: only a refund the gateway read from Flutterwave in the last 15
  -- minutes, for this charge, this amount, completed.
  if v_code is null and not (
       v_check.id is not null
       and v_check.target_type = 'refund'
       and v_check.target_id = p_refund_id::text
       and v_check.flw_refund_id = p_provider_refund_id
       and v_check.tx_id is not distinct from v_tx and v_tx is not null
       and v_check.amount_kobo is not distinct from v_refund.amount_kobo
       and v_check.test_mode = v_refund.test_mode
       and v_check.created_at > now() - interval '15 minutes'
       and public.admin_flw_check_done(v_check)) then
    v_code := 'FLW_NOT_VERIFIED';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.record_manual_refund(p_refund_id, p_provider_refund_id, v_admin.label);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'refund', p_refund_id::text, v_refund.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('status', r.status, 'provider_refund_id', r.provider_refund_id)
                                               from public.refunds r where r.id = p_refund_id)));
end $$;

create function public.admin_resolve_payment_incident(p_incident_id bigint, p_outcome text, p_refund_id uuid,
                                                      p_check_id bigint, p_confirmed boolean, p_reason text,
                                                      p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin    public.admins := public.admin_session('viewer', null, false);
  v_action   text;
  v_prior    jsonb;
  v_incident public.payment_incidents;
  v_check    public.flw_refund_checks;
  v_owed     boolean;
  v_code     text;
  v_evidence jsonb := '{}'::jsonb;
  v_detail   jsonb;
  v_side     text;
begin
  select * into v_incident from public.payment_incidents where id = p_incident_id;
  v_owed := coalesce(v_incident.kind, '') in ('unrecorded_payment', 'refund_not_created', 'currency_mismatch', 'mode_mismatch');
  v_action := case when v_owed then 'incident.resolve_money' else 'incident.resolve' end;
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, v_action, p_incident_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_incident from public.payment_incidents where id = p_incident_id for update;
  if not found then
    return public.admin_record(v_admin, v_action, null, 'incident', p_incident_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_incident.test_mode then 'test' else 'live' end;
  v_code := coalesce(public.admin_gate(v_admin, v_action, v_incident.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_incident.resolved_at is not null then v_code := 'ALREADY_RESOLVED'; end if;
  if v_code is null and v_owed then
    if p_outcome is null then
      v_code := 'OUTCOME_REQUIRED';
    elsif p_outcome = 'payment_recorded' then
      if v_incident.kind <> 'unrecorded_payment'
         or not exists (select 1 from public.payments p
                         where p.order_id = v_incident.order_id
                           and p.provider_reference = v_incident.provider_reference) then
        v_code := 'OUTCOME_NOT_MET';
      end if;
      v_evidence := jsonb_build_object('provider_reference', v_incident.provider_reference);
    elsif p_outcome = 'refund_completed' then
      if not exists (select 1 from public.refunds r
                      where r.id = p_refund_id and r.order_id is not distinct from v_incident.order_id
                        and r.status = 'completed') then
        v_code := 'OUTCOME_NOT_MET';
      end if;
      v_evidence := jsonb_build_object('refund_id', p_refund_id);
    elsif p_outcome = 'flw_refund_verified' then
      select * into v_check from public.flw_refund_checks c where c.id = p_check_id;
      if not (v_check.id is not null
              and v_check.target_type = 'incident'
              and v_check.target_id = p_incident_id::text
              and v_check.tx_id is not distinct from v_incident.provider_reference
              and v_incident.provider_reference is not null
              and v_check.test_mode = v_incident.test_mode
              and v_check.created_at > now() - interval '15 minutes'
              and public.admin_flw_check_done(v_check)) then
        v_code := 'OUTCOME_NOT_MET';
      end if;
      v_evidence := jsonb_build_object('check_id', p_check_id, 'flw_refund_id', v_check.flw_refund_id,
                                       'amount_kobo', v_check.amount_kobo);
    elsif p_outcome = 'handled_outside' then
      if v_admin.role <> 'owner' then
        v_code := 'ROLE';
      elsif not coalesce(p_confirmed, false) then
        v_code := 'OUTCOME_NOT_MET';
      end if;
      v_evidence := jsonb_build_object('confirmed', coalesce(p_confirmed, false));
    else
      v_code := 'OUTCOME_NOT_MET';
    end if;
  elsif v_code is null and coalesce(p_outcome, 'reviewed') <> 'reviewed' then
    v_code := 'OUTCOME_NOT_MET';
  end if;
  v_detail := jsonb_build_object('kind', v_incident.kind, 'order_id', v_incident.order_id,
                                 'outcome', coalesce(p_outcome, case when v_owed then null else 'reviewed' end),
                                 'evidence', v_evidence);
  if v_code is not null then
    return public.admin_record(v_admin, v_action, v_side, 'incident', p_incident_id::text, v_incident.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.resolve_payment_incident(p_incident_id, v_admin.label);
  exception when others then
    return public.admin_record(v_admin, v_action, v_side, 'incident', p_incident_id::text, v_incident.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, v_action, v_side, 'incident', p_incident_id::text, v_incident.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('resolved', true)));
end $$;

create function public.admin_retry_job(p_job_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'job.retry';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_job    public.jobs;
  v_refund public.refunds;
  v_after  public.jobs;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_job_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'job', p_job_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_job.test_mode then 'test' else 'live' end;
  if v_job.order_item_id is not null then
    select * into v_refund from public.refunds r
     where r.order_item_id = v_job.order_item_id and r.status <> 'cancelled'
     order by r.created_at desc limit 1;
  end if;
  v_detail := jsonb_build_object('kind', v_job.kind,
    'before', jsonb_build_object('status', v_job.status, 'last_error_code', v_job.last_error_code),
    'line_refund', case when v_refund.id is null then null
                        else jsonb_build_object('id', v_refund.id, 'status', v_refund.status) end);
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_job.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_job.status not in ('needs_attention', 'failed') then v_code := 'NOT_RETRYABLE'; end if;
  if v_code is null and v_job.kind = 'transfer_domain' and v_job.status = 'failed' then
    v_code := 'TRANSFER_CODE_GONE';
  end if;
  if v_code is null and v_job.kind in ('register_domain', 'renew_domain') and v_job.status = 'failed'
     and v_refund.id is not null
     and (v_refund.status in ('sending', 'submitted', 'completed') or v_refund.provider_refund_id is not null) then
    v_code := 'REFUND_AT_PROVIDER';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.retry_job(p_job_id);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  select * into v_after from public.jobs where id = p_job_id;
  if v_after.status <> 'queued' then
    return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'NOT_RETRIED', null, v_detail);
  end if;
  return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object(
      'status', v_after.status,
      'line_refund', (select jsonb_build_object('id', r.id, 'status', r.status) from public.refunds r
                       where r.id = v_refund.id))));
end $$;

create function public.admin_retry_ssl_job(p_job_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'ssl_job.retry';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_job    public.ssl_jobs;
  v_cert   public.ssl_certificates;
  v_refund public.refunds;
  v_after  public.ssl_jobs;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_job_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'ssl_job', p_job_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_job.test_mode then 'test' else 'live' end;
  select * into v_cert from public.ssl_certificates where id = v_job.certificate_id;
  if v_cert.order_item_id is not null then
    select * into v_refund from public.refunds r
     where r.order_item_id = v_cert.order_item_id and r.status <> 'cancelled'
     order by r.created_at desc limit 1;
  end if;
  v_detail := jsonb_build_object('kind', v_job.kind,
    'before', jsonb_build_object('status', v_job.status, 'last_error_code', v_job.last_error_code,
                                 'sent_at', v_job.sent_at),
    'line_refund', case when v_refund.id is null then null
                        else jsonb_build_object('id', v_refund.id, 'status', v_refund.status) end);
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_job.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_job.status not in ('needs_attention', 'failed') then v_code := 'NOT_RETRYABLE'; end if;
  if v_code is null and v_job.kind = 'ssl_initialize' and v_job.status = 'failed'
     and v_refund.id is not null
     and (v_refund.status in ('sending', 'submitted', 'completed') or v_refund.provider_refund_id is not null) then
    v_code := 'REFUND_AT_PROVIDER';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.retry_ssl_job(p_job_id);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  select * into v_after from public.ssl_jobs where id = p_job_id;
  if v_after.status <> 'queued' then
    return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'NOT_RETRIED', null, v_detail);
  end if;
  return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object(
      'status', v_after.status,
      'line_refund', (select jsonb_build_object('id', r.id, 'status', r.status) from public.refunds r
                       where r.id = v_refund.id))));
end $$;

-- Fail is the one way an admin ends a registry job, so it needs evidence:
-- a fresh registry read after the last attempt (READ_REGISTRY_FIRST), no
-- supplier charge for the name (LEDGER_SHOWS_CHARGE), and never for an
-- unlock (N14) or an unverified charge (D20).
create function public.admin_fail_job(p_job_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'job.fail';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_job     public.jobs;
  v_domain  public.domains;
  v_env     text;
  v_call_id bigint;
  v_last_at timestamptz;
  v_fail    text;
  v_code    text;
  v_detail  jsonb;
  v_side    text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_job_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'job', p_job_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_job.test_mode then 'test' else 'live' end;
  v_env := case when v_job.test_mode then 'ote' else 'production' end;
  select * into v_domain from public.domains where id = v_job.domain_id for update;
  v_detail := jsonb_build_object('kind', v_job.kind, 'line', v_job.order_item_id,
    'before', jsonb_build_object('status', v_job.status, 'last_error_code', v_job.last_error_code));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_job.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_job.status <> 'needs_attention' then v_code := 'NOT_NEEDS_ATTENTION'; end if;
  if v_code is null and coalesce(v_job.last_error_code, '') = 'PAYMENT_NOT_VERIFIED' then
    v_code := 'PAYMENT_NOT_VERIFIED';
  end if;
  if v_code is null and v_job.kind in ('renew_domain', 'apply_nameservers') then v_code := 'USE_RETRY'; end if;
  -- N14: stopping a pending unlock could hold a domain against a transfer-out.
  if v_code is null and v_job.kind = 'set_transfer_lock' and v_domain.pending_transfer_lock is distinct from true then
    v_code := 'TRANSFER_OUT_PROTECTED';
  end if;
  if v_code is null and v_job.kind = 'register_domain' then
    select max(c.created_at) into v_last_at from public.supplier_calls c
     where c.job_id = v_job.id and c.operation = 'RegisterWithContactInfo';
    select c.id into v_call_id from public.supplier_calls c
     where c.domain_name = v_domain.domain_name and c.environment = v_env
       and c.operation in ('GetDetails', 'AdminGetDetails') and c.outcome = 'not_found'
       and c.created_at > now() - interval '15 minutes'
       and c.created_at > coalesce(v_last_at, '-infinity'::timestamptz)
     order by c.created_at desc limit 1;
    if v_call_id is null then
      v_code := 'READ_REGISTRY_FIRST';
    elsif exists (select 1 from public.supplier_ledger_entries e
                   where e.test_mode = v_job.test_mode and e.product_type = 1 and e.delta_cents < 0
                     and e.occurred_at > v_job.created_at
                     and (lower(trim(e.description)) = lower(v_domain.domain_name::text)
                          or position(lower(v_domain.domain_name::text) in lower(e.description)) > 0)) then
      v_code := 'LEDGER_SHOWS_CHARGE';
    end if;
    v_fail := 'NOT_AT_REGISTRY';
  elsif v_code is null and v_job.kind = 'transfer_domain' then
    select max(c.created_at) into v_last_at from public.supplier_calls c
     where c.job_id = v_job.id and c.operation = 'Transfer';
    select c.id into v_call_id from public.supplier_calls c
     where c.domain_name = v_domain.domain_name and c.environment = v_env
       and c.operation = 'AdminTransferQuery' and c.outcome = 'ok'
       and c.message in ('rejected', 'cancelled')
       and c.created_at > now() - interval '15 minutes'
       and c.created_at > coalesce(v_last_at, '-infinity'::timestamptz)
     order by c.created_at desc limit 1;
    if v_call_id is null then v_code := 'READ_TRANSFER_FIRST'; end if;
    v_fail := 'TRANSFER_REFUSED';
  elsif v_code is null and v_job.kind in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    v_fail := 'STOPPED_BY_ADMIN';
  elsif v_code is null then
    v_code := 'USE_RETRY';
  end if;
  v_detail := v_detail || jsonb_build_object('call_id', v_call_id);
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.fail_job(p_job_id, v_fail, left(trim(p_reason), 500), false);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'job', p_job_id::text, v_job.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object(
      'status', (select j.status from public.jobs j where j.id = p_job_id),
      'code', v_fail,
      'refund_queued', (select jsonb_build_object('id', r.id, 'status', r.status) from public.refunds r
                         where v_job.order_item_id is not null and r.order_item_id = v_job.order_item_id
                           and r.status <> 'cancelled'
                         order by r.created_at desc limit 1))));
end $$;

create function public.admin_fail_ssl_job(p_job_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'ssl_job.fail';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_job    public.ssl_jobs;
  v_fail   text;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_job_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'ssl_job', p_job_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_job.test_mode then 'test' else 'live' end;
  v_detail := jsonb_build_object('kind', v_job.kind, 'sent_at', v_job.sent_at,
    'before', jsonb_build_object('status', v_job.status, 'last_error_code', v_job.last_error_code));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_job.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_job.status <> 'needs_attention' then v_code := 'NOT_NEEDS_ATTENTION'; end if;
  if v_code is null and coalesce(v_job.last_error_code, '') = 'PAYMENT_NOT_VERIFIED' then
    v_code := 'PAYMENT_NOT_VERIFIED';
  end if;
  -- N3: once the order may have reached the supplier, only reading settles it.
  if v_code is null and v_job.kind = 'ssl_initialize' and v_job.sent_at is not null then
    v_code := 'ALREADY_SENT';
  end if;
  v_fail := case when v_job.kind = 'ssl_initialize' then 'FAILED_BY_ADMIN' else 'STOPPED_BY_ADMIN' end;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.fail_ssl_job(p_job_id, v_fail, left(trim(p_reason), 500), false);
  exception when others then
    return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, v_side, 'ssl_job', p_job_id::text, v_job.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object(
      'status', (select j.status from public.ssl_jobs j where j.id = p_job_id), 'code', v_fail)));
end $$;

create function public.admin_activate_fx_rate(p_rate_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'fx.activate';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_rate   public.fx_rates;
  v_active public.fx_rates;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_rate_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_rate from public.fx_rates where id = p_rate_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  select * into v_active from public.fx_rates
   where base = v_rate.base and quote = v_rate.quote and status = 'active'
   order by effective_from desc nulls last limit 1;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('costing_rate', v_active.costing_rate, 'quoted_at', v_active.quoted_at),
    'rate', jsonb_build_object('costing_rate', v_rate.costing_rate, 'quoted_at', v_rate.quoted_at,
                               'source', v_rate.source, 'status', v_rate.status),
    'move_pct', case when v_active.costing_rate > 0
                     then round((v_rate.costing_rate / v_active.costing_rate - 1) * 100, 2) end);
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and v_rate.status <> 'pending_review' then v_code := 'NOT_PENDING'; end if;
  if v_code is null and not (v_rate.quoted_at > now() - interval '48 hours') then v_code := 'RATE_TOO_OLD'; end if;
  if v_code is null and v_active.id is not null and v_active.quoted_at >= v_rate.quoted_at then
    v_code := 'NEWER_RATE_ACTIVE';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.activate_fx_rate(p_rate_id, v_admin.user_id);
  exception when others then
    return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('status', 'active', 'costing_rate', v_rate.costing_rate)));
end $$;

create function public.admin_reject_fx_rate(p_rate_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'fx.reject';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_rate   public.fx_rates;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_rate_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_rate from public.fx_rates where id = p_rate_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('rate', jsonb_build_object('costing_rate', v_rate.costing_rate,
                                 'source', v_rate.source, 'quoted_at', v_rate.quoted_at, 'status', v_rate.status));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and v_rate.status <> 'pending_review' then v_code := 'NOT_PENDING'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  update public.fx_rates set status = 'rejected', reviewed_by = v_admin.user_id, reviewed_at = now()
   where id = p_rate_id;
  return public.admin_record(v_admin, c_action, 'global', 'fx_rate', p_rate_id::text, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('status', 'rejected')));
end $$;

-- A JSON value as an exact number with at most p_scale decimals, or null.
create function public.admin_json_number(p_value jsonb, p_scale integer)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return null;
  end if;
  v := (p_value #>> '{}')::numeric;
  if v <> round(v, p_scale) then
    return null;
  end if;
  return v;
end;
$$;

-- pricing.update (owner, money). VAT is statutory and is not a key here.
create function public.admin_update_pricing_settings(p_changes jsonb, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'pricing.update';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_now    public.pricing_settings;
  v_key    text;
  v_num    numeric;
  v_code   text;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, 'pricing_settings');
  if v_prior is not null then return v_prior; end if;
  select * into v_now from public.pricing_settings where id for update;
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and (p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb) then
    v_code := 'NO_CHANGES';
  end if;
  if v_code is null then
    for v_key in select jsonb_object_keys(p_changes) loop
      if v_key not in ('margin_ngn', 'fx_buffer_pct', 'icann_fee_cents', 'fx_move_threshold_pct') then
        v_code := 'UNKNOWN_KEY';
        exit;
      end if;
      v_num := case v_key
                 when 'margin_ngn' then public.admin_json_number(p_changes -> v_key, 0)
                 when 'icann_fee_cents' then public.admin_json_number(p_changes -> v_key, 0)
                 else public.admin_json_number(p_changes -> v_key, 2)
               end;
      if v_num is null
         or (v_key = 'margin_ngn' and v_num not between 1000 and 50000)
         or (v_key = 'fx_buffer_pct' and v_num not between 0 and 20)
         or (v_key = 'icann_fee_cents' and v_num not between 0 and 200)
         or (v_key = 'fx_move_threshold_pct' and v_num not between 1 and 50) then
        v_code := 'OUT_OF_RANGE';
        exit;
      end if;
      v_before := v_before || jsonb_build_object(v_key, case v_key
                    when 'margin_ngn' then to_jsonb(v_now.margin_ngn)
                    when 'fx_buffer_pct' then to_jsonb(v_now.fx_buffer_pct)
                    when 'icann_fee_cents' then to_jsonb(round(v_now.icann_fee_usd * 100)::bigint)
                    else to_jsonb(v_now.fx_move_threshold_pct) end);
      v_after := v_after || jsonb_build_object(v_key, v_num);
    end loop;
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'pricing_settings', 'pricing_settings', null,
                               p_reason, p_request_key, 'refused', v_code, null,
                               jsonb_build_object('keys', (select coalesce(jsonb_agg(k), '[]'::jsonb)
                                                             from jsonb_object_keys(case when jsonb_typeof(p_changes) = 'object'
                                                                                         then p_changes else '{}'::jsonb end) k)));
  end if;
  update public.pricing_settings
     set margin_ngn = coalesce((v_after ->> 'margin_ngn')::numeric, margin_ngn),
         fx_buffer_pct = coalesce((v_after ->> 'fx_buffer_pct')::numeric, fx_buffer_pct),
         icann_fee_usd = coalesce((v_after ->> 'icann_fee_cents')::numeric / 100, icann_fee_usd),
         fx_move_threshold_pct = coalesce((v_after ->> 'fx_move_threshold_pct')::numeric, fx_move_threshold_pct),
         updated_at = now(), updated_by = v_admin.user_id
   where id;
  return public.admin_record(v_admin, c_action, 'global', 'pricing_settings', 'pricing_settings', null,
    p_reason, p_request_key, 'ok', null, null, jsonb_build_object('before', v_before, 'after', v_after));
end $$;

-- settings.update / settings.refund_limit_raise (owner, money), within hard
-- ceilings: ₦1,000,000 a refund, ₦5,000,000 a day, at least 5 minutes' delay.
create function public.admin_update_ops_settings(p_changes jsonb, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_action text := 'settings.update';
  v_prior  jsonb;
  v_now    public.ops_settings;
  v_key    text;
  v_num    numeric;
  v_code   text;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
  v_single numeric;
  v_daily  numeric;
  v_new    numeric;
  v_trust  numeric;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, v_action, 'ops_settings');
  if v_prior is not null then return v_prior; end if;
  select * into v_now from public.ops_settings where id for update;
  v_code := coalesce(public.admin_gate(v_admin, v_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and (p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb) then
    v_code := 'NO_CHANGES';
  end if;
  if v_code is null then
    for v_key in select jsonb_object_keys(p_changes) loop
      if v_key not in ('auto_refund_max_kobo', 'auto_refund_daily_max_kobo', 'refund_delay_minutes',
                       'stuck_order_minutes', 'max_domains_per_account_day', 'float_alert_cents',
                       'velocity_new_max', 'velocity_trusted_max', 'velocity_standard_after_days',
                       'velocity_trusted_after_days', 'velocity_trusted_after_paid_orders') then
        v_code := 'UNKNOWN_KEY';
        exit;
      end if;
      v_num := public.admin_json_number(p_changes -> v_key, 0);
      if v_num is null
         or (v_key = 'auto_refund_max_kobo' and v_num not between 1 and 100000000)
         or (v_key = 'auto_refund_daily_max_kobo' and v_num not between 1 and 500000000)
         or (v_key = 'refund_delay_minutes' and v_num not between 5 and 1440)
         or (v_key = 'stuck_order_minutes' and v_num not between 5 and 1440)
         or (v_key = 'max_domains_per_account_day' and v_num not between 1 and 1000)
         or (v_key = 'float_alert_cents' and v_num not between 0 and 1000000)
         or (v_key = 'velocity_new_max' and v_num not between 1 and 1000)
         or (v_key = 'velocity_trusted_max' and v_num not between 1 and 5000)
         or (v_key = 'velocity_standard_after_days' and v_num not between 0 and 365)
         or (v_key = 'velocity_trusted_after_days' and v_num not between 0 and 3650)
         or (v_key = 'velocity_trusted_after_paid_orders' and v_num not between 0 and 1000) then
        v_code := 'OUT_OF_RANGE';
        exit;
      end if;
      v_before := v_before || jsonb_build_object(v_key, (case v_key
                    when 'float_alert_cents' then to_jsonb(round(v_now.float_alert_usd * 100)::bigint)
                    else to_jsonb(v_now) -> v_key end));
      v_after := v_after || jsonb_build_object(v_key, v_num);
    end loop;
  end if;
  if v_code is null then
    v_single := coalesce((v_after ->> 'auto_refund_max_kobo')::numeric, v_now.auto_refund_max_kobo);
    v_daily := coalesce((v_after ->> 'auto_refund_daily_max_kobo')::numeric, v_now.auto_refund_daily_max_kobo);
    v_new := coalesce((v_after ->> 'velocity_new_max')::numeric, v_now.velocity_new_max);
    v_trust := coalesce((v_after ->> 'velocity_trusted_max')::numeric, v_now.velocity_trusted_max);
    if v_daily < v_single or v_trust < v_new then
      v_code := 'OUT_OF_RANGE';
    end if;
  end if;
  if v_code is null
     and (coalesce((v_after ->> 'auto_refund_max_kobo')::numeric, v_now.auto_refund_max_kobo) > v_now.auto_refund_max_kobo
          or coalesce((v_after ->> 'auto_refund_daily_max_kobo')::numeric, v_now.auto_refund_daily_max_kobo) > v_now.auto_refund_daily_max_kobo
          or coalesce((v_after ->> 'refund_delay_minutes')::numeric, v_now.refund_delay_minutes) < v_now.refund_delay_minutes) then
    v_action := 'settings.refund_limit_raise';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, v_action, 'global', 'ops_settings', 'ops_settings', null,
                               p_reason, p_request_key, 'refused', v_code, null,
                               jsonb_build_object('keys', (select coalesce(jsonb_agg(k), '[]'::jsonb)
                                                             from jsonb_object_keys(case when jsonb_typeof(p_changes) = 'object'
                                                                                         then p_changes else '{}'::jsonb end) k)));
  end if;
  update public.ops_settings
     set auto_refund_max_kobo = coalesce((v_after ->> 'auto_refund_max_kobo')::bigint, auto_refund_max_kobo),
         auto_refund_daily_max_kobo = coalesce((v_after ->> 'auto_refund_daily_max_kobo')::bigint, auto_refund_daily_max_kobo),
         refund_delay_minutes = coalesce((v_after ->> 'refund_delay_minutes')::integer, refund_delay_minutes),
         stuck_order_minutes = coalesce((v_after ->> 'stuck_order_minutes')::integer, stuck_order_minutes),
         max_domains_per_account_day = coalesce((v_after ->> 'max_domains_per_account_day')::integer, max_domains_per_account_day),
         float_alert_usd = coalesce((v_after ->> 'float_alert_cents')::numeric / 100, float_alert_usd),
         velocity_new_max = coalesce((v_after ->> 'velocity_new_max')::integer, velocity_new_max),
         velocity_trusted_max = coalesce((v_after ->> 'velocity_trusted_max')::integer, velocity_trusted_max),
         velocity_standard_after_days = coalesce((v_after ->> 'velocity_standard_after_days')::integer, velocity_standard_after_days),
         velocity_trusted_after_days = coalesce((v_after ->> 'velocity_trusted_after_days')::integer, velocity_trusted_after_days),
         velocity_trusted_after_paid_orders = coalesce((v_after ->> 'velocity_trusted_after_paid_orders')::integer, velocity_trusted_after_paid_orders)
   where id;
  return public.admin_record(v_admin, v_action, 'global', 'ops_settings', 'ops_settings', null,
    p_reason, p_request_key, 'ok', null, null, jsonb_build_object('before', v_before, 'after', v_after));
end $$;

create function public.admin_set_tld_flags(p_name text, p_is_paused boolean, p_paused_reason text,
                                           p_featured_rank integer, p_featured_tagline text, p_reason text,
                                           p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'extension.flags';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_name   text := lower(trim(coalesce(p_name, '')));
  v_tld    public.tlds;
  v_paused boolean;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, v_name);
  if v_prior is not null then return v_prior; end if;
  select * into v_tld from public.tlds where name = v_name for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'tld', left(v_name, 200), null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_paused := coalesce(p_is_paused, v_tld.is_paused);
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('is_paused', v_tld.is_paused, 'paused_reason', v_tld.paused_reason,
                                 'featured_rank', v_tld.featured_rank, 'featured_tagline', v_tld.featured_tagline),
    'held_domains', (select count(*) from public.domains d
                      where d.tld = v_tld.name and d.source <> 'demo'
                        and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and v_paused and char_length(trim(coalesce(p_paused_reason, ''))) not between 3 and 120 then
    v_code := 'PAUSE_REASON';
  end if;
  if v_code is null and p_featured_rank is not null and p_featured_rank not between 1 and 50 then
    v_code := 'OUT_OF_RANGE';
  end if;
  if v_code is null and char_length(coalesce(p_featured_tagline, '')) > 60 then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'tld', v_tld.name, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  update public.tlds
     set is_paused = v_paused,
         paused_reason = case when v_paused then trim(p_paused_reason) else null end,
         featured_rank = p_featured_rank,
         featured_tagline = nullif(trim(coalesce(p_featured_tagline, '')), '')
   where name = v_tld.name;
  return public.admin_record(v_admin, c_action, 'global', 'tld', v_tld.name, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('is_paused', t.is_paused,
                 'paused_reason', t.paused_reason, 'featured_rank', t.featured_rank,
                 'featured_tagline', t.featured_tagline) from public.tlds t where t.name = v_tld.name)));
end $$;

create function public.admin_set_ssl_sellable(p_product_code text, p_sellable boolean, p_reason text,
                                              p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'ssl_product.sellable';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_product public.ssl_products;
  v_code    text;
  v_detail  jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_product_code);
  if v_prior is not null then return v_prior; end if;
  select * into v_product from public.ssl_products where product_code = p_product_code for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'ssl_product', left(p_product_code, 200), null,
                               p_reason, p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('before', jsonb_build_object('is_sellable', v_product.is_sellable));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and p_sellable is null then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is null and p_sellable and v_product.create_usd is null then v_code := 'NO_PRICE'; end if;
  if v_code is null then
    begin
      update public.ssl_products set is_sellable = p_sellable where product_code = p_product_code;
    exception when check_violation then
      v_code := 'INCOMPLETE_PRODUCT';
    end;
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'ssl_product', p_product_code, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  return public.admin_record(v_admin, c_action, 'global', 'ssl_product', p_product_code, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('is_sellable', p_sellable)));
end $$;

-- The host of an https URL, lower-cased; null when it carries a user or port.
create function public.admin_url_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(substring(coalesce(p_url, '') from '^https://([A-Za-z0-9.-]+)(?:[/?#]|$)'))
$$;

create function public.admin_save_preset_draft(p_preset_id uuid, p_provider text, p_nameservers text[],
                                               p_source_url text, p_notes text, p_assigns_per_zone boolean,
                                               p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'preset.draft_save';
  v_admin    public.admins := public.admin_session('viewer', null, false);
  v_prior    jsonb;
  v_preset   public.nameserver_presets;
  v_provider text;
  v_hosts    text[];
  v_per_zone boolean := coalesce(p_assigns_per_zone, false);
  v_host     text := public.admin_url_host(p_source_url);
  v_code     text;
  v_detail   jsonb;
  v_draft    uuid;
  v_target   text := coalesce(p_preset_id::text, 'new:' || lower(trim(coalesce(p_provider, ''))));
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, v_target);
  if v_prior is not null then return v_prior; end if;
  if p_preset_id is not null then
    select * into v_preset from public.nameserver_presets where id = p_preset_id for update;
    if not found then
      return public.admin_record(v_admin, c_action, 'global', 'preset', v_target, null, p_reason,
                                 p_request_key, 'refused', 'NOT_FOUND', null, '{}');
    end if;
    v_provider := v_preset.provider;
  else
    v_provider := trim(coalesce(p_provider, ''));
  end if;
  select coalesce(array_agg(lower(trim(h)) order by ord), '{}') into v_hosts
    from unnest(coalesce(p_nameservers, '{}')) with ordinality as n(h, ord);
  v_detail := jsonb_build_object('provider', v_provider, 'source_host', v_host,
    'before', jsonb_build_object('nameservers', v_preset.nameservers),
    'after', jsonb_build_object('nameservers', v_hosts));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and char_length(v_provider) not between 2 and 60 then v_code := 'PROVIDER'; end if;
  if v_code is null and v_preset.registrar_default_for is not null then v_code := 'REGISTRAR_DEFAULT'; end if;
  if v_code is null and p_preset_id is null
     and exists (select 1 from public.nameserver_presets p where lower(p.provider) = lower(v_provider)) then
    v_code := 'PROVIDER_EXISTS';
  end if;
  if v_code is null and (v_host is null or char_length(p_source_url) > 500
       or not exists (select 1 from public.nameserver_preset_sources s
                       where lower(s.provider) = lower(v_provider) and s.host = v_host)) then
    v_code := 'SOURCE_NOT_ALLOWED';
  end if;
  if v_code is null and not public.are_hostnames(v_hosts) then v_code := 'NOT_HOSTNAMES'; end if;
  if v_code is null and ((not v_per_zone and cardinality(v_hosts) not between 2 and 13)
                         or (v_per_zone and cardinality(v_hosts) <> 0)) then
    v_code := 'NAMESERVER_COUNT';
  end if;
  if v_code is null and char_length(coalesce(p_notes, '')) > 500 then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is null and exists (select 1 from public.nameserver_preset_drafts d
                                 where d.published_at is null and d.discarded_at is null
                                   and (d.preset_id = p_preset_id or lower(d.provider) = lower(v_provider))) then
    v_code := 'DRAFT_OPEN';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'preset', v_target, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  insert into public.nameserver_preset_drafts (preset_id, provider, nameservers, source_url, notes,
                                               assigns_per_zone, saved_by)
  values (p_preset_id, v_provider, v_hosts, p_source_url, nullif(trim(coalesce(p_notes, '')), ''),
          v_per_zone, v_admin.label)
  returning id into v_draft;
  return public.admin_record(v_admin, c_action, 'global', 'preset', v_target, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('draft_id', v_draft,
                                   'after', jsonb_build_object('nameservers', v_hosts, 'draft_id', v_draft)));
end $$;

create function public.admin_publish_preset_draft(p_draft_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'preset.publish';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_draft  public.nameserver_preset_drafts;
  v_preset public.nameserver_presets;
  v_id     uuid;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_draft_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_draft from public.nameserver_preset_drafts where id = p_draft_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  if v_draft.preset_id is not null then
    select * into v_preset from public.nameserver_presets where id = v_draft.preset_id for update;
  end if;
  v_detail := jsonb_build_object('provider', v_draft.provider, 'checked_at', v_draft.checked_at,
    'before', jsonb_build_object('nameservers', v_preset.nameservers),
    'after', jsonb_build_object('nameservers', v_draft.nameservers));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and (v_draft.published_at is not null or v_draft.discarded_at is not null) then
    v_code := 'NOT_OPEN';
  end if;
  if v_code is null and v_preset.registrar_default_for is not null then v_code := 'REGISTRAR_DEFAULT'; end if;
  if v_code is null and not exists (select 1 from public.nameserver_preset_sources s
                                     where lower(s.provider) = lower(v_draft.provider)
                                       and s.host = public.admin_url_host(v_draft.source_url)) then
    v_code := 'SOURCE_NOT_ALLOWED';
  end if;
  if v_code is null and not v_draft.assigns_per_zone
     and not (coalesce(v_draft.check_ok, false) and v_draft.checked_at > v_draft.saved_at) then
    v_code := 'NOT_CHECKED';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    if v_draft.preset_id is not null then
      update public.nameserver_presets
         set nameservers = v_draft.nameservers, source_url = v_draft.source_url, notes = v_draft.notes,
             assigns_per_zone = v_draft.assigns_per_zone, verified_at = now(),
             last_checked_at = coalesce(v_draft.checked_at, last_checked_at),
             check_failed_since = case when coalesce(v_draft.check_ok, false) then null else check_failed_since end,
             last_check = coalesce(v_draft.check_detail, last_check)
       where id = v_draft.preset_id;
      v_id := v_draft.preset_id;
    else
      insert into public.nameserver_presets (provider, nameservers, assigns_per_zone, notes, source_url,
                                             verified_at, last_checked_at, last_check, is_hidden)
      values (v_draft.provider, v_draft.nameservers, v_draft.assigns_per_zone, v_draft.notes, v_draft.source_url,
              now(), v_draft.checked_at, v_draft.check_detail, false)
      returning id into v_id;
    end if;
  exception when others then
    return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null,
                               p_reason, p_request_key, 'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  update public.nameserver_preset_drafts set published_at = now(), preset_id = v_id where id = p_draft_id;
  return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('preset_id', v_id,
                                   'after', jsonb_build_object('nameservers', v_draft.nameservers, 'preset_id', v_id)));
end $$;

create function public.admin_discard_preset_draft(p_draft_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'preset.draft_discard';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_draft  public.nameserver_preset_drafts;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_draft_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_draft from public.nameserver_preset_drafts where id = p_draft_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('provider', v_draft.provider);
  v_code := public.admin_gate(v_admin, c_action, false);
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then v_code := 'REASON'; end if;
  if v_code is null and (v_draft.published_at is not null or v_draft.discarded_at is not null) then
    v_code := 'NOT_OPEN';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  update public.nameserver_preset_drafts set discarded_at = now() where id = p_draft_id;
  return public.admin_record(v_admin, c_action, 'global', 'preset_draft', p_draft_id::text, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('discarded', true)));
end $$;

-- Hide (operator) narrows what customers see; show (owner, money) widens it.
create function public.admin_set_preset_hidden(p_id uuid, p_hidden boolean, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_action text := case when coalesce(p_hidden, true) then 'preset.hide' else 'preset.show' end;
  v_prior  jsonb;
  v_preset public.nameserver_presets;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, v_action, p_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_preset from public.nameserver_presets where id = p_id for update;
  if not found then
    return public.admin_record(v_admin, v_action, 'global', 'preset', p_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('provider', v_preset.provider,
    'before', jsonb_build_object('is_hidden', v_preset.is_hidden, 'nameservers', v_preset.nameservers),
    'after', jsonb_build_object('nameservers', v_preset.nameservers),
    'blast_radius', jsonb_build_object(
      'domains', (select count(*) from public.domains d where d.nameserver_preset_id = p_id and d.source <> 'demo'),
      'orders', (select count(*) from public.orders o where o.nameserver_preset_id = p_id),
      'lines', (select count(*) from public.order_items oi where oi.nameserver_preset_id = p_id)));
  v_code := public.admin_gate(v_admin, v_action, false);
  if v_code is null and v_action = 'preset.show' then
    v_code := public.admin_reason_problem(p_reason);
  elsif v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then
    v_code := 'REASON';
  end if;
  if v_code is null and v_preset.registrar_default_for is not null then v_code := 'REGISTRAR_DEFAULT'; end if;
  if v_code is null and v_action = 'preset.show' and v_preset.auto_hidden_at is not null then
    v_code := 'CHECKER_HID_IT';
  end if;
  if v_code is null and v_preset.is_hidden = coalesce(p_hidden, true) then v_code := 'NO_CHANGE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, v_action, 'global', 'preset', p_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  update public.nameserver_presets set is_hidden = coalesce(p_hidden, true) where id = p_id;
  return public.admin_record(v_admin, v_action, 'global', 'preset', p_id::text, null,
    p_reason, p_request_key, 'ok', null, null,
    jsonb_set(v_detail, '{after}', jsonb_build_object('is_hidden', coalesce(p_hidden, true),
                                                      'nameservers', v_preset.nameservers)));
end $$;

create function public.admin_requeue_email(p_email_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'email.requeue';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_email  public.email_outbox;
  v_code   text;
  v_detail jsonb;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_email_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_email from public.email_outbox where id = p_email_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'email', p_email_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_email.test_mode then 'test' else 'live' end;
  v_detail := jsonb_build_object('kind', v_email.kind, 'category', v_email.category,
                                 'before', jsonb_build_object('status', v_email.status));
  v_code := public.admin_gate(v_admin, c_action, v_email.test_mode);
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then v_code := 'REASON'; end if;
  if v_code is null and v_email.status <> 'failed' then v_code := 'NOT_FAILED'; end if;
  if v_code is null and v_email.complained_at is not null then v_code := 'COMPLAINED'; end if;
  if v_code is null and coalesce(v_email.delivery_status, '') = 'bounced' then v_code := 'BOUNCED'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'email', p_email_id::text, v_email.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  update public.email_outbox
     set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null,
         claimed_by = null, claimed_at = null
   where id = p_email_id;
  return public.admin_record(v_admin, c_action, v_side, 'email', p_email_id::text, v_email.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('status', 'pending')));
end $$;

create function public.admin_queue_deep_sync(p_domain_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'domain.deep_sync';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_domain public.domains;
  v_code   text;
  v_side   text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_domain_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_domain from public.domains where id = p_domain_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'domain', p_domain_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_domain.test_mode then 'test' else 'live' end;
  v_code := public.admin_gate(v_admin, c_action, v_domain.test_mode);
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then v_code := 'REASON'; end if;
  if v_code is null and (v_domain.source = 'demo'
                         or v_domain.local_status not in ('active', 'expired_grace', 'redemption')) then
    v_code := 'NOT_SYNCABLE';
  end if;
  if v_code is null and not exists (
       select 1 from public.service_heartbeats h
        where h.name = case when v_domain.test_mode then 'gateway:ote' else 'gateway:production' end
          and h.beat_at > now() - interval '15 minutes') then
    v_code := 'NO_GATEWAY';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'domain', p_domain_id::text, v_domain.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null,
                               jsonb_build_object('domain_id', p_domain_id));
  end if;
  update public.domains set deep_checked_at = null where id = p_domain_id;
  return public.admin_record(v_admin, c_action, v_side, 'domain', p_domain_id::text, v_domain.test_mode,
    p_reason, p_request_key, 'ok', null, null,
    jsonb_build_object('domain_id', p_domain_id, 'after', jsonb_build_object('queued', true)));
end $$;

-- 30 searches and reveals per admin per hour, shared by the three lookups
-- that return personal data.
create function public.admin_lookup_rate_limited(p_admin_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= 30
    from public.admin_audit_log a
   where a.admin_id = p_admin_id
     and a.action in ('customer.search', 'customer.reveal', 'domain.reveal_contacts')
     and a.outcome = 'ok'
     and a.created_at > now() - interval '1 hour'
$$;

-- customer.search: an exact email, order number or domain; masked rows only.
-- The query itself is never stored (N13).
create function public.admin_find_customers(p_query text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'customer.search';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_query  text := lower(trim(coalesce(p_query, '')));
  v_kind   text;
  v_ids    uuid[];
  v_code   text;
  v_rows   jsonb;
  v_out    jsonb;
begin
  v_code := public.admin_gate(v_admin, c_action, true);
  if v_code is null and public.admin_lookup_rate_limited(v_admin.user_id) then v_code := 'RATE_LIMITED'; end if;
  if v_code is null and char_length(v_query) not between 3 and 254 then v_code := 'BAD_QUERY'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, case when v_admin.test_only then 'test' else 'global' end,
                               'customer_search', null, null, null, null, 'refused', v_code, null, '{}');
  end if;
  if position('@' in v_query) > 0 then
    v_kind := 'email';
    select array_agg(p.id) into v_ids from public.profiles p where lower(p.email::text) = v_query;
  elsif v_query ~ '^[a-z]{2,4}-[0-9a-z-]+$' and exists (select 1 from public.orders o where lower(o.order_number) = v_query) then
    v_kind := 'order';
    select array_agg(distinct o.user_id) into v_ids from public.orders o where lower(o.order_number) = v_query;
  else
    v_kind := 'domain';
    select array_agg(distinct d.user_id) into v_ids from public.domains d where d.domain_name = v_query;
  end if;
  select coalesce(jsonb_agg(r order by r ->> 'joinedAt' desc), '[]'::jsonb), array_agg((r ->> 'userId')::uuid)
    into v_rows, v_ids
    from (
      select jsonb_build_object(
               'userId', p.id,
               'maskedEmail', public.admin_mask_email(p.email::text),
               'joinedAt', p.created_at,
               'domainsHeld', (select count(*) from public.domains d
                                where d.user_id = p.id and d.source <> 'demo' and d.test_mode = v_admin.test_only
                                  and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')),
               'ordersPaid', (select count(*) from public.orders o
                               where o.user_id = p.id and o.paid_at is not null and o.test_mode = v_admin.test_only)) as r
        from public.profiles p
       where p.id = any (coalesce(v_ids, '{}'))
         and (not v_admin.test_only or public.is_reserved_email(p.email::text))
       order by p.created_at desc
       limit 20
    ) s;
  v_out := public.admin_record(v_admin, c_action, case when v_admin.test_only then 'test' else 'global' end,
                               'customer_search', null, null, null, null, 'ok', null, null,
                               jsonb_build_object('kind', v_kind, 'matched', coalesce(to_jsonb(v_ids), '[]'::jsonb)));
  return v_out || jsonb_build_object('rows', v_rows);
end $$;

create function public.admin_reveal_customer(p_user_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'customer.reveal';
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_prior   jsonb;
  v_profile public.profiles;
  v_code    text;
  v_contact jsonb;
begin
  -- D4: a repeated key answers with the recorded result only. Details are
  -- shown only after the gate, the rate limit and a new audit row, so a key
  -- kept from before a demotion or the limit shows nothing; take a new one.
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_user_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_profile from public.profiles where id = p_user_id;
  if found then
    v_contact := jsonb_build_object('email', v_profile.email, 'fullName', v_profile.full_name,
                                    'phone', v_profile.phone, 'businessName', v_profile.business_name);
  end if;
  if v_profile.id is null then
    return public.admin_record(v_admin, c_action, null, 'customer', p_user_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_code := public.admin_gate(v_admin, c_action, public.is_reserved_email(v_profile.email::text));
  if v_code is null and public.admin_lookup_rate_limited(v_admin.user_id) then v_code := 'RATE_LIMITED'; end if;
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then v_code := 'REASON'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'customer', p_user_id::text, null,
                               p_reason, p_request_key, 'refused', v_code, null, '{}');
  end if;
  return public.admin_record(v_admin, c_action, 'global', 'customer', p_user_id::text, null,
                             p_reason, p_request_key, 'ok', null, null, '{}')
         || jsonb_build_object('contact', v_contact);
end $$;

create function public.admin_reveal_registrant(p_domain_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'domain.reveal_contacts';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_domain public.domains;
  v_code   text;
  v_side   text;
  v_out    jsonb;
begin
  -- As admin_reveal_customer: a replay carries no contact details.
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_domain_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_domain from public.domains where id = p_domain_id;
  if found then
    v_out := jsonb_build_object('registrant', v_domain.registrant, 'contacts', v_domain.contacts);
  end if;
  if v_domain.id is null then
    return public.admin_record(v_admin, c_action, null, 'domain', p_domain_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_domain.test_mode then 'test' else 'live' end;
  v_code := public.admin_gate(v_admin, c_action, v_domain.test_mode);
  if v_code is null and public.admin_lookup_rate_limited(v_admin.user_id) then v_code := 'RATE_LIMITED'; end if;
  if v_code is null and p_reason is not null and char_length(trim(p_reason)) > 500 then v_code := 'REASON'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'domain', p_domain_id::text, v_domain.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, '{}');
  end if;
  return public.admin_record(v_admin, c_action, v_side, 'domain', p_domain_id::text, v_domain.test_mode,
                             p_reason, p_request_key, 'ok', null, null, '{}')
         || v_out;
end $$;

-- ── 8. Grants (§3.0) ────────────────────────────────────────────────────────
-- Supabase's default privileges grant every new function to anon. Revoke all,
-- then grant to at most one role.

revoke all on function public.admins_factor_is_theirs() from public, anon, authenticated, service_role;
revoke all on function public.admins_log_change() from public, anon, authenticated, service_role;
revoke all on function public.admin_changes_final() from public, anon, authenticated, service_role;
revoke all on function public.admin_audit_is_final() from public, anon, authenticated, service_role;
revoke all on function public.append_only_final() from public, anon, authenticated, service_role;
revoke all on function public.admin_tier(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_session(text, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_gate(public.admins, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_status() from public, anon, authenticated, service_role;
revoke all on function public.admin_whoami(integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_replay(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_record(public.admins, text, text, text, text, boolean, text, uuid, text, text, text, jsonb, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_reason_problem(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_mask_email(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_note(text, text, text, text, jsonb, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_claim_note(bigint, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_note_result(bigint, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_redact_reason(bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.purge_test_admin_audit() from public, anon, authenticated, service_role;
revoke all on function public.grant_test_admin(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_flw_refund_check(bigint, boolean, text, text, text, text, bigint, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.preset_drafts_for_check() from public, anon, authenticated, service_role;
revoke all on function public.record_preset_draft_check(uuid, boolean, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_flw_check_done(public.flw_refund_checks) from public, anon, authenticated, service_role;
revoke all on function public.admin_json_number(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_url_host(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_lookup_rate_limited(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_approve_refund(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_retry_refund(uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_cancel_refund(uuid, boolean, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_record_manual_refund(uuid, bigint, text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_payment_incident(bigint, text, uuid, bigint, boolean, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_retry_job(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_retry_ssl_job(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_fail_job(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_fail_ssl_job(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_activate_fx_rate(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_reject_fx_rate(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_update_pricing_settings(jsonb, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_update_ops_settings(jsonb, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_tld_flags(text, boolean, text, integer, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_ssl_sellable(text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_preset_draft(uuid, text, text[], text, text, boolean, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_publish_preset_draft(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_discard_preset_draft(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_preset_hidden(uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_requeue_email(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_queue_deep_sync(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_find_customers(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_reveal_customer(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_reveal_registrant(uuid, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.admin_status() to authenticated;
grant execute on function public.admin_whoami(integer) to authenticated;
grant execute on function public.admin_note(text, text, text, text, jsonb, text, uuid) to authenticated;
grant execute on function public.admin_redact_reason(bigint, text, uuid) to authenticated;
grant execute on function public.admin_approve_refund(uuid, text, uuid) to authenticated;
grant execute on function public.admin_retry_refund(uuid, boolean, text, uuid) to authenticated;
grant execute on function public.admin_cancel_refund(uuid, boolean, boolean, text, uuid) to authenticated;
grant execute on function public.admin_record_manual_refund(uuid, bigint, text, boolean, text, uuid) to authenticated;
grant execute on function public.admin_resolve_payment_incident(bigint, text, uuid, bigint, boolean, text, uuid) to authenticated;
grant execute on function public.admin_retry_job(uuid, text, uuid) to authenticated;
grant execute on function public.admin_retry_ssl_job(uuid, text, uuid) to authenticated;
grant execute on function public.admin_fail_job(uuid, text, uuid) to authenticated;
grant execute on function public.admin_fail_ssl_job(uuid, text, uuid) to authenticated;
grant execute on function public.admin_activate_fx_rate(uuid, text, uuid) to authenticated;
grant execute on function public.admin_reject_fx_rate(uuid, text, uuid) to authenticated;
grant execute on function public.admin_update_pricing_settings(jsonb, text, uuid) to authenticated;
grant execute on function public.admin_update_ops_settings(jsonb, text, uuid) to authenticated;
grant execute on function public.admin_set_tld_flags(text, boolean, text, integer, text, text, uuid) to authenticated;
grant execute on function public.admin_set_ssl_sellable(text, boolean, text, uuid) to authenticated;
grant execute on function public.admin_save_preset_draft(uuid, text, text[], text, text, boolean, text, uuid) to authenticated;
grant execute on function public.admin_publish_preset_draft(uuid, text, uuid) to authenticated;
grant execute on function public.admin_discard_preset_draft(uuid, text, uuid) to authenticated;
grant execute on function public.admin_set_preset_hidden(uuid, boolean, text, uuid) to authenticated;
grant execute on function public.admin_requeue_email(uuid, text, uuid) to authenticated;
grant execute on function public.admin_queue_deep_sync(uuid, text, uuid) to authenticated;
grant execute on function public.admin_find_customers(text) to authenticated;
grant execute on function public.admin_reveal_customer(uuid, text, uuid) to authenticated;
grant execute on function public.admin_reveal_registrant(uuid, text, uuid) to authenticated;

grant execute on function public.admin_claim_note(bigint, text, text, text, text) to service_role;
grant execute on function public.admin_note_result(bigint, text, text, jsonb) to service_role;
grant execute on function public.grant_test_admin(uuid) to service_role;
grant execute on function public.record_flw_refund_check(bigint, boolean, text, text, text, text, bigint, text, text, text, text)
  to service_role;
grant execute on function public.preset_drafts_for_check() to service_role;
grant execute on function public.record_preset_draft_check(uuid, boolean, jsonb) to service_role;
grant execute on function public.admin_mask_email(text) to service_role;

-- activate_fx_rate goes to the FX job (service key) and admin_activate_fx_rate only.
revoke execute on function public.activate_fx_rate(uuid, uuid) from public, anon, authenticated;

-- Today RLS is all that stops these writes; the admin wrappers own them now,
-- so a permissive policy added later must not open live pricing to the
-- publishable key. PostgREST never truncates.
revoke insert, update, delete, truncate on public.fx_rates, public.pricing_settings, public.tlds,
  public.ssl_products, public.nameserver_presets, public.market_references from anon, authenticated;
revoke truncate on all tables in schema public from anon, authenticated;
