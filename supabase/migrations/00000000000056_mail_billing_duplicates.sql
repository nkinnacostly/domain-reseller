-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 56: MyDomainsHub Mail — duplicate Flutterwave subscriptions and
-- duplicate renewal charges (docs/MAIL-SPEC.md §8; CLAUDE.md, the money rows
-- of §15).
--
-- What a live test-mode run on Flutterwave showed (7 Oct 2026): one checkout
-- charge (10534506) started two subscriptions for the same customer and plan
-- (53194 at 00:54:15 UTC, 53195 at 00:57:09), and both renewed an hour later
-- (10534534, 10534536), each on the first charge's tx_ref — so a renewal does
-- carry the checkout's reference, as migration 50 assumed. GET
-- /v3/subscriptions?transaction_id=10534506 returns both. One payment can
-- therefore bill a customer twice a period.
--
--   settings   — billing_settings.duplicate_renewal_window_hours (72): a
--                successful renewal arriving while the current period began
--                from a renewal recorded that recently pays for a month
--                already paid.
--   incidents  — two new kinds. `duplicate_charge`: that second renewal,
--                recorded once (payments are unique on Flutterwave's
--                transaction id) and never applied, for a person to refund;
--                Mail has no refund flow, so nothing is refunded
--                automatically. `duplicate_subscription`: the app found more
--                than one live subscription for one first charge, kept the
--                earliest-created and cancels the others at Flutterwave.
--   record_billing_charge — as migration 54, with that second renewal
--                recorded instead of applied, and the account (and, for a
--                duplicate, the first charge) named in the answer, so the app
--                looks for the second subscription at once.
--   the sweep  — hourly, pg_cron asks the app's /api/jobs/billing through
--                pg_net with the Vault token migration 47 made;
--                begin_billing_jobs checks it and names the live
--                subscriptions to look at, those with an open
--                duplicate_subscription incident first, so a cancel that
--                failed or timed out is asked again the next hour.
--   alerts     — both new kinds are critical (money to refund, or a card that
--                may be charged again); a sweep silent for three hours is a
--                warning.
--
-- Deploy in either order. Applied before the app ships, a second renewal is
-- already kept from the period (the answer is `unapplied`, which the app
-- handles today), and /api/jobs/billing answers 404 until the app ships — the
-- silent-sweep alert says so after three hours. Shipped first, the app stops
-- every subscription of a charge and cancels duplicates; their incident rows
-- wait for this migration's kinds (the cancels do not).
--
-- Every function created or replaced here is revoked from public, anon,
-- authenticated and service_role, then granted to exactly one role, or none
-- (a helper). No signature changes, so no overload is left behind.
-- supabase/tests/mail_billing.sql (check 17) and mail_sending.sql's check 16
-- hold them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings (tuned without a deploy) ────────────────────────────────────
alter table mail.billing_settings
  -- A second successful renewal this soon after the one that began the
  -- current period is a duplicate charge, never another month.
  add column duplicate_renewal_window_hours integer not null default 72
    check (duplicate_renewal_window_hours between 1 and 336);

-- ── 2. Two incident kinds ───────────────────────────────────────────────────
alter table mail.billing_incidents drop constraint billing_incidents_kind_check;
alter table mail.billing_incidents
  add constraint billing_incidents_kind_check check (kind in (
    'unknown_reference',          -- an MDM- reference no checkout has
    'tx_ref_mismatch',            -- a charge presented for another checkout
    'mode_mismatch',              -- a test charge for a live checkout, or back
    'currency_mismatch',          -- a successful charge not in naira
    'unapplied_charge',           -- recorded, paid for nothing: refund it
    'subscription_not_canceled',  -- Flutterwave may charge again: cancel it
    'unrecorded_payment',         -- confirmed by Flutterwave, not recorded here
    'unexpected_failed_charge',   -- a failed charge far from the period end
    'duplicate_charge',           -- a second renewal for a month already paid: refund it
    'duplicate_subscription'));   -- two or more from one first charge: the later ones cancelled

