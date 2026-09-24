-- ─────────────────────────────────────────────────────────────────────────────
-- Refunds (PRD FR-R3, I6, §8.5; backlog L15) and ops alerts (I5, §13.5; L16),
-- with the payment hardening they need (SEC-7, SEC-11).
--
-- Money goes back only through these functions, and only to the Flutterwave
-- charge it came from — a refund cannot be pointed anywhere else. The rules
-- that keep it safe live here rather than in the worker, so neither a bug nor
-- a leaked service key can:
--   • refund more than a charge took — a trigger sums every refund per charge;
--   • refund a line twice — one refund per line, one per extra charge;
--   • rewrite or delete a live payment or refund — direct writes are revoked,
--     only these functions change them, and a completed refund is final;
--   • send a large refund with nobody looking — per-refund and daily limits
--     hold it for approval, and approving is not granted to the service key.
--
-- Refunds go to the original payment method, as the published refund policy
-- promises (§8.5 allows "to source"); the wallet FR-R3 prefers is not built.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Settings a person tunes; the service key cannot change them ─────────────
create table public.ops_settings (
  id                          boolean primary key default true check (id),
  -- A single refund above this waits for a person (approve_refund).
  auto_refund_max_kobo        bigint not null default 25000000 check (auto_refund_max_kobo > 0),
  -- Automatic refunds sent in any 24 hours, per side. Beyond it, refunds wait.
  auto_refund_daily_max_kobo  bigint not null default 100000000
                                check (auto_refund_daily_max_kobo > 0),
  -- How long a failed line waits before its refund goes out: time for a late
  -- registry answer to surface. The worker also reads the registry first.
  refund_delay_minutes        integer not null default 10
                                check (refund_delay_minutes between 0 and 1440),
  -- I5: paid but not settled for this long raises an alert.
  stuck_order_minutes         integer not null default 15
                                check (stuck_order_minutes between 5 and 1440),
  -- SEC-11: domains one account may order in any 24 hours.
  max_domains_per_account_day integer not null default 20
                                check (max_domains_per_account_day between 1 and 1000),
  -- FR-FLOAT-2, simplified: alert when the supplier balance drops below this.
  float_alert_usd             numeric(10, 2) not null default 25 check (float_alert_usd >= 0),
  updated_at                  timestamptz not null default now()
);
insert into public.ops_settings default values;

create trigger ops_settings_set_updated_at
  before update on public.ops_settings
  for each row execute function public.set_updated_at();

-- ── Payments: the charge that paid an order, and underpayments ──────────────
alter table public.payments
  add constraint payments_status_known check (status in ('successful', 'underpaid'));

-- The charge that paid for the order. Line refunds are made against it.
alter table public.orders
  add column payment_id uuid references public.payments (id) on delete restrict;

update public.orders o
   set payment_id = first_paid.id
  from (
    select distinct on (order_id) id, order_id
      from public.payments
     where status = 'successful'
     order by order_id, created_at, id
  ) first_paid
 where first_paid.order_id = o.id
   and o.paid_at is not null;

-- ── Refunds ──────────────────────────────────────────────────────────────────
create type public.refund_reason as enum (
  'registration_failed',  -- a paid line the registry would not register (FR-R3)
  'duplicate_charge',     -- a second charge for an order already paid (§8.5)
  'overpayment',          -- a charge larger than the order total: the excess
  'underpayment',         -- a charge smaller than the total pays for nothing: all of it
  'empty_order'           -- a charge for an order with nothing in it
);

create type public.refund_status as enum (
  'queued',           -- waiting to be sent
  'held',             -- over an automatic limit: waits for a person to approve
  'sending',          -- claimed; the request may be in flight
  'submitted',        -- Flutterwave accepted it; waiting for it to complete
  'completed',        -- Flutterwave has returned the money. Final.
  'failed',           -- Flutterwave refused it; a person decides what next
  'needs_attention',  -- we do not know what happened, or a safety check stopped it
  'cancelled'         -- a person decided not to refund
);

create table public.refunds (
  id                  uuid primary key default extensions.gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete restrict,
  -- The charge the money goes back to. Flutterwave refunds a transaction, so
  -- this is also where the money lands: the card or account that paid.
  payment_id          uuid not null references public.payments (id) on delete restrict,
  order_item_id       uuid references public.order_items (id) on delete restrict,
  user_id             uuid not null references public.profiles (id) on delete restrict,
  reason              public.refund_reason not null,
  amount_kobo         bigint not null check (amount_kobo > 0),
  test_mode           boolean not null,
  status              public.refund_status not null default 'queued',
  -- Flutterwave's refund id, once it has one. A charge's refunds at
  -- Flutterwave are matched to ours by it, so it is never reused.
  provider_refund_id  text unique,
  provider_status     text,
  attempts            smallint not null default 0,
  run_after           timestamptz not null default now(),
  locked_by           text,
  locked_at           timestamptz,
  last_error_code     text,
  last_error          text,
  approved_by         text,
  approved_at         timestamptz,
  submitted_at        timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((reason = 'registration_failed') = (order_item_id is not null))
);

