-- ─────────────────────────────────────────────────────────────────────────────
-- Exchange rates (PRD FR-FX-1..FR-FX-5).
--
-- We buy US dollars on the parallel market to fund the supplier balance, so
-- the costing rate is what a dealer SELLS dollars to us for. Append-only: a
-- rate is never edited, only superseded, because every historical price must
-- stay reproducible for disputes and accounting (FR-PRICE-7).
-- ─────────────────────────────────────────────────────────────────────────────

create type public.fx_source as enum ('aboki-parallel', 'manual', 'official');

create type public.fx_status as enum (
  'active',           -- the rate the storefront prices against
  'pending_review',   -- fetched, but moved too far to apply unattended
  'superseded',       -- replaced by a newer active rate
  'rejected'          -- implausible; kept for the audit trail
);

create table public.fx_rates (
  id              uuid primary key default extensions.gen_random_uuid(),
  base            char(3) not null default 'USD',
  quote           char(3) not null default 'NGN',
  source          public.fx_source not null,

  -- What a dealer pays for dollars, and what they charge for them.
  buy_rate        numeric(12,4) not null check (buy_rate > 0),
  sell_rate       numeric(12,4) not null check (sell_rate > 0),
  -- Our cost basis. Never the midpoint — see packages/shared/src/pricing/fx.ts.
  costing_rate    numeric(12,4) not null check (costing_rate > 0),

  buffer_pct      numeric(6,4) not null default 4 check (buffer_pct >= 0 and buffer_pct <= 25),
  status          public.fx_status not null default 'pending_review',

  -- How far this moved from the rate it replaced, for the audit trail.
  move_pct        numeric(8,4),
  review_reason   text,

  quoted_at       timestamptz not null,
  effective_from  timestamptz,
  raw_payload     jsonb,

  created_at      timestamptz not null default now(),
  reviewed_by     uuid references auth.users (id),
  reviewed_at     timestamptz
);

comment on table public.fx_rates is
  'Append-only FX history. Exactly one row per pair may be active at a time.';
comment on column public.fx_rates.costing_rate is
  'The dealer SELL rate. We buy dollars, so this is what they cost us.';

create index fx_rates_lookup_idx
  on public.fx_rates (base, quote, status, effective_from desc);

-- Exactly one active rate per currency pair. A second would mean two prices
-- for the same domain, which is a bug this project has already shipped once.
create unique index fx_rates_one_active_per_pair
  on public.fx_rates (base, quote)
  where status = 'active';

-- An active rate must say when it took effect.
alter table public.fx_rates
  add constraint fx_rates_active_needs_effective_from
  check (status <> 'active' or effective_from is not null);

-- ── Activating a rate supersedes the previous one, atomically ───────────────
create or replace function public.activate_fx_rate(rate_id uuid, actor uuid default null)
returns public.fx_rates
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.fx_rates;
begin
  select * into target from public.fx_rates where id = rate_id for update;
  if not found then
    raise exception 'fx rate % not found', rate_id;
  end if;
  if target.status = 'active' then
    return target;
  end if;

  update public.fx_rates
     set status = 'superseded'
   where base = target.base
     and quote = target.quote
     and status = 'active';

  update public.fx_rates
     set status = 'active',
         effective_from = coalesce(effective_from, now()),
         reviewed_by = actor,
         reviewed_at = case when actor is null then reviewed_at else now() end
   where id = rate_id
  returning * into target;

  return target;
end;
$$;

comment on function public.activate_fx_rate is
  'Promotes a rate to active and supersedes the previous one in one transaction.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.fx_rates enable row level security;

-- The storefront publishes the rate it charges at, so the active row is public.
-- Everything else — pending reviews, rejected feeds, history — is staff only.
create policy "fx_rates: anyone may read the active rate"
  on public.fx_rates for select
  to anon, authenticated
  using (status = 'active');

-- Writes come from the rate job and admin tooling, both of which use the
-- secret key and bypass RLS. No client-side write path exists by design.
