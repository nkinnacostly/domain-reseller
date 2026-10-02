-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 39: SSL certificates (PRD E15, FR-SSL-1 – FR-SSL-9).
--
-- We resell three of DomainNameAPI's certificates. What the supplier's SSL
-- API does, read and tried in its sandbox on 2 Oct 2026, is in PRD Appendix
-- E; three facts shape this migration:
--
-- 1. Every SSL call names the certificate by its domain name alone, and a
--    name with two certificates reaches only the first (sandbox): a second
--    one could never be set up. So one certificate per name per side, and
--    the order job refuses a name the supplier already holds before it buys.
-- 2. Buying happens at `initialize`, which charges our float and has no
--    idempotency key. The job notes that it is about to send (sent_at), and
--    after a timeout only ever reads — never sends again (N3).
-- 3. The customer's private key is never sent or kept: `configure` works
--    without it (sandbox), there is no column for it, and the checks below
--    refuse a stored value that contains one (N13).
--
-- The queue is its own table (ssl_jobs), worked by the gateway like `jobs`
-- (migration 13): claimed with FOR UPDATE SKIP LOCKED, moved only by the
-- functions here, and a paid line's charge is confirmed with Flutterwave
-- before anything is bought (SEC-7). Order lines, refunds, invoices and
-- emails are the existing ones: an SSL line is an `order_items` row of type
-- `ssl`, and a refused order is refunded like a failed registration.
--
-- Deploy: 38 (the refund reason) and this, then the gateway, then the web
-- (docs/DEPLOY.md). Nothing here changes what the current gateway or web do.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Products ────────────────────────────────────────────────────────────────
-- Synced weekly from GET /products/ssls by the gateway (ssl/sync.ts). The
-- sync owns every column but is_sellable, which is the owner's: a product is
-- sold only when the owner says so AND the sync has priced it (N5b).