-- ── 3. Recording a charge ───────────────────────────────────────────────────
-- As migration 54's, with two changes: a successful renewal for a period that
-- a renewal began within duplicate_renewal_window_hours is a duplicate charge
-- (recorded, unapplied, an incident; outcome `unapplied`, reason
-- `duplicate_charge`, which the app already treats as money for a person),
-- and the `paid` answer names the account, so the app looks at once for a
-- second subscription that charge started.
create or replace function mail.record_billing_charge(p_test_mode boolean, p_transaction_id text, p_tx_ref text,
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
  v_window   interval;
  v_period   mail.payments;
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
    -- Only near the period's end (review 22): anyone can make a charge fail
    -- on a reference printed on an invoice, so one at any other time is an
    -- incident for a person, never a past-due subscription.
    v_window := make_interval(hours => v_settings.failed_renewal_window_hours);
    if v_checkout.status = 'paid' and v_sub.id is not null and v_sub.checkout_id = v_checkout.id
       and v_sub.status = 'active' and v_sub.first_transaction_id is distinct from p_transaction_id
       and now() not between v_sub.current_period_end - v_window and v_sub.current_period_end + v_window then
      perform mail.record_billing_incident(p_test_mode, 'unexpected_failed_charge', v_account.id,
                                           p_transaction_id,
                                           jsonb_build_object('status', v_status, 'amount_kobo', p_amount_kobo));
      return jsonb_build_object('ok', true, 'outcome', 'failed');
    end if;
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
      -- Stop the Flutterwave subscription only when ours is stale (review
      -- 22): never for an underpaid charge, which anyone can make on a
      -- reference an invoice prints.
      return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', v_reason,
                                'cancelTransactions',
                                case when v_reason in ('subscription_replaced', 'subscription_canceled',
                                                       'subscription_ended', 'checkout_unapplied',
                                                       'account_closed')
                                     then to_jsonb(array_remove(array[v_checkout.paid_transaction_id], null))
                                     else '[]'::jsonb end);
    end if;

    -- Migration 56: one month, one renewal. A first charge can start two
    -- Flutterwave subscriptions (7 Oct 2026), and both renew on its tx_ref.
    -- A successful renewal that arrives while the current period began from a
    -- renewal recorded within duplicate_renewal_window_hours is that second
    -- subscription charging for a month already paid: recorded once (the
    -- payment is unique on Flutterwave's transaction id), never applied, and
    -- an incident for a person to refund — Mail has no refund flow, so nothing
    -- is refunded automatically. The app then looks for the second
    -- subscription by the first charge (`firstTransactionId`) and cancels it.
    select p.* into v_period from mail.payments p
     where p.subscription_id = v_sub.id and p.kind = 'renewal' and p.applied
       and p.period_start = v_sub.current_period_start
       and p.created_at > now() - make_interval(hours => v_settings.duplicate_renewal_window_hours)
     order by p.created_at desc
     limit 1;
    if v_period.id is not null then
      insert into mail.payments (account_id, subscription_id, checkout_id, kind, applied, plan_code,
                                 provider_reference, tx_ref, amount_kobo, currency, method, test_mode, raw)
      values (v_account.id, v_sub.id, v_checkout.id, 'renewal', false, v_sub.plan_code, p_transaction_id, p_tx_ref,
              p_amount_kobo, 'NGN', left(nullif(p_method, ''), 40), p_test_mode, coalesce(p_raw, '{}'));
      perform mail.record_billing_incident(p_test_mode, 'duplicate_charge', v_account.id, p_transaction_id,
                                           jsonb_build_object(
                                             'amount_kobo', p_amount_kobo,
                                             'transaction_id', p_transaction_id,
                                             'period_transaction_id', v_period.provider_reference,
                                             'refund', 'Not refunded automatically: Mail has no refund flow. Refund it in Flutterwave.'));
      return jsonb_build_object('ok', true, 'outcome', 'unapplied', 'reason', 'duplicate_charge',
                                'accountId', v_account.id, 'firstTransactionId', v_sub.first_transaction_id,
                                'cancelTransactions', '[]'::jsonb);
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

  -- A past-due plan paid again (review 23): the new month starts where the
  -- old one ended, so the days past due are not given free.
  if v_checkout.kind = 'pay_due' then
    v_start := coalesce(v_sub.current_period_end, now());
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
                            'accountId', v_account.id, 'cancelTransactions', to_jsonb(v_cancel));
