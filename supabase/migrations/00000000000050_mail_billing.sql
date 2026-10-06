-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 50: MyDomainsHub Mail — billing (docs/MAIL-SPEC.md §8, §9, §10).
--
-- Monthly plans in naira, charged by Flutterwave payment plans (recurring
-- card). The rules, as §8 and CLAUDE.md's money rows set them:
--
--   • Prices come from mail.plans, VAT from mail.billing_settings (N5b), in
--     kobo (N5). VAT is added at checkout and shown on a tax invoice.
--   • A charge counts only once the app has re-read it from Flutterwave and
--     passed what Flutterwave said to record_billing_charge (SEC-7), which
--     checks the reference, the test/live side, the currency and the amount,
--     and is idempotent on Flutterwave's transaction id.
--   • Upgrades take effect at once: the new plan's month starts now, less a
--     credit for the unused part of the old plan's month (prorated, before
--     VAT). Downgrades and cancellations wait for the period's end.
--   • A renewal that fails, or does not arrive, puts the subscription past
--     due: sending continues for billing_settings.past_due_days, then the
--     account drops to the Free plan. No part-month refunds; no overage.
--   • Money tables (payments, invoices) are append-only: a live row is never
--     rewritten or deleted, by anyone; test rows go only with their e2e
--     account (e2e_purge_account, migration 45). payments.raw keeps the same
--     allowlist as the shop's (migration 20), enforced by a trigger.
--   • A charge that arrives but pays for nothing is still recorded, as
--     unapplied, with an incident for a person to refund — never dropped.
--
-- Flutterwave's recurring charges are made by Flutterwave, not by us; how
-- they are told apart is described at record_billing_charge. A renewal that
-- never reaches us is caught by billing_sweep (hourly), which moves the
-- subscription to past due once the period has ended.
--
-- This migration only changes accounts.plan_code; the caps that follow from a
-- plan (effective_caps, reserve_send) are migration 44's and are not touched.
--
-- Every function is revoked from public, anon, authenticated and service_role,
-- then granted to at most one role; supabase/tests/mail_billing.sql and check
-- 16 of supabase/tests/mail_sending.sql loop over the grants.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings (one row) ───────────────────────────────────────────────────
create table mail.billing_settings (
  id                    boolean primary key default true check (id),
  -- VAT on our supply, in basis points: 750 is 7.5% (§8). Added at checkout.
  vat_bps               integer not null default 750 check (vat_bps between 0 and 5000),
  -- §8: a failed renewal gives this many days past due before the Free plan.
  past_due_days         integer not null default 7 check (past_due_days between 1 and 60),
  -- Flutterwave charges a renewal around the period's end, on its own clock:
  -- the sweep waits this long past the end before calling a renewal missing.
  renewal_wait_hours    integer not null default 6 check (renewal_wait_hours between 0 and 72),
  -- A checkout's quote (an upgrade's credit above all) is honoured for this
  -- long; a charge for an older one is recorded, unapplied, for a refund.
  checkout_ttl_minutes  integer not null default 1440 check (checkout_ttl_minutes between 15 and 10080),
  -- Checkouts one account may start in an hour: each one is a Flutterwave call.
  checkouts_per_hour    integer not null default 10 check (checkouts_per_hour between 1 and 100),
  updated_at            timestamptz not null default now()
);
insert into mail.billing_settings default values;

create function mail.billing_settings_stay()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'mail.billing_settings keeps its one row' using errcode = '23514';
end;
$$;
create trigger billing_settings_no_delete before delete or truncate on mail.billing_settings
  for each statement execute function mail.billing_settings_stay();

-- ── 2. Flutterwave's payment plan objects ───────────────────────────────────
-- One per plan, side (test or live keys), Flutterwave API and monthly amount
-- (price + VAT): a Flutterwave plan charges a fixed amount, so a new price or
-- VAT rate needs a new plan object. Made on demand by the app (POST
-- /v3/payment-plans) and recorded here by register_flutterwave_plan. The API's
-- host keeps the e2e mock's objects (test keys, another host) from ever being
-- offered to Flutterwave itself, which shares this database's test side.
create table mail.flutterwave_plans (
  id                   bigint generated always as identity primary key,
  plan_code            text not null references mail.plans (code),
  test_mode            boolean not null,
  api_host             text not null check (api_host ~ '^[a-z0-9.-]{1,100}(:[0-9]{1,5})?$'
                                            and (test_mode or api_host = 'api.flutterwave.com')),
  price_kobo           bigint not null check (price_kobo > 0),
  vat_bps              integer not null check (vat_bps between 0 and 5000),
  amount_kobo          bigint not null check (amount_kobo > 0),
  flutterwave_plan_id  bigint not null check (flutterwave_plan_id > 0),
  created_at           timestamptz not null default now(),
  unique (api_host, flutterwave_plan_id),
  unique (plan_code, test_mode, api_host, amount_kobo)
);

-- ── 3. Checkouts ────────────────────────────────────────────────────────────
-- One per "pay" button: the quote, worked out in SQL from plans and settings,
-- and the reference Flutterwave carries back (tx_ref, `MDM-<id>`: Paidly
-- forwards every MDM- reference here, MAIL-SPEC §8).
--   subscribe — no live subscription: the plan's month, from payment.
--   upgrade   — a dearer plan, at once: its month from payment, less a credit
--               for the unused part of the current month (before VAT).
--   pay_due   — a past-due subscription paid again, on any paid plan.
create table mail.checkouts (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references mail.accounts (id) on delete cascade,
  kind                  text not null check (kind in ('subscribe', 'upgrade', 'pay_due')),
  plan_code             text not null references mail.plans (code),
  tx_ref                text not null unique check (tx_ref = 'MDM-' || id::text),
  test_mode             boolean not null,
  price_kobo            bigint not null check (price_kobo > 0),
  -- An upgrade's credit: the old plan, and the period end it was worked out
  -- against (the payment applies only while that is still the period).
  from_plan_code        text references mail.plans (code),
  credit_kobo           bigint not null default 0 check (credit_kobo >= 0),
  credit_until          timestamptz,
  subtotal_kobo         bigint not null check (subtotal_kobo > 0),
  vat_bps               integer not null check (vat_bps between 0 and 5000),
  vat_kobo              bigint not null check (vat_kobo >= 0),
  total_kobo            bigint not null check (total_kobo > 0),
  -- What Flutterwave charges each month after this first payment.
  recurring_kobo        bigint not null check (recurring_kobo > 0),
  flutterwave_plan_id   bigint not null,
  status                text not null default 'open' check (status in ('open', 'paid', 'unapplied')),
  created_by            uuid,
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  paid_transaction_id   text check (paid_transaction_id is null or paid_transaction_id ~ '^[0-9]{1,20}$'),
  constraint checkouts_sums check (
    subtotal_kobo = price_kobo - credit_kobo and total_kobo = subtotal_kobo + vat_kobo),
  constraint checkouts_credit_is_upgrades check (
    (kind = 'upgrade') = (from_plan_code is not null and credit_until is not null)
    and (kind = 'upgrade' or credit_kobo = 0)),
  constraint checkouts_paid check ((status = 'open') = (paid_at is null))
);
create index checkouts_account_idx on mail.checkouts (account_id, created_at desc);

