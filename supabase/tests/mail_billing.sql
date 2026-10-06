-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 50 (MyDomainsHub Mail, billing), tried as the database owner and,
-- where the grant is the point, as `anon`, `authenticated` and `service_role`:
-- quotes and VAT from the tables (N5b), checkouts and who may start them,
-- test keys for e2e accounts only (N12), a charge recorded once and only as
-- Flutterwave confirmed it (SEC-7), renewals, a failed renewal, upgrades with
-- their credit, downgrades and cancellations at the period's end, the sweep,
-- tax invoices from the test series, the raw allowlist, money rows that are
-- final, RLS by role, and every billing function's grant. People are made up
-- with e2e-*@example.com addresses; only test payments are recorded, so the
-- live invoice series is never touched. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_billing.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.mb_as(p_uid uuid) returns void language plpgsql as $f$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
    execute 'set local role authenticated';
  end if;
end $f$;

create function pg_temp.mb_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.mb_outcome(p_j jsonb, p_outcome text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true or (p_j ->> 'outcome') is distinct from p_outcome then
    raise exception '% (expected %, got %)', p_what, p_outcome, p_j;
  end if;
end $f$;

create function pg_temp.mb_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- A checkout started the way the app starts one: as the person.
create function pg_temp.mb_checkout(p_uid uuid, p_account uuid, p_plan text, p_test boolean, p_fw bigint,
                                    p_total bigint)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  perform pg_temp.mb_as(p_uid);
  v_j := mail.start_checkout(p_account, p_plan, p_test, p_fw, p_total);
  execute 'reset role';
  return v_j;
end $f$;

-- What Flutterwave said about a charge, recorded the way the app records it (service key).
create function pg_temp.mb_charge(p_test boolean, p_tx text, p_ref text, p_status text, p_kobo bigint,
                                  p_currency text default 'NGN', p_last4 text default '4242')
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.record_billing_charge(p_test, p_tx, p_ref, p_status, p_kobo, p_currency, 'card', p_last4, 'visa',
           jsonb_build_object('id', p_tx::bigint, 'tx_ref', p_ref, 'status', p_status, 'amount', p_kobo / 100.0,
                              'currency', p_currency, 'payment_type', 'card',
                              'customer', jsonb_build_object('email', 'someone@example.com', 'name', 'Some One'),
                              'card', jsonb_build_object('token', 'flw-t1nk-secret', 'last_4digits', p_last4)));
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mb_service(p_sql text) returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v_j;
  execute 'reset role';
  return v_j;
end $f$;

do $$
declare
  v_tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o        uuid := gen_random_uuid();
  u_a        uuid := gen_random_uuid();
  u_v        uuid := gen_random_uuid();
  u_s        uuid := gen_random_uuid();
  u_real     uuid := gen_random_uuid();
  a_acc      uuid;
  b_acc      uuid;
  v_j        jsonb;
  v_c1       jsonb;
  v_c2       jsonb;
  v_ref      text;
  v_sub      mail.subscriptions;
  v_end      timestamptz;
  v_n        integer;
  v_text     text;
  v_inv      mail.invoices;
  v_pay      mail.payments;
  v_tx       bigint := 880000000000 + floor(random() * 100000000)::bigint;
  fw_starter bigint := 77000000 + floor(random() * 1000000)::bigint;
  fw_pro     bigint;
  v_row      record;
  v_want     text;
  v_expected jsonb;
  v_passed   integer := 0;
begin
  fw_pro := fw_starter + 1;
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', 'e2e-m50-o-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_a, 'authenticated', 'authenticated', 'e2e-m50-a-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_v, 'authenticated', 'authenticated', 'e2e-m50-v-' || v_tag || '@example.com', now(), '{}', now(), now()),
    (u_s, 'authenticated', 'authenticated', 'e2e-m50-s-' || v_tag || '@example.com', now(), '{}', now(), now()),
    -- Not an e2e address: an account of theirs is a real one.
    (u_real, 'authenticated', 'authenticated', 'm50-real-' || v_tag || '@example.net', now(), '{}', now(), now());

  perform pg_temp.mb_as(u_o);
  a_acc := (mail.create_account('m50 ' || v_tag, 'https://m50.example', 'Receipts', 1000) ->> 'accountId')::uuid;
  perform pg_temp.mb_as(u_real);
  b_acc := (mail.create_account('m50 real ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values (a_acc, u_a, 'admin'), (a_acc, u_v, 'viewer');

  -- ── 1. Settings and the money tables' shape.
  if (select vat_bps from mail.billing_settings) <> 750 or (select past_due_days from mail.billing_settings) <> 7 then
    raise exception 'FAILED 1: billing settings are not 7.5%% VAT and 7 days past due';
  end if;
  begin
    delete from mail.billing_settings;
    raise exception 'FAILED 1: the settings row was deleted';
  exception when check_violation then null;
  end;
  if mail.billing_vat(2000000, 750) <> 150000 or mail.billing_vat(4166667, 750) <> 312500
     or mail.billing_vat(1, 5000) <> 1 or mail.billing_vat(0, 750) <> 0 then
    raise exception 'FAILED 1: VAT is not rounded half up to the kobo';
  end if;
  if mail.billing_period_end('2027-01-31 12:00+01') <> '2027-02-28 12:00+01'::timestamptz then
    raise exception 'FAILED 1: a month on from 31 January is not 28 February';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Signed out, nobody reaches billing; a member reads it, by role.
  perform pg_temp.mb_as(null);
  begin
    perform mail.billing_overview(a_acc);
    raise exception 'FAILED 2: anon read billing';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.mb_as(u_s);
  perform pg_temp.mb_code(mail.billing_overview(a_acc), 'not_found', 'FAILED 2: a stranger reads billing');
  perform pg_temp.mb_as(u_v);
  v_j := mail.billing_overview(a_acc);
  perform pg_temp.mb_ok(v_j, 'FAILED 2: a viewer reads billing');
  if (v_j ->> 'canManage')::boolean or v_j -> 'subscription' <> 'null'::jsonb or v_j ->> 'role' <> 'viewer'
     or (v_j -> 'plan' ->> 'code') <> 'free' or (v_j ->> 'vatBps')::integer <> 750 then
    raise exception 'FAILED 2: the viewer''s overview is wrong: %', v_j;
  end if;
  if (select count(*) from jsonb_array_elements(v_j -> 'plans') p where p ->> 'code' = 'scale') <> 0 then
    raise exception 'FAILED 2: Scale is listed though it is not offered';
  end if;
  select p into v_c1 from jsonb_array_elements(v_j -> 'plans') p where p ->> 'code' = 'starter';
  if v_c1 -> 'quote' ->> 'change' <> 'subscribe' or (v_c1 -> 'quote' ->> 'totalKobo')::bigint <> 2150000
     or (v_c1 -> 'quote' ->> 'vatKobo')::bigint <> 150000 or (v_c1 -> 'quote' ->> 'recurringKobo')::bigint <> 2150000 then
    raise exception 'FAILED 2: Starter''s quote is not ₦20,000 + 7.5%% VAT: %', v_c1;
  end if;
  select p into v_c1 from jsonb_array_elements(v_j -> 'plans') p where p ->> 'code' = 'free';
  if v_c1 -> 'quote' ->> 'change' <> 'current' then
    raise exception 'FAILED 2: Free is not the current plan: %', v_c1;
  end if;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 3. Flutterwave plan objects: made on demand, recorded once, at today's amount.
  v_j := pg_temp.mb_service(format('select mail.flutterwave_plan_for(%L, true, %L)', 'starter', 'mock.test:4315'));
  if (v_j ->> 'amountKobo')::bigint <> 2150000 or v_j -> 'flutterwavePlanId' <> 'null'::jsonb then
    raise exception 'FAILED 3: Starter''s plan object is not wanted at ₦21,500: %', v_j;
  end if;
  perform pg_temp.mb_code(pg_temp.mb_service(format('select mail.flutterwave_plan_for(%L, true, %L)', 'scale', 'mock.test:4315')),
                          'not_offered', 'FAILED 3: a plan object for Scale');
  perform pg_temp.mb_code(pg_temp.mb_service(format('select mail.flutterwave_plan_for(%L, true, %L)', 'free', 'mock.test:4315')),
                          'not_offered', 'FAILED 3: a plan object for Free');
  perform pg_temp.mb_code(pg_temp.mb_service(
    format('select mail.register_flutterwave_plan(%L, true, %L, 2000000, %s)', 'starter', 'mock.test:4315', fw_starter)),
    'amount_changed', 'FAILED 3: a plan object without VAT was recorded');
  perform pg_temp.mb_code(pg_temp.mb_service(
    format('select mail.register_flutterwave_plan(%L, false, %L, 2150000, %s)', 'starter', 'mock.test:4315', fw_starter)),
    'validation', 'FAILED 3: a live plan object on another API');
  v_j := pg_temp.mb_service(format('select mail.register_flutterwave_plan(%L, true, %L, 2150000, %s)',
                                   'starter', 'mock.test:4315', fw_starter));
  perform pg_temp.mb_ok(v_j, 'FAILED 3: Starter''s plan object');
  -- Made twice at once: the first recorded wins.
  v_j := pg_temp.mb_service(format('select mail.register_flutterwave_plan(%L, true, %L, 2150000, %s)',
                                   'starter', 'mock.test:4315', fw_starter + 500));
  if (v_j ->> 'flutterwavePlanId')::bigint <> fw_starter then
    raise exception 'FAILED 3: a second plan object replaced the first: %', v_j;
  end if;
  -- The mock's object is never offered to Flutterwave's own test API.
  v_j := pg_temp.mb_service(format('select mail.flutterwave_plan_for(%L, true, %L)', 'starter', 'api.flutterwave.com'));
  if v_j -> 'flutterwavePlanId' <> 'null'::jsonb then
    raise exception 'FAILED 3: another API''s plan object was offered: %', v_j;
  end if;
  perform pg_temp.mb_ok(pg_temp.mb_service(
    format('select mail.register_flutterwave_plan(%L, true, %L, 5912500, %s)', 'pro', 'mock.test:4315', fw_pro)),
    'FAILED 3: Pro''s plan object');
  begin
    perform pg_temp.mb_as(u_o);
    perform mail.register_flutterwave_plan('starter', true, 'mock.test:4315', 2150000, 1);
    raise exception 'FAILED 3: a signed-in person recorded a plan object';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 4. Who may start a checkout, for what, with which keys.
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_v, a_acc, 'starter', true, fw_starter, 2150000), 'forbidden',
                          'FAILED 4: a viewer started a checkout');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_s, a_acc, 'starter', true, fw_starter, 2150000), 'not_found',
                          'FAILED 4: a stranger started a checkout');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'scale', true, fw_starter, 2150000), 'not_offered',
                          'FAILED 4: a checkout for Scale');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'free', true, fw_starter, 0), 'not_offered',
                          'FAILED 4: a checkout for Free');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', false, fw_starter, 2150000),
                          'live_mode_not_for_tests', 'FAILED 4: live keys for an e2e account');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_real, b_acc, 'starter', true, fw_starter, 2150000),
                          'test_mode_e2e_only', 'FAILED 4: test keys bought a real account a plan');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_pro, 2150000),
                          'no_flutterwave_plan', 'FAILED 4: Pro''s plan object for a Starter checkout');
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2000000),
                          'quote_changed', 'FAILED 4: a checkout for a total the quote is not');
  v_c1 := pg_temp.mb_checkout(u_a, a_acc, 'starter', true, fw_starter, 2150000);
  perform pg_temp.mb_ok(v_c1, 'FAILED 4: an admin''s checkout');
  v_ref := v_c1 ->> 'txRef';
  if v_ref <> 'MDM-' || (v_c1 ->> 'checkoutId') or v_c1 ->> 'kind' <> 'subscribe'
     or (v_c1 ->> 'totalKobo')::bigint <> 2150000 then
    raise exception 'FAILED 4: the checkout is wrong: %', v_c1;
  end if;
  update mail.billing_settings set checkouts_per_hour = 1;
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2150000),
                          'too_many_checkouts', 'FAILED 4: checkouts past the hour''s limit');
  update mail.billing_settings set checkouts_per_hour = 10;
  v_passed := v_passed + 1;

  -- ── 5. A charge counts only as Flutterwave confirmed it (SEC-7).
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 90)::text, 'MDM-' || gen_random_uuid(), 'successful', 2150000),
                             'unknown_reference', 'FAILED 5: a reference no checkout has');
  if not exists (select 1 from mail.billing_incidents where kind = 'unknown_reference'
                  and provider_reference = (v_tx + 90)::text and resolved_at is null) then
    raise exception 'FAILED 5: an unknown reference left no incident';
  end if;
  perform pg_temp.mb_outcome(pg_temp.mb_charge(false, (v_tx + 91)::text, v_ref, 'successful', 2150000),
                             'mismatch', 'FAILED 5: a live charge settled a test checkout');
  if not exists (select 1 from mail.billing_incidents where kind = 'mode_mismatch' and account_id = a_acc) then
    raise exception 'FAILED 5: a crossed side left no incident';
  end if;
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 92)::text, v_ref, 'pending', 2150000),
                             'pending', 'FAILED 5: a pending charge');
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 93)::text, v_ref, 'failed', 2150000),
                             'failed', 'FAILED 5: a failed first charge');
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 94)::text, v_ref, 'successful', 2150000, 'USD'),
                             'mismatch', 'FAILED 5: a charge in dollars');
  if exists (select 1 from mail.payments where account_id = a_acc)
     or exists (select 1 from mail.subscriptions where account_id = a_acc)
     or (select plan_code from mail.accounts where id = a_acc) <> 'free' then
    raise exception 'FAILED 5: a charge that did not count changed something';
  end if;
  begin
    perform pg_temp.mb_as(u_o);
    perform mail.record_billing_charge(true, (v_tx + 95)::text, v_ref, 'successful', 2150000, 'NGN', 'card', null,
                                       null, '{}');
    raise exception 'FAILED 5: a signed-in person recorded a charge';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 6. The first payment: Starter at once, a month from now, a test tax invoice.
  v_j := pg_temp.mb_charge(true, v_tx::text, v_ref, 'successful', 2150000);
  perform pg_temp.mb_outcome(v_j, 'paid', 'FAILED 6: the first payment');
  if v_j -> 'cancelTransactions' <> '[]'::jsonb or v_j ->> 'invoiceNumber' !~ '^MDM-TEST-INV-[0-9]{6,}$' then
    raise exception 'FAILED 6: the first payment''s answer is wrong: %', v_j;
  end if;
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'active' or v_sub.plan_code <> 'starter' or v_sub.amount_kobo <> 2150000
     or v_sub.current_period_start <> now() or v_sub.current_period_end <> mail.billing_period_end(now())
     or v_sub.first_transaction_id <> v_tx::text or v_sub.card_last4 <> '4242' or v_sub.card_brand <> 'VISA'
     or not v_sub.test_mode or (select plan_code from mail.accounts where id = a_acc) <> 'starter' then
    raise exception 'FAILED 6: the subscription is wrong: %', row_to_json(v_sub);
  end if;
  select * into v_pay from mail.payments where provider_reference = v_tx::text;
  if not v_pay.applied or v_pay.kind <> 'first' or v_pay.amount_kobo <> 2150000
     or v_pay.raw ? 'customer' or v_pay.raw ? 'card' or v_pay.raw::text like '%t1nk%'
     or (v_pay.raw ->> 'tx_ref') <> v_ref then
    raise exception 'FAILED 6: the payment row is wrong or kept more than the allowlist: %', row_to_json(v_pay);
  end if;
  select * into v_inv from mail.invoices where payment_id = v_pay.id;
  if v_inv.number <> v_j ->> 'invoiceNumber' or not v_inv.test_mode or v_inv.subtotal_kobo <> 2000000
     or v_inv.vat_kobo <> 150000 or v_inv.total_kobo <> 2150000 or v_inv.paid_kobo <> 2150000
     or jsonb_array_length(v_inv.lines) <> 1 or v_inv.billed_to ->> 'name' <> 'm50 ' || v_tag
     or v_inv.period_end <> v_sub.current_period_end then
    raise exception 'FAILED 6: the invoice is wrong: %', row_to_json(v_inv);
  end if;
  if (select status from mail.checkouts where tx_ref = v_ref) <> 'paid'
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'billing.subscribed') then
    raise exception 'FAILED 6: the checkout or the account log was not updated';
  end if;
  -- The redirect and the webhook both arrive: the second changes nothing.
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, v_tx::text, v_ref, 'successful', 2150000),
                             'already', 'FAILED 6: the same charge twice');
  if (select count(*) from mail.payments where account_id = a_acc) <> 1
     or (select count(*) from mail.invoices where account_id = a_acc) <> 1 then
    raise exception 'FAILED 6: the same charge was recorded twice';
  end if;
  -- The card on file, for those who manage billing only.
  perform pg_temp.mb_as(u_o);
  v_j := mail.billing_overview(a_acc);
  if v_j -> 'subscription' -> 'card' ->> 'last4' <> '4242' or v_j -> 'subscription' ->> 'status' <> 'active' then
    raise exception 'FAILED 6: the owner does not see the card''s last four: %', v_j;
  end if;
  perform pg_temp.mb_as(u_v);
  v_j := mail.billing_overview(a_acc);
  if v_j -> 'subscription' -> 'card' <> 'null'::jsonb then
    raise exception 'FAILED 6: a viewer sees the card';
  end if;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 7. RLS: invoices and checkouts for owners and admins; nothing else for anyone.
  perform pg_temp.mb_as(u_a);
  if (select count(*) from mail.invoices) <> 1 or (select count(*) from mail.checkouts) < 1 then
    raise exception 'FAILED 7: an admin does not read the invoices';
  end if;
  perform pg_temp.mb_as(u_v);
  if exists (select 1 from mail.invoices) or exists (select 1 from mail.checkouts) then
    raise exception 'FAILED 7: a viewer reads invoices or checkouts';
  end if;
  perform pg_temp.mb_as(u_s);
  if exists (select 1 from mail.invoices) or exists (select 1 from mail.checkouts) then
    raise exception 'FAILED 7: a stranger reads invoices or checkouts';
  end if;
  begin
    perform 1 from mail.subscriptions;
    raise exception 'FAILED 7: subscriptions are readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from mail.payments;
    raise exception 'FAILED 7: payments are readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from mail.billing_incidents;
    raise exception 'FAILED 7: incidents are readable';
  exception when insufficient_privilege then null;
  end;
  execute 'set local role service_role';
  begin
    perform 1 from mail.invoices;
    raise exception 'FAILED 7: the service key reads a billing table';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 8. Money rows are final, even for the owner of the database.
  begin
    update mail.payments set amount_kobo = 1 where id = v_pay.id;
    raise exception 'FAILED 8: a payment was rewritten';
  exception when check_violation then null;
  end;
  begin
    delete from mail.payments where id = v_pay.id;
    raise exception 'FAILED 8: a payment was deleted';
  exception when check_violation then null;
  end;
  begin
    update mail.invoices set total_kobo = 1 where id = v_inv.id;
    raise exception 'FAILED 8: an invoice was rewritten';
  exception when check_violation then null;
  end;
  begin
    delete from mail.invoices where id = v_inv.id;
    raise exception 'FAILED 8: an invoice was deleted';
  exception when check_violation then null;
  end;
  -- A live payment survives even the e2e purge's flag.
  insert into mail.payments (account_id, kind, applied, plan_code, provider_reference, tx_ref, amount_kobo,
                             currency, test_mode)
  values (b_acc, 'first', false, 'starter', (v_tx + 99)::text, 'MDM-' || gen_random_uuid(), 100, 'NGN', false);
  perform set_config('mail.e2e_purge', 'on', true);
  begin
    delete from mail.payments where provider_reference = (v_tx + 99)::text;
    raise exception 'FAILED 8: a live payment was deleted under the purge flag';
  exception when check_violation then null;
  end;
  perform set_config('mail.e2e_purge', 'off', true);
  v_passed := v_passed + 1;

  -- ── 9. Renewals on the subscription's reference; one that pays too little is kept, unapplied.
  v_end := v_sub.current_period_end;
  v_j := pg_temp.mb_charge(true, (v_tx + 1)::text, v_ref, 'successful', 2150000);
  perform pg_temp.mb_outcome(v_j, 'renewed', 'FAILED 9: a renewal');
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.current_period_start <> v_end or v_sub.current_period_end <> mail.billing_period_end(v_end)
     or v_sub.status <> 'active' or (select count(*) from mail.invoices where account_id = a_acc) <> 2 then
    raise exception 'FAILED 9: the renewal did not follow on from the last month: %', row_to_json(v_sub);
  end if;
  v_j := pg_temp.mb_charge(true, (v_tx + 2)::text, v_ref, 'successful', 100);
  perform pg_temp.mb_outcome(v_j, 'unapplied', 'FAILED 9: a renewal below the plan''s amount');
  if v_j ->> 'reason' <> 'underpaid' or (select applied from mail.payments where provider_reference = (v_tx + 2)::text)
     or not exists (select 1 from mail.billing_incidents where kind = 'unapplied_charge'
                     and provider_reference = (v_tx + 2)::text)
     or (select current_period_end from mail.subscriptions where account_id = a_acc) <> v_sub.current_period_end then
    raise exception 'FAILED 9: an underpaid renewal was applied, or left no incident: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 10. An upgrade, at once: Pro's month from now, less the unused part of Starter's.
  update mail.subscriptions
     set current_period_start = now() - interval '10 days', current_period_end = now() + interval '20 days'
   where account_id = a_acc;
  perform pg_temp.mb_as(u_o);
  v_j := mail.billing_overview(a_acc);
  execute 'reset role';
  select p into v_c1 from jsonb_array_elements(v_j -> 'plans') p where p ->> 'code' = 'pro';
  if v_c1 -> 'quote' ->> 'change' <> 'upgrade' or (v_c1 -> 'quote' ->> 'creditKobo')::bigint <> 1333333
     or (v_c1 -> 'quote' ->> 'subtotalKobo')::bigint <> 4166667 or (v_c1 -> 'quote' ->> 'vatKobo')::bigint <> 312500
     or (v_c1 -> 'quote' ->> 'totalKobo')::bigint <> 4479167 then
    raise exception 'FAILED 10: Pro''s upgrade quote is wrong: %', v_c1;
  end if;
  select p into v_c1 from jsonb_array_elements(v_j -> 'plans') p where p ->> 'code' = 'free';
  if v_c1 -> 'quote' ->> 'change' <> 'cancel' then
    raise exception 'FAILED 10: Free is not offered as a cancellation: %', v_c1;
  end if;
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2150000), 'current_plan',
                          'FAILED 10: a checkout for the current plan');
  v_c2 := pg_temp.mb_checkout(u_o, a_acc, 'pro', true, fw_pro, 4479167);
  perform pg_temp.mb_ok(v_c2, 'FAILED 10: the upgrade''s checkout');
  if v_c2 ->> 'kind' <> 'upgrade' then
    raise exception 'FAILED 10: the upgrade''s checkout is not an upgrade: %', v_c2;
  end if;
  v_j := pg_temp.mb_charge(true, (v_tx + 3)::text, v_c2 ->> 'txRef', 'successful', 4479167);
  perform pg_temp.mb_outcome(v_j, 'paid', 'FAILED 10: the upgrade''s payment');
  -- Starter's Flutterwave subscription is the app's to cancel now.
  if v_j -> 'cancelTransactions' <> jsonb_build_array(v_tx::text) then
    raise exception 'FAILED 10: the replaced subscription is not named for cancelling: %', v_j;
  end if;
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  select * into v_inv from mail.invoices where number = v_j ->> 'invoiceNumber';
  if v_sub.plan_code <> 'pro' or v_sub.amount_kobo <> 5912500 or v_sub.current_period_start <> now()
     or v_sub.first_transaction_id <> (v_tx + 3)::text or (select plan_code from mail.accounts where id = a_acc) <> 'pro'
     or jsonb_array_length(v_inv.lines) <> 2 or (v_inv.lines -> 1 ->> 'amountKobo')::bigint <> -1333333
     or v_inv.subtotal_kobo <> 4166667 or v_inv.total_kobo <> 4479167 then
    raise exception 'FAILED 10: the upgrade was not applied as quoted: % %', row_to_json(v_sub), row_to_json(v_inv);
  end if;
  -- Starter's subscription charging after all: kept, unapplied, and named again for cancelling.
  v_j := pg_temp.mb_charge(true, (v_tx + 4)::text, v_ref, 'successful', 2150000);
  perform pg_temp.mb_outcome(v_j, 'unapplied', 'FAILED 10: a charge on the replaced subscription');
  if v_j ->> 'reason' <> 'subscription_replaced' or v_j -> 'cancelTransactions' <> jsonb_build_array(v_tx::text) then
    raise exception 'FAILED 10: the replaced subscription''s charge is wrong: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 11. Downgrades and cancellations wait for the period's end, once Flutterwave has stopped.
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2150000), 'use_schedule',
                          'FAILED 11: a downgrade as a checkout');
  perform pg_temp.mb_as(u_v);
  perform pg_temp.mb_code(mail.schedule_plan_change(a_acc, 'starter'), 'forbidden', 'FAILED 11: a viewer downgraded');
  perform pg_temp.mb_as(u_o);
  perform pg_temp.mb_code(mail.schedule_plan_change(a_acc, 'starter'), 'provider_active',
                          'FAILED 11: a downgrade while Flutterwave still charges');
  perform pg_temp.mb_code(mail.schedule_plan_change(a_acc, 'pro'), 'current_plan', 'FAILED 11: a change to the same plan');
  execute 'reset role';
  -- A stale call cannot mark the new subscription.
  v_j := pg_temp.mb_service(format('select mail.note_provider_canceled(%L, %L)', a_acc, v_tx::text));
  perform pg_temp.mb_code(v_j, 'not_found', 'FAILED 11: the replaced subscription''s cancel marked the new one');
  perform pg_temp.mb_ok(pg_temp.mb_service(format('select mail.note_provider_canceled(%L, %L)', a_acc, (v_tx + 3)::text)),
                        'FAILED 11: Flutterwave''s cancel noted');
  perform pg_temp.mb_as(u_a);
  v_j := mail.schedule_plan_change(a_acc, 'starter');
  perform pg_temp.mb_ok(v_j, 'FAILED 11: an admin scheduled a downgrade');
  if (v_j ->> 'effectiveAt')::timestamptz <> v_sub.current_period_end
     or (mail.billing_overview(a_acc) -> 'subscription' ->> 'scheduledPlanCode') <> 'starter' then
    raise exception 'FAILED 11: the downgrade is not scheduled for the period''s end: %', v_j;
  end if;
  perform pg_temp.mb_code(mail.keep_current_plan(a_acc), 'provider_canceled',
                          'FAILED 11: kept Pro while Flutterwave''s subscription is stopped');
  execute 'reset role';
  perform pg_temp.mb_ok(pg_temp.mb_service(format('select mail.note_provider_active(%L, %L)', a_acc, (v_tx + 3)::text)),
                        'FAILED 11: Flutterwave''s reactivation noted');
  perform pg_temp.mb_as(u_o);
  perform pg_temp.mb_ok(mail.keep_current_plan(a_acc), 'FAILED 11: kept Pro');
  if (mail.billing_overview(a_acc) -> 'subscription' -> 'scheduledPlanCode') <> 'null'::jsonb then
    raise exception 'FAILED 11: the downgrade is still scheduled';
  end if;
  execute 'reset role';
  perform pg_temp.mb_service(format('select mail.note_provider_canceled(%L, %L)', a_acc, (v_tx + 3)::text));
  perform pg_temp.mb_as(u_o);
  perform pg_temp.mb_ok(mail.schedule_plan_change(a_acc, 'free'), 'FAILED 11: a cancellation');
  execute 'reset role';
  -- A charge after the cancellation: kept, unapplied.
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 5)::text, v_c2 ->> 'txRef', 'successful', 5912500),
                             'unapplied', 'FAILED 11: a renewal after a cancellation');
  -- At the period's end, the sweep moves the account to Free.
  update mail.subscriptions set current_period_end = now() - interval '1 minute',
                                current_period_start = now() - interval '1 month'
   where account_id = a_acc;
  perform mail.billing_sweep();
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'ended' or v_sub.ended_reason <> 'canceled' or v_sub.scheduled_plan_code is not null
     or (select plan_code from mail.accounts where id = a_acc) <> 'free'
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'billing.canceled') then
    raise exception 'FAILED 11: the cancellation was not applied at the period''s end: %', row_to_json(v_sub);
  end if;
  v_passed := v_passed + 1;

  -- ── 12. Subscribing again; a failed renewal is past due; paying again; a lapse to Free.
  v_c1 := pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2150000);
  perform pg_temp.mb_ok(v_c1, 'FAILED 12: a new subscription''s checkout');
  v_ref := v_c1 ->> 'txRef';
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 6)::text, v_ref, 'successful', 2150000),
                             'paid', 'FAILED 12: subscribing again');
  v_j := pg_temp.mb_charge(true, (v_tx + 7)::text, v_ref, 'failed', 2150000);
  perform pg_temp.mb_outcome(v_j, 'renewal_failed', 'FAILED 12: a failed renewal');
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'past_due' or v_sub.past_due_reason <> 'renewal_failed'
     or v_sub.past_due_until <> v_sub.current_period_end + interval '7 days'
     or (select plan_code from mail.accounts where id = a_acc) <> 'starter' then
    raise exception 'FAILED 12: a failed renewal is not seven days past due: %', row_to_json(v_sub);
  end if;
  perform pg_temp.mb_as(u_o);
  perform pg_temp.mb_code(mail.schedule_plan_change(a_acc, 'free'), 'past_due', 'FAILED 12: scheduled while past due');
  execute 'reset role';
  perform pg_temp.mb_code(pg_temp.mb_checkout(u_o, a_acc, 'pro', true, fw_pro, 5912500), 'provider_active',
                          'FAILED 12: paid again while Flutterwave may still retry');
  perform pg_temp.mb_service(format('select mail.note_provider_canceled(%L, %L)', a_acc, (v_tx + 6)::text));
  v_c2 := pg_temp.mb_checkout(u_o, a_acc, 'pro', true, fw_pro, 5912500);
  perform pg_temp.mb_ok(v_c2, 'FAILED 12: paying a past-due subscription');
  if v_c2 ->> 'kind' <> 'pay_due' then
    raise exception 'FAILED 12: the checkout is not a payment of what is due: %', v_c2;
  end if;
  v_j := pg_temp.mb_charge(true, (v_tx + 8)::text, v_c2 ->> 'txRef', 'successful', 5912500);
  perform pg_temp.mb_outcome(v_j, 'paid', 'FAILED 12: the past-due payment');
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'active' or v_sub.plan_code <> 'pro' or v_sub.past_due_until is not null
     or v_j -> 'cancelTransactions' <> '[]'::jsonb then
    raise exception 'FAILED 12: paying again did not make the subscription active: %', row_to_json(v_sub);
  end if;
  -- No renewal a few hours after the end: past due, counted from the end.
  v_end := now() - interval '7 hours';
  update mail.subscriptions set current_period_end = v_end, current_period_start = v_end - interval '1 month'
   where account_id = a_acc;
  perform mail.billing_sweep();
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'past_due' or v_sub.past_due_reason <> 'renewal_failed' or v_sub.past_due_since <> v_end
     or v_sub.past_due_until <> v_end + interval '7 days' then
    raise exception 'FAILED 12: a missing renewal is not past due: %', row_to_json(v_sub);
  end if;
  -- A late renewal still counts, and follows on from the last month.
  perform pg_temp.mb_outcome(pg_temp.mb_charge(true, (v_tx + 9)::text, v_c2 ->> 'txRef', 'successful', 5912500),
                             'renewed', 'FAILED 12: a late renewal');
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'active' or v_sub.current_period_start <> v_end then
    raise exception 'FAILED 12: the late renewal left a gap: %', row_to_json(v_sub);
  end if;
  -- Past due beyond its grace: Free.
  update mail.subscriptions
     set status = 'past_due', past_due_reason = 'renewal_failed', past_due_since = now() - interval '8 days',
         past_due_until = now() - interval '1 minute'
   where account_id = a_acc;
  perform mail.billing_sweep();
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'ended' or v_sub.ended_reason <> 'lapsed' or (select plan_code from mail.accounts where id = a_acc) <> 'free'
     or not exists (select 1 from mail.account_audit_log where account_id = a_acc and action = 'billing.lapsed') then
    raise exception 'FAILED 12: a lapsed subscription did not drop to Free: %', row_to_json(v_sub);
  end if;
  v_passed := v_passed + 1;

  -- ── 13. A downgrade to a paid plan: at the period's end, the lower plan waits for its first payment.
  update mail.subscriptions
     set status = 'active', ended_at = null, ended_reason = null, plan_code = 'pro', price_kobo = 5500000,
         vat_bps = 750, amount_kobo = 5912500, current_period_start = now() - interval '1 month',
         current_period_end = now() - interval '1 minute', scheduled_plan_code = 'starter', scheduled_at = now(),
         provider_canceled_at = now()
   where account_id = a_acc;
  update mail.accounts set plan_code = 'pro' where id = a_acc;
  perform mail.billing_sweep();
  select * into v_sub from mail.subscriptions where account_id = a_acc;
  if v_sub.status <> 'past_due' or v_sub.past_due_reason <> 'payment_needed' or v_sub.plan_code <> 'starter'
     or v_sub.amount_kobo <> 2150000 or (select plan_code from mail.accounts where id = a_acc) <> 'starter' then
    raise exception 'FAILED 13: the paid downgrade is wrong: %', row_to_json(v_sub);
  end if;
  v_passed := v_passed + 1;

  -- ── 14. A stale checkout's payment is kept for a refund, and its subscription named for cancelling.
  v_c1 := pg_temp.mb_checkout(u_o, a_acc, 'starter', true, fw_starter, 2150000);
  perform pg_temp.mb_ok(v_c1, 'FAILED 14: a checkout to go stale');
  update mail.checkouts set created_at = now() - interval '2 days' where id = (v_c1 ->> 'checkoutId')::uuid;
  v_j := pg_temp.mb_charge(true, (v_tx + 10)::text, v_c1 ->> 'txRef', 'successful', 2150000);
  perform pg_temp.mb_outcome(v_j, 'unapplied', 'FAILED 14: a stale checkout''s payment');
  if v_j ->> 'reason' <> 'checkout_expired' or v_j -> 'cancelTransactions' <> jsonb_build_array((v_tx + 10)::text)
     or (select status from mail.checkouts where id = (v_c1 ->> 'checkoutId')::uuid) <> 'unapplied' then
    raise exception 'FAILED 14: the stale checkout''s payment is wrong: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 15. Every billing function, granted to exactly the role it names; no billing table open.
  v_expected := '{
    "billing_settings_stay":"none", "billing_rows_are_final":"none", "billing_payment_record":"none",
    "billing_keep_record_only":"none", "billing_vat":"none", "billing_period_end":"none", "billing_note":"none",
    "billing_quote":"none", "billing_issue_invoice":"none", "billing_unapplied":"none", "billing_sweep":"none",
    "billing_overview":"authenticated", "start_checkout":"authenticated", "schedule_plan_change":"authenticated",
    "keep_current_plan":"authenticated",
    "flutterwave_plan_for":"service_role", "register_flutterwave_plan":"service_role",
    "billing_provider_state":"service_role", "note_provider_canceled":"service_role",
    "note_provider_active":"service_role", "record_billing_incident":"service_role",
    "record_billing_charge":"service_role"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and p.proname in (select jsonb_object_keys(v_expected)) loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute') then
      raise exception 'FAILED 15: mail.% is anon-executable', v_row.proname;
    end if;
    if has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 15: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 15: % of % billing functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  for v_row in select c.oid, c.relname from pg_class c
                where c.relnamespace = 'mail'::regnamespace and c.relkind = 'r'
                  and c.relname in ('billing_settings', 'flutterwave_plans', 'checkouts', 'subscriptions', 'payments',
                                    'invoices', 'billing_incidents') loop
    if has_table_privilege('anon', v_row.oid, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_row.oid, 'insert, update, delete, truncate')
       or has_table_privilege('service_role', v_row.oid, 'select, insert, update, delete, truncate')
       or (has_table_privilege('authenticated', v_row.oid, 'select')
           is distinct from (v_row.relname in ('checkouts', 'invoices'))) then
      raise exception 'FAILED 15: mail.% is open to an API role', v_row.relname;
    end if;
  end loop;
  if has_sequence_privilege('service_role', 'mail.invoice_number_seq', 'usage')
     or has_sequence_privilege('authenticated', 'mail.test_invoice_number_seq', 'usage') then
    raise exception 'FAILED 15: an invoice sequence is open to an API role';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mail-billing-sweep') then
    raise exception 'FAILED 15: the sweep is not scheduled';
  end if;
  v_passed := v_passed + 1;

  -- ── 16. The e2e purge takes a test account's billing with it (migration 45).
  v_j := pg_temp.mb_service(format('select mail.e2e_purge_account(%L)', a_acc));
  perform pg_temp.mb_ok(v_j, 'FAILED 16: the e2e purge');
  if exists (select 1 from mail.payments where account_id = a_acc) or exists (select 1 from mail.invoices where account_id = a_acc)
     or exists (select 1 from mail.subscriptions where account_id = a_acc)
     or exists (select 1 from mail.checkouts where account_id = a_acc) then
    raise exception 'FAILED 16: billing rows outlived their e2e account';
  end if;
  if not exists (select 1 from mail.payments where provider_reference = (v_tx + 99)::text) then
    raise exception 'FAILED 16: the purge took a live payment';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 50: % checks passed', v_passed;
end;
$$;

rollback;
