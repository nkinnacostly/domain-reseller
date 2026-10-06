-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 43: MyDomainsHub Mail — the core (docs/MAIL-SPEC.md §9, approved
-- by the owner on 6 Oct 2026).
--
-- Mail keeps its own schema, `mail`, in the shop's Supabase project (M5):
-- one `auth.users`, and access to a Mail account is membership of a
-- `mail.accounts` row — never being a shop customer. Every table has RLS
-- (N7); members read their own account's rows by role; nothing is written
-- by the API roles directly, only through the SQL functions below and in
-- migration 44.
--
-- This migration: settings, plans (§8, prices in kobo, N5), accounts,
-- members, invites, domains, API keys (MR7: only a hash is stored) and the
-- account's own security log, with `create_account`, `create_api_key` and
-- `revoke_api_key`. Every function is revoked from public, anon,
-- authenticated and service_role, then granted to at most one role;
-- supabase/tests/mail_core.sql checks that loop.
--
-- After applying: expose the schema to the API (config.toml `[api] schemas`)
-- and regenerate types with `--schema public,mail`.
-- ─────────────────────────────────────────────────────────────────────────────

create schema mail;
comment on schema mail is 'MyDomainsHub Mail (docs/MAIL-SPEC.md, M5). RLS on every table.';

-- PostgREST reaches the schema as these roles; RLS and the grants below decide
-- what each may do there. anon only ever reads plans.
revoke all on schema mail from public;
grant usage on schema mail to anon, authenticated, service_role;

-- ── 1. Settings (one row) ───────────────────────────────────────────────────
-- Trust-and-safety and send-budget numbers, ops_settings-style, so they are
-- tuned without a deploy. Read by the functions only; a missing row fails
-- every send closed.
create table mail.settings (
  id                    boolean primary key default true check (id),
  -- The SES account's 24-hour quota is shared with the shop (§4.4, owner
  -- 6 Oct 2026: 50,000 a day for everything): Mail reserves at most this many
  -- recipients in any 24 hours, and no one account more than half of what the
  -- others leave (reserve_send, migration 44).
  account_daily_budget  integer not null default 49000 check (account_daily_budget > 0),
  -- §7.2: a sandbox account sends at most this many a day, to its own members.
  sandbox_daily_cap     integer not null default 100 check (sandbox_daily_cap > 0),
  -- §7.3: an approved account's first warm-up day; it doubles from there.
  warmup_start_cap      integer not null default 1000 check (warmup_start_cap > 0),
  -- Each account gets an SES tenant; one person cannot mint them without end.
  owned_accounts_max    integer not null default 3 check (owned_accounts_max between 1 and 100),
  -- §6: per key, 10 requests a second with bursts of 20.
  key_rate_per_second   numeric(6, 2) not null default 10 check (key_rate_per_second > 0),
  key_burst             integer not null default 20 check (key_burst > 0),
  -- A send that keeps failing to reach SES is given up after this many tries.
  max_send_attempts     integer not null default 8 check (max_send_attempts between 1 and 50),
  updated_at            timestamptz not null default now()
);
insert into mail.settings default values;

create function mail.settings_stay()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'mail.settings keeps its one row' using errcode = '23514';
end;
$$;
create trigger settings_no_delete before delete or truncate on mail.settings
  for each statement execute function mail.settings_stay();

-- ── 2. Plans (§8) ───────────────────────────────────────────────────────────
-- Prices are the owner's (6 Oct 2026), in kobo before VAT (N5, N5b): seed rows,
-- never constants in code. Caps count recipients, as SES does: an email to
-- three people is three. `is_offered` is false for a plan the SES account
-- cannot carry yet — Scale's 60,000 a day is above the account's 50,000
-- (owner, 6 Oct 2026).
create table mail.plans (
  code               text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name               text not null check (char_length(btrim(name)) between 1 and 40),
  price_kobo         bigint not null check (price_kobo >= 0),
  monthly_cap        integer not null check (monthly_cap > 0),
  daily_cap          integer not null check (daily_cap > 0),
  max_domains        integer not null check (max_domains > 0),
  max_members        integer not null check (max_members > 0),
  log_retention_days integer not null check (log_retention_days between 1 and 400),
  is_offered         boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint plans_daily_within_monthly check (daily_cap <= monthly_cap)
);