-- ── 4. Subscriptions ────────────────────────────────────────────────────────
-- One row per account, made by its first paid checkout. It is state, not
-- money: changed only by the functions below.
--   active   — paid to current_period_end; Flutterwave renews it monthly.
--   past_due — a renewal failed or did not come (renewal_failed), or a
--              downgrade to a paid plan is waiting for its first payment
--              (payment_needed). Sending continues until past_due_until.
--   ended    — on the Free plan again (canceled at a period end, or lapsed).
create table mail.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null unique references mail.accounts (id) on delete cascade,
  plan_code              text not null references mail.plans (code),
  status                 text not null check (status in ('active', 'past_due', 'ended')),
  test_mode              boolean not null,
  -- The plan's price and VAT when this month was sold, and what Flutterwave
  -- charges each month for it (price + VAT).
  price_kobo             bigint not null check (price_kobo > 0),
  vat_bps                integer not null check (vat_bps between 0 and 5000),
  amount_kobo            bigint not null check (amount_kobo > 0),
  current_period_start   timestamptz not null,
  current_period_end     timestamptz not null,
  -- §8: a downgrade or cancellation waits for the period's end ('free' cancels).
  scheduled_plan_code    text references mail.plans (code),
  scheduled_at           timestamptz,
  past_due_reason        text check (past_due_reason in ('renewal_failed', 'payment_needed')),
  past_due_since         timestamptz,
  past_due_until         timestamptz,
  ended_at               timestamptz,
  ended_reason           text check (ended_reason in ('canceled', 'lapsed')),
  -- The checkout whose first charge started the Flutterwave subscription now
  -- charging this account, that charge's transaction id (Flutterwave finds
  -- the subscription by it) and the payment plan object.
  checkout_id            uuid references mail.checkouts (id) on delete set null,
  first_transaction_id   text check (first_transaction_id is null or first_transaction_id ~ '^[0-9]{1,20}$'),
  flutterwave_plan_id    bigint,
  -- When Flutterwave confirmed that subscription cancelled, so it charges no
  -- more: required before a downgrade or cancellation is scheduled, and
  -- before a past-due subscription starts a new one.
  provider_canceled_at   timestamptz,
  -- The card on file: its last four digits and its scheme, nothing else.
  card_last4             text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_brand             text check (card_brand is null or card_brand ~ '^[A-Z][A-Z ]{1,19}$'),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_period check (current_period_end >= current_period_start),
  constraint subscriptions_amount check (amount_kobo = price_kobo + (price_kobo * vat_bps + 5000) / 10000),
  constraint subscriptions_past_due check (
    (status = 'past_due') = (past_due_reason is not null)
    and (past_due_reason is null) = (past_due_until is null)
    and (past_due_reason is null) = (past_due_since is null)),
  constraint subscriptions_ended check ((status = 'ended') = (ended_at is not null and ended_reason is not null)),
  constraint subscriptions_schedule check (
    (scheduled_plan_code is null) = (scheduled_at is null)
    and (scheduled_plan_code is null or status = 'active'))
);

-- ── 5. Payments (money: append-only) ────────────────────────────────────────
-- Every charge Flutterwave confirmed, once (unique on its transaction id).
-- `applied` is false for money that arrived but paid for nothing — a stale
-- checkout, a second subscription, a charge after a cancellation — which an
-- incident hands to a person to refund (§8: no part-month refunds unless the
-- service failed us, and such a charge is our failure).
create table mail.payments (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references mail.accounts (id) on delete cascade,
  subscription_id     uuid references mail.subscriptions (id) on delete cascade,
  checkout_id         uuid references mail.checkouts (id) on delete cascade,
  kind                text not null check (kind in ('first', 'renewal')),
  applied             boolean not null,
  plan_code           text not null references mail.plans (code),
  provider            text not null default 'flutterwave' check (provider = 'flutterwave'),
  provider_reference  text not null unique check (provider_reference ~ '^[0-9]{1,20}$'),
  tx_ref              text not null,
  amount_kobo         bigint not null check (amount_kobo > 0),
  currency            char(3) not null check (currency = 'NGN'),
  method              text check (method is null or char_length(method) <= 40),
  test_mode           boolean not null,
  period_start        timestamptz,
  period_end          timestamptz,
  raw                 jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  constraint payments_period check ((period_start is null) = (period_end is null)
                                    and (applied = (period_start is not null)))
);
create index payments_account_idx on mail.payments (account_id, created_at desc);

-- ── 6. Invoices (money: append-only) ────────────────────────────────────────
-- A tax invoice for every applied payment, numbered from its own sequence —
-- live and test apart, so test payments never leave gaps in the real series
-- (as the shop's, migration 26). Seller facts (CAC, TIN) are printed by the
-- page from one place; the buyer, lines and sums are kept as issued.
create sequence mail.invoice_number_seq;
create sequence mail.test_invoice_number_seq;

create table mail.invoices (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique check (number ~ '^MDM-(TEST-)?INV-[0-9]{6,}$'),
  account_id          uuid not null references mail.accounts (id) on delete cascade,
  payment_id          uuid not null unique references mail.payments (id) on delete cascade,
  test_mode           boolean not null,
  issued_at           timestamptz not null default now(),
  -- The account as it was named when billed.
  billed_to           jsonb not null check (jsonb_typeof(billed_to) = 'object'),
  plan_code           text not null references mail.plans (code),
  plan_name           text not null,
  period_start        timestamptz not null,
  period_end          timestamptz not null,
  -- [{ "description": text, "amountKobo": integer }], credits negative.
  lines               jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 1),
  subtotal_kobo       bigint not null check (subtotal_kobo > 0),
  vat_bps             integer not null check (vat_bps between 0 and 5000),
  vat_kobo            bigint not null check (vat_kobo >= 0),
  total_kobo          bigint not null check (total_kobo > 0),
  paid_kobo           bigint not null check (paid_kobo >= total_kobo),
  provider_reference  text not null,
  tx_ref              text not null,
  method              text,
  constraint invoices_sums check (total_kobo = subtotal_kobo + vat_kobo),
  constraint invoices_test_numbers check (test_mode = (number like 'MDM-TEST-%'))
);
create index invoices_account_idx on mail.invoices (account_id, issued_at desc);

-- ── 7. Billing incidents ────────────────────────────────────────────────────
-- Money that arrived but could not be applied, or a Flutterwave subscription
-- we could not stop: recorded, not just logged, for a person (the admin area
-- reads them). Amounts, statuses and reasons only — never card or contact data.
create table mail.billing_incidents (
  id                  bigint generated always as identity primary key,
  test_mode           boolean not null,
  kind                text not null check (kind in (
                        'unknown_reference',          -- an MDM- reference no checkout has
                        'tx_ref_mismatch',            -- a charge presented for another checkout
                        'mode_mismatch',              -- a test charge for a live checkout, or back
                        'currency_mismatch',          -- a successful charge not in naira
                        'unapplied_charge',           -- recorded, paid for nothing: refund it
                        'subscription_not_canceled',  -- Flutterwave may charge again: cancel it
                        'unrecorded_payment')),       -- confirmed by Flutterwave, not recorded here
  account_id          uuid references mail.accounts (id) on delete cascade,
  provider_reference  text check (provider_reference is null or char_length(provider_reference) <= 64),
  detail              jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text
);
-- One open incident per kind, account and charge: repeats do not pile up.
create unique index billing_incidents_open on mail.billing_incidents
  (kind, coalesce(account_id::text, ''), coalesce(provider_reference, '')) where resolved_at is null;

-- ── 8. Money rows are final ─────────────────────────────────────────────────
-- Never rewritten. Deleted only inside e2e_purge_account, and only test rows:
-- a live payment or invoice outlives everything, the service key included.
create function mail.billing_rows_are_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('mail.e2e_purge', true), '') = 'on'
     and coalesce(old.test_mode, false) then
    return old;
  end if;
  raise exception '%.% rows are final', tg_table_schema, tg_table_name using errcode = '23514';
end;
$$;
create trigger payments_are_final before update or delete on mail.payments
  for each row execute function mail.billing_rows_are_final();
