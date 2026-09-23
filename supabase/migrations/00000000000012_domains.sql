-- ─────────────────────────────────────────────────────────────────────────────
-- Domains: the portfolio (PRD §12, E5, E6, E10).
--
-- One row per domain a customer holds or has paid for. Written only by our
-- server; customers read their own. `source = 'demo'` rows are sample data
-- for trying the panel and are always labelled as such in the UI.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.domain_status as enum (
  'pending', 'active', 'expired_grace', 'redemption', 'pending_delete', 'released',
  'transferred_away', 'pending_verification', 'transfer_requested', 'transfer_pending',
  'transfer_rejected', 'transfer_cancelled', 'registration_failed', 'closed'
);

create type public.delegation_status as enum ('undelegated', 'pending', 'verified', 'failed');

-- FR-D2 / N11: presets are data, sourced from each provider's own docs and
-- re-verified. A preset without a verification date is never shown.
create table public.nameserver_presets (
  id               uuid primary key default extensions.gen_random_uuid(),
  provider         text not null unique,
  nameservers      text[] not null default '{}',
  -- FR-D3: providers such as Cloudflare assign a pair per account; we explain
  -- where to find them instead of pre-filling anything.
  assigns_per_zone boolean not null default false,
  notes            text,
  source_url       text not null,
  verified_at      timestamptz,
  is_hidden        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (assigns_per_zone or cardinality(nameservers) between 2 and 13)
);

create table public.domains (
  id                     uuid primary key default extensions.gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete restrict,
  domain_name            extensions.citext not null,
  tld                    text not null,
  source                 text not null check (source in ('registration', 'transfer', 'demo')),
  -- Bought with Flutterwave test keys: shown, never registered.
  test_mode              boolean not null default false,
  order_item_id          uuid unique references public.order_items (id) on delete set null,
  local_status           public.domain_status not null default 'pending',
  registered_at          timestamptz,
  expires_at             timestamptz,
  auto_renew             boolean not null default true,
  transfer_lock          boolean not null default true,
  privacy_enabled        boolean not null default false,
  -- What the registry has, as far as we know, and what the customer has
  -- asked for but we have not yet applied.
  nameservers            text[],
  pending_nameservers    text[] check (pending_nameservers is null or cardinality(pending_nameservers) between 2 and 13),
  nameserver_preset_id   uuid references public.nameserver_presets (id) on delete set null,
  delegation_status      public.delegation_status not null default 'undelegated',
  delegation_checked_at  timestamptz,
  registrant             jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- A real domain belongs to one account. Demo and test rows may repeat names.
create unique index domains_live_name_unique
  on public.domains (domain_name) where source <> 'demo' and not test_mode;
create index domains_user_id_idx on public.domains (user_id, expires_at);

-- Append-only audit log (FR-N5, FR-P6 Activity).
create table public.domain_events (
  id          bigserial primary key,
  domain_id   uuid not null references public.domains (id) on delete cascade,
  event_type  text not null,
  actor_type  text not null check (actor_type in ('user', 'system', 'support')),
  actor_id    uuid,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index domain_events_domain_id_idx on public.domain_events (domain_id, created_at desc);

create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function public.set_updated_at();
create trigger nameserver_presets_set_updated_at
  before update on public.nameserver_presets
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.nameserver_presets enable row level security;
alter table public.domains            enable row level security;
alter table public.domain_events      enable row level security;

create policy "nameserver_presets: anyone reads verified, visible presets"
  on public.nameserver_presets for select to anon, authenticated
  using (verified_at is not null and not is_hidden);

create policy "domains: read own"
  on public.domains for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "domain_events: read own"
  on public.domain_events for select to authenticated
  using (exists (
    select 1 from public.domains d where d.id = domain_id and d.user_id = (select auth.uid())
  ));

revoke insert, update, delete on public.nameserver_presets, public.domains, public.domain_events
  from authenticated, anon;

-- ── Presets verified 23 Sept 2026 against each provider's own documentation,
-- every nameserver resolving to A (and AAAA where published).
insert into public.nameserver_presets (provider, nameservers, assigns_per_zone, notes, source_url, verified_at) values
  ('Vercel', array['ns1.vercel-dns.com', 'ns2.vercel-dns.com'], false,
   'For sites deployed on Vercel. Add the domain to your Vercel project first.',
   'https://vercel.com/docs/domains/working-with-nameservers', now()),
  ('Hostinger', array['ns1.dns-parking.com', 'ns2.dns-parking.com'], false,
   'For Hostinger web hosting.',
   'https://www.hostinger.com/support/8671230-how-to-look-up-domain-nameservers-at-hostinger/', now()),
  ('Truehost Nigeria', array['ns1.cloudoon.com', 'ns2.cloudoon.net', 'ns3.cloudoon.org'], false,
   'For Truehost Nigeria shared hosting (nameservers in use since 1 June 2022).',
   'https://truehost.com.ng/cloud/index.php/announcements/3/Our-New-Nameservers.html', now()),
  ('Cloudflare', '{}', true,
   'Cloudflare gives each account its own pair. Add the domain in your Cloudflare dashboard, then copy the two nameservers it shows you.',
   'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/', now()),
  ('Netlify', '{}', true,
   'Netlify DNS assigns nameservers per domain. Add the domain under Domains in Netlify, then copy the nameservers it lists.',
   'https://docs.netlify.com/domains-https/netlify-dns/delegate-to-netlify/', now());

-- ── Paid orders enter the portfolio (PRD §13.4 step 6) ───────────────────────
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

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

    -- Each paid line becomes a domain, waiting to be registered. Nameservers
    -- given at checkout (FR-C10) wait as the requested set.
    insert into public.domains (
      user_id, domain_name, tld, source, test_mode, order_item_id, local_status,
      auto_renew, privacy_enabled, pending_nameservers, registrant
    )
    select v_order.user_id, oi.domain, oi.tld, 'registration', v_order.test_mode, oi.id, 'pending',
           oi.auto_renew, oi.privacy, v_order.nameservers, v_order.registrant
      from public.order_items oi
     where oi.order_id = v_order.id
    on conflict (order_item_id) do nothing;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'order_paid', 'system', jsonb_build_object('order_number', v_order.order_number)
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id;

    return 'paid';
  end if;

  return v_order.status;
end;
$$;