insert into mail.plans (code, name, price_kobo, monthly_cap, daily_cap, max_domains, max_members,
                        log_retention_days, is_offered, sort_order) values
  ('free',    'Free',            0,   3000,   100,  1,  1,  7, true,  10),
  ('starter', 'Starter',   2000000,  50000,  5000,  5,  3, 30, true,  20),
  ('pro',     'Pro',       5500000, 150000, 20000, 20, 10, 30, true,  30),
  ('scale',   'Scale',    16000000, 500000, 60000, 50, 25, 60, false, 40);

-- ── 3. Accounts and members ─────────────────────────────────────────────────
create table mail.accounts (
  id                      uuid primary key default gen_random_uuid(),
  -- Ten hex characters; names the account's SES tenant and configuration set.
  short_id                text not null unique check (short_id ~ '^[0-9a-f]{10}$'),
  name                    text not null check (char_length(btrim(name)) between 1 and 100),
  website                 text check (website is null or char_length(website) <= 200),
  use_case                text check (use_case is null or char_length(use_case) <= 1000),
  expected_monthly_volume integer check (expected_monthly_volume is null or expected_monthly_volume >= 0),
  plan_code               text not null default 'free' references mail.plans (code),
  -- sandbox → active (an admin's review, §7.2); paused by us or SES (MR5); closed.
  state                   text not null default 'sandbox'
                          check (state in ('sandbox', 'active', 'paused', 'closed')),
  state_reason            text check (state_reason is null or char_length(state_reason) <= 500),
  -- MR1: every send names this tenant and this configuration set.
  ses_tenant              text not null unique check (ses_tenant ~ '^mdm-[0-9a-f]{10}$'),
  config_set              text not null unique check (config_set ~ '^mdm-[0-9a-f]{10}$'),
  -- The tenant's sending status as SES reports it (EventBridge, §4.2):
  -- pending until the tenant exists, disabled while SES has paused it.
  ses_status              text not null default 'pending'
                          check (ses_status in ('pending', 'enabled', 'disabled', 'reinstated')),
  tenant_ready_at         timestamptz,
  -- §7.3: days of warm-up passed since approval; null before approval.
  warmup_day              integer check (warmup_day is null or warmup_day between 0 and 60),
  -- An admin's plan override (§10); null keeps the plan's caps.
  daily_cap_override      integer check (daily_cap_override is null or daily_cap_override >= 0),
  monthly_cap_override    integer check (monthly_cap_override is null or monthly_cap_override >= 0),
  reviewed_by             text,
  reviewed_at             timestamptz,
  created_by              uuid references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint accounts_names_match check (ses_tenant = 'mdm-' || short_id and config_set = 'mdm-' || short_id)
);

create table mail.members (
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (account_id, user_id)
);
create index members_user_idx on mail.members (user_id);
-- One owner per account.
create unique index members_one_owner on mail.members (account_id) where role = 'owner';

-- Pending invitations (§9): only a hash of the token is kept, for seven days.
create table mail.invites (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references mail.accounts (id) on delete cascade,
  email       text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role        text not null check (role in ('admin', 'developer', 'viewer')),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create index invites_account_idx on mail.invites (account_id);

-- ── 4. Domains (§5) ─────────────────────────────────────────────────────────
-- SES keeps one identity per name per AWS account, so one live claim per name
-- across every Mail account. mydomainshub.com and its subdomains are ours.
create table mail.domains (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references mail.accounts (id) on delete cascade,
  name              text not null check (
                      char_length(name) <= 253
                      and name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
                      and name !~ '(^|\.)mydomainshub\.com$'),
  status            text not null default 'pending'
                    check (status in ('pending', 'verified', 'failed', 'removed')),
  identity_arn      text,
  dkim_tokens       text[] not null default '{}',
  dkim_status       text,
  mail_from_domain  text,
  mail_from_status  text,
  failed_reason     text check (failed_reason is null or char_length(failed_reason) <= 200),
  last_checked_at   timestamptz,
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index domains_one_live_claim on mail.domains (name) where status in ('pending', 'verified');
create index domains_account_idx on mail.domains (account_id);

-- ── 5. API keys (MR7) ───────────────────────────────────────────────────────
-- Shown once; stored as sha256(pepper ‖ secret), hex, computed by the app —
-- the database never sees the secret or the pepper. `prefix` tells keys apart.
-- A sending key may be limited to one domain. The token bucket (rl_*) is the
-- per-key rate limit (§6), kept here so every serverless instance shares it.
create table mail.api_keys (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references mail.accounts (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  prefix         text not null check (prefix ~ '^mdh_live_[A-Za-z0-9]{4}$'),
  key_hash       text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  permission     text not null check (permission in ('full', 'sending')),
  domain_id      uuid references mail.domains (id) on delete restrict,
  last_used_at   timestamptz,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid,
  rl_tokens      double precision not null default 20,
  rl_updated_at  timestamptz not null default now(),
  constraint api_keys_domain_only_for_sending check (domain_id is null or permission = 'sending')
);
create index api_keys_account_idx on mail.api_keys (account_id);

-- ── 6. The account's own security log (§9) ──────────────────────────────────
-- Key created or revoked, member added, domain removed: ids, names and
-- prefixes, never a secret or an address. Append-only.
create table mail.account_audit_log (
  id             bigint generated always as identity primary key,
  account_id     uuid not null references mail.accounts (id) on delete cascade,
  at             timestamptz not null default now(),
  actor          text not null check (actor in ('user', 'api', 'system', 'admin')),
  actor_user_id  uuid,
  action         text not null check (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  target         text,
  detail         jsonb not null default '{}' check (jsonb_typeof(detail) = 'object')
);
create index account_audit_log_account_idx on mail.account_audit_log (account_id, at desc);

create function mail.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '23514';
end;
$$;
create trigger account_audit_log_final before update or delete on mail.account_audit_log
  for each row execute function mail.append_only();
create trigger account_audit_log_no_truncate before truncate on mail.account_audit_log
  for each statement execute function mail.append_only();

-- ── 7. Membership, as RLS asks it ───────────────────────────────────────────
-- Whether the caller holds one of these roles in the account. Security
-- definer, so a policy on members can ask without recursing into itself.
create function mail.has_role(p_account_id uuid,
                              p_roles text[] default array['owner', 'admin', 'developer', 'viewer'])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from mail.members m
     where m.account_id = p_account_id
       and m.user_id = (select auth.uid())
       and m.role = any (p_roles))
$$;

-- ── 8. Creating an account ──────────────────────────────────────────────────
-- The caller becomes its owner; it starts in the sandbox on the Free plan
-- (§7.2). Its tenant and configuration set are named now, `mdm-<short id>`,
-- and created by the provisioning job (§4.1, a later migration).
create function mail.create_account(p_name text,
                                    p_website text default null,
                                    p_use_case text default null,
                                    p_expected_monthly_volume integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_settings mail.settings;
  v_owned    integer;
  v_short    text;
  v_id       uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;
  if p_website is not null and char_length(p_website) > 200 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'website');
  end if;
  if p_use_case is not null and char_length(p_use_case) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'use_case');
  end if;
  if p_expected_monthly_volume is not null and p_expected_monthly_volume < 0 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'expected_monthly_volume');
  end if;

  select * into v_settings from mail.settings where id;
  if not found then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  -- Serialises one person's sign-ups, so two at once cannot pass the count.
  perform pg_advisory_xact_lock(hashtextextended('mail.create_account:' || v_user::text, 0));
  select count(*) into v_owned
    from mail.members m join mail.accounts a on a.id = m.account_id
   where m.user_id = v_user and m.role = 'owner' and a.state <> 'closed';
  if v_owned >= v_settings.owned_accounts_max then
    return jsonb_build_object('ok', false, 'code', 'limit', 'max', v_settings.owned_accounts_max);
  end if;

  for i in 1..5 loop
    v_short := encode(extensions.gen_random_bytes(5), 'hex');
    begin
      insert into mail.accounts (short_id, name, website, use_case, expected_monthly_volume,
                                 ses_tenant, config_set, created_by)
      values (v_short, btrim(p_name), nullif(btrim(p_website), ''), nullif(btrim(p_use_case), ''),
              p_expected_monthly_volume, 'mdm-' || v_short, 'mdm-' || v_short, v_user)
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_id := null;
    end;
  end loop;
  if v_id is null then
    raise exception 'create_account: no free short id' using errcode = '55000';
  end if;

  insert into mail.members (account_id, user_id, role) values (v_id, v_user, 'owner');
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target)
  values (v_id, 'user', v_user, 'account.created', v_id::text),
         (v_id, 'user', v_user, 'member.added', v_user::text);
  return jsonb_build_object('ok', true, 'accountId', v_id, 'shortId', v_short);
end;
$$;

-- ── 9. API keys: create and revoke ──────────────────────────────────────────
-- The app makes the secret, shows it once, and sends only its prefix and
-- hash. Owners and admins may make full-access keys; developers sending keys.
create function mail.create_api_key(p_account_id uuid, p_name text, p_permission text,
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
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select m.role, a.state into v_role, v_state
    from mail.members m join mail.accounts a on a.id = m.account_id
   where m.account_id = p_account_id and m.user_id = v_user;
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

  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, domain_id, created_by)
  values (p_account_id, btrim(p_name), p_prefix, p_key_hash, p_permission, p_domain_id, v_user)
  returning id into v_id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'key.created', v_id::text,
          jsonb_build_object('prefix', p_prefix, 'permission', p_permission));
  return jsonb_build_object('ok', true, 'keyId', v_id);