create trigger payments_no_truncate before truncate on mail.payments
  for each statement execute function mail.billing_rows_are_final();
create trigger invoices_are_final before update or delete on mail.invoices
  for each row execute function mail.billing_rows_are_final();
create trigger invoices_no_truncate before truncate on mail.invoices
  for each statement execute function mail.billing_rows_are_final();

-- payments.raw: the shop's allowlist (migration 20, transactionRecord() in
-- @dr/shared/payments). Flutterwave's answer also carries the customer's
-- details and a reusable card token; none of that is kept, whoever writes.
create function mail.billing_payment_record(p_raw jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(
           e.key,
           case when jsonb_typeof(e.value) = 'string' then to_jsonb(left(e.value #>> '{}', 200))
                else e.value end
         ), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_raw) = 'object' then p_raw else '{}'::jsonb end) e
   where e.key in ('id', 'tx_ref', 'flw_ref', 'amount', 'charged_amount', 'app_fee',
                   'merchant_fee', 'currency', 'status', 'payment_type', 'created_at')
     and jsonb_typeof(e.value) in ('string', 'number')
$$;

create function mail.billing_keep_record_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.raw := mail.billing_payment_record(new.raw);
  return new;
end;
$$;
create trigger payments_keep_record_only before insert on mail.payments
  for each row execute function mail.billing_keep_record_only();

-- ── 9. Small helpers ────────────────────────────────────────────────────────

-- VAT on an amount in kobo, rounded half up to the kobo (the shop's vatKobo).
create function mail.billing_vat(p_amount_kobo bigint, p_vat_bps integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (greatest(p_amount_kobo, 0) * p_vat_bps + 5000) / 10000
$$;

-- A month on from a moment, on Lagos's calendar (31 Jan → 28 or 29 Feb).
create function mail.billing_period_end(p_start timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_start at time zone 'Africa/Lagos') + interval '1 month') at time zone 'Africa/Lagos'
$$;

-- The account's security log (migration 43): billing changes, with plan
-- codes and invoice numbers, never an amount a viewer need not see.
create function mail.billing_note(p_account_id uuid, p_actor text, p_action text, p_detail jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, p_actor, case when p_actor = 'user' then auth.uid() end, p_action,
          p_account_id::text, coalesce(p_detail, '{}'::jsonb))
$$;

-- What one plan would cost this account now, and which change it would be:
--   current, subscribe, upgrade (with its credit), downgrade, cancel, pay, none.
-- Every amount is worked out here, from mail.plans and mail.billing_settings.
create function mail.billing_quote(p_account_id uuid, p_plan_code text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_account  mail.accounts;
  v_plan     mail.plans;
  v_sub      mail.subscriptions;
  v_live     boolean;
  v_change   text;
  v_credit   bigint := 0;
  v_left     numeric;
  v_length   numeric;
  v_subtotal bigint;
  v_vat      bigint;
begin
  select * into v_settings from mail.billing_settings where id;
  select * into v_account from mail.accounts where id = p_account_id;
  select * into v_plan from mail.plans where code = p_plan_code;
  if v_settings.id is null or v_account.id is null or v_plan.code is null then
    return null;
  end if;
  select * into v_sub from mail.subscriptions where account_id = p_account_id;
  v_live := coalesce(v_sub.status in ('active', 'past_due'), false);

  if not v_live then
    v_change := case
      when v_plan.price_kobo = 0 then case when v_account.plan_code = v_plan.code then 'current' else 'none' end
      when v_plan.is_offered then 'subscribe'
      else 'none' end;
  elsif v_sub.status = 'past_due' then
    v_change := case when v_plan.price_kobo > 0 and v_plan.is_offered then 'pay' else 'none' end;
  else
    v_change := case
      when v_plan.code = v_sub.plan_code then 'current'
      when v_plan.price_kobo = 0 then 'cancel'
      when not v_plan.is_offered then 'none'
      when v_plan.price_kobo > v_sub.price_kobo then 'upgrade'
      when v_plan.price_kobo < v_sub.price_kobo then 'downgrade'
      else 'none' end;
  end if;

  if v_change = 'upgrade' then
    -- The unused part of the current month, in seconds, at the price it was sold at.
    v_left := greatest(extract(epoch from v_sub.current_period_end - now()), 0);
    v_length := greatest(extract(epoch from v_sub.current_period_end - v_sub.current_period_start), 1);
    v_credit := least(floor(v_sub.price_kobo * v_left / v_length), v_sub.price_kobo)::bigint;
  end if;
  v_subtotal := v_plan.price_kobo - v_credit;
  v_vat := mail.billing_vat(v_subtotal, v_settings.vat_bps);

  return jsonb_build_object(
    'planCode', v_plan.code,
    'change', v_change,
    'priceKobo', v_plan.price_kobo,
    'creditKobo', v_credit,
    'subtotalKobo', v_subtotal,
    'vatBps', v_settings.vat_bps,
    'vatKobo', v_vat,
    'totalKobo', v_subtotal + v_vat,
    'recurringKobo', v_plan.price_kobo + mail.billing_vat(v_plan.price_kobo, v_settings.vat_bps),
    'fromPlanCode', case when v_change = 'upgrade' then v_sub.plan_code end,
    'creditUntil', case when v_change = 'upgrade' then v_sub.current_period_end end);
end;
$$;

-- ── 10. The billing page's read ─────────────────────────────────────────────
-- Any member sees the plan, the period and what each plan would cost; owners
-- and admins, who manage billing, also see the card's last four digits.
create function mail.billing_overview(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role     text;
  v_manage   boolean;
  v_account  mail.accounts;
  v_settings mail.billing_settings;
  v_sub      mail.subscriptions;
  v_plan     mail.plans;
  v_subj     jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_manage := v_role in ('owner', 'admin');
  select * into v_account from mail.accounts where id = p_account_id;
  select * into v_settings from mail.billing_settings where id;
  select * into v_plan from mail.plans where code = v_account.plan_code;
  select * into v_sub from mail.subscriptions where account_id = p_account_id;

  if v_sub.id is not null then
    v_subj := jsonb_build_object(
      'status', v_sub.status,
      'planCode', v_sub.plan_code,
      'planName', (select p.name from mail.plans p where p.code = v_sub.plan_code),
      'testMode', v_sub.test_mode,
      'priceKobo', v_sub.price_kobo,
      'vatBps', v_sub.vat_bps,
      'amountKobo', v_sub.amount_kobo,
      'currentPeriodStart', v_sub.current_period_start,
      'currentPeriodEnd', v_sub.current_period_end,
      'scheduledPlanCode', v_sub.scheduled_plan_code,
      'scheduledPlanName', (select p.name from mail.plans p where p.code = v_sub.scheduled_plan_code),
      'pastDueReason', v_sub.past_due_reason,
      'pastDueSince', v_sub.past_due_since,
      'pastDueUntil', v_sub.past_due_until,
      'endedAt', v_sub.ended_at,
      'endedReason', v_sub.ended_reason,
      'card', case when v_manage and v_sub.card_last4 is not null and v_sub.status <> 'ended'
                   then jsonb_build_object('last4', v_sub.card_last4, 'brand', v_sub.card_brand) end);
  end if;

  return jsonb_build_object(
    'ok', true,
    'role', v_role,
    'canManage', v_manage,
    'vatBps', v_settings.vat_bps,
    'pastDueDays', v_settings.past_due_days,
    'plan', case when v_plan.code is not null then
              jsonb_build_object('code', v_plan.code, 'name', v_plan.name, 'priceKobo', v_plan.price_kobo) end,
    'subscription', v_subj,
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', p.code, 'name', p.name, 'priceKobo', p.price_kobo,
               'monthlyCap', p.monthly_cap, 'dailyCap', p.daily_cap, 'maxDomains', p.max_domains,
               'maxMembers', p.max_members, 'logRetentionDays', p.log_retention_days,
               'isOffered', p.is_offered,
               'quote', mail.billing_quote(p_account_id, p.code))
             order by p.sort_order, p.code)
        from mail.plans p
       where p.is_offered or p.code = v_account.plan_code or p.code = v_sub.plan_code), '[]'::jsonb));