end;
$$;

-- ── 4. The hourly look for duplicate subscriptions ──────────────────────────
-- Flutterwave made the second subscription three minutes after the charge,
-- so the look the payment's settling makes can come too early; this one comes
-- every hour. SQL cannot call Flutterwave: pg_cron asks the app's job route,
-- which holds the key, and the route asks begin_billing_jobs what to look at.

-- The route's address (Supabase Vault, beside migration 47's): change it with
-- vault.update_secret if the app moves. The bearer token is migration 47's.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'mail_billing_jobs_url') then
    perform vault.create_secret('https://emails.mydomainshub.com/api/jobs/billing', 'mail_billing_jobs_url',
      'MyDomainsHub Mail: the billing job route pg_cron calls hourly (migration 56)');
  end if;
end;
$$;

-- The bearer token pg_cron sent, checked against the Vault's (compared as
-- hashes), and the run noted as a heartbeat (the alert below reads it).
-- Answers the live subscriptions the app's key may ask Flutterwave about: its
-- side (test or live keys) and its API's host (plan objects are recorded per
-- host, migration 50, so the e2e mock's are never sent to Flutterwave), not
-- cancelled at Flutterwave, those with an open duplicate_subscription
-- incident first (a cancel not yet confirmed), then the newest first charges.
create function mail.begin_billing_jobs(p_token text, p_test_mode boolean, p_api_host text, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_rows  jsonb;
begin
  select s.decrypted_secret into v_token from vault.decrypted_secrets s where s.name = 'mail_jobs_token';
  if coalesce(v_token, '') = '' or coalesce(p_token, '') = ''
     or extensions.digest(p_token, 'sha256') <> extensions.digest(v_token, 'sha256') then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if p_test_mode is null or coalesce(p_limit, 0) not between 1 and 500
     or coalesce(p_api_host, '') !~ '^[a-z0-9.-]{1,100}(:[0-9]{1,5})?$' then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  perform public.record_heartbeat(case when p_test_mode then 'mail:billing-jobs:test' else 'mail:billing-jobs' end,
                                  p_test_mode, '{}'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_object('accountId', x.account_id,
                                               'firstTransactionId', x.first_transaction_id)
                            order by x.retry desc, x.paid_at desc nulls last), '[]'::jsonb)
    into v_rows
    from (select s.account_id, s.first_transaction_id, c.paid_at,
                 exists (select 1 from mail.billing_incidents i
                          where i.kind = 'duplicate_subscription' and i.account_id = s.account_id
                            and i.provider_reference = s.first_transaction_id and i.resolved_at is null) as retry
            from mail.subscriptions s
            left join mail.checkouts c on c.id = s.checkout_id
           where s.status in ('active', 'past_due') and s.provider_canceled_at is null
             and s.first_transaction_id is not null and s.test_mode = p_test_mode
             and exists (select 1 from mail.flutterwave_plans f
                          where f.flutterwave_plan_id = s.flutterwave_plan_id and f.test_mode = s.test_mode
                            and f.api_host = p_api_host)
           order by retry desc, c.paid_at desc nulls last
           limit p_limit) x;
  return jsonb_build_object('ok', true, 'accounts', v_rows);
end;
$$;