end;
$$;

create function mail.revoke_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key  mail.api_keys;
  v_role text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_key from mail.api_keys where id = p_key_id for update;
  if v_key.id is not null then
    select m.role into v_role from mail.members m
     where m.account_id = v_key.account_id and m.user_id = v_user;
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not (v_role in ('owner', 'admin') or (v_role = 'developer' and v_key.permission = 'sending')) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_key.revoked_at is not null then
    return jsonb_build_object('ok', true, 'keyId', v_key.id, 'already', true);
  end if;
  update mail.api_keys set revoked_at = now(), revoked_by = v_user where id = v_key.id;
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_key.account_id, 'user', v_user, 'key.revoked', v_key.id::text,
          jsonb_build_object('prefix', v_key.prefix));
  return jsonb_build_object('ok', true, 'keyId', v_key.id);
end;
$$;

-- ── 10. Row-level security ──────────────────────────────────────────────────
alter table mail.settings          enable row level security;   -- no policies: functions only
alter table mail.plans             enable row level security;
alter table mail.accounts          enable row level security;
alter table mail.members           enable row level security;
alter table mail.invites           enable row level security;
alter table mail.domains           enable row level security;
alter table mail.api_keys          enable row level security;
alter table mail.account_audit_log enable row level security;

create policy plans_public_read on mail.plans for select to anon, authenticated using (true);
create policy accounts_member_read on mail.accounts for select to authenticated
  using (mail.has_role(id));