end;
$$;

-- ── 11. Flutterwave's plan objects, on demand (service key) ─────────────────
-- What the plan object for a plan should charge, and its id on this API if we have one.
create function mail.flutterwave_plan_for(p_plan_code text, p_test_mode boolean, p_api_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_plan     mail.plans;
  v_amount   bigint;
  v_id       bigint;
begin
  select * into v_settings from mail.billing_settings where id;
  select * into v_plan from mail.plans where code = p_plan_code;
  if p_test_mode is null or v_settings.id is null or v_plan.code is null
     or v_plan.price_kobo <= 0 or not v_plan.is_offered then
    return jsonb_build_object('ok', false, 'code', 'not_offered');
  end if;
  v_amount := v_plan.price_kobo + mail.billing_vat(v_plan.price_kobo, v_settings.vat_bps);
  select f.flutterwave_plan_id into v_id from mail.flutterwave_plans f
   where f.plan_code = v_plan.code and f.test_mode = p_test_mode and f.api_host = p_api_host
     and f.amount_kobo = v_amount;
  return jsonb_build_object('ok', true, 'planCode', v_plan.code, 'planName', v_plan.name,
                            'priceKobo', v_plan.price_kobo, 'vatBps', v_settings.vat_bps,
                            'amountKobo', v_amount, 'flutterwavePlanId', v_id);
end;
$$;

-- Records a plan object the app made at Flutterwave. Two made at once for the
-- same amount: the first recorded wins, and its id is the answer.
create function mail.register_flutterwave_plan(p_plan_code text, p_test_mode boolean, p_api_host text,
                                               p_amount_kobo bigint, p_flutterwave_plan_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_want jsonb := mail.flutterwave_plan_for(p_plan_code, p_test_mode, p_api_host);
  v_id   bigint;
begin
  if not coalesce((v_want ->> 'ok')::boolean, false) then
    return v_want;
  end if;
  if p_amount_kobo is distinct from (v_want ->> 'amountKobo')::bigint then
    return jsonb_build_object('ok', false, 'code', 'amount_changed', 'amountKobo', v_want -> 'amountKobo');
  end if;
  if coalesce(p_flutterwave_plan_id, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'flutterwave_plan_id');
  end if;
  -- Live keys go to Flutterwave's own API and nowhere else (N12).
  if coalesce(p_api_host, '') !~ '^[a-z0-9.-]{1,100}(:[0-9]{1,5})?$'
     or (not p_test_mode and p_api_host <> 'api.flutterwave.com') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'api_host');
  end if;
  insert into mail.flutterwave_plans (plan_code, test_mode, api_host, price_kobo, vat_bps, amount_kobo,
                                      flutterwave_plan_id)
  values (p_plan_code, p_test_mode, p_api_host, (v_want ->> 'priceKobo')::bigint, (v_want ->> 'vatBps')::integer,
          p_amount_kobo, p_flutterwave_plan_id)
  on conflict do nothing;
  select f.flutterwave_plan_id into v_id from mail.flutterwave_plans f
   where f.plan_code = p_plan_code and f.test_mode = p_test_mode and f.api_host = p_api_host
     and f.amount_kobo = p_amount_kobo;
  if v_id is null then
    -- The id is already recorded for another plan or amount.
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'flutterwave_plan_id');
  end if;
  return jsonb_build_object('ok', true, 'flutterwavePlanId', v_id);
end;
$$;

-- ── 12. Starting a checkout (as the person) ─────────────────────────────────
-- Owners and admins only. The quote is worked out again here; if it is not
-- the total the person was shown, nothing is started (`quote_changed`). Test
-- keys pay only for e2e test accounts, live keys never for them: a test
-- payment must never buy a real account a plan (N12).
create function mail.start_checkout(p_account_id uuid, p_plan_code text, p_test_mode boolean,
                                    p_flutterwave_plan_id bigint, p_expected_total_kobo bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_role     text;
  v_account  mail.accounts;
  v_settings mail.billing_settings;
  v_sub      mail.subscriptions;
  v_plan     mail.plans;
  v_quote    jsonb;
  v_kind     text;
  v_id       uuid := gen_random_uuid();
  v_e2e      boolean;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if v_account.state = 'paused' then
    return jsonb_build_object('ok', false, 'code', 'account_paused');
  end if;
  if p_test_mode is null then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'test_mode');
  end if;
  v_e2e := mail.is_e2e_account(p_account_id);
  if p_test_mode and not v_e2e then
    return jsonb_build_object('ok', false, 'code', 'test_mode_e2e_only');
  end if;
  if not p_test_mode and v_e2e then
    return jsonb_build_object('ok', false, 'code', 'live_mode_not_for_tests');
  end if;
  select * into v_settings from mail.billing_settings where id;
  if v_settings.id is null then
    raise exception 'mail.billing_settings is missing' using errcode = '55000';
  end if;

  select * into v_sub from mail.subscriptions where account_id = p_account_id;
  if v_sub.id is not null and v_sub.status <> 'ended' and v_sub.test_mode <> p_test_mode then
    return jsonb_build_object('ok', false, 'code', 'mode_mismatch');
  end if;
  select * into v_plan from mail.plans where code = p_plan_code;
  if v_plan.code is null or not v_plan.is_offered or v_plan.price_kobo <= 0 then
    return jsonb_build_object('ok', false, 'code', 'not_offered');
  end if;

  v_quote := mail.billing_quote(p_account_id, p_plan_code);
  v_kind := case v_quote ->> 'change'
              when 'subscribe' then 'subscribe' when 'upgrade' then 'upgrade' when 'pay' then 'pay_due' end;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'code',
      case v_quote ->> 'change' when 'current' then 'current_plan'
                                 when 'downgrade' then 'use_schedule' when 'cancel' then 'use_schedule'
                                 else 'not_offered' end);
  end if;
  -- A past-due subscription's Flutterwave subscription must be stopped first,
  -- or a late retry and this payment would both charge the card.
  if v_kind = 'pay_due' and v_sub.first_transaction_id is not null and v_sub.provider_canceled_at is null then
    return jsonb_build_object('ok', false, 'code', 'provider_active');
  end if;
  if not exists (select 1 from mail.flutterwave_plans f
                  where f.flutterwave_plan_id = p_flutterwave_plan_id and f.plan_code = v_plan.code
                    and f.test_mode = p_test_mode and f.amount_kobo = (v_quote ->> 'recurringKobo')::bigint) then
    return jsonb_build_object('ok', false, 'code', 'no_flutterwave_plan');
  end if;
  if p_expected_total_kobo is distinct from (v_quote ->> 'totalKobo')::bigint then
    return jsonb_build_object('ok', false, 'code', 'quote_changed', 'totalKobo', v_quote -> 'totalKobo');
  end if;
  if (select count(*) from mail.checkouts c
       where c.account_id = p_account_id and c.created_at > now() - interval '1 hour')
     >= v_settings.checkouts_per_hour then
    return jsonb_build_object('ok', false, 'code', 'too_many_checkouts');
  end if;

  insert into mail.checkouts (id, account_id, kind, plan_code, tx_ref, test_mode, price_kobo, from_plan_code,
                              credit_kobo, credit_until, subtotal_kobo, vat_bps, vat_kobo, total_kobo,
                              recurring_kobo, flutterwave_plan_id, created_by)
  values (v_id, p_account_id, v_kind, v_plan.code, 'MDM-' || v_id::text, p_test_mode, v_plan.price_kobo,
          v_quote ->> 'fromPlanCode', (v_quote ->> 'creditKobo')::bigint,
          (v_quote ->> 'creditUntil')::timestamptz, (v_quote ->> 'subtotalKobo')::bigint,
          (v_quote ->> 'vatBps')::integer, (v_quote ->> 'vatKobo')::bigint, (v_quote ->> 'totalKobo')::bigint,
          (v_quote ->> 'recurringKobo')::bigint, p_flutterwave_plan_id, v_user);

  return jsonb_build_object('ok', true, 'checkoutId', v_id, 'txRef', 'MDM-' || v_id::text, 'kind', v_kind,
                            'planCode', v_plan.code, 'planName', v_plan.name,
                            'totalKobo', (v_quote ->> 'totalKobo')::bigint,
                            'recurringKobo', (v_quote ->> 'recurringKobo')::bigint);
