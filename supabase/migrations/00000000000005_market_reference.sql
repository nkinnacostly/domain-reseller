-- ─────────────────────────────────────────────────────────────────────────────
-- Competitor reference prices.
--
-- Our supplier charges one flat wholesale price across the whole .ng family,
-- but the registry does not and neither does the market: .com.ng retails for a
-- fraction of .ng. Without a reference we cannot tell that we are pricing an
-- extension far above what anyone else sells it for.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.market_references (
  tld            text primary key references public.tlds (name) on delete cascade,
  -- Typical retail price in Nigeria, naira, first year.
  typical_ngn    numeric(12,2) not null check (typical_ngn > 0),
  -- Cheapest credible competitor, naira.
  lowest_ngn     numeric(12,2) check (lowest_ngn > 0),
  source_note    text not null,
  observed_on    date not null default current_date,
  updated_at     timestamptz not null default now()
);

comment on table public.market_references is
  'What competitors charge. Used to flag extensions we cannot sell profitably.';

alter table public.market_references enable row level security;
-- Competitor data is internal. Reads happen server-side with the secret key.