create table public.ssl_products (
  product_code      text primary key check (product_code ~ '^[A-Za-z0-9]{1,16}$'),
  name              text check (char_length(name) between 1 and 200),
  vendor            text check (char_length(vendor) between 1 and 80),
  validation_type   text check (char_length(validation_type) between 1 and 20),
  is_wildcard       boolean,
  is_multi_domain   boolean,
  -- Names one certificate covers, the main one included (the supplier's defaultSanCount).
  included_names    smallint check (included_names between 1 and 250),
  max_names         smallint check (max_names between 1 and 1000),
  is_reissue_free   boolean,
  requires_csr      boolean,
  -- The Reseller group's price for one term, period 1, USD. Null until synced.
  create_usd        numeric(10, 2) check (create_usd > 0),
  is_sellable       boolean not null default false,
  synced_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A product we sell has a price, a name and its shape.
  check (not is_sellable or create_usd is null or
         (name is not null and is_wildcard is not null and is_multi_domain is not null
          and included_names is not null))
);

comment on table public.ssl_products is
  'SSL certificates the supplier sells (GET /products/ssls), synced weekly. Only is_sellable rows with a cost are offered.';
comment on column public.ssl_products.is_sellable is
  'The owner''s choice, never written by the sync. A product is sold only once the sync has also priced it.';

create trigger ssl_products_set_updated_at
  before update on public.ssl_products
  for each row execute function public.set_updated_at();

-- The owner's three (2 Oct 2026): Sectigo PositiveSSL, Wildcard and Multi
-- Domain. Unpriced until the sync writes them; nothing is sold before then.
insert into public.ssl_products (product_code, is_sellable)
values ('351', true), ('352', true), ('371', true)
on conflict (product_code) do nothing;

alter table public.ssl_products enable row level security;
-- No policies: the storefront reads them with the secret key, like the margin.
revoke all on public.ssl_products from anon, authenticated;

-- ── Cart lines ──────────────────────────────────────────────────────────────
-- A line per certificate, in its own table so domain lines (cart_items, and
-- its unique name per cart) are untouched: a cart can hold example.com and a
-- certificate for it. Written only by the server, like cart_items (FR-C4).

create table public.cart_ssl_items (
  id                uuid primary key default extensions.gen_random_uuid(),
  cart_id           uuid not null references public.carts (id) on delete cascade,
  product_code      text not null references public.ssl_products (product_code),
  -- The name the supplier will know it by: example.com, or *.example.com.
  common_name       text not null
                      check (common_name = lower(common_name)
                             and common_name ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
                             and char_length(common_name) <= 253),
  quoted_total_kobo bigint not null check (quoted_total_kobo > 0),
  quoted_fx_rate_id uuid not null references public.fx_rates (id),
  quoted_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  -- The supplier knows a certificate by its name only (Appendix E).
  unique (cart_id, common_name)
);

create index cart_ssl_items_cart_id_idx on public.cart_ssl_items (cart_id);

comment on table public.cart_ssl_items is
  'SSL certificate lines with the price quoted to the customer (FR-SSL-6). Held for the price-lock window, then re-quoted.';

alter table public.cart_ssl_items enable row level security;

create policy "cart_ssl_items: in own cart"
  on public.cart_ssl_items for all to authenticated
  using (exists (
    select 1 from public.carts c where c.id = cart_id and c.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.carts c where c.id = cart_id and c.user_id = (select auth.uid())
  ));

revoke insert, update on public.cart_ssl_items from authenticated, anon;

-- Sign-in moves an anonymous cart's certificates too (migration 10).
create or replace function public.merge_anonymous_cart(p_token_hash text, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anon  uuid;
  v_user  uuid;
  v_moved integer := 0;
  v_ssl   integer := 0;
begin
  select id into v_anon
    from public.carts
   where anon_token_hash = p_token_hash
     for update;
  if v_anon is null then
    return 0;
  end if;

  -- A session can outlive its account for a few minutes; keep the cart.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return 0;
  end if;

  insert into public.carts (user_id) values (p_user_id)
    on conflict (user_id) do nothing;
  select id into v_user from public.carts where user_id = p_user_id;

  -- A domain already in the user's cart keeps the user's line and quote.
  insert into public.cart_items (
    cart_id, domain, tld, period_years, privacy, auto_renew,
    quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at
  )
  select v_user, domain, tld, period_years, privacy, auto_renew,
         quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at
    from public.cart_items
   where cart_id = v_anon
  on conflict (cart_id, domain) do nothing;
  get diagnostics v_moved = row_count;

  -- So does a certificate for a name already there.
  insert into public.cart_ssl_items (
    cart_id, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id, quoted_at
  )
  select v_user, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id, quoted_at
    from public.cart_ssl_items
   where cart_id = v_anon
  on conflict (cart_id, common_name) do nothing;
  get diagnostics v_ssl = row_count;

  delete from public.carts where id = v_anon;
  return v_moved + v_ssl;
end;
$$;

-- An anonymous cart is stale by its newest line, certificates included (migration 21).
create or replace function public.purge_stale_carts(p_older_than interval default '60 days'::interval)
returns integer
language sql
security definer
set search_path = ''
as $$
  with stale as (
    delete from public.carts c
     where c.anon_token_hash is not null
       and c.user_id is null
       and greatest(
             c.updated_at,
             coalesce((select max(greatest(i.created_at, i.quoted_at))
                         from public.cart_items i
                        where i.cart_id = c.id), c.updated_at),
             coalesce((select max(greatest(s.created_at, s.quoted_at))
                         from public.cart_ssl_items s
                        where s.cart_id = c.id), c.updated_at)
           ) < now() - greatest(p_older_than, interval '60 days')
    returning c.id
  )
  select count(*)::integer from stale
$$;

-- ── Order lines ─────────────────────────────────────────────────────────────
-- An SSL line: item_type 'ssl', `domain` the certificate's name, `tld` the
-- name's last label, one "year" (the subscription), no privacy or
-- auto-renew, and `renewal_kobo` what a new certificate cost on the day (N8).

alter table public.order_items
  add column ssl_product_code text references public.ssl_products (product_code);

alter table public.order_items drop constraint order_items_item_type_check;
alter table public.order_items
  add constraint order_items_item_type_check
  check (item_type in ('register', 'renew', 'transfer', 'ssl'));

alter table public.order_items
  add constraint order_items_ssl_product
  check ((item_type = 'ssl') = (ssl_product_code is not null));

-- A name may appear once per kind: a domain and a certificate for it can be
-- bought together.
alter table public.order_items drop constraint order_items_order_id_domain_key;
alter table public.order_items
  add constraint order_items_order_id_item_type_domain_key unique (order_id, item_type, domain);

comment on column public.order_items.ssl_product_code is
  'An SSL line''s product (ssl_products). Null on every other line.';

-- ── Certificates ────────────────────────────────────────────────────────────

create table public.ssl_certificates (
  id                      uuid primary key default extensions.gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete restrict,
  order_item_id           uuid not null unique references public.order_items (id) on delete cascade,
  product_code            text not null references public.ssl_products (product_code),
  -- A snapshot: renaming a product later does not rename what was bought.
  product_name            text not null,
  is_wildcard             boolean not null default false,
  included_names          smallint not null default 1 check (included_names between 1 and 250),
  -- The name every supplier call uses: example.com, or *.example.com.
  common_name             text not null
                            check (common_name = lower(common_name)
                                   and common_name ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  -- Test payments are ordered only in the supplier's sandbox (as jobs.test_mode).
  test_mode               boolean not null,
  status                  text not null default 'pending'
                            check (status in ('pending', 'awaiting_setup', 'setting_up',
                                              'awaiting_validation', 'issued', 'reissuing',
                                              'revoked', 'cancelled', 'failed')),
  -- What the supplier last said, in its words (WaitingForInstall, Active…).
  supplier_status         text check (char_length(supplier_status) <= 60),
  -- A supplier word we do not know: kept, alerted after a day, never guessed.
  status_unrecognised_since timestamptz,
  supplier_certificate_id uuid,
  -- The supplier's subscription: one year from the purchase (Appendix E).
  purchased_at            timestamptz,
  subscription_ends_at    timestamptz,
  -- The set-up, as the customer asked for it (FR-SSL-4).
  validation_method       text check (validation_method in ('email')),
  approver_email          text check (approver_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  san_names               text[] not null default '{}'
                            check (cardinality(san_names) < included_names),
  web_server              text check (web_server in ('apache', 'iis')),
  csr                     text check (csr like '-----BEGIN %CERTIFICATE REQUEST-----%'
                                      and char_length(csr) <= 16000),
  -- The contact the CA records. Personal data: read only by its owner (RLS).
  contact                 jsonb check (contact is null or jsonb_typeof(contact) = 'object'),
  configured_at           timestamptz,
  -- Our words for the last thing that went wrong that the customer can fix.
  last_error_code         text check (char_length(last_error_code) <= 60),
  -- The certificate itself: public, so kept (FR-SSL-7).
  issued_at               timestamptz,
  expires_at              timestamptz,
  certificate_pem         text check (char_length(certificate_pem) <= 20000),
  ca_bundle_pem           text check (char_length(ca_bundle_pem) <= 40000),
  reissue_count           integer not null default 0 check (reissue_count >= 0),
  last_checked_at         timestamptz,
  next_check_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- N13: a private key is never kept, wherever it might be pasted.
  constraint ssl_certificates_no_private_key check (
    coalesce(csr, '') !~ 'PRIVATE KEY'
    and coalesce(certificate_pem, '') !~ 'PRIVATE KEY'
    and coalesce(ca_bundle_pem, '') !~ 'PRIVATE KEY'
    and coalesce(contact::text, '') !~ 'PRIVATE KEY'
  )
);

comment on table public.ssl_certificates is
  'One SSL certificate per paid ssl order line (FR-SSL-3). Moved only by the functions of migration 39.';
comment on column public.ssl_certificates.common_name is
  'The name every supplier call uses. A wildcard is *.example.com from the start: bought as the bare name it can never be set up.';

create index ssl_certificates_user_idx on public.ssl_certificates (user_id, created_at desc);
create index ssl_certificates_check_idx on public.ssl_certificates (test_mode, next_check_at)
  where status in ('awaiting_validation', 'issued');
-- One certificate bought per name and side: the supplier reaches only the
-- first. Pending rows are left out so a second payment for a name can still
-- be recorded; its order job then refuses the name and the line is refunded.
create unique index ssl_certificates_one_per_name
  on public.ssl_certificates (common_name, test_mode)
  where status not in ('pending', 'failed');

create trigger ssl_certificates_set_updated_at
  before update on public.ssl_certificates
  for each row execute function public.set_updated_at();

alter table public.ssl_certificates enable row level security;

create policy "ssl_certificates: read own"
  on public.ssl_certificates for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.ssl_certificates from anon;
revoke insert, update, delete on public.ssl_certificates from authenticated;
grant select on public.ssl_certificates to authenticated;

-- ── The queue ───────────────────────────────────────────────────────────────

create table public.ssl_jobs (
  id               uuid primary key default extensions.gen_random_uuid(),
  -- A kind the gateway does not know is held for a person, never guessed at.
  kind             text not null check (kind in ('ssl_initialize', 'ssl_configure', 'ssl_reissue')),
  -- I4: a duplicate enqueue is a no-op.
  idempotency_key  text not null unique,
  certificate_id   uuid not null references public.ssl_certificates (id) on delete cascade,
  test_mode        boolean not null,
  status           public.job_status not null default 'queued',
  attempts         smallint not null default 0,
  run_after        timestamptz not null default now(),
  -- N3: noted just before the supplier write is sent. Set, a later attempt
  -- only reads: an initialize sent twice would be bought twice.
  sent_at          timestamptz,
  locked_by        text,
  locked_at        timestamptz,
  last_error_code  text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index ssl_jobs_claim_idx on public.ssl_jobs (test_mode, run_after)
  where status in ('queued', 'running');
-- One job in hand per certificate.
create unique index ssl_jobs_one_open on public.ssl_jobs (certificate_id)
  where status in ('queued', 'running');

create trigger ssl_jobs_set_updated_at
  before update on public.ssl_jobs
  for each row execute function public.set_updated_at();

alter table public.ssl_jobs enable row level security;
revoke all on public.ssl_jobs from anon, authenticated;

-- I7: SSL calls are recorded like provisioning calls, against their job.
alter table public.supplier_calls
  add column ssl_job_id uuid references public.ssl_jobs (id) on delete set null;
create index supplier_calls_ssl_job_id_idx on public.supplier_calls (ssl_job_id);

-- ── Refunds ─────────────────────────────────────────────────────────────────
-- A certificate line refunds as a registration does. Compared as text so this
-- migration does not depend on 38's value being committed when it runs.

alter table public.refunds drop constraint refunds_check;
alter table public.refunds
  add constraint refunds_check
  check ((reason::text in ('registration_failed', 'renewal_failed', 'transfer_failed', 'ssl_failed'))
         = (order_item_id is not null));

create or replace function public.enqueue_line_refund(p_order_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item     public.order_items%rowtype;
  v_order    public.orders%rowtype;
  v_existing public.refunds%rowtype;
  v_settings public.ops_settings%rowtype;
  v_sum      bigint;
  v_amount   bigint;
begin
  select * into v_item from public.order_items where id = p_order_item_id;
  if not found or v_item.status <> 'failed' then
    return null;
  end if;
  select * into v_order from public.orders where id = v_item.order_id;

  select * into v_existing from public.refunds where order_item_id = p_order_item_id for update;
  if found then
    if v_existing.status <> 'cancelled' or v_existing.provider_refund_id is not null then
      return v_existing.id;
    end if;
    select * into v_settings from public.ops_settings;
    begin
      update public.refunds
         set status = 'queued', attempts = 0, approved_by = null, approved_at = null,
             run_after = now() + make_interval(mins => v_settings.refund_delay_minutes),
             last_error_code = null, last_error = null
       where id = v_existing.id;
    exception when others then
      insert into public.payment_incidents (test_mode, kind, order_id, detail)
      values (v_order.test_mode, 'refund_not_created', v_order.id,
              jsonb_build_object('reason', 'registration_failed', 'refund_id', v_existing.id,
                                 'error', left(sqlerrm, 300)))
      on conflict do nothing;
      return null;
    end;
    insert into public.refund_events (refund_id, event, detail)
    values (v_existing.id, 'queued', jsonb_build_object('why', 'registration failed again'));
    return v_existing.id;
  end if;

  if v_order.payment_id is null then
    insert into public.payment_incidents (test_mode, kind, order_id, detail)
    values (v_order.test_mode, 'refund_not_created', v_order.id,
            jsonb_build_object('why', 'order has no recorded payment'))
    on conflict do nothing;
    return null;
  end if;

  select sum(price_kobo) into v_sum from public.order_items where order_id = v_order.id;
  if v_sum is distinct from v_order.subtotal_kobo then
    insert into public.payment_incidents (test_mode, kind, order_id, detail)
    values (v_order.test_mode, 'refund_not_created', v_order.id,
            jsonb_build_object('why', 'lines do not add up to the subtotal',
                               'lines_kobo', v_sum, 'subtotal_kobo', v_order.subtotal_kobo))
    on conflict do nothing;
    return null;
  end if;

  with lines as (
    select id, price_kobo,
           sum(price_kobo) over (order by created_at, id
                                 rows between unbounded preceding and current row) as upto
      from public.order_items
     where order_id = v_order.id
  )
  select l.price_kobo
         + (floor(v_order.vat_kobo::numeric * l.upto / v_order.subtotal_kobo)
            - floor(v_order.vat_kobo::numeric * (l.upto - l.price_kobo) / v_order.subtotal_kobo))::bigint
    into v_amount
    from lines l
   where l.id = p_order_item_id;

  return public.enqueue_refund(v_order.id, v_order.payment_id, v_item.id,
                               (case v_item.item_type
                                 when 'renew' then 'renewal_failed'
                                 when 'transfer' then 'transfer_failed'
                                 -- FR-SSL-3: a certificate the CA's supplier would not sell.
                                 when 'ssl' then 'ssl_failed'
                                 else 'registration_failed'
                               end)::text::public.refund_reason,
                               v_amount, null);
end;
$$;

-- ── Paid: one certificate and one order job per SSL line ────────────────────
-- Fired by record_order_payment's own update, so the certificate rows, their
-- jobs and the payment are one transaction (as registrations, migration 13).

create or replace function public.ssl_for_paid_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ssl_certificates (
    user_id, order_item_id, product_code, product_name, is_wildcard, included_names,
    common_name, test_mode
  )
  select new.user_id, oi.id, oi.ssl_product_code,
         coalesce(p.name, 'SSL certificate ' || oi.ssl_product_code),
         coalesce(p.is_wildcard, oi.domain like '*.%'),
         coalesce(p.included_names, 1),
         lower(oi.domain::text), new.test_mode
    from public.order_items oi
    left join public.ssl_products p on p.product_code = oi.ssl_product_code
   where oi.order_id = new.id
     and oi.item_type = 'ssl'
  on conflict (order_item_id) do nothing;

  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode)
  select 'ssl_initialize', 'ssl_initialize:' || c.order_item_id, c.id, c.test_mode
    from public.ssl_certificates c
    join public.order_items oi on oi.id = c.order_item_id
   where oi.order_id = new.id
  on conflict (idempotency_key) do nothing;

  -- Bought: off the cart, as record_order_payment does for domains.
  delete from public.cart_ssl_items ci
   using public.carts c, public.order_items oi
   where ci.cart_id = c.id
     and c.user_id = new.user_id
     and oi.order_id = new.id
     and oi.item_type = 'ssl'
     and ci.common_name = lower(oi.domain::text)
     and ci.product_code = oi.ssl_product_code;
  return null;
end;
$$;

create trigger orders_ssl_on_payment
  after update of paid_at on public.orders
  for each row
  when (old.paid_at is null and new.paid_at is not null)
  execute function public.ssl_for_paid_order();

-- The receipt email names each certificate's product (FR-SSL-6).
create or replace function public.email_for_paid_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_email(
    'order_receipt', 'transactional', new.user_id, 'order_receipt:' || new.id,
    jsonb_build_object(
      'order_id', new.id,
      'order_number', new.order_number,
      'invoice_number', new.invoice_number,
      'paid_at', new.paid_at,
      'subtotal_kobo', new.subtotal_kobo,
      'vat_pct', new.vat_pct,
      'vat_kobo', new.vat_kobo,
      'total_kobo', new.total_kobo,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'domain', oi.domain,
                 'kind', oi.item_type,
                 'years', oi.period_years,
                 'price_kobo', oi.price_kobo,
                 'renewal_kobo', oi.renewal_kobo,
                 'renewal_years', oi.renewal_years,
                 'product', p.name)
               order by oi.created_at, oi.domain)
          from public.order_items oi
          left join public.ssl_products p on p.product_code = oi.ssl_product_code
         where oi.order_id = new.id), '[]'::jsonb)),
    null, new.id, new.test_mode);
  return null;
end;
$$;

-- ── The queue's functions (service_role only) ───────────────────────────────

-- Claims one due SSL job on one side, with what the worker needs to run it.
create or replace function public.claim_ssl_job(
  p_worker        text,
  p_test_mode     boolean,
  p_lease_seconds integer default 300,
  p_job_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job  public.ssl_jobs%rowtype;
  v_cert public.ssl_certificates%rowtype;
begin
  if coalesce(trim(p_worker), '') = '' then
    raise exception 'an SSL job is claimed by a named worker';
  end if;

  select * into v_job
    from public.ssl_jobs j
   where j.test_mode = p_test_mode
     and (p_job_id is null or j.id = p_job_id)
     and (
       (j.status = 'queued' and j.run_after <= now())
       or (j.status = 'running' and j.locked_at < now() - make_interval(secs => p_lease_seconds))
     )
   order by j.run_after
   limit 1
   for update skip locked;

  if not found then
    return null;
  end if;

  update public.ssl_jobs
     set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1
   where id = v_job.id
  returning * into v_job;

  select * into v_cert from public.ssl_certificates where id = v_job.certificate_id;

  if v_job.kind = 'ssl_initialize' then
    update public.order_items set status = 'provisioning'
     where id = v_cert.order_item_id and status = 'pending';
    update public.orders o set status = 'provisioning'
      from public.order_items oi
     where oi.id = v_cert.order_item_id and o.id = oi.order_id and o.status = 'paid';
  end if;

  return (
    select jsonb_build_object(
             'id', v_job.id,
             'kind', v_job.kind,
             'attempts', v_job.attempts,
             'test_mode', v_job.test_mode,
             'sent_at', v_job.sent_at,
             'created_at', v_job.created_at,
             'certificate_id', c.id,
             'common_name', c.common_name,
             'product_code', c.product_code,
             'is_wildcard', c.is_wildcard,
             'included_names', c.included_names,
             'status', c.status,
             'supplier_status', c.supplier_status,
             'issued_at', c.issued_at,
             -- The set-up, for ssl_configure. Never a private key: there is none.
             'csr', c.csr,
             'approver_email', c.approver_email,
             'web_server', c.web_server,
             'san_names', to_jsonb(c.san_names),
             'contact', c.contact,
             -- Another certificate for this name, bought or paid for before this
             -- one: the supplier would reach only that one (Appendix E).
             'name_taken', exists (
               select 1 from public.ssl_certificates o
                where o.common_name = c.common_name
                  and o.test_mode = c.test_mode
                  and o.id <> c.id
                  and o.status <> 'failed'
                  and (o.status <> 'pending' or o.created_at < c.created_at)
             ),
             -- Confirmed with Flutterwave before anything is bought (SEC-7).
             'payment', case when v_job.kind = 'ssl_initialize'
               then jsonb_build_object(
                 'order_tx_ref', o.tx_ref,
                 'order_total_kobo', o.total_kobo,
                 'reference', p.provider_reference,
                 'amount_kobo', p.amount_kobo,
                 'currency', p.currency,
                 'status', p.status
               ) end
           )
      from public.ssl_certificates c
      join public.order_items oi on oi.id = c.order_item_id
      join public.orders o on o.id = oi.order_id
      left join public.payments p on p.id = o.payment_id
     where c.id = v_job.certificate_id
  );
end;
$$;

-- N3: noted once, just before the job's supplier write. Returns when.
create or replace function public.note_ssl_job_sent(p_job_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update public.ssl_jobs set sent_at = coalesce(sent_at, now())
   where id = p_job_id and status = 'running'
  returning sent_at into v_at;
  if v_at is null then
    raise exception 'SSL job % is not running', p_job_id;
  end if;
  return v_at;
end;
$$;

-- Bought from the supplier: the line is done and the customer's set-up begins.
create or replace function public.complete_ssl_initialize(
  p_job_id               uuid,
  p_supplier_id          uuid,
  p_supplier_status      text,
  p_purchased_at         timestamptz,
  p_subscription_ends_at timestamptz,
  p_recovered            boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.ssl_jobs%rowtype;
  v_cert     public.ssl_certificates%rowtype;
  v_order_id uuid;
  v_refund   public.refunds%rowtype;
begin
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'ssl_initialize' then
    raise exception 'SSL job % is not an order', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'SSL job % is %', p_job_id, v_job.status;
  end if;

  select * into v_cert from public.ssl_certificates where id = v_job.certificate_id for update;

  update public.ssl_certificates
     set status = 'awaiting_setup',
         supplier_certificate_id = coalesce(p_supplier_id, supplier_certificate_id),
         supplier_status = left(p_supplier_status, 60),
         purchased_at = coalesce(p_purchased_at, purchased_at, now()),
         subscription_ends_at = coalesce(p_subscription_ends_at, subscription_ends_at),
         status_unrecognised_since = null,
         last_error_code = null
   where id = v_cert.id;

  update public.order_items set status = 'completed', failure_code = null
   where id = v_cert.order_item_id
  returning order_id into v_order_id;

  update public.ssl_jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null,
         last_error_code = case when p_recovered then 'RECOVERED' else null end
   where id = v_job.id;

  -- Ordered after all, though a refund was queued: stop it if it has not left.
  select * into v_refund from public.refunds
   where order_item_id = v_cert.order_item_id and status <> 'cancelled'
   for update;
  if found then
    if v_refund.status in ('queued', 'held', 'failed', 'needs_attention')
       and v_refund.provider_refund_id is null then
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'certificate ordered after all'));
    else
      insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
      values (v_cert.test_mode, 'registered_after_refund', v_order_id, v_refund.id::text,
              jsonb_build_object('refund_status', v_refund.status,
                                 'amount_kobo', v_refund.amount_kobo, 'certificate', true))
      on conflict do nothing;
    end if;
  end if;

  perform public.queue_email(
    'ssl_ready', 'transactional', v_cert.user_id, 'ssl_ready:' || v_cert.id,
    jsonb_build_object('certificate_id', v_cert.id, 'name', v_cert.common_name,
                       'product', v_cert.product_name),
    null, v_order_id, v_cert.test_mode);

  perform public.settle_order(v_order_id);
end;
$$;

-- The supplier took the set-up: the CA now emails the approver (FR-SSL-5).
create or replace function public.record_ssl_configured(
  p_job_id          uuid,
  p_supplier_status text,
  p_recovered       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ssl_jobs%rowtype;
begin
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'ssl_configure' then
    raise exception 'SSL job % is not a set-up', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'SSL job % is %', p_job_id, v_job.status;
  end if;

  update public.ssl_certificates
     set status = 'awaiting_validation',
         validation_method = 'email',
         supplier_status = left(p_supplier_status, 60),
         configured_at = now(),
         last_error_code = null,
         status_unrecognised_since = null,
         -- The poller asks the supplier soon, then less often (ssl/poller.ts).
         next_check_at = now() + interval '5 minutes'
   where id = v_job.certificate_id;

  update public.ssl_jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null,
         last_error_code = case when p_recovered then 'RECOVERED' else null end
   where id = v_job.id;
end;
$$;

-- The supplier refused the set-up for something the customer can fix: back
-- to them, with our code for why. No money moves.
create or replace function public.refuse_ssl_setup(p_job_id uuid, p_code text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ssl_jobs%rowtype;
begin
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'ssl_configure' then
    raise exception 'SSL job % is not a set-up', p_job_id;
  end if;
  if v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  update public.ssl_jobs
     set status = 'failed', finished_at = now(), last_error_code = left(p_code, 60),
         last_error = left(p_message, 500), locked_by = null, locked_at = null
   where id = v_job.id;

  update public.ssl_certificates
     set status = 'awaiting_setup', last_error_code = left(p_code, 60)
   where id = v_job.certificate_id and status = 'setting_up';
end;
$$;

-- A reissue the supplier took. `p_state` is where the certificate now stands:
-- awaiting_setup (a new request is wanted), awaiting_validation or issued.
create or replace function public.record_ssl_reissue(
  p_job_id          uuid,
  p_supplier_status text,
  p_state           text,
  p_recovered       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ssl_jobs%rowtype;
begin
  if p_state not in ('awaiting_setup', 'awaiting_validation', 'issued') then
    raise exception 'not a state a reissue leaves: %', p_state;
  end if;
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'ssl_reissue' then
    raise exception 'SSL job % is not a reissue', p_job_id;
  end if;
  if v_job.status = 'succeeded' then
    return;
  end if;
  if v_job.status not in ('running', 'needs_attention') then
    raise exception 'SSL job % is %', p_job_id, v_job.status;
  end if;

  update public.ssl_certificates
     set status = p_state,
         supplier_status = left(p_supplier_status, 60),
         reissue_count = reissue_count + 1,
         -- Issued again at once: drop the old text so the poller fetches the new.
         certificate_pem = case when p_state = 'issued' then null else certificate_pem end,
         ca_bundle_pem = case when p_state = 'issued' then null else ca_bundle_pem end,
         last_error_code = null,
         status_unrecognised_since = null,
         configured_at = case when p_state = 'awaiting_validation' then now() else configured_at end,
         next_check_at = now() + interval '5 minutes'
   where id = v_job.certificate_id;

  update public.ssl_jobs
     set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null,
         last_error_code = case when p_recovered then 'RECOVERED' else null end
   where id = v_job.id;
end;
$$;

-- Unknown, retries left: try again later (I2).
create or replace function public.reschedule_ssl_job(
  p_job_id        uuid,
  p_delay_seconds integer,
  p_code          text,
  p_message       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ssl_jobs
     set status = 'queued',
         run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
         last_error_code = left(p_code, 60),
         last_error = left(p_message, 500),
         locked_by = null,
         locked_at = null
   where id = p_job_id
     and status = 'running';
end;
$$;

-- A job's end. needs_attention: the outcome is unknown, or our data is bad —
-- a person looks, nothing is refunded. Otherwise it failed: an order the
-- supplier refused is refunded; a set-up or reissue goes back to the customer.
create or replace function public.fail_ssl_job(
  p_job_id          uuid,
  p_code            text,
  p_message         text,
  p_needs_attention boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.ssl_jobs%rowtype;
  v_cert     public.ssl_certificates%rowtype;
  v_order_id uuid;
begin
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  if coalesce(p_needs_attention, true) then
    update public.ssl_jobs
       set status = 'needs_attention', last_error_code = left(p_code, 60),
           last_error = left(p_message, 500), locked_by = null, locked_at = null
     where id = v_job.id;
    return;
  end if;

  update public.ssl_jobs
     set status = 'failed', finished_at = now(), last_error_code = left(p_code, 60),
         last_error = left(p_message, 500), locked_by = null, locked_at = null
   where id = v_job.id;

  select * into v_cert from public.ssl_certificates where id = v_job.certificate_id for update;

  if v_job.kind = 'ssl_initialize' then
    update public.ssl_certificates
       set status = 'failed', last_error_code = left(p_code, 60)
     where id = v_cert.id and status = 'pending';
    update public.order_items set status = 'failed', failure_code = left(p_code, 60)
     where id = v_cert.order_item_id
    returning order_id into v_order_id;
    perform public.queue_email(
      'order_line_failed', 'transactional', v_cert.user_id, 'ssl_failed:' || v_cert.id,
      jsonb_build_object('domain', v_cert.common_name, 'action', 'certificate', 'code', p_code),
      null, v_order_id, v_cert.test_mode);
    perform public.enqueue_line_refund(v_cert.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind = 'ssl_configure' then
    update public.ssl_certificates
       set status = 'awaiting_setup', last_error_code = left(p_code, 60)
     where id = v_cert.id and status = 'setting_up';
  elsif v_job.kind = 'ssl_reissue' then
    update public.ssl_certificates
       set status = 'issued', last_error_code = left(p_code, 60)
     where id = v_cert.id and status = 'reissuing';
  end if;
end;
$$;

-- For a person, after looking: run a held or failed job again. A failed
-- order's refund is stopped first, and refused once it reached Flutterwave.
create or replace function public.retry_ssl_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job    public.ssl_jobs%rowtype;
  v_cert   public.ssl_certificates%rowtype;
  v_refund public.refunds%rowtype;
begin
  select * into v_job from public.ssl_jobs where id = p_job_id for update;
  if not found or v_job.status not in ('needs_attention', 'failed') then
    return;
  end if;
  select * into v_cert from public.ssl_certificates where id = v_job.certificate_id for update;

  if v_job.kind = 'ssl_initialize' and v_job.status = 'failed' then
    select * into v_refund from public.refunds
     where order_item_id = v_cert.order_item_id and status <> 'cancelled'
     for update;
    if found then
      if v_refund.status in ('sending', 'submitted', 'completed') or v_refund.provider_refund_id is not null then
        raise exception 'the refund for this line has reached Flutterwave (%): settle it before ordering again',
          v_refund.status;
      end if;
      update public.refunds set status = 'cancelled' where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'cancelled', jsonb_build_object('why', 'certificate order retried'));
    end if;
    update public.order_items set status = 'pending', failure_code = null
     where id = v_cert.order_item_id and status = 'failed';
    update public.ssl_certificates set status = 'pending', last_error_code = null
     where id = v_cert.id and status = 'failed';
    update public.orders o set status = 'provisioning'
      from public.order_items oi
     where oi.id = v_cert.order_item_id and o.id = oi.order_id
       and o.status in ('failed', 'partially_failed');
  elsif v_job.kind = 'ssl_configure' and v_job.status = 'failed' then
    update public.ssl_certificates set status = 'setting_up', last_error_code = null
     where id = v_cert.id and status = 'awaiting_setup';
  elsif v_job.kind = 'ssl_reissue' and v_job.status = 'failed' then
    update public.ssl_certificates set status = 'reissuing', last_error_code = null
     where id = v_cert.id and status = 'issued';
  end if;

  update public.ssl_jobs
     set status = 'queued', run_after = now(), attempts = 0, locked_by = null, locked_at = null,
         finished_at = null
   where id = p_job_id;
end;
$$;

-- The customer's set-up (FR-SSL-4), called by the web with the session's
-- user id after its own checks: stored on the certificate, then a job sends
-- it to the supplier. Never a private key (the table refuses one).
create or replace function public.request_ssl_setup(
  p_user_id        uuid,
  p_certificate_id uuid,
  p_csr            text,
  p_approver_email text,
  p_web_server     text,
  p_san_names      text[],
  p_contact        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cert public.ssl_certificates%rowtype;
  v_job  uuid;
begin
  select * into v_cert from public.ssl_certificates
   where id = p_certificate_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'certificate % is not this account''s', p_certificate_id using errcode = '42501';
  end if;
  if v_cert.status <> 'awaiting_setup' then
    raise exception 'certificate % is %, not waiting for its set-up', p_certificate_id, v_cert.status
      using errcode = '55000';
  end if;
  if coalesce(p_csr, '') ~ 'PRIVATE KEY' then
    raise exception 'a private key is never stored' using errcode = '22023';
  end if;
  if v_cert.is_wildcard and cardinality(coalesce(p_san_names, '{}')) > 0 then
    raise exception 'a wildcard certificate takes no extra names' using errcode = '22023';
  end if;

  update public.ssl_certificates
     set csr = p_csr,
         approver_email = lower(trim(p_approver_email)),
         validation_method = 'email',
         web_server = p_web_server,
         san_names = coalesce(p_san_names, '{}'),
         contact = p_contact,
         status = 'setting_up',
         last_error_code = null
   where id = v_cert.id;

  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode)
  values ('ssl_configure',
          'ssl_configure:' || v_cert.id || ':' ||
            (select count(*) + 1 from public.ssl_jobs where certificate_id = v_cert.id and kind = 'ssl_configure'),
          v_cert.id, v_cert.test_mode)
  returning id into v_job;
  return v_job;
end;
$$;

-- A reissue the customer asked for (FR-SSL-8): queued, sent by the gateway.
create or replace function public.request_ssl_reissue(p_user_id uuid, p_certificate_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cert public.ssl_certificates%rowtype;
  v_job  uuid;
begin
  select * into v_cert from public.ssl_certificates
   where id = p_certificate_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'certificate % is not this account''s', p_certificate_id using errcode = '42501';
  end if;
  if v_cert.status <> 'issued' then
    raise exception 'certificate % is %, not issued', p_certificate_id, v_cert.status
      using errcode = '55000';
  end if;

  update public.ssl_certificates set status = 'reissuing', last_error_code = null
   where id = v_cert.id;

  insert into public.ssl_jobs (kind, idempotency_key, certificate_id, test_mode)
  values ('ssl_reissue', 'ssl_reissue:' || v_cert.id || ':' || (v_cert.reissue_count + 1),
          v_cert.id, v_cert.test_mode)
  returning id into v_job;
  return v_job;
end;
$$;

-- What the supplier's check-status said (the gateway's poller, FR-SSL-7).
-- `p_state` is our word for it, or null for a word we do not know: then
-- nothing changes but the record of it, and a day later a person is told.
create or replace function public.record_ssl_status(
  p_certificate_id     uuid,
  p_supplier_status    text,
  p_state              text,
  p_issued_at          timestamptz,
  p_expires_at         timestamptz,
  p_certificate        text,
  p_ca_bundle          text,
  p_next_check_seconds integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cert public.ssl_certificates%rowtype;
  v_next timestamptz := now() + make_interval(secs => greatest(coalesce(p_next_check_seconds, 3600), 60));
begin
  if p_state is not null
     and p_state not in ('awaiting_setup', 'awaiting_validation', 'issued', 'revoked', 'cancelled') then
    raise exception 'not a certificate state: %', p_state;
  end if;
  select * into v_cert from public.ssl_certificates where id = p_certificate_id for update;
  if not found then
    raise exception 'certificate % not found', p_certificate_id;
  end if;

  -- A job holds it (set-up or reissue in hand): its answer wins; only note the look.
  if v_cert.status not in ('awaiting_validation', 'issued') then
    update public.ssl_certificates set last_checked_at = now() where id = v_cert.id;
    return v_cert.status;
  end if;

  if p_state is null then
    update public.ssl_certificates
       set supplier_status = left(p_supplier_status, 60),
           status_unrecognised_since = coalesce(status_unrecognised_since, now()),
           last_checked_at = now(),
           next_check_at = v_next
     where id = v_cert.id;
    return v_cert.status;
  end if;

  update public.ssl_certificates
     set status = p_state,
         supplier_status = left(p_supplier_status, 60),
         status_unrecognised_since = null,
         -- Newly issued (first time, or after a reissue): this certificate's
         -- dates and text, or none yet — never the one it replaces, which
         -- would stop the poller fetching the new one.
         issued_at = case
           when p_state <> 'issued' then issued_at
           when v_cert.status = 'issued' then coalesce(p_issued_at, issued_at)
           else coalesce(p_issued_at, now()) end,
         expires_at = case
           when p_state <> 'issued' then expires_at
           when v_cert.status = 'issued' then coalesce(p_expires_at, expires_at)
           else p_expires_at end,
         certificate_pem = case
           when p_state <> 'issued' then certificate_pem
           when nullif(trim(coalesce(p_certificate, '')), '') is not null then p_certificate
           when v_cert.status = 'issued' then certificate_pem
           else null end,
         ca_bundle_pem = case
           when p_state <> 'issued' then ca_bundle_pem
           when nullif(trim(coalesce(p_ca_bundle, '')), '') is not null then p_ca_bundle
           when v_cert.status = 'issued' then ca_bundle_pem
           else null end,
         last_checked_at = now(),
         next_check_at = v_next
   where id = v_cert.id;

  if p_state = 'issued' and v_cert.status = 'awaiting_validation' then
    perform public.queue_email(
      'ssl_issued', 'transactional', v_cert.user_id,
      'ssl_issued:' || v_cert.id || ':' || v_cert.reissue_count,
      jsonb_build_object('certificate_id', v_cert.id, 'name', v_cert.common_name,
                         'expires_at', coalesce(p_expires_at, v_cert.expires_at)),
      null, null, v_cert.test_mode);
  end if;
  return p_state;
end;
$$;

-- Certificates the poller should ask about now: waiting on the approver, or
-- issued but without the certificate text yet. Oldest look first.
create or replace function public.ssl_certificates_to_check(p_test_mode boolean, p_limit integer default 10)
returns table (
  id              uuid,
  common_name     text,
  status          text,
  is_wildcard     boolean,
  configured_at   timestamptz,
  has_certificate boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.common_name, c.status, c.is_wildcard, c.configured_at,
         c.certificate_pem is not null
    from public.ssl_certificates c
   where c.test_mode = p_test_mode
     and (c.status = 'awaiting_validation' or (c.status = 'issued' and c.certificate_pem is null))
     and coalesce(c.next_check_at, c.updated_at) <= now()
   order by coalesce(c.next_check_at, c.updated_at)
   limit least(greatest(coalesce(p_limit, 10), 1), 100)
$$;

-- Whether a certificate for this name is already ours on this side — any
-- account's, anything but a failed order. The web refuses to sell one then.
create or replace function public.ssl_name_in_use(p_common_name text, p_test_mode boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ssl_certificates c
     where c.common_name = lower(p_common_name)
       and c.test_mode = p_test_mode
       and c.status <> 'failed'
  )
$$;

-- ── Alerts: SSL jobs and statuses that need a person ────────────────────────

create or replace function public.current_alert_conditions(p_test_mode boolean)
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
                  when 'transfer_domain' then 'Transfer'
                  when 'set_transfer_lock' then 'Transfer lock change'
                  when 'set_privacy' then 'Privacy change'
                  when 'update_contacts' then 'Contact change'
                  else 'Nameserver change'
                end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- The same for certificates (migration 39): never refunded or re-sent by itself.
  select 'ssl_job:' || j.id,
         'critical',
         'ssl_job_needs_attention',
         format('%s of the SSL certificate for %s%s needs a person (%s)',
                case j.kind
                  when 'ssl_initialize' then 'The order'
                  when 'ssl_configure' then 'The set-up'
                  when 'ssl_reissue' then 'The reissue'
                  else 'A job'
                end,
                c.common_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.ssl_jobs j
    join public.ssl_certificates c on c.id = j.certificate_id
    left join public.order_items oi on oi.id = c.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- A status word from the supplier we do not know, for a day.
  select 'ssl_status:' || c.id,
         'warning',
         'ssl_status_unrecognised',
         format('The supplier calls the SSL certificate for %s "%s", which we do not recognise — check it and teach the gateway the word',
                c.common_name, coalesce(c.supplier_status, ''))
    from public.ssl_certificates c
   where c.test_mode = p_test_mode
     and c.status_unrecognised_since < now() - interval '1 day'

  union all
  -- I5: paid, and not settled in time.
  select 'order_stuck:' || o.id,
         'critical',
         'order_stuck',
         format('Order %s was paid %s minutes ago and is still %s',
                o.order_number, floor(extract(epoch from now() - o.paid_at) / 60), o.status)
    from public.orders o
    cross join public.ops_settings s
   where o.test_mode = p_test_mode
     and o.status in ('paid', 'provisioning')
     and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
     -- A transfer waits days for the other registrar; only other lines are late (migration 26).
     and exists (
       select 1 from public.order_items oi2
        where oi2.order_id = o.id
          and oi2.status in ('pending', 'provisioning')
          and not (oi2.item_type = 'transfer' and exists (
            select 1 from public.domains d2
             where d2.order_item_id = oi2.id and d2.local_status = 'transfer_pending'))
     )

  union all
  -- Refunds a person must look at, or approve.
  select 'refund:' || r.id,
         case when r.status = 'held' then 'warning' else 'critical' end,
         'refund_' || r.status,
         format('Refund of ₦%s for order %s%s is %s%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number,
                coalesce(' (' || oi.domain || ')', ''),
                replace(r.status::text, '_', ' '),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')

  union all
  -- A refund that should have gone out 30 minutes ago: is the worker running?
  select 'refund_overdue:' || r.id,
         'critical',
         'refund_overdue',
         format('Refund of ₦%s for order %s has waited %s minutes to be sent%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.run_after) / 60),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status in ('queued', 'sending')
     and r.run_after < now() - interval '30 minutes'

  union all
  -- Accepted by Flutterwave but not completed after ten days.
  select 'refund_slow:' || r.id,
         'warning',
         'refund_slow',
         format('Refund of ₦%s for order %s was sent %s days ago and has not completed',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.submitted_at) / 86400))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status = 'submitted'
     and r.submitted_at < now() - interval '10 days'

  union all
  -- Money that arrived but could not be applied, or a refund that could not be queued.
  select 'incident:' || i.id,
         'critical',
         'payment_' || i.kind,
         format('Payment incident: %s%s',
                replace(i.kind, '_', ' '),
                coalesce(', order ' || o.order_number, ''))
    from public.payment_incidents i
    left join public.orders o on o.id = i.order_id
   where i.test_mode = p_test_mode and i.resolved_at is null

  union all
  -- The registry disagrees with us (§13.5).
  select 'drift:' || g.id,
         case when g.kind in ('supplier_may_renew', 'unknown_domain') then 'warning' else 'critical' end,
         'drift_' || g.kind,
         format('Registry check: %s — %s', g.domain_name, replace(g.kind, '_', ' '))
    from public.registry_drift g
   where g.test_mode = p_test_mode and g.resolved_at is null

  union all
  -- The registry has not been read successfully for three hours.
  select 'reconcile_stale:' || p_test_mode::text,
         'warning',
         'reconcile_stale',
         'The registry has not been reconciled successfully for over three hours'
   where exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode and r.started_at > now() - interval '7 days'
         )
     and not exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode
              and r.finished_at > now() - interval '3 hours'
              and r.error is null
         )

  union all
  -- FR-FLOAT-2, simplified: checkout refuses orders the float cannot cover.
  select 'float_low:' || p_test_mode::text,
         'warning',
         'float_low',
         format('Supplier balance is $%s, below the $%s alert level. Checkout refuses orders it cannot cover.',
                to_char(b.balance_usd, 'FM999,999,990.00'), to_char(s.float_alert_usd, 'FM999,990.00'))
    from (
      select balance_usd, taken_at from public.supplier_balance_snapshots
       where test_mode = p_test_mode order by taken_at desc limit 1
    ) b
    cross join public.ops_settings s
   where b.taken_at > now() - interval '2 hours'
     and b.balance_usd < s.float_alert_usd

  union all
  -- The weekly catalogue syncs inside the gateway (migrations 27 and 39): the
  -- last run failed or was refused, or nothing has succeeded for eight days.
  -- Prices then drift from the supplier's.
  select 'catalogue_sync:' || h.name,
         'warning',
         'catalogue_sync',
         case
           when h.detail ->> 'outcome' in ('failed', 'refused')
             then format('The supplier %s sync %s on %s — prices are not being updated',
                         case when h.name like 'ssl%' then 'SSL product' else 'catalogue' end,
                         h.detail ->> 'outcome', to_char(h.beat_at, 'DD Mon HH24:MI'))
           else format('The supplier %s has not synced for over eight days — prices are not being updated',
                       case when h.name like 'ssl%' then 'SSL product list' else 'catalogue' end)
         end
    from public.service_heartbeats h
   where p_test_mode = false
     and h.name in ('catalogue:production', 'ssl_catalogue:production')
     and (
       h.detail ->> 'outcome' in ('failed', 'refused')
       or coalesce((h.detail ->> 'lastSuccessAt')::timestamptz, h.beat_at - interval '9 days')
          < now() - interval '8 days'
     )

  union all
  -- FR-NT3: an ERRP notice that bounced is a compliance failure — the
  -- registrant must be reached another way. Raised for three days.
  select 'notice_bounced:' || c.id,
         'critical',
         'compliance_notice_bounced',
         format('The %s expiry notice for %s bounced — reach the registrant another way',
                case c.notice_type when 'errp_pre_35' then 'one-month'
                                   when 'errp_pre_7' then 'one-week'
                                   else 'after-expiry' end,
                c.domain_name)
    from public.compliance_notices c
    join public.email_outbox e on e.id = c.email_id
   where e.test_mode = p_test_mode
     and c.delivery_status = 'bounced'
     and c.delivery_checked_at > now() - interval '3 days'

  union all
  -- An email that could not be sent at all (migration 31).
  select 'email_failed:' || e.id,
         case when e.category = 'transactional' then 'warning' else 'critical' end,
         'email_failed',
         format('A %s email (%s%s) could not be sent: %s',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                coalesce(e.last_error, 'no reason given'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'failed'
     and e.updated_at > now() - interval '3 days'

  union all
  -- Emails not sent after half an hour: the gateway's sender is not running,
  -- has no credentials for its provider (EMAIL_PROVIDER), or the provider is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and its provider''s credentials (EMAIL_PROVIDER)',
                count(*))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status in ('pending', 'sending')
     and e.created_at < now() - interval '30 minutes'
  having count(*) > 0

  union all
  -- FR-D2: a preset the DNS check hid — customers no longer see it.
  select 'preset_hidden:' || p.id,
         'critical',
         'preset_hidden',
         format('Host preset %s is hidden: its nameservers stopped resolving on %s. Check the provider''s documentation, fix or retire it.',
                p.provider, to_char(p.check_failed_since, 'DD Mon'))
    from public.nameserver_presets p
   where p_test_mode = false and p.is_hidden and p.auto_hidden_at is not null

  union all
  -- …and one failing, not yet hidden.
  select 'preset_failing:' || p.id,
         'warning',
         'preset_failing',
         format('Host preset %s: its nameservers are not resolving (since %s). It is hidden after a day.',
                p.provider, to_char(p.check_failed_since, 'DD Mon HH24:MI'))
    from public.nameserver_presets p
   where p_test_mode = false and p.check_failed_since is not null and not p.is_hidden

  union all
  -- The quarterly re-verification against the provider's own documentation.
  select 'preset_stale:' || p.id,
         'warning',
         'preset_stale',
         format('Host preset %s was last verified against its documentation on %s — check it again and update verified_at.',
                p.provider, to_char(p.verified_at, 'DD Mon YYYY'))
    from public.nameserver_presets p
   where p_test_mode = false and not p.is_hidden and p.verified_at < now() - interval '90 days'

  union all
  -- FR-NT3: an ERRP or security email with no final delivery report a day
  -- after sending. SES pushes its reports (migration 34) and Brevo is read
  -- back; either way a missing one is not a delivery. Raised for three days.
  select 'email_unconfirmed:' || e.id,
         case when e.category = 'compliance' then 'critical' else 'warning' end,
         'email_unconfirmed',
         format('A %s email (%s%s) sent %s UTC has no delivery report — check the email provider''s log; it is not counted as delivered',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                to_char(e.sent_at at time zone 'UTC', 'DD Mon HH24:MI'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'sent'
     and e.category in ('compliance', 'security')
     and coalesce(e.delivery_status, 'deferred') = 'deferred'
     and e.sent_at < now() - interval '24 hours'
     and e.sent_at > now() - interval '4 days'

  union all
  -- A recipient reported one of our emails as spam (SES, migration 34).
  -- Complaints cost the sending domain its reputation, and SES now
  -- suppresses the address. Raised for three days.
  select 'email_complaint:' || e.id,
         'warning',
         'email_complaint',
         format('A %s email (%s%s) was reported as spam by its recipient — SES will not send to that address again until it leaves the account''s suppression list',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.complained_at > now() - interval '3 days'
$$;

-- ── Who may call what ───────────────────────────────────────────────────────

revoke all on function public.ssl_for_paid_order() from public, anon, authenticated, service_role;
revoke all on function public.claim_ssl_job(text, boolean, integer, uuid) from public, anon, authenticated;
revoke all on function public.note_ssl_job_sent(uuid) from public, anon, authenticated;
revoke all on function public.complete_ssl_initialize(uuid, uuid, text, timestamptz, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.record_ssl_configured(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.refuse_ssl_setup(uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_ssl_reissue(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.reschedule_ssl_job(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.fail_ssl_job(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.retry_ssl_job(uuid) from public, anon, authenticated;
revoke all on function public.request_ssl_setup(uuid, uuid, text, text, text, text[], jsonb) from public, anon, authenticated;
revoke all on function public.request_ssl_reissue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_ssl_status(uuid, text, text, timestamptz, timestamptz, text, text, integer) from public, anon, authenticated;
revoke all on function public.ssl_certificates_to_check(boolean, integer) from public, anon, authenticated;
revoke all on function public.ssl_name_in_use(text, boolean) from public, anon, authenticated;

grant execute on function public.claim_ssl_job(text, boolean, integer, uuid) to service_role;
grant execute on function public.note_ssl_job_sent(uuid) to service_role;
grant execute on function public.complete_ssl_initialize(uuid, uuid, text, timestamptz, timestamptz, boolean) to service_role;
grant execute on function public.record_ssl_configured(uuid, text, boolean) to service_role;
grant execute on function public.refuse_ssl_setup(uuid, text, text) to service_role;
grant execute on function public.record_ssl_reissue(uuid, text, text, boolean) to service_role;
grant execute on function public.reschedule_ssl_job(uuid, integer, text, text) to service_role;
grant execute on function public.fail_ssl_job(uuid, text, text, boolean) to service_role;
grant execute on function public.retry_ssl_job(uuid) to service_role;
grant execute on function public.request_ssl_setup(uuid, uuid, text, text, text, text[], jsonb) to service_role;
grant execute on function public.request_ssl_reissue(uuid, uuid) to service_role;
grant execute on function public.record_ssl_status(uuid, text, text, timestamptz, timestamptz, text, text, integer) to service_role;
grant execute on function public.ssl_certificates_to_check(boolean, integer) to service_role;
grant execute on function public.ssl_name_in_use(text, boolean) to service_role;

notify pgrst, 'reload schema';