end;
$$;

-- ── 13. Downgrades and cancellations, at the period's end (as the person) ───
-- Flutterwave must have stopped the subscription first (the app cancels it,
-- then note_provider_canceled), so the card is not charged for a month the
-- account will not have. 'free' cancels.
create function mail.schedule_plan_change(p_account_id uuid, p_plan_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text;
  v_sub   mail.subscriptions;
  v_quote jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  perform 1 from mail.accounts where id = p_account_id for update;
  select * into v_sub from mail.subscriptions where account_id = p_account_id for update;
  if v_sub.id is null or v_sub.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', case when v_sub.status = 'past_due' then 'past_due'
                                                       else 'no_subscription' end);
  end if;
  v_quote := mail.billing_quote(p_account_id, p_plan_code);
  if coalesce(v_quote ->> 'change', 'none') not in ('downgrade', 'cancel') then
    return jsonb_build_object('ok', false, 'code',
      case v_quote ->> 'change' when 'current' then 'current_plan' when 'upgrade' then 'use_checkout'
                                 else 'not_offered' end);
  end if;
  if v_sub.provider_canceled_at is null then
    return jsonb_build_object('ok', false, 'code', 'provider_active');
  end if;
  update mail.subscriptions
     set scheduled_plan_code = p_plan_code, scheduled_at = now(), updated_at = now()
   where id = v_sub.id;
  perform mail.billing_note(p_account_id, 'user', 'billing.change_scheduled',
                            jsonb_build_object('from', v_sub.plan_code, 'to', p_plan_code,
                                               'at', v_sub.current_period_end));
  return jsonb_build_object('ok', true, 'planCode', p_plan_code, 'effectiveAt', v_sub.current_period_end);
end;
$$;

