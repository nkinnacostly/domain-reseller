-- ─────────────────────────────────────────────────────────────────────────────
-- Live TLD catalogue and pricing settings.
--
-- Wholesale costs come from the reseller platform and live here, not in a file.
-- Margin and buffer live here too: no pricing input is hardcoded anywhere.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.tlds (
  name                  text primary key,
  register_usd          numeric(12,4) not null check (register_usd >= 0),
  renew_usd             numeric(12,4) not null check (renew_usd >= 0),
  transfer_usd          numeric(12,4) check (transfer_usd >= 0),
  restore_usd           numeric(12,4) check (restore_usd >= 0),
  min_period            smallint not null default 1,
  max_period            smallint not null default 10,
  redemption_days       smallint not null default 0,
  requires_extra_fields boolean not null default false,
  -- gTLDs carry the ICANN fee; two-letter ccTLDs do not.
  is_country_code       boolean not null
    generated always as (length(split_part(name, '.', array_length(string_to_array(name, '.'), 1))) = 2) stored,
  is_sellable           boolean not null default true,
  synced_at             timestamptz not null default now()
);

comment on table public.tlds is
  'Wholesale catalogue, synced from the reseller platform. Never hand-edited.';

create index tlds_sellable_idx on public.tlds (is_sellable, name);

-- ── Pricing settings ────────────────────────────────────────────────────────
create table public.pricing_settings (
  id              boolean primary key default true check (id),  -- single row
  -- Flat profit per domain, in naira. Not a percentage.
  margin_ngn      numeric(12,2) not null check (margin_ngn >= 0),
  -- Covers the gap between quoting and actually settling the dollars.
  fx_buffer_pct   numeric(6,4) not null default 0 check (fx_buffer_pct >= 0 and fx_buffer_pct <= 25),
  -- ICANN transaction fee per year on gTLDs, in USD.
  icann_fee_usd   numeric(6,4) not null default 0.20 check (icann_fee_usd >= 0),
  -- A rate moving more than this in one update is held for review.
  fx_move_threshold_pct numeric(6,4) not null default 5 check (fx_move_threshold_pct > 0),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id)
);

comment on table public.pricing_settings is
  'Single row. Every pricing input lives here so none of it is hardcoded.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.tlds enable row level security;
alter table public.pricing_settings enable row level security;

-- The catalogue is published on the pricing page, so sellable rows are public.
create policy "tlds: anyone may read sellable extensions"
  on public.tlds for select to anon, authenticated
  using (is_sellable);

-- Settings are NOT public: margin is commercially sensitive.
-- Reads happen server-side with the secret key, which bypasses RLS.