-- Asks the app's billing job route to run (pg_net: sent after this
-- transaction commits). Answers the request's id, or null when the route is
-- not configured; it never fails pg_cron, and the next hour asks again.
create function mail.kick_billing_jobs()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_token text;
  v_id    bigint;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'mail_billing_jobs_url';
  select s.decrypted_secret into v_token from vault.decrypted_secrets s where s.name = 'mail_jobs_token';
  if coalesce(v_url, '') !~ '^https://[a-z0-9.-]+(:[0-9]+)?/' or coalesce(v_token, '') = '' then
    return null;
  end if;
  select net.http_post(
           url := v_url,
           body := '{}'::jsonb,
           headers := jsonb_build_object('Content-Type', 'application/json',
                                         'Authorization', 'Bearer ' || v_token),
           timeout_milliseconds := 55000)
    into v_id;
  return v_id;
exception when others then
  return null;
end;
$$;

-- cron.schedule replaces a job of the same name, so this is safe to run again.
-- At :47, half an hour from billing_sweep's :17.
select cron.schedule('mail-billing-duplicates', '47 * * * *', 'select mail.kick_billing_jobs()');

-- ── 5. Alerts ───────────────────────────────────────────────────────────────
-- As migration 54, with both new incident kinds critical, and one condition
-- more: mail_billing_jobs_silent, when the hourly look above has not run for
-- three hours (counted from its set-up until its first run).
-- The shop's current_alert_conditions (live side) reads this, unchanged.
create or replace function mail.alert_conditions()
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  -- SES paused an account's tenant (§4.2): nothing it queues is sent (MR5).
  select 'mail_tenant_paused:' || a.id, 'critical', 'mail_tenant_paused',
         format('Mail: SES paused the tenant of account %s. Nothing it queues is sent; read the finding in Mail''s admin before anyone resumes it (MR5).',
                a.ses_tenant)
    from mail.accounts a
   where a.ses_status = 'disabled' and a.state <> 'closed' and not a.is_e2e
     and not mail.asked_ses_to_pause(a.id)

  union all
  -- Our own threshold paused an account (§7.4).
  select 'mail_threshold_pause:' || a.id, 'critical', 'mail_threshold_pause',
         format('Mail: account %s paused by our threshold: bounces %s, complaints %s over %s days (%s sent). Only the owner can resume it (MR5).',
                a.ses_tenant, mail.ppm_text((f.detail ->> 'bouncePpm')::integer),
                mail.ppm_text((f.detail ->> 'complaintPpm')::integer),
                coalesce(f.detail ->> 'windowDays', '7'), coalesce(f.detail ->> 'sent', '?'))
    from mail.accounts a
    join lateral (select x.detail from mail.safety_findings x
                   where x.account_id = a.id and x.source = 'threshold' and x.severity = 'pause'
                     and x.resolved_at is null
                   order by x.opened_at desc limit 1) f on true
   where a.state = 'paused' and not a.is_e2e

  union all
  -- An account over our warning level (§7.4).
  select 'mail_threshold_warning:' || a.id, 'warning', 'mail_threshold_warning',
         format('Mail: account %s is over our warning level: bounces %s, complaints %s over %s days (%s sent).',
                a.ses_tenant, mail.ppm_text((f.detail ->> 'bouncePpm')::integer),
                mail.ppm_text((f.detail ->> 'complaintPpm')::integer),
                coalesce(f.detail ->> 'windowDays', '7'), coalesce(f.detail ->> 'sent', '?'))
    from mail.accounts a
    join lateral (select x.detail from mail.safety_findings x
                   where x.account_id = a.id and x.source = 'threshold' and x.severity = 'warning'
                     and x.resolved_at is null
                   order by x.opened_at desc limit 1) f on true
   where a.state in ('sandbox', 'active') and not a.is_e2e

  union all
  -- The whole SES account's reputation (§7.8), before AWS's own review levels.
  select 'mail_reputation:bounce',
         case when r.bounce_ppm >= s.bounce_pause_ppm then 'critical' else 'warning' end,
         'mail_reputation',
         format('The SES account''s bounce rate is %s (CloudWatch, the shop''s email included). AWS reviews accounts at 5%%.',
                mail.ppm_text(r.bounce_ppm))
    from mail.settings s
    cross join lateral (select x.bounce_ppm from mail.reputation_readings x
                         where x.outcome = 'ok' and x.bounce_ppm is not null
                           and x.read_at > now() - interval '2 hours'
                         order by x.read_at desc limit 1) r
   where s.id and r.bounce_ppm >= s.bounce_warn_ppm

  union all
  select 'mail_reputation:complaint',
         case when r.complaint_ppm >= s.complaint_pause_ppm then 'critical' else 'warning' end,
         'mail_reputation',
         format('The SES account''s complaint rate is %s (CloudWatch, the shop''s email included). AWS reviews accounts at 0.1%%.',
                mail.ppm_text(r.complaint_ppm))
    from mail.settings s
    cross join lateral (select x.complaint_ppm from mail.reputation_readings x
                         where x.outcome = 'ok' and x.complaint_ppm is not null
                           and x.read_at > now() - interval '2 hours'
                         order by x.read_at desc limit 1) r
   where s.id and r.complaint_ppm >= s.complaint_warn_ppm

  union all
  -- The SES account's 24-hour quota (§4.4), as the worker last read it.
  select 'mail_quota:24h',
         case when q.share >= 0.95 then 'critical' else 'warning' end,
         'mail_quota',
         format('The SES account has used %s%% of its 24-hour quota; free and sandbox Mail accounts wait for paid ones.',
                floor(q.share * 100)::integer)
    from mail.settings s
    cross join lateral (select case when jsonb_typeof(h.detail -> 'share') = 'number'
                                    then (h.detail ->> 'share')::numeric end as share
                          from public.service_heartbeats h
                         where h.name = 'mail-worker:quota' and h.beat_at > now() - interval '30 minutes') q
   where s.id and q.share is not null and q.share * 100 >= s.quota_alert_pct

  union all
  -- A worker loop that stopped reporting (§11: send, webhooks, quota, domains, safety).
  select 'mail_silent:' || h.name, 'critical', 'mail_silent',
         format('Mail: %s has not reported for %s minutes.', h.name,
                floor(extract(epoch from now() - h.beat_at) / 60)::integer)
    from public.service_heartbeats h
   where h.name like 'mail-worker:%'
     and h.beat_at < now() - make_interval(mins => 15 + case when h.detail ->> 'everyMinutes' ~ '^\d{1,4}$'
                                                            then (h.detail ->> 'everyMinutes')::integer else 0 end)

  union all
  -- The event endpoint (§4.2, §11): every email sent 15–60 minutes ago is
  -- still without a single SES event, though SES publishes one on sending.
  select 'mail_events_silent', 'critical', 'mail_events_silent',
         format('Mail: none of the %s emails sent 15 to 60 minutes ago has an SES event yet — /api/ses/events or its SNS subscription may be down.',
                x.sent)
    from (select count(*) as sent,
                 count(*) filter (where not exists (select 1 from mail.email_events v where v.email_id = e.id)) as silent
            from mail.emails e join mail.accounts a on a.id = e.account_id
           where e.sent_at between now() - interval '60 minutes' and now() - interval '15 minutes'
             and e.ses_message_id is not null and not a.is_e2e) x
   where x.sent > 0 and x.silent = x.sent

  union all
  -- A pause or resume SES has not taken (§7.4): our own gate holds meanwhile.
  select 'mail_tenant_action:' || t.id, 'critical', 'mail_tenant_action',
         format('Mail: SES has not %s the tenant of account %s yet (asked %s minutes ago, %s tries%s). Our own gate %s meanwhile.',
                case t.sending_status when 'DISABLED' then 'paused' else 'resumed' end, a.ses_tenant,
                floor(extract(epoch from now() - t.requested_at) / 60)::integer, t.attempts,
                coalesce('; last: ' || t.last_error, ''),
                case t.sending_status when 'DISABLED' then 'refuses its email' else 'lets it send' end)
    from mail.tenant_actions t join mail.accounts a on a.id = t.account_id
   where t.state in ('pending', 'claimed') and t.requested_at < now() - interval '15 minutes'

  union all
  -- A billing incident (§8): money a person must look at. Live side only.
  select 'mail_billing_incident:' || i.id,
         case when i.kind in ('unrecorded_payment', 'unapplied_charge', 'subscription_not_canceled',
                              'duplicate_charge', 'duplicate_subscription')
              then 'critical' else 'warning' end,
         'mail_billing_incident',
         format('Mail billing: incident %s (%s)%s needs a person. Read it under Accounts, Billing incidents, in Mail''s admin.',
                i.id, replace(i.kind, '_', ' '), coalesce(' on account ' || a.ses_tenant, ''))
    from mail.billing_incidents i
    left join mail.accounts a on a.id = i.account_id
   where i.resolved_at is null and not i.test_mode and not coalesce(a.is_e2e, false)

  union all
  -- The hourly look for duplicate subscriptions (§8, migration 56): no run
  -- for three hours since it last ran, or since it was set up.
  select 'mail_billing_jobs_silent', 'warning', 'mail_billing_jobs_silent',
         format('Mail billing: the hourly check for duplicate Flutterwave subscriptions has not run for %s hours. Check pg_cron''s mail-billing-duplicates job and that /api/jobs/billing is deployed.',
                floor(extract(epoch from now() - x.since) / 3600)::integer)
    from (select coalesce((select h.beat_at from public.service_heartbeats h where h.name = 'mail:billing-jobs'),
                          (select v.created_at from vault.secrets v where v.name = 'mail_billing_jobs_url')) as since) x
   where x.since < now() - interval '3 hours'

  union all
  -- Customer webhooks due and untried for too long (§11: "a webhook backlog over an hour").
  select 'mail_webhook_backlog', 'critical', 'mail_webhook_backlog',
         format('Mail: %s webhook deliveries have waited over %s minutes without being tried (the oldest %s minutes); the worker''s webhook loop is behind or stopped.',
                x.n, s.webhook_backlog_minutes, x.oldest)
    from mail.settings s
    cross join lateral (
      select count(*) as n,
             floor(extract(epoch from now() - min(case when d.status = 'delivering' then d.claimed_at
                                                       else d.next_attempt_at end)) / 60)::integer as oldest
        from mail.webhook_deliveries d
        join mail.webhooks w on w.id = d.webhook_id
        join mail.accounts a on a.id = d.account_id
       where w.status = 'enabled' and not a.is_e2e
         and ((d.status = 'pending' and d.next_attempt_at < now() - make_interval(mins => s.webhook_backlog_minutes))
              or (d.status = 'delivering' and d.claimed_at < now() - make_interval(mins => s.webhook_backlog_minutes)))) x
   where s.id and x.n > 0
$$;

-- ── 6. Grants ───────────────────────────────────────────────────────────────
revoke all on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function mail.begin_billing_jobs(text, boolean, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function mail.kick_billing_jobs() from public, anon, authenticated, service_role;
revoke all on function mail.alert_conditions() from public, anon, authenticated, service_role;

-- Billing (apps/mail, secret key): the redirect and the webhook, and the job route.
grant execute on function mail.record_billing_charge(boolean, text, text, text, bigint, text, text, text, text, jsonb)
  to service_role;
grant execute on function mail.begin_billing_jobs(text, boolean, text, integer) to service_role;
-- Helpers (kick_billing_jobs, for pg_cron; alert_conditions) stay granted to no API role.

notify pgrst, 'reload schema';