-- Withdraws a scheduled change. Flutterwave's subscription must be running
-- again first (the app reactivates it, then note_provider_active).
create function mail.keep_current_plan(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sub  mail.subscriptions;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  perform 1 from mail.accounts where id = p_account_id for update;
  select * into v_sub from mail.subscriptions where account_id = p_account_id for update;
  if v_sub.id is null or v_sub.status <> 'active' or v_sub.scheduled_plan_code is null then
    return jsonb_build_object('ok', false, 'code', 'nothing_scheduled');
  end if;
  if v_sub.provider_canceled_at is not null then
    return jsonb_build_object('ok', false, 'code', 'provider_canceled');
  end if;
  update mail.subscriptions set scheduled_plan_code = null, scheduled_at = null, updated_at = now()
   where id = v_sub.id;
  perform mail.billing_note(p_account_id, 'user', 'billing.change_withdrawn',
                            jsonb_build_object('kept', v_sub.plan_code, 'was', v_sub.scheduled_plan_code));
  return jsonb_build_object('ok', true, 'planCode', v_sub.plan_code);
end;
$$;

-- ── 14. What Flutterwave holds for an account (service key) ─────────────────
-- For the app's calls to Flutterwave's subscriptions API, after it has
-- checked the person's role.
create function mail.billing_provider_state(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sub mail.subscriptions;
begin
  select * into v_sub from mail.subscriptions where account_id = p_account_id;
  if v_sub.id is null then
    return jsonb_build_object('ok', true, 'subscription', null);
  end if;
  return jsonb_build_object('ok', true, 'subscription', jsonb_build_object(
    'status', v_sub.status, 'planCode', v_sub.plan_code, 'testMode', v_sub.test_mode,
    'firstTransactionId', v_sub.first_transaction_id, 'flutterwavePlanId', v_sub.flutterwave_plan_id,
    'providerCanceled', v_sub.provider_canceled_at is not null,
    'scheduledPlanCode', v_sub.scheduled_plan_code));
end;
$$;

-- Flutterwave confirmed the subscription its first charge started is
-- cancelled (or running again). Named by that charge, so a stale call cannot
-- mark a newer subscription.
create function mail.note_provider_canceled(p_account_id uuid, p_first_transaction_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update mail.subscriptions
     set provider_canceled_at = coalesce(provider_canceled_at, now()), updated_at = now()
   where account_id = p_account_id and first_transaction_id = p_first_transaction_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1, 'code', case when v_n = 0 then 'not_found' end);
end;
$$;

create function mail.note_provider_active(p_account_id uuid, p_first_transaction_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update mail.subscriptions
     set provider_canceled_at = null, updated_at = now()
   where account_id = p_account_id and first_transaction_id = p_first_transaction_id
     and status = 'active';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1, 'code', case when v_n = 0 then 'not_found' end);
end;
$$;

-- ── 15. Incidents (service key, and the functions below) ────────────────────
create function mail.record_billing_incident(p_test_mode boolean, p_kind text, p_account_id uuid,
                                             p_provider_reference text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into mail.billing_incidents (test_mode, kind, account_id, provider_reference, detail)
  values (coalesce(p_test_mode, false), p_kind, p_account_id, left(p_provider_reference, 64),
          -- Scalars only, a few of them: statuses, amounts, reasons.
          coalesce((select jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'string'
                                                        then to_jsonb(left(e.value #>> '{}', 100)) else e.value end)
                      from jsonb_each(case when jsonb_typeof(p_detail) = 'object' then p_detail
                                           else '{}'::jsonb end) e
                     where e.key ~ '^[a-z_]{1,40}$' and jsonb_typeof(e.value) in ('string', 'number', 'boolean')),
                   '{}'::jsonb))
  on conflict do nothing;
end;
$$;

-- ── 16. Recording a charge ──────────────────────────────────────────────────
-- An invoice for an applied payment, numbered in the payment's transaction.
create function mail.billing_issue_invoice(p_payment_id uuid, p_lines jsonb, p_subtotal_kobo bigint,
                                           p_vat_bps integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_payment mail.payments;
  v_account mail.accounts;
  v_number  text;
  v_vat     bigint := mail.billing_vat(p_subtotal_kobo, p_vat_bps);
begin
  select * into v_payment from mail.payments where id = p_payment_id;
  select * into v_account from mail.accounts where id = v_payment.account_id;
  v_number := case when v_payment.test_mode
                then 'MDM-TEST-INV-' || lpad(nextval('mail.test_invoice_number_seq')::text, 6, '0')
                else 'MDM-INV-' || lpad(nextval('mail.invoice_number_seq')::text, 6, '0') end;
  insert into mail.invoices (number, account_id, payment_id, test_mode, billed_to, plan_code, plan_name,
                             period_start, period_end, lines, subtotal_kobo, vat_bps, vat_kobo, total_kobo,
                             paid_kobo, provider_reference, tx_ref, method)
  values (v_number, v_account.id, v_payment.id, v_payment.test_mode,
          jsonb_strip_nulls(jsonb_build_object('name', v_account.name, 'website', v_account.website)),
          v_payment.plan_code, (select p.name from mail.plans p where p.code = v_payment.plan_code),
          v_payment.period_start, v_payment.period_end, p_lines, p_subtotal_kobo, p_vat_bps, v_vat,
          p_subtotal_kobo + v_vat, v_payment.amount_kobo, v_payment.provider_reference, v_payment.tx_ref,
          v_payment.method);
  return v_number;
end;
$$;

-- A charge that paid for nothing: kept, with an incident to refund it.
create function mail.billing_unapplied(p_test_mode boolean, p_account_id uuid, p_checkout_id uuid,
                                       p_subscription_id uuid, p_kind text, p_plan_code text,
                                       p_transaction_id text, p_tx_ref text, p_amount_kobo bigint,
                                       p_method text, p_raw jsonb, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                             provider_reference, tx_ref, amount_kobo, currency, method, test_mode, raw)
  values (p_account_id, p_subscription_id, p_checkout_id, p_kind, false, p_plan_code, p_transaction_id,
          p_tx_ref, p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, coalesce(p_raw, '{}'));
  perform mail.record_billing_incident(p_test_mode, 'unapplied_charge', p_account_id, p_transaction_id,
                                       jsonb_build_object('reason', p_reason, 'amount_kobo', p_amount_kobo,
                                                          'kind', p_kind));
end;
$$;

-- What Flutterwave said about one transaction, after the app re-read it
-- (SEC-7): its id, our reference (tx_ref), its status, amount, currency and
-- method, the card's last four digits and scheme, and the allowlisted record.
-- Called by the payment redirect and the webhook, in any order, any number of
-- times; an account's billing is changed by one call at a time.
--
-- How a charge is told apart (Flutterwave v3 payment plans): the first charge
-- of a subscription carries the checkout's tx_ref and starts the
-- subscription at Flutterwave. Later charges are made by Flutterwave. A
-- charge on a paid checkout's reference with another transaction id is taken
-- for such a renewal. [UNVERIFIED: Flutterwave's documentation does not say
-- which tx_ref a recurring charge carries; a renewal whose reference matches
-- no checkout is recorded as an `unknown_reference` incident, and the
-- subscription goes past due at the period's end, so nothing is applied on a
-- guess.]
--
-- Outcomes (`outcome`): paid, renewed, already, pending, failed,
-- renewal_failed, unapplied, mismatch, unknown_reference. `cancelTransactions`
-- names the first charges of Flutterwave subscriptions the app must now
-- cancel: the one an upgrade replaced, or one that paid for nothing.
create function mail.record_billing_charge(p_test_mode boolean, p_transaction_id text, p_tx_ref text,
                                           p_status text, p_amount_kobo bigint, p_currency text,
                                           p_method text, p_card_last4 text, p_card_brand text, p_raw jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_checkout mail.checkouts;
  v_account  mail.accounts;
  v_sub      mail.subscriptions;
  v_prior    mail.payments;
  v_plan     mail.plans;
  v_payment  uuid;
  v_number   text;
  v_start    timestamptz := now();
  v_end      timestamptz;
  v_reason   text;
  v_cancel   text[] := '{}';
  v_status   text := lower(coalesce(p_status, ''));
  v_last4    text := case when coalesce(p_card_last4, '') ~ '^[0-9]{4}$' then p_card_last4 end;
  v_brand    text := case when coalesce(p_card_brand, '') ~ '^[A-Za-z][A-Za-z ]{1,19}$'
                          then upper(p_card_brand) end;
  v_lines    jsonb;
  v_action   text;
begin
  if p_test_mode is null or coalesce(p_transaction_id, '') !~ '^[0-9]{1,20}$' then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  select * into v_settings from mail.billing_settings where id;
  if v_settings.id is null then
    raise exception 'mail.billing_settings is missing' using errcode = '55000';
  end if;

  if coalesce(p_tx_ref, '') ~ '^MDM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_checkout from mail.checkouts where tx_ref = p_tx_ref;
  end if;
  if v_checkout.id is null then
    if v_status = 'successful' then
      perform mail.record_billing_incident(p_test_mode, 'unknown_reference', null, p_transaction_id,
                                           jsonb_build_object('amount_kobo', p_amount_kobo,
                                                              'currency', p_currency));
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'unknown_reference');
  end if;

  -- One account's billing at a time: the redirect and the webhook race.
  select * into v_account from mail.accounts where id = v_checkout.account_id for update;
  select * into v_checkout from mail.checkouts where id = v_checkout.id;
  select * into v_sub from mail.subscriptions where account_id = v_account.id for update;

  -- A test charge never settles a live checkout, nor a live one a test checkout (N12).
  if v_checkout.test_mode <> p_test_mode then
    perform mail.record_billing_incident(p_test_mode, 'mode_mismatch', v_account.id, p_transaction_id,
                                         jsonb_build_object('checkout_test_mode', v_checkout.test_mode));
    return jsonb_build_object('ok', true, 'outcome', 'mismatch');
  end if;

  -- Idempotent on Flutterwave's transaction id.
  select * into v_prior from mail.payments where provider_reference = p_transaction_id;
  if v_prior.id is not null then
    if v_prior.tx_ref <> p_tx_ref then
      perform mail.record_billing_incident(p_test_mode, 'tx_ref_mismatch', v_account.id, p_transaction_id,
                                           jsonb_build_object('reason', 'charge_recorded_for_another_reference'));
      return jsonb_build_object('ok', true, 'outcome', 'mismatch');
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'already', 'applied', v_prior.applied);
  end if;

  if v_status = 'pending' then
    return jsonb_build_object('ok', true, 'outcome', 'pending');
  end if;

  if v_status <> 'successful' then
    -- A first payment that failed changes nothing. A failed charge on a paid
    -- checkout's reference is Flutterwave failing to renew (§8): past due.
    if v_checkout.status = 'paid' and v_sub.id is not null and v_sub.checkout_id = v_checkout.id
       and v_sub.status = 'active' and v_sub.first_transaction_id is distinct from p_transaction_id then
      update mail.subscriptions
         set status = 'past_due', past_due_reason = 'renewal_failed', past_due_since = now(),
             past_due_until = greatest(current_period_end, now())
                              + make_interval(days => v_settings.past_due_days),
             scheduled_plan_code = null, scheduled_at = null, updated_at = now()
       where id = v_sub.id;
      perform mail.billing_note(v_account.id, 'system', 'billing.renewal_failed',
                                jsonb_build_object('plan', v_sub.plan_code));
      return jsonb_build_object('ok', true, 'outcome', 'renewal_failed');
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'failed');
  end if;

  -- Not naira: never applied and not refunded automatically; a person looks.
  if upper(coalesce(p_currency, '')) <> 'NGN' then
    perform mail.record_billing_incident(p_test_mode, 'currency_mismatch', v_account.id, p_transaction_id,
                                         jsonb_build_object('currency', left(p_currency, 3)));
    return jsonb_build_object('ok', true, 'outcome', 'mismatch');
  end if;
  if coalesce(p_amount_kobo, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;

  -- ── A later charge on a paid checkout's reference: a renewal.
  if v_checkout.status <> 'open' then
    v_reason := case
      when v_checkout.status = 'unapplied' then 'checkout_unapplied'
      when v_sub.id is null or v_sub.checkout_id is distinct from v_checkout.id then 'subscription_replaced'
      when v_sub.status = 'ended' then 'subscription_ended'
      when v_account.state = 'closed' then 'account_closed'
      when v_sub.scheduled_plan_code is not null or v_sub.provider_canceled_at is not null then 'subscription_canceled'
      when p_amount_kobo < v_sub.amount_kobo then 'underpaid'
      else null end;
    if v_reason is not null then
      perform mail.billing_unapplied(p_test_mode, v_account.id, v_checkout.id, v_sub.id, 'renewal',
                                     coalesce(v_sub.plan_code, v_checkout.plan_code), p_transaction_id, p_tx_ref,
                                     p_amount_kobo, p_method, p_raw, v_reason);
      return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', v_reason,
                                'cancelTransactions', to_jsonb(array_remove(array[v_checkout.paid_transaction_id], null)));
    end if;

    -- Late or early, the month follows on from the last: no gap, no overlap.
    v_start := v_sub.current_period_end;
    v_end := mail.billing_period_end(v_start);
    insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                               provider_reference, tx_ref, amount_kobo, currency, method, test_mode,
                               period_start, period_end, raw)
    values (v_account.id, v_sub.id, v_checkout.id, 'renewal', true, v_sub.plan_code, p_transaction_id, p_tx_ref,
            p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, v_start, v_end,
            coalesce(p_raw, '{}'))
    returning id into v_payment;
    select * into v_plan from mail.plans where code = v_sub.plan_code;
    v_number := mail.billing_issue_invoice(
      v_payment,
      jsonb_build_array(jsonb_build_object('description', v_plan.name || ' plan, one month',
                                           'amountKobo', v_sub.price_kobo)),
      v_sub.price_kobo, v_sub.vat_bps);
    update mail.subscriptions
       set status = 'active', current_period_start = v_start, current_period_end = v_end,
           past_due_reason = null, past_due_since = null, past_due_until = null,
           card_last4 = coalesce(v_last4, card_last4), card_brand = coalesce(v_brand, card_brand),
           updated_at = now()
     where id = v_sub.id;
    if v_account.plan_code is distinct from v_sub.plan_code then
      update mail.accounts set plan_code = v_sub.plan_code, updated_at = now() where id = v_account.id;
    end if;
    perform mail.billing_note(v_account.id, 'system', 'billing.renewed',
                              jsonb_build_object('plan', v_sub.plan_code, 'invoice', v_number));
    return jsonb_build_object('ok', true, 'outcome', 'renewed', 'invoiceNumber', v_number,
                              'cancelTransactions', '[]'::jsonb);
  end if;

  -- ── The checkout's first payment.
  v_reason := case
    when v_account.state = 'closed' then 'account_closed'
    when v_checkout.created_at + make_interval(mins => v_settings.checkout_ttl_minutes) < now() then 'checkout_expired'
    when p_amount_kobo < v_checkout.total_kobo then 'underpaid'
    when v_checkout.kind = 'subscribe' and coalesce(v_sub.status, 'ended') <> 'ended' then 'already_subscribed'
    when v_checkout.kind = 'upgrade'
         and (v_sub.id is null or v_sub.status <> 'active' or v_sub.plan_code is distinct from v_checkout.from_plan_code
              or v_sub.current_period_end is distinct from v_checkout.credit_until) then 'subscription_changed'
    when v_checkout.kind = 'pay_due' and coalesce(v_sub.status, 'ended') <> 'past_due' then 'subscription_changed'
    else null end;
  if v_reason is not null then
    perform mail.billing_unapplied(p_test_mode, v_account.id, v_checkout.id, v_sub.id, 'first',
                                   v_checkout.plan_code, p_transaction_id, p_tx_ref, p_amount_kobo, p_method,
                                   p_raw, v_reason);
    update mail.checkouts
       set status = 'unapplied', paid_at = now(), paid_transaction_id = p_transaction_id
     where id = v_checkout.id;
    -- This charge started a Flutterwave subscription of its own: stop it.
    return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', v_reason,
                              'cancelTransactions', jsonb_build_array(p_transaction_id));
  end if;

  v_end := mail.billing_period_end(v_start);
  -- An upgrade replaces the Flutterwave subscription that was charging.
  if v_sub.id is not null and v_sub.first_transaction_id is not null and v_sub.provider_canceled_at is null then
    v_cancel := array[v_sub.first_transaction_id];
  end if;
  if v_sub.id is null then
    insert into mail.subscriptions (account_id, plan_code, status, test_mode, price_kobo, vat_bps, amount_kobo,
                                    current_period_start, current_period_end, checkout_id,
                                    first_transaction_id, flutterwave_plan_id, card_last4, card_brand)
    values (v_account.id, v_checkout.plan_code, 'active', p_test_mode, v_checkout.price_kobo, v_checkout.vat_bps,
            v_checkout.recurring_kobo, v_start, v_end, v_checkout.id, p_transaction_id,
            v_checkout.flutterwave_plan_id, v_last4, v_brand)
    returning * into v_sub;
  else
    update mail.subscriptions
       set plan_code = v_checkout.plan_code, status = 'active', test_mode = p_test_mode,
           price_kobo = v_checkout.price_kobo, vat_bps = v_checkout.vat_bps, amount_kobo = v_checkout.recurring_kobo,
           current_period_start = v_start, current_period_end = v_end,
           scheduled_plan_code = null, scheduled_at = null,
           past_due_reason = null, past_due_since = null, past_due_until = null,
           ended_at = null, ended_reason = null,
           checkout_id = v_checkout.id, first_transaction_id = p_transaction_id,
           flutterwave_plan_id = v_checkout.flutterwave_plan_id, provider_canceled_at = null,
           card_last4 = v_last4, card_brand = v_brand, updated_at = now()
     where id = v_sub.id
    returning * into v_sub;
  end if;
  update mail.accounts set plan_code = v_checkout.plan_code, updated_at = now() where id = v_account.id;

  insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                             provider_reference, tx_ref, amount_kobo, currency, method, test_mode,
                             period_start, period_end, raw)
  values (v_account.id, v_sub.id, v_checkout.id, 'first', true, v_checkout.plan_code, p_transaction_id, p_tx_ref,
          p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, v_start, v_end,
          coalesce(p_raw, '{}'))
  returning id into v_payment;
  select * into v_plan from mail.plans where code = v_checkout.plan_code;
  v_lines := jsonb_build_array(jsonb_build_object('description', v_plan.name || ' plan, one month',
                                                  'amountKobo', v_checkout.price_kobo));
  if v_checkout.credit_kobo > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description', 'Credit for the unused part of the '
                     || (select p.name from mail.plans p where p.code = v_checkout.from_plan_code) || ' plan''s month',
      'amountKobo', -v_checkout.credit_kobo));
  end if;
  v_number := mail.billing_issue_invoice(v_payment, v_lines, v_checkout.subtotal_kobo, v_checkout.vat_bps);
  update mail.checkouts
     set status = 'paid', paid_at = now(), paid_transaction_id = p_transaction_id
   where id = v_checkout.id;
  v_action := case v_checkout.kind when 'upgrade' then 'billing.upgraded' when 'pay_due' then 'billing.paid'
                                   else 'billing.subscribed' end;
  perform mail.billing_note(v_account.id, 'system', v_action,
                            jsonb_build_object('plan', v_checkout.plan_code, 'invoice', v_number));
  return jsonb_build_object('ok', true, 'outcome', 'paid', 'kind', v_checkout.kind, 'invoiceNumber', v_number,
                            'cancelTransactions', to_jsonb(v_cancel));