create policy members_member_read on mail.members for select to authenticated
  using (mail.has_role(account_id));
create policy invites_admin_read on mail.invites for select to authenticated
  using (mail.has_role(account_id, array['owner', 'admin']));
create policy domains_member_read on mail.domains for select to authenticated
  using (mail.has_role(account_id));
create policy api_keys_developer_read on mail.api_keys for select to authenticated
  using (mail.has_role(account_id, array['owner', 'admin', 'developer']));
create policy account_audit_log_admin_read on mail.account_audit_log for select to authenticated
  using (mail.has_role(account_id, array['owner', 'admin']));

-- ── 11. Grants ──────────────────────────────────────────────────────────────
-- Tables: reads only, and never a hash or a rate-limit counter. No API role —
-- service_role included — writes a mail table: every write is a function.
revoke all on all tables in schema mail from public, anon, authenticated, service_role;
grant select on mail.plans to anon, authenticated;
grant select on mail.accounts, mail.members, mail.domains to authenticated;
grant select (id, account_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at)
  on mail.invites to authenticated;
grant select (id, account_id, name, prefix, permission, domain_id, last_used_at, created_by, created_at,
              revoked_at, revoked_by)
  on mail.api_keys to authenticated;
grant select on mail.account_audit_log to authenticated;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

-- Functions: revoke all, then grant to at most one role.
revoke all on function mail.settings_stay() from public, anon, authenticated, service_role;
revoke all on function mail.append_only() from public, anon, authenticated, service_role;
revoke all on function mail.has_role(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function mail.create_account(text, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function mail.create_api_key(uuid, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.revoke_api_key(uuid) from public, anon, authenticated, service_role;

-- has_role runs inside the policies, as the reading role.
grant execute on function mail.has_role(uuid, text[]) to authenticated;
grant execute on function mail.create_account(text, text, text, integer) to authenticated;
grant execute on function mail.create_api_key(uuid, text, text, text, text, uuid) to authenticated;
grant execute on function mail.revoke_api_key(uuid) to authenticated;
