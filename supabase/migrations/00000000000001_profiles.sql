-- ─────────────────────────────────────────────────────────────────────────────
-- Identity: profiles and reusable contact profiles.
-- RLS is enabled on every table. There are no exceptions to this rule.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.account_type as enum ('individual', 'business');

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         extensions.citext not null,
  full_name     text,
  phone         text,
  account_type  public.account_type not null default 'individual',
  business_name text,
  tax_id        text,
  kyc_status    text not null default 'none',
  risk_score    integer not null default 0 check (risk_score between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user. Mirrors auth.users.';

create table public.contact_profiles (
  id                 uuid primary key default extensions.gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  label              text not null,
  first_name         text not null,
  last_name          text not null,
  company            text,
  email              extensions.citext not null,
  phone              text not null,
  phone_country_code text not null,
  fax                text,
  fax_country_code   text,
  address_line1      text not null,
  address_line2      text,
  address_line3      text,
  city               text not null,
  state              text not null,
  zip_code           text not null,
  country            char(2) not null check (country ~ '^[A-Z]{2}$'),
  is_default         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.contact_profiles is
  'Registrant/admin/tech/billing contacts. Field shape mirrors the supplier ContactInfo contract.';

create index contact_profiles_user_id_idx on public.contact_profiles (user_id);
create unique index contact_profiles_one_default_per_user
  on public.contact_profiles (user_id) where is_default;

-- ── updated_at ───────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger contact_profiles_set_updated_at
  before update on public.contact_profiles
  for each row execute function public.set_updated_at();

-- ── provision a profile on sign-up ───────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.profiles         enable row level security;
alter table public.contact_profiles enable row level security;

create policy "profiles: read own"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "contact_profiles: read own"
  on public.contact_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "contact_profiles: insert own"
  on public.contact_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "contact_profiles: update own"
  on public.contact_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "contact_profiles: delete own"
  on public.contact_profiles for delete to authenticated
  using ((select auth.uid()) = user_id);