end;
$$;

-- ── 17. The hourly sweep (pg_cron) ──────────────────────────────────────────
--   1. A scheduled change whose period has ended: to Free (cancelled), or to
--      the lower paid plan, past due until its first payment (Flutterwave
--      cannot change a subscription's amount, so the new plan needs a new
--      card payment; sending continues meanwhile, as for a failed renewal).
--   2. A renewal that has not come renewal_wait_hours after the period's
--      end: past due (§8), with the grace counted from the period's end.
--   3. Past due beyond its grace: the Free plan.
-- Accounts are locked before subscriptions, as record_billing_charge does.
create function mail.billing_sweep()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.billing_settings;
  v_id       uuid;
  v_sub      mail.subscriptions;
  v_plan     mail.plans;
  v_changed  integer := 0;
  v_past_due integer := 0;
  v_lapsed   integer := 0;
begin
  select * into v_settings from mail.billing_settings where id;
  if v_settings.id is null then
    raise exception 'mail.billing_settings is missing' using errcode = '55000';
  end if;

  for v_id in
    select s.account_id from mail.subscriptions s
     where (s.status = 'active' and s.current_period_end <= now())
        or (s.status = 'past_due' and s.past_due_until <= now())
  loop
    perform 1 from mail.accounts where id = v_id for update;
    select * into v_sub from mail.subscriptions where account_id = v_id for update;

    if v_sub.status = 'active' and v_sub.scheduled_plan_code is not null and v_sub.current_period_end <= now() then
      select * into v_plan from mail.plans where code = v_sub.scheduled_plan_code;
      if v_plan.price_kobo = 0 then
        update mail.subscriptions
           set status = 'ended', ended_at = v_sub.current_period_end, ended_reason = 'canceled',
               scheduled_plan_code = null, scheduled_at = null, updated_at = now()
         where id = v_sub.id;
        update mail.accounts set plan_code = v_plan.code, updated_at = now() where id = v_id;
        perform mail.billing_note(v_id, 'system', 'billing.canceled',
                                  jsonb_build_object('from', v_sub.plan_code, 'to', v_plan.code));
      else
        update mail.subscriptions
           set plan_code = v_plan.code, price_kobo = v_plan.price_kobo, vat_bps = v_settings.vat_bps,
               amount_kobo = v_plan.price_kobo + mail.billing_vat(v_plan.price_kobo, v_settings.vat_bps),
               status = 'past_due', past_due_reason = 'payment_needed',
               past_due_since = v_sub.current_period_end,
               past_due_until = v_sub.current_period_end + make_interval(days => v_settings.past_due_days),
               scheduled_plan_code = null, scheduled_at = null, updated_at = now()
         where id = v_sub.id;
        update mail.accounts set plan_code = v_plan.code, updated_at = now() where id = v_id;
        perform mail.billing_note(v_id, 'system', 'billing.downgraded',
                                  jsonb_build_object('from', v_sub.plan_code, 'to', v_plan.code));
      end if;
      v_changed := v_changed + 1;
    elsif v_sub.status = 'active' and v_sub.scheduled_plan_code is null
          and v_sub.current_period_end + make_interval(hours => v_settings.renewal_wait_hours) <= now() then
      update mail.subscriptions
         set status = 'past_due', past_due_reason = 'renewal_failed', past_due_since = v_sub.current_period_end,
             past_due_until = v_sub.current_period_end + make_interval(days => v_settings.past_due_days),
             updated_at = now()
       where id = v_sub.id;
      perform mail.billing_note(v_id, 'system', 'billing.past_due', jsonb_build_object('plan', v_sub.plan_code));
      v_past_due := v_past_due + 1;
    elsif v_sub.status = 'past_due' and v_sub.past_due_until <= now() then
      update mail.subscriptions
         set status = 'ended', ended_at = now(), ended_reason = 'lapsed',
             past_due_reason = null, past_due_since = null, past_due_until = null, updated_at = now()
       where id = v_sub.id;
      update mail.accounts set plan_code = 'free', updated_at = now() where id = v_id;
      perform mail.billing_note(v_id, 'system', 'billing.lapsed', jsonb_build_object('from', v_sub.plan_code));
      v_lapsed := v_lapsed + 1;
    end if;
  end loop;
  return jsonb_build_object('changed', v_changed, 'pastDue', v_past_due, 'lapsed', v_lapsed);
