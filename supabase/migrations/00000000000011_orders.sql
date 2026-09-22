-- ─────────────────────────────────────────────────────────────────────────────
-- Orders and payments (PRD §12, §13.4 order saga, FR-C5 – FR-C9).
--
-- Money is integer kobo (N5). Orders, lines and payments are written only by
-- our server with the secret key — people read their own, never write: a
-- price, a status or a payment row must never come from the browser.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.order_status as enum (
  'awaiting_payment',   -- created, charge not yet confirmed
  'paid',               -- charge verified with Flutterwave; registration queued
  'provisioning',
  'completed',
  'partially_failed',
  'failed',
  'cancelled'           -- the customer abandoned or cancelled the payment
);

create type public.order_item_status as enum (
  'pending',            -- waiting to be registered
  'provisioning',
  'completed',
  'failed',
  'refunded'
);

create sequence public.order_number_seq start 1001;

create table public.orders (
  id              uuid primary key default extensions.gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete restrict,
  order_number    text not null unique
                    default ('ND-' || lpad(nextval('public.order_number_seq')::text, 6, '0')),
  status          public.order_status not null default 'awaiting_payment',

  subtotal_kobo   bigint not null check (subtotal_kobo > 0),
  vat_pct         numeric(5,2) not null,
  vat_kobo        bigint not null check (vat_kobo >= 0),
  total_kobo      bigint not null check (total_kobo = subtotal_kobo + vat_kobo),
  fx_rate_id      uuid not null references public.fx_rates (id),

  -- Our reference for the charge. Flutterwave echoes it back, and it is the
  -- idempotency key for this order's payment (FR-PAY-3).
  tx_ref          text not null unique,

  -- Who registers the domains, as confirmed at checkout. A snapshot: editing
  -- a saved contact later must not change what this order registers.
  registrant      jsonb not null,
  contact_profile_id uuid references public.contact_profiles (id) on delete set null,
  -- FR-C10: optional nameservers, applied right after registration.
  nameservers     text[] check (nameservers is null or cardinality(nameservers) between 2 and 13),

  -- FR-C8: what the float pre-flight found. A shortfall is only ever let
  -- through with Flutterwave test keys — live keys refuse the order.
  float_check     text not null check (float_check in ('covered', 'shortfall_test_mode')),
  test_mode       boolean not null,

  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index orders_user_id_idx on public.orders (user_id, created_at desc);

create table public.order_items (
  id            uuid primary key default extensions.gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  item_type     text not null default 'register' check (item_type in ('register')),
  domain        extensions.citext not null,
  tld           text not null,
  period_years  smallint not null check (period_years between 1 and 10),
  privacy       boolean not null,
  auto_renew    boolean not null,
  price_kobo    bigint not null check (price_kobo > 0),
  renewal_kobo  bigint not null check (renewal_kobo > 0),
  status        public.order_item_status not null default 'pending',
  failure_code  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (order_id, domain)
);

create index order_items_order_id_idx on public.order_items (order_id);

create table public.payments (
  id                 uuid primary key default extensions.gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete restrict,
  user_id            uuid not null references public.profiles (id) on delete restrict,
  provider           text not null check (provider in ('flutterwave')),
  -- Flutterwave's transaction id. Unique, so a replayed webhook or a second
  -- redirect can never record the same charge twice (SEC-7).
  provider_reference text not null unique,
  tx_ref             text not null,
  amount_kobo        bigint not null check (amount_kobo > 0),
  currency           char(3) not null,
  status             text not null,
  method             text,
  raw                jsonb not null,
  created_at         timestamptz not null default now()
);

create index payments_order_id_idx on public.payments (order_id);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();
create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function public.set_updated_at();

-- ── RLS: read your own, write nothing ────────────────────────────────────────
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.payments    enable row level security;

create policy "orders: read own"
  on public.orders for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "order_items: read own"
  on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())
  ));

create policy "payments: read own"
  on public.payments for select to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.orders, public.order_items, public.payments
  from authenticated, anon;

-- ── Marking an order paid, exactly once ──────────────────────────────────────
-- The redirect and the webhook can both arrive, in either order, more than
-- once. This records the payment and moves the order to `paid` in one
-- transaction; every later call finds it done and changes nothing.
create or replace function public.record_order_payment(
  p_order_id           uuid,
  p_provider_reference text,
  p_amount_kobo        bigint,
  p_currency           text,
  p_method             text,
  p_raw                jsonb
)
returns public.order_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'successful', p_method, p_raw
  )
  on conflict (provider_reference) do nothing;

  if v_order.status in ('awaiting_payment', 'cancelled') then
    update public.orders set status = 'paid', paid_at = now() where id = v_order.id;
    -- The purchased names leave the cart.
    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);
    return 'paid';
  end if;

  return v_order.status;
end;
$$;

revoke all on function public.record_order_payment(uuid, text, bigint, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_order_payment(uuid, text, bigint, text, text, jsonb)
  to service_role;
