-- ─────────────────────────────────────────────────────────────────────────────
-- Cart (PRD E3, FR-C1 – FR-C4).
--
-- A cart belongs to a signed-in user, or to an anonymous browser identified by
-- a random token in an httpOnly cookie — stored here only as a SHA-256 hash.
-- Anonymous carts have no RLS policy at all: only the server, with the secret
-- key, can reach them, and only by presenting the token. They merge into the
-- user's cart on sign-in.
-- ─────────────────────────────────────────────────────────────────────────────

-- VAT is a pricing input like any other (CLAUDE.md N5b), not a constant.
alter table public.pricing_settings
  add column vat_pct numeric(5,2) not null default 7.5 check (vat_pct >= 0 and vat_pct < 100);

create table public.carts (
  id              uuid primary key default extensions.gen_random_uuid(),
  user_id         uuid unique references public.profiles (id) on delete cascade,
  anon_token_hash text unique check (anon_token_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Exactly one owner: a person, or an anonymous browser.
  check (num_nonnulls(user_id, anon_token_hash) = 1)
);

comment on table public.carts is
  'One open cart per user or anonymous browser (FR-C1). Anonymous carts are server-only.';

create table public.cart_items (
  id                  uuid primary key default extensions.gen_random_uuid(),
  cart_id             uuid not null references public.carts (id) on delete cascade,
  domain              extensions.citext not null
                        check (domain ~* '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9-]{2,63})+$'),
  tld                 text not null,
  period_years        smallint not null default 1 check (period_years between 1 and 10),
  -- FR-C3: the only two toggles. Auto-renew on; privacy on where it is free.
  privacy             boolean not null default true,
  auto_renew          boolean not null default true,
  -- The price quoted when the line was added or last re-quoted (FR-C4), in
  -- kobo: the whole period, and one renewal year (N8 — shown beside it).
  quoted_total_kobo   bigint not null check (quoted_total_kobo > 0),
  quoted_renewal_kobo bigint not null check (quoted_renewal_kobo > 0),
  quoted_fx_rate_id   uuid not null references public.fx_rates (id),
  quoted_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (cart_id, domain)
);

comment on table public.cart_items is
  'Domain lines with the price quoted to the customer. Held for the price-lock window, then re-quoted (FR-C4).';

create index cart_items_cart_id_idx on public.cart_items (cart_id);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.carts      enable row level security;
alter table public.cart_items enable row level security;

create policy "carts: own"
  on public.carts for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "cart_items: in own cart"
  on public.cart_items for all to authenticated
  using (exists (
    select 1 from public.carts c where c.id = cart_id and c.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.carts c where c.id = cart_id and c.user_id = (select auth.uid())
  ));

-- Quotes are ours to set. Lines are written only by our server actions, with
-- the secret key and after checking who owns the cart, so a price can never
-- come from the browser. People may read and delete their own lines.
revoke insert, update on public.cart_items from authenticated, anon;