end;
$$;

-- cron.schedule replaces a job of the same name, so this is safe to run again.
select cron.schedule('mail-billing-sweep', '17 * * * *', 'select mail.billing_sweep()');

-- ── 18. Row-level security ──────────────────────────────────────────────────
alter table mail.billing_settings   enable row level security;   -- no policies: functions only
alter table mail.flutterwave_plans  enable row level security;   -- no policies: functions only
alter table mail.checkouts          enable row level security;
alter table mail.subscriptions      enable row level security;   -- no policies: billing_overview
alter table mail.payments           enable row level security;   -- no policies: invoices carry it
alter table mail.invoices           enable row level security;
alter table mail.billing_incidents  enable row level security;   -- no policies: the admin area

-- Billing is for the people who manage it: owners and admins.
create policy checkouts_billing_read on mail.checkouts for select to authenticated
  using (mail.has_role(account_id, array['owner', 'admin']));
create policy invoices_billing_read on mail.invoices for select to authenticated
  using (mail.has_role(account_id, array['owner', 'admin']));

-- ── 19. Grants ──────────────────────────────────────────────────────────────
-- Reads only, and only these two. No API role — service_role included —
-- writes a billing table: every write is a function.
revoke all on mail.billing_settings, mail.flutterwave_plans, mail.checkouts, mail.subscriptions,
  mail.payments, mail.invoices, mail.billing_incidents from public, anon, authenticated, service_role;
grant select on mail.checkouts, mail.invoices to authenticated;
revoke all on sequence mail.invoice_number_seq, mail.test_invoice_number_seq
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.billing_settings_stay() from public, anon, authenticated, service_role;
revoke all on function mail.billing_rows_are_final() from public, anon, authenticated, service_role;
revoke all on function mail.billing_payment_record(jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.billing_keep_record_only() from public, anon, authenticated, service_role;
revoke all on function mail.billing_vat(bigint, integer) from public, anon, authenticated, service_role;
revoke all on function mail.billing_period_end(timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.billing_note(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function mail.billing_quote(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.billing_overview(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.flutterwave_plan_for(text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function mail.register_flutterwave_plan(text, boolean, text, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function mail.start_checkout(uuid, text, boolean, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function mail.schedule_plan_change(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.keep_current_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.billing_provider_state(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.note_provider_canceled(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.note_provider_active(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.record_billing_incident(boolean, text, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.billing_issue_invoice(uuid, jsonb, bigint, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.billing_unapplied(boolean, uuid, uuid, uuid, text, text, text, text, bigint, text,
                                              jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.billing_sweep() from public, anon, authenticated, service_role;

-- The dashboard, as the person: the page's read and the changes they make.
grant execute on function mail.billing_overview(uuid) to authenticated;
grant execute on function mail.start_checkout(uuid, text, boolean, bigint, bigint) to authenticated;
grant execute on function mail.schedule_plan_change(uuid, text) to authenticated;
grant execute on function mail.keep_current_plan(uuid) to authenticated;
-- The app's Flutterwave side (secret key): plan objects, the redirect and the
-- webhook, and what Flutterwave confirmed about a subscription.
grant execute on function mail.flutterwave_plan_for(text, boolean, text) to service_role;
grant execute on function mail.register_flutterwave_plan(text, boolean, text, bigint, bigint) to service_role;
grant execute on function mail.billing_provider_state(uuid) to service_role;
grant execute on function mail.note_provider_canceled(uuid, text) to service_role;
grant execute on function mail.note_provider_active(uuid, text) to service_role;
grant execute on function mail.record_billing_incident(boolean, text, uuid, text, jsonb) to service_role;
grant execute on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  to service_role;