-- One refund per failed line, and one per extra charge (I6: never twice).
create unique index refunds_one_per_line
  on public.refunds (order_item_id) where order_item_id is not null;
create unique index refunds_one_per_extra_charge
  on public.refunds (payment_id, reason) where order_item_id is null;
create index refunds_claim_idx
  on public.refunds (test_mode, run_after) where status in ('queued', 'sending', 'submitted');
create index refunds_order_idx on public.refunds (order_id);

create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function public.set_updated_at();

-- An append-only history of every refund: what happened, when, and who.
-- Codes and ids only — never a card, an account number or a name (N13).
create table public.refund_events (
  id          bigserial primary key,
  refund_id   uuid not null references public.refunds (id) on delete restrict,
  event       text not null,
  actor       text not null default 'system',
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index refund_events_refund_idx on public.refund_events (refund_id, created_at);

/*
 * The money rules, enforced on every write whoever makes it:
 *   • a refund's target and amount never change once written;
 *   • a completed refund is final, and keeps its provider reference;
 *   • status moves only along the paths below;
 *   • the refunds against one charge never add up to more than it took.
 * The charge row is locked while summing, so two refunds racing for the same
 * charge are counted one after the other.
 */
create or replace function public.refunds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_payment  public.payments%rowtype;
  v_refunded bigint;
begin
  if tg_op = 'UPDATE' then
    if old.status = 'completed' then
      raise exception 'a completed refund is final';
    end if;
    if new.order_id <> old.order_id
       or new.payment_id <> old.payment_id
       or new.order_item_id is distinct from old.order_item_id
       or new.user_id <> old.user_id
       or new.reason <> old.reason
       or new.amount_kobo <> old.amount_kobo
       or new.test_mode <> old.test_mode then
      raise exception 'a refund''s amount and target never change';
    end if;
    if old.provider_refund_id is not null
       and new.provider_refund_id is distinct from old.provider_refund_id then
      raise exception 'a refund keeps its provider reference';
    end if;
    if new.status = old.status then
      return new;
    end if;
    if not (
         (old.status = 'queued'          and new.status in ('held', 'sending', 'cancelled'))
      or (old.status = 'held'            and new.status in ('queued', 'cancelled'))
      or (old.status = 'sending'         and new.status in ('queued', 'submitted', 'completed', 'failed', 'needs_attention'))
      or (old.status = 'submitted'       and new.status in ('completed', 'failed', 'needs_attention'))
      or (old.status = 'failed'          and new.status in ('queued', 'cancelled'))
      or (old.status = 'needs_attention' and new.status in ('queued', 'cancelled'))
      or (old.status = 'cancelled'       and new.status in ('queued'))
    ) then
      raise exception 'a refund cannot move from % to %', old.status, new.status;
    end if;
  end if;

  select * into v_payment from public.payments where id = new.payment_id for update;
  if not found or v_payment.order_id <> new.order_id then
    raise exception 'a refund goes back to a charge on its own order';
  end if;
  if v_payment.currency <> 'NGN' then
    raise exception 'only naira charges are refunded automatically';
  end if;

  if new.status <> 'cancelled' then
    select coalesce(sum(r.amount_kobo), 0) into v_refunded
      from public.refunds r
     where r.payment_id = new.payment_id
       and r.id <> new.id
       and r.status <> 'cancelled';
    if v_refunded + new.amount_kobo > v_payment.amount_kobo then
      raise exception 'refunds would exceed charge % (% + % > %)',
        v_payment.provider_reference, v_refunded, new.amount_kobo, v_payment.amount_kobo
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger refunds_guard
  before insert or update on public.refunds
  for each row execute function public.refunds_guard();

/* Live money rows are never rewritten or deleted. Test rows may be purged. */
create or replace function public.money_rows_are_final()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_test boolean;
begin
  if tg_table_name = 'payments' then
    select o.test_mode into v_test from public.orders o where o.id = old.order_id;
    if tg_op = 'UPDATE' then
      raise exception 'payments are never rewritten';
    end if;
  elsif tg_table_name = 'refunds' then
    v_test := old.test_mode;
  elsif tg_table_name = 'refund_events' then
    if tg_op = 'UPDATE' then
      raise exception 'refund history is never rewritten';
    end if;
    select r.test_mode into v_test from public.refunds r where r.id = old.refund_id;
  end if;

  if coalesce(v_test, false) = false then
    raise exception 'live money records are never deleted';
  end if;
  return old;
end;
$$;

create trigger payments_are_final
  before update or delete on public.payments
  for each row execute function public.money_rows_are_final();
create trigger refunds_are_kept
  before delete on public.refunds
  for each row execute function public.money_rows_are_final();
create trigger refund_events_are_final
  before update or delete on public.refund_events
  for each row execute function public.money_rows_are_final();

-- ── Payment incidents: money that arrived but could not be applied ──────────
create table public.payment_incidents (
  id                  bigserial primary key,
  test_mode           boolean not null,
  kind                text not null check (kind in (
                        'underpayment',        -- a successful charge below the total; refunded
                        'tx_ref_mismatch',     -- a transaction presented for the wrong order
                        'currency_mismatch',   -- a successful charge not in naira
                        'unrecorded_payment',  -- verified at Flutterwave, not recorded here
                        'refund_not_created'   -- a refund was due but could not be queued
                      )),
  order_id            uuid references public.orders (id) on delete set null,
  provider_reference  text,
  -- Amounts, statuses and codes only — never card, account or contact data.
  detail              jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text
);
-- One open incident per kind, order and charge: repeats do not pile up.
create unique index payment_incidents_open_unique
  on public.payment_incidents (kind, coalesce(order_id::text, ''), coalesce(provider_reference, ''))
  where resolved_at is null;

/* For the web app's payment path. Security events are recorded, not just logged. */
create or replace function public.record_payment_incident(
  p_kind               text,
  p_order_id           uuid,
  p_provider_reference text,
  p_detail             jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test boolean;
begin
  select o.test_mode into v_test from public.orders o where o.id = p_order_id;
  insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
  values (coalesce(v_test, false), p_kind, p_order_id, left(p_provider_reference, 64),
          coalesce(p_detail, '{}'))
  on conflict do nothing;
end;
$$;

-- ── Queueing a refund ────────────────────────────────────────────────────────

/* Why a refund must wait for a person, or null when it may go out now. */
create or replace function public.refund_hold_reason(
  p_amount_kobo bigint,
  p_test_mode   boolean,
  p_exclude_id  uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_amount_kobo > s.auto_refund_max_kobo then 'over_single_limit'
    when (
      select coalesce(sum(r.amount_kobo), 0)
        from public.refunds r
       where r.test_mode = p_test_mode
         and r.id is distinct from p_exclude_id
         and r.status in ('sending', 'submitted', 'completed')
         and coalesce(r.submitted_at, r.updated_at) > now() - interval '24 hours'
    ) + p_amount_kobo > s.auto_refund_daily_max_kobo then 'over_daily_limit'
  end
  from public.ops_settings s
$$;

/*
 * Queues one refund. Never raises: it runs inside the transaction that failed
 * a line or recorded a charge, and a refund that cannot be queued must not
 * undo that. It becomes a payment incident — an alert — instead.
 */
create or replace function public.enqueue_refund(
  p_order_id       uuid,
  p_payment_id     uuid,
  p_order_item_id  uuid,
  p_reason         public.refund_reason,
  p_amount_kobo    bigint,
  p_delay_minutes  integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_settings public.ops_settings%rowtype;
  v_hold     text;
  v_id       uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  select * into v_settings from public.ops_settings;
  v_hold := public.refund_hold_reason(p_amount_kobo, v_order.test_mode, null);

  begin
    insert into public.refunds (
      order_id, payment_id, order_item_id, user_id, reason, amount_kobo, test_mode,
      status, run_after, last_error_code
    ) values (
      v_order.id, p_payment_id, p_order_item_id, v_order.user_id, p_reason, p_amount_kobo,
      v_order.test_mode,
      case when v_hold is null then 'queued' else 'held' end::public.refund_status,
      now() + make_interval(mins => coalesce(p_delay_minutes, v_settings.refund_delay_minutes)),
      upper(v_hold)
    )
    on conflict do nothing
    returning id into v_id;
  exception when others then
    insert into public.payment_incidents (test_mode, kind, order_id, detail)
    values (coalesce(v_order.test_mode, false), 'refund_not_created', p_order_id,
            jsonb_build_object('reason', p_reason, 'amount_kobo', p_amount_kobo, 'error', left(sqlerrm, 300)))
    on conflict do nothing;
    return null;
  end;

  if v_id is not null then
    insert into public.refund_events (refund_id, event, detail)
    values (v_id, 'queued', jsonb_build_object('reason', p_reason, 'amount_kobo', p_amount_kobo));
    if v_hold is not null then
      insert into public.refund_events (refund_id, event, detail)
      values (v_id, 'held', jsonb_build_object('why', v_hold));
    end if;
  end if;
  return v_id;
end;
$$;

/*
 * A failed line's refund: its price plus its share of the order's VAT.
 *
 * VAT was charged on the order, not per line, so each line's share is the
 * difference of cumulative floors in a fixed line order. The shares are
 * within a kobo of proportional and add up to the order's VAT exactly — so
 * when every line fails, the refunds add up to exactly what was paid.
 */
create or replace function public.enqueue_line_refund(p_order_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item   public.order_items%rowtype;
  v_order  public.orders%rowtype;
  v_sum    bigint;
  v_amount bigint;
begin
  select * into v_item from public.order_items where id = p_order_item_id;
  if not found or v_item.status <> 'failed' then
    return null;
  end if;
  select * into v_order from public.orders where id = v_item.order_id;

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
                               'registration_failed', v_amount, null);
end;
$$;

-- ── Recording a charge: the paying one, and anything extra ──────────────────
/*
 * As before (migration 13), plus: the charge is linked as the order's
 * payment, and money we should not keep is queued straight back — a second
 * charge for a paid order, the excess over the total, or a charge for an
 * order with nothing in it. It also refuses what the web app already refuses
 * (another currency, less than the total), so the rule holds even if a
 * caller forgets it.
 */
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
  v_order      public.orders%rowtype;
  v_payment_id uuid;
  v_owner      uuid;
  v_items      integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;
  if p_currency <> 'NGN' then
    raise exception 'order % is paid in naira only', v_order.order_number;
  end if;
  if p_amount_kobo < v_order.total_kobo then
    raise exception 'a charge below the total does not pay order %', v_order.order_number;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'successful', p_method, p_raw
  )
  on conflict (provider_reference) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    -- Seen before: the redirect and the webhook both arrive, in any order.
    select order_id into v_owner from public.payments where provider_reference = p_provider_reference;
    if v_owner <> v_order.id then
      raise exception 'charge % belongs to another order', p_provider_reference;
    end if;
    return v_order.status;
  end if;

  if v_order.status in ('awaiting_payment', 'cancelled') then
    update public.orders
       set status = 'paid', paid_at = now(), payment_id = v_payment_id
     where id = v_order.id;

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

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

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select 'register_domain', 'register:' || d.order_item_id, d.id, d.order_item_id, d.test_mode
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id
    on conflict (idempotency_key) do nothing;

    select count(*) into v_items from public.order_items where order_id = v_order.id;
    if v_items = 0 then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'empty_order', p_amount_kobo, 0);
      update public.orders set status = 'failed' where id = v_order.id;
      return 'failed';
    end if;
    if p_amount_kobo > v_order.total_kobo then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'overpayment',
                                    p_amount_kobo - v_order.total_kobo, 0);
    end if;
    return 'paid';
  end if;

  -- A second charge for an order already paid: every kobo of it goes back.
  perform public.enqueue_refund(v_order.id, v_payment_id, null, 'duplicate_charge', p_amount_kobo, 0);
  return v_order.status;
end;
$$;

/*
 * A successful charge in naira for less than the order total. It pays for
 * nothing — the order stays unpaid — so the whole charge is queued back, and
 * it is recorded as an incident because it should not happen with a fixed
 * payment link (bank transfers can arrive short).
 */
create or replace function public.record_underpayment(
  p_order_id           uuid,
  p_provider_reference text,
  p_amount_kobo        bigint,
  p_currency           text,
  p_method             text,
  p_raw                jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order      public.orders%rowtype;
  v_payment_id uuid;
  v_owner      uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;
  if p_currency <> 'NGN' or p_amount_kobo <= 0 or p_amount_kobo >= v_order.total_kobo then
    raise exception 'not an underpayment for order %', v_order.order_number;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'underpaid', p_method, p_raw
  )
  on conflict (provider_reference) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    select id, order_id into v_payment_id, v_owner
      from public.payments where provider_reference = p_provider_reference;
    if v_owner <> v_order.id then
      raise exception 'charge % belongs to another order', p_provider_reference;
    end if;
    return v_payment_id;
  end if;

  perform public.enqueue_refund(v_order.id, v_payment_id, null, 'underpayment', p_amount_kobo, 0);
  insert into public.payment_incidents (test_mode, kind, order_id, provider_reference, detail)
  values (v_order.test_mode, 'underpayment', v_order.id, p_provider_reference,
          jsonb_build_object('charged_kobo', p_amount_kobo, 'total_kobo', v_order.total_kobo))
  on conflict do nothing;
  return v_payment_id;
end;
$$;

-- ── A failed line queues its refund (FR-R3, I6) ─────────────────────────────
/*
 * As in migration 13, plus the refund. Only a definite failure refunds:
 * `p_needs_attention` means the outcome is unknown, so nothing moves until a
 * person has looked (I2) — and the refund worker reads the registry again
 * before any money goes back.
 */
create or replace function public.fail_job(
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
  v_job      public.jobs%rowtype;
  v_order_id uuid;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  if p_needs_attention then
    update public.jobs
       set status = 'needs_attention', last_error_code = p_code, last_error = left(p_message, 500),
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id,
            case v_job.kind when 'register_domain' then 'registration_delayed' else 'nameservers_delayed' end,
            'system', jsonb_build_object('code', p_code));
    return;
  end if;

  update public.jobs
     set status = 'failed', finished_at = now(), last_error_code = p_code,
         last_error = left(p_message, 500), locked_by = null, locked_at = null
   where id = v_job.id;

  if v_job.kind = 'register_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    update public.domains set local_status = 'registration_failed', pending_nameservers = null
     where id = v_job.domain_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'registration_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  else
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_not_applied', 'system', jsonb_build_object('code', p_code));
  end if;
end;
$$;

-- ── The refund worker's side (the gateway) ───────────────────────────────────

/*
 * Claims the next refund for one side (test or live) with SKIP LOCKED, and
 * says what to do with it:
 *   send     — queued: read the charge's refunds at Flutterwave, then refund;
 *   recover  — an earlier send may have landed: read, never send blind (I2);
 *   poll     — submitted: ask Flutterwave whether it has completed.
 * A queued refund over a limit is held instead, and the next one is tried.
 */
create or replace function public.claim_refund(
  p_worker        text,
  p_test_mode     boolean,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
  v_action text;
  v_hold   text;
  v_lapsed timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
  for i in 1..25 loop
    select * into v_refund
      from public.refunds r
     where r.test_mode = p_test_mode
       and (
         (r.status = 'queued' and r.run_after <= now())
         or (r.status in ('sending', 'submitted')
             and ((r.locked_at is null and r.run_after <= now()) or r.locked_at < v_lapsed))
       )
     order by r.run_after
     limit 1
     for update skip locked;

    if not found then
      return null;
    end if;

    if v_refund.status = 'queued' then
      if v_refund.approved_at is null then
        v_hold := public.refund_hold_reason(v_refund.amount_kobo, v_refund.test_mode, v_refund.id);
        if v_hold is not null then
          update public.refunds set status = 'held', last_error_code = upper(v_hold)
           where id = v_refund.id;
          insert into public.refund_events (refund_id, event, detail)
          values (v_refund.id, 'held', jsonb_build_object('why', v_hold));
          continue;
        end if;
      end if;
      v_action := 'send';
      update public.refunds
         set status = 'sending', attempts = attempts + 1, locked_by = p_worker, locked_at = now()
       where id = v_refund.id;
      insert into public.refund_events (refund_id, event, detail)
      values (v_refund.id, 'sending', jsonb_build_object('attempt', v_refund.attempts + 1));
    elsif v_refund.status = 'sending' then
      v_action := 'recover';
      update public.refunds
         set attempts = attempts + 1, locked_by = p_worker, locked_at = now()
       where id = v_refund.id;
    else
      v_action := 'poll';
      update public.refunds set locked_by = p_worker, locked_at = now() where id = v_refund.id;
    end if;

    return (
      select jsonb_build_object(
               'id', r.id,
               'action', v_action,
               'reason', r.reason,
               'amount_kobo', r.amount_kobo,
               'attempts', r.attempts,
               'test_mode', r.test_mode,
               'provider_refund_id', r.provider_refund_id,
               'submitted_at', r.submitted_at,
               'transaction_id', p.provider_reference,
               -- For the chargeback check: Flutterwave files disputes by it.
               'flw_ref', p.raw ->> 'flw_ref',
               'charged_kobo', p.amount_kobo,
               'charged_at', p.created_at,
               'order_number', o.order_number,
               'domain_name', oi.domain,
               -- Refunds at Flutterwave already accounted for by other rows of ours.
               'known_provider_refund_ids', (
                 select coalesce(jsonb_agg(r2.provider_refund_id), '[]'::jsonb)
                   from public.refunds r2
                  where r2.payment_id = r.payment_id
                    and r2.id <> r.id
                    and r2.provider_refund_id is not null
               ),
               -- What our other refunds on this charge add up to, cancelled aside.
               'other_refunds_kobo', (
                 select coalesce(sum(r2.amount_kobo), 0)
                   from public.refunds r2
                  where r2.payment_id = r.payment_id
                    and r2.id <> r.id
                    and r2.status <> 'cancelled'
               )
             )
        from public.refunds r
        join public.payments p on p.id = r.payment_id
        join public.orders o on o.id = r.order_id
        left join public.order_items oi on oi.id = r.order_item_id
       where r.id = v_refund.id
    );
  end loop;
  return null;
end;
$$;

/* Flutterwave accepted the refund and has not finished it yet. */
create or replace function public.record_refund_submitted(
  p_refund_id           uuid,
  p_provider_refund_id  text,
  p_provider_status     text,
  p_check_after_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;

  update public.refunds
     set status = 'submitted',
         provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         provider_status = left(p_provider_status, 40),
         submitted_at = coalesce(submitted_at, now()),
         run_after = now() + make_interval(secs => greatest(p_check_after_seconds, 30)),
         locked_by = null, locked_at = null,
         last_error_code = null, last_error = null
   where id = v_refund.id;

  if v_refund.status = 'sending' then
    insert into public.refund_events (refund_id, event, detail)
    values (v_refund.id, 'submitted',
            jsonb_build_object('provider_refund_id', p_provider_refund_id, 'status', p_provider_status));
  end if;
end;
$$;

/* The money is back with the customer. A refunded line is marked so. Final. */
create or replace function public.complete_refund(
  p_refund_id          uuid,
  p_provider_refund_id text,
  p_provider_status    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund % not found', p_refund_id;
  end if;
  if v_refund.status = 'completed' then
    return;
  end if;
  if v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is %', p_refund_id, v_refund.status;
  end if;

  update public.refunds
     set status = 'completed',
         provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         provider_status = left(p_provider_status, 40),
         submitted_at = coalesce(submitted_at, now()),
         completed_at = now(),
         locked_by = null, locked_at = null,
         last_error_code = null, last_error = null
   where id = v_refund.id;

  insert into public.refund_events (refund_id, event, detail)
  values (v_refund.id, 'completed',
          jsonb_build_object('provider_refund_id', coalesce(v_refund.provider_refund_id, p_provider_refund_id),
                             'status', p_provider_status));

  if v_refund.order_item_id is not null then
    update public.order_items set status = 'refunded'
     where id = v_refund.order_item_id and status = 'failed';
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'refunded', 'system',
           jsonb_build_object('amount_kobo', v_refund.amount_kobo, 'sandbox', v_refund.test_mode)
      from public.domains d
     where d.order_item_id = v_refund.order_item_id;
  end if;
end;
$$;

/*
 * Stops a refund. `p_needs_attention` means we do not know what happened, or
 * a safety check stopped it; otherwise Flutterwave refused it. Either way a
 * person decides what comes next (retry_refund or cancel_refund).
 */
create or replace function public.fail_refund(
  p_refund_id       uuid,
  p_code            text,
  p_message         text,
  p_needs_attention boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
  v_status public.refund_status := case when p_needs_attention
                                        then 'needs_attention' else 'failed' end;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;

  update public.refunds
     set status = v_status, last_error_code = left(p_code, 60), last_error = left(p_message, 500),
         locked_by = null, locked_at = null
   where id = v_refund.id;
  insert into public.refund_events (refund_id, event, detail)
  values (v_refund.id, v_status::text, jsonb_build_object('code', p_code));
end;
$$;

/*
 * Tries again later. `p_sent` false means nothing reached Flutterwave (a
 * safety read could not be made), so the refund goes back to the queue;
 * true keeps it in flight, and the next claim reads before doing anything.
 */
create or replace function public.reschedule_refund(
  p_refund_id     uuid,
  p_delay_seconds integer,
  p_code          text,
  p_message       text,
  p_sent          boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.status not in ('sending', 'submitted') then
    raise exception 'refund % is not in flight', p_refund_id;
  end if;
  if not p_sent and v_refund.status <> 'sending' then
    raise exception 'refund % has already reached Flutterwave', p_refund_id;
  end if;

  update public.refunds
     set status = case when p_sent then v_refund.status else 'queued' end,
         run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
         last_error_code = left(p_code, 60), last_error = left(p_message, 500),
         locked_by = null, locked_at = null
   where id = v_refund.id;
end;
$$;

-- ── A person's side: run from the Supabase SQL editor, never the service key ─

/* Lets a held refund go out, past the automatic limits. */
create or replace function public.approve_refund(p_refund_id uuid, p_by text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(trim(p_by), '') = '' then
    raise exception 'say who approved it';
  end if;
  update public.refunds
     set status = 'queued', approved_by = p_by, approved_at = now(), run_after = now(),
         last_error_code = null
   where id = p_refund_id and status = 'held';
  if not found then
    raise exception 'refund % is not held', p_refund_id;
  end if;
  insert into public.refund_events (refund_id, event, actor) values (p_refund_id, 'approved', p_by);
end;
$$;

/* After a person has checked Flutterwave and the registry: try again. */
create or replace function public.retry_refund(p_refund_id uuid, p_by text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(trim(p_by), '') = '' then
    raise exception 'say who retried it';
  end if;
  update public.refunds
     set status = 'queued', attempts = 0, run_after = now(),
         approved_by = coalesce(approved_by, p_by), approved_at = coalesce(approved_at, now())
   where id = p_refund_id and status in ('failed', 'needs_attention', 'cancelled');
  if not found then
    raise exception 'refund % cannot be retried from its current state', p_refund_id;
  end if;
  insert into public.refund_events (refund_id, event, actor) values (p_refund_id, 'retried', p_by);
end;
$$;

/* A person decided not to refund — say, the domain registered after all. */
create or replace function public.cancel_refund(p_refund_id uuid, p_by text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(trim(p_by), '') = '' or coalesce(trim(p_note), '') = '' then
    raise exception 'say who cancelled it, and why';
  end if;
  update public.refunds set status = 'cancelled'
   where id = p_refund_id and status in ('queued', 'held', 'failed', 'needs_attention');
  if not found then
    raise exception 'refund % cannot be cancelled from its current state', p_refund_id;
  end if;
  insert into public.refund_events (refund_id, event, actor, detail)
  values (p_refund_id, 'cancelled', p_by, jsonb_build_object('note', left(p_note, 300)));
end;
$$;

create or replace function public.resolve_payment_incident(p_incident_id bigint, p_by text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.payment_incidents set resolved_at = now(), resolved_by = p_by
   where id = p_incident_id and resolved_at is null;
$$;

-- ── The customer's view of their refunds ─────────────────────────────────────
/*
 * What someone may see about the refunds on their own order: amount, the
 * line, and a plain state. Internal codes, provider messages and limits stay
 * out of it.
 */
create or replace function public.my_order_refunds(p_order_id uuid)
returns table (
  id          uuid,
  domain      text,
  reason      text,
  amount_kobo bigint,
  state       text,
  refunded_at timestamptz,
  test_mode   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, oi.domain::text, r.reason::text, r.amount_kobo,
         case r.status
           when 'completed' then 'refunded'
           when 'submitted' then 'sent'
           else 'processing'
         end,
         r.completed_at, r.test_mode
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.order_id = p_order_id
     and o.user_id = (select auth.uid())
     and r.status <> 'cancelled'
   order by r.created_at
$$;

-- ── Abuse limits for the payment path (SEC-11) ───────────────────────────────
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

/*
 * Counts one hit against `p_key` in the current fixed window and says whether
 * it is within `p_max`. One statement, so concurrent requests on a
 * serverless platform count correctly without a shared cache.
 */
create or replace function public.rate_limit_hit(
  p_key            text,
  p_max            integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_max is null or p_max < 1 then
    raise exception 'a rate limit needs a positive window and maximum';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits (key, window_start, hits)
  values (left(p_key, 200), v_window, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;

/* SEC-11: domains this account has ordered in the last 24 hours, and its cap. */
create or replace function public.account_domain_allowance(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'ordered', (
             select count(*)
               from public.order_items oi
               join public.orders o on o.id = oi.order_id
              where o.user_id = p_user_id
                and o.status <> 'cancelled'
                and o.created_at > now() - interval '24 hours'
           ),
           'max', s.max_domains_per_account_day
         )
    from public.ops_settings s
$$;

-- ── Signs of life, and the supplier float ────────────────────────────────────
create table public.service_heartbeats (
  name       text primary key,
  test_mode  boolean not null,
  beat_at    timestamptz not null default now(),
  detail     jsonb not null default '{}'
);

create or replace function public.record_heartbeat(p_name text, p_test_mode boolean, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.service_heartbeats (name, test_mode, beat_at, detail)
  values (left(p_name, 100), p_test_mode, now(), coalesce(p_detail, '{}'))
  on conflict (name) do update
    set beat_at = now(), test_mode = excluded.test_mode, detail = excluded.detail;
$$;

create table public.supplier_balance_snapshots (
  id           bigserial primary key,
  test_mode    boolean not null,
  balance_usd  numeric(12, 2) not null,
  taken_at     timestamptz not null default now()
);
create index supplier_balance_recent_idx on public.supplier_balance_snapshots (test_mode, taken_at desc);

create or replace function public.record_supplier_balance(p_test_mode boolean, p_balance_usd numeric)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.supplier_balance_snapshots (test_mode, balance_usd)
  values (p_test_mode, p_balance_usd);
  delete from public.supplier_balance_snapshots where taken_at < now() - interval '90 days';
$$;

-- ── Ops alerts (I5, §13.5, backlog L16) ──────────────────────────────────────
create table public.ops_alerts (
  id                    bigserial primary key,
  -- What the alert is about, stable while the condition lasts.
  key                   text not null,
  test_mode             boolean not null,
  severity              text not null check (severity in ('critical', 'warning')),
  kind                  text not null,
  -- Order numbers, domains, codes and amounts — never contact or card data.
  summary               text not null,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  notified_at           timestamptz,
  notify_count          integer not null default 0,
  resolved_at           timestamptz,
  resolved_notified_at  timestamptz
);
create unique index ops_alerts_open_unique on public.ops_alerts (key) where resolved_at is null;
create index ops_alerts_side_idx on public.ops_alerts (test_mode, resolved_at);

/* Everything that needs a person right now, for one side. */
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
                case j.kind when 'register_domain' then 'Registration' else 'Nameserver change' end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

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
$$;

/*
 * Brings the alert table in line with the current conditions for one side,
 * and returns what to send: alerts never sent, reminders for ones still open
 * (critical every two hours, warnings daily), and resolutions of ones that
 * were sent. Also clears expired rate-limit windows.
 */
create or replace function public.sync_alerts(p_test_mode boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conditions jsonb;
  v_out        jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('ops_alerts:' || p_test_mode::text));

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_conditions
    from public.current_alert_conditions(p_test_mode) c;

  insert into public.ops_alerts (key, test_mode, severity, kind, summary)
  select c.key, p_test_mode, c.severity, c.kind, c.summary
    from jsonb_to_recordset(v_conditions) as c(key text, severity text, kind text, summary text)
  on conflict (key) where resolved_at is null
  do update set last_seen_at = now(), severity = excluded.severity, summary = excluded.summary;

  update public.ops_alerts a
     set resolved_at = now()
   where a.test_mode = p_test_mode
     and a.resolved_at is null
     and not exists (
       select 1 from jsonb_to_recordset(v_conditions) as c(key text) where c.key = a.key
     );

  delete from public.rate_limits where window_start < now() - interval '2 days';
  delete from public.ops_alerts where resolved_at < now() - interval '90 days';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'type', case
                     when a.resolved_at is not null then 'resolved'
                     when a.notified_at is null then 'new'
                     else 'reminder'
                   end,
           'severity', a.severity,
           'kind', a.kind,
           'summary', a.summary,
           'first_seen_at', a.first_seen_at
         ) order by a.severity, a.first_seen_at), '[]'::jsonb)
    into v_out
    from public.ops_alerts a
   where a.test_mode = p_test_mode
     and (
       (a.resolved_at is null and a.notified_at is null)
       or (a.resolved_at is null and a.notified_at < now() - case a.severity
                                                          when 'critical' then interval '2 hours'
                                                          else interval '24 hours' end)
       or (a.resolved_at is not null and a.notified_at is not null and a.resolved_notified_at is null)
     );

  return v_out;
end;
$$;

/* Records what was actually delivered, so a failed send is retried next time. */
create or replace function public.mark_alerts_notified(p_alert_ids bigint[], p_resolved_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ops_alerts
     set notified_at = now(), notify_count = notify_count + 1
   where id = any (coalesce(p_alert_ids, '{}')) and resolved_at is null;
  update public.ops_alerts
     set resolved_notified_at = now()
   where id = any (coalesce(p_resolved_ids, '{}')) and resolved_at is not null;
$$;

-- ── Test clean-up that can never touch live money ────────────────────────────
/*
 * Removes a test account's orders and everything hanging off them. Refuses if
 * the account has any live order: live payments and refunds are kept forever.
 * Delete the account's domains first (they point at its order lines).
 */
create or replace function public.purge_test_orders(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.orders where user_id = p_user_id and not test_mode) then
    raise exception 'account % has live orders; they are never purged', p_user_id;
  end if;
  delete from public.refund_events e using public.refunds r
   where e.refund_id = r.id and r.user_id = p_user_id;
  delete from public.refunds where user_id = p_user_id;
  delete from public.payment_incidents
   where order_id in (select id from public.orders where user_id = p_user_id);
  update public.orders set payment_id = null where user_id = p_user_id;
  delete from public.payments where user_id = p_user_id;
  delete from public.orders where user_id = p_user_id;
end;
$$;

-- ── Who may do what ──────────────────────────────────────────────────────────
alter table public.ops_settings               enable row level security;
alter table public.refunds                    enable row level security;
alter table public.refund_events              enable row level security;
alter table public.payment_incidents          enable row level security;
alter table public.rate_limits                enable row level security;
alter table public.service_heartbeats         enable row level security;
alter table public.supplier_balance_snapshots enable row level security;
alter table public.ops_alerts                 enable row level security;
-- No policies: people see refunds only through my_order_refunds.

revoke all on public.ops_settings, public.refunds, public.refund_events, public.payment_incidents,
              public.rate_limits, public.service_heartbeats, public.supplier_balance_snapshots,
              public.ops_alerts
  from anon, authenticated;

-- The service key reads these, but changes money and alerts only through the
-- functions above: no direct insert, update or delete, even with the key.
revoke insert, update, delete, truncate
  on public.payments, public.refunds, public.refund_events, public.payment_incidents,
     public.ops_settings, public.ops_alerts, public.rate_limits, public.service_heartbeats,
     public.supplier_balance_snapshots
  from service_role;

-- Internal: called only by the functions above.
revoke all on function public.refunds_guard() from public, anon, authenticated, service_role;
revoke all on function public.money_rows_are_final() from public, anon, authenticated, service_role;
revoke all on function public.refund_hold_reason(bigint, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_refund(uuid, uuid, uuid, public.refund_reason, bigint, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_line_refund(uuid) from public, anon, authenticated, service_role;

-- A person's decisions: the SQL editor only, never the service key.
revoke all on function public.approve_refund(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.retry_refund(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.cancel_refund(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.resolve_payment_incident(bigint, text) from public, anon, authenticated, service_role;

-- The customer's own refunds.
revoke all on function public.my_order_refunds(uuid) from public, anon;
grant execute on function public.my_order_refunds(uuid) to authenticated;

-- Our server and the gateway.
revoke all on function public.record_order_payment(uuid, text, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_underpayment(uuid, text, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_payment_incident(text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_refund(text, boolean, integer) from public, anon, authenticated;
revoke all on function public.record_refund_submitted(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.complete_refund(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_refund(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.reschedule_refund(uuid, integer, text, text, boolean) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.account_domain_allowance(uuid) from public, anon, authenticated;
revoke all on function public.record_heartbeat(text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.record_supplier_balance(boolean, numeric) from public, anon, authenticated;
revoke all on function public.current_alert_conditions(boolean) from public, anon, authenticated;
revoke all on function public.sync_alerts(boolean) from public, anon, authenticated;
revoke all on function public.mark_alerts_notified(bigint[], bigint[]) from public, anon, authenticated;
revoke all on function public.purge_test_orders(uuid) from public, anon, authenticated;

grant execute on function public.record_order_payment(uuid, text, bigint, text, text, jsonb) to service_role;
grant execute on function public.record_underpayment(uuid, text, bigint, text, text, jsonb) to service_role;
grant execute on function public.record_payment_incident(text, uuid, text, jsonb) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
grant execute on function public.claim_refund(text, boolean, integer) to service_role;
grant execute on function public.record_refund_submitted(uuid, text, text, integer) to service_role;
grant execute on function public.complete_refund(uuid, text, text) to service_role;
grant execute on function public.fail_refund(uuid, text, text, boolean) to service_role;
grant execute on function public.reschedule_refund(uuid, integer, text, text, boolean) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.account_domain_allowance(uuid) to service_role;
grant execute on function public.record_heartbeat(text, boolean, jsonb) to service_role;
grant execute on function public.record_supplier_balance(boolean, numeric) to service_role;
grant execute on function public.current_alert_conditions(boolean) to service_role;
grant execute on function public.sync_alerts(boolean) to service_role;
grant execute on function public.mark_alerts_notified(bigint[], bigint[]) to service_role;
grant execute on function public.purge_test_orders(uuid) to service_role;
