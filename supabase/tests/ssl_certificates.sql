-- ─────────────────────────────────────────────────────────────────────────────
-- Migrations 38–39, tried as the database owner: a paid SSL line becomes a
-- certificate and an order job in the payment's transaction; the job is
-- claimed with its charge, notes a send once, and completes, refuses or is
-- held as the queue's other jobs are; a second certificate for a name is
-- refused before anything is bought; the customer's set-up and reissue go
-- through the queue; a private key is never stored; people read only their
-- own certificates; a refused order is refunded with reason ssl_failed.
-- Each check fails the script if it does not hold. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/ssl_certificates.sql
--
-- Only test orders are paid here: an invoice sequence does not roll back.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := extensions.gen_random_uuid();
  v_other    uuid := extensions.gen_random_uuid();
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_tag      text := left(extensions.gen_random_uuid()::text, 8);
  v_name     text;
  v_csr      text := E'-----BEGIN CERTIFICATE REQUEST-----\nMIICozCCAYsCAQAwXjELMAkGA1UEBhMCTkcxDjAMBgNVBAgMBUxhZ29zMQ4wDAYD\n-----END CERTIFICATE REQUEST-----';
  v_contact  jsonb := '{"firstName":"Ada","lastName":"Okafor","email":"ada@example.com","phoneCountryCode":"234","phone":"8031234567","addressLine1":"12 Admiralty Way","city":"Lagos","state":"Lagos","zipCode":"100001","country":"NG"}';
  v_cart     uuid;
  v_order    uuid;
  v_order2   uuid;
  v_line     uuid;
  v_cert     public.ssl_certificates;
  v_cert2    uuid;
  v_job      uuid;
  v_claim    jsonb;
  v_at       timestamptz;
  v_again    timestamptz;
  v_state    text;
  v_count    integer;
  v_refused  boolean;
  v_passed   integer := 0;
begin
  if v_rate is null then
    raise exception 'needs one fx rate to build test rows';
  end if;
  v_name := 'm39-' || v_tag || '.com';

  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'e2e-sql-m39-' || v_user || '@example.com', now(), now()),
         (v_other, 'authenticated', 'authenticated', 'e2e-sql-m39-' || v_other || '@example.com', now(), now());

  -- The owner's three products are there to be sold, unpriced until the sync writes them.
  if (select count(*) from public.ssl_products
       where product_code in ('351', '352', '371') and is_sellable) <> 3 then
    raise exception 'FAILED 0: the three products are not marked for sale';
  end if;
  update public.ssl_products
     set name = 'Sectigo PositiveSSL Certificate', vendor = 'Sectigo', validation_type = 'DV',
         is_wildcard = false, is_multi_domain = false, included_names = 1, max_names = 1,
         is_reissue_free = true, requires_csr = true, create_usd = 6.99, synced_at = now()
   where product_code = '351';
  v_passed := v_passed + 1;

  -- 1. A cart holds a domain and a certificate for the same name.
  insert into public.carts (user_id) values (v_user) returning id into v_cart;
  insert into public.cart_items (cart_id, domain, tld, period_years, quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id)
  values (v_cart, v_name, 'com', 1, 1800000, 1800000, v_rate);
  insert into public.cart_ssl_items (cart_id, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id)
  values (v_cart, '351', v_name, 1350000, v_rate);
  begin
    insert into public.cart_ssl_items (cart_id, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id)
    values (v_cart, '351', 'Not A Name', 1350000, v_rate);
    v_refused := false;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 1: a cart took a certificate for something that is not a name';
  end if;
  v_passed := v_passed + 1;

  -- 2. Paid: one certificate and one queued order job per SSL line, in the same
  --    transaction; the cart line goes; the receipt names the product.
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 3150000, 7.5, 236250, 3386250, v_rate, 'MDH-m39-' || v_tag, v_contact, 'covered', true)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, ssl_product_code)
  values (v_order, v_name, 'com', 'register', 1, 1800000, 1800000, false, false, null),
         (v_order, v_name, 'com', 'ssl', 1, 1350000, 1350000, false, false, '351');
  begin
    insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                    privacy, auto_renew)
    values (v_order, 'x' || v_name, 'com', 'ssl', 1, 1, 1, false, false);
    v_refused := false;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 2: an SSL line without a product was accepted';
  end if;

  perform public.record_order_payment(v_order, 'm39-' || v_tag, 3386250, 'NGN', 'card', '{}'::jsonb);
  select oi.id into v_line from public.order_items oi where oi.order_id = v_order and oi.item_type = 'ssl';
  select * into v_cert from public.ssl_certificates where order_item_id = v_line;
  if v_cert.id is null or v_cert.status <> 'pending' or v_cert.common_name <> v_name
     or v_cert.product_name <> 'Sectigo PositiveSSL Certificate' or not v_cert.test_mode
     or v_cert.user_id <> v_user then
    raise exception 'FAILED 2: no pending certificate for the paid line';
  end if;
  if (select count(*) from public.ssl_jobs
       where certificate_id = v_cert.id and kind = 'ssl_initialize' and status = 'queued' and test_mode) <> 1 then
    raise exception 'FAILED 2: expected one queued order job';
  end if;
  if exists (select 1 from public.cart_ssl_items where cart_id = v_cart) then
    raise exception 'FAILED 2: the bought certificate is still in the cart';
  end if;
  if not exists (select 1 from public.email_outbox
                  where order_id = v_order and kind = 'order_receipt'
                    and data -> 'lines' @> jsonb_build_array(jsonb_build_object(
                          'kind', 'ssl', 'product', 'Sectigo PositiveSSL Certificate'))) then
    raise exception 'FAILED 2: the receipt email does not name the certificate';
  end if;
  -- The domain line was not counted as a certificate, nor the certificate as a domain.
  if (select count(*) from public.domains where order_item_id in (select id from public.order_items where order_id = v_order)) <> 1
     or (select count(*) from public.ssl_certificates c join public.order_items oi on oi.id = c.order_item_id
          where oi.order_id = v_order) <> 1 then
    raise exception 'FAILED 2: lines became the wrong things';
  end if;
  v_passed := v_passed + 1;

  -- 3. The claim carries the charge to confirm, and marks the line in hand.
  v_claim := public.claim_ssl_job('m39-check', true, 300,
               (select id from public.ssl_jobs where certificate_id = v_cert.id));
  if v_claim ->> 'certificate_id' <> v_cert.id::text or v_claim ->> 'kind' <> 'ssl_initialize'
     or (v_claim -> 'payment' ->> 'reference') <> 'm39-' || v_tag
     or (v_claim -> 'payment' ->> 'order_tx_ref') <> 'MDH-m39-' || v_tag
     or (v_claim ->> 'name_taken')::boolean
     or (v_claim ->> 'sent_at') is not null then
    raise exception 'FAILED 3: claim was %', v_claim;
  end if;
  v_job := (v_claim ->> 'id')::uuid;
  if (select status from public.order_items where id = v_line) <> 'provisioning' then
    raise exception 'FAILED 3: the line is not in hand';
  end if;
  v_passed := v_passed + 1;

  -- 4. The send is noted once (N3): a second note keeps the first time.
  v_at := public.note_ssl_job_sent(v_job);
  perform pg_sleep(0.01);
  v_again := public.note_ssl_job_sent(v_job);
  if v_at is null or v_again <> v_at then
    raise exception 'FAILED 4: sent_at moved from % to %', v_at, v_again;
  end if;
  v_passed := v_passed + 1;

  -- 5. Bought: the certificate waits for its set-up, the line is done, the
  --    customer is told; doing it twice changes nothing.
  perform public.complete_ssl_initialize(v_job, extensions.gen_random_uuid(), 'WaitingForInstall',
                                         now(), now() + interval '1 year', false);
  perform public.complete_ssl_initialize(v_job, null, 'WaitingForInstall', null, null, false);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_cert.status <> 'awaiting_setup' or v_cert.supplier_certificate_id is null
     or v_cert.subscription_ends_at is null
     or (select status from public.order_items where id = v_line) <> 'completed'
     or (select status from public.ssl_jobs where id = v_job) <> 'succeeded' then
    raise exception 'FAILED 5: the order did not complete';
  end if;
  if (select count(*) from public.email_outbox where kind = 'ssl_ready' and user_id = v_user) <> 1 then
    raise exception 'FAILED 5: expected one set-up email';
  end if;
  -- The domain line is still pending, so the order is not settled yet.
  if (select status from public.orders where id = v_order) not in ('paid', 'provisioning') then
    raise exception 'FAILED 5: the order settled before its domain';
  end if;
  v_passed := v_passed + 1;

  -- 6. Only its owner can ask for a set-up, never with a private key, and only once at a time.
  begin
    perform public.request_ssl_setup(v_other, v_cert.id, v_csr, 'admin@' || v_name, 'apache', '{}', v_contact);
    v_refused := false;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 6: another account set up this certificate';
  end if;
  begin
    perform public.request_ssl_setup(v_user, v_cert.id,
      v_csr || E'\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      'admin@' || v_name, 'apache', '{}', v_contact);
    v_refused := false;
  exception when invalid_parameter_value then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 6: a private key was accepted with the CSR';
  end if;
  begin
    perform public.request_ssl_setup(v_user, v_cert.id, v_csr, 'admin@' || v_name, 'apache',
                                     array['www.' || v_name], v_contact);
    v_refused := false;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 6: a single-name certificate took an extra name';
  end if;
  v_job := public.request_ssl_setup(v_user, v_cert.id, v_csr, 'Admin@' || v_name, 'apache', '{}', v_contact);
  begin
    perform public.request_ssl_setup(v_user, v_cert.id, v_csr, 'admin@' || v_name, 'apache', '{}', v_contact);
    v_refused := false;
  exception when object_not_in_prerequisite_state then
    v_refused := true;
  end;
  if not v_refused
     or (select status from public.ssl_certificates where id = v_cert.id) <> 'setting_up'
     or (select approver_email from public.ssl_certificates where id = v_cert.id) <> 'admin@' || v_name
     or (select count(*) from public.ssl_jobs where certificate_id = v_cert.id and kind = 'ssl_configure') <> 1 then
    raise exception 'FAILED 6: the set-up was not queued exactly once';
  end if;
  v_passed := v_passed + 1;

  -- 7. A set-up the supplier refuses goes back to the customer with our code;
  --    the next one is a new job, and once taken the CA waits on the approver.
  v_claim := public.claim_ssl_job('m39-check', true, 300, v_job);
  if v_claim ->> 'csr' <> v_csr or v_claim ->> 'approver_email' <> 'admin@' || v_name
     or v_claim -> 'contact' ->> 'city' <> 'Lagos' or v_claim -> 'payment' is distinct from 'null'::jsonb then
    raise exception 'FAILED 7: set-up claim was %', v_claim;
  end if;
  perform public.refuse_ssl_setup(v_job, 'CSR_NAME_MISMATCH', 'e2e');
  if (select status from public.ssl_certificates where id = v_cert.id) <> 'awaiting_setup'
     or (select last_error_code from public.ssl_certificates where id = v_cert.id) <> 'CSR_NAME_MISMATCH' then
    raise exception 'FAILED 7: a refused set-up did not come back to the customer';
  end if;
  v_job := public.request_ssl_setup(v_user, v_cert.id, v_csr, 'admin@' || v_name, 'iis', '{}', v_contact);
  perform public.claim_ssl_job('m39-check', true, 300, v_job);
  perform public.record_ssl_configured(v_job, 'WaitingForValidation', false);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_cert.status <> 'awaiting_validation' or v_cert.configured_at is null
     or v_cert.last_error_code is not null or v_cert.web_server <> 'iis' then
    raise exception 'FAILED 7: the set-up was not recorded';
  end if;
  v_passed := v_passed + 1;

  -- 8. A supplier word we do not know changes nothing but the record of it.
  v_state := public.record_ssl_status(v_cert.id, 'SomethingNew', null, null, null, null, null, 600);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_state <> 'awaiting_validation' or v_cert.status <> 'awaiting_validation'
     or v_cert.supplier_status <> 'SomethingNew' or v_cert.status_unrecognised_since is null then
    raise exception 'FAILED 8: an unknown word moved the certificate';
  end if;
  v_passed := v_passed + 1;

  -- 9. Issued: the dates and the certificate are kept, and the customer is told once.
  perform public.record_ssl_status(v_cert.id, 'Active', 'issued', now(), now() + interval '199 days',
    E'-----BEGIN CERTIFICATE-----\nMIIF\n-----END CERTIFICATE-----', '', 3600);
  perform public.record_ssl_status(v_cert.id, 'Active', 'issued', null, null, '', '', 3600);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_cert.status <> 'issued' or v_cert.expires_at is null or v_cert.certificate_pem is null
     or v_cert.ca_bundle_pem is not null or v_cert.status_unrecognised_since is not null then
    raise exception 'FAILED 9: the issued certificate was not kept';
  end if;
  if (select count(*) from public.email_outbox where kind = 'ssl_issued' and user_id = v_user) <> 1 then
    raise exception 'FAILED 9: expected one issued email';
  end if;
  v_passed := v_passed + 1;

  -- 10. A private key is never stored, wherever it is put (N13).
  begin
    update public.ssl_certificates
       set certificate_pem = E'-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'
     where id = v_cert.id;
    v_refused := false;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 10: a private key was stored';
  end if;
  v_passed := v_passed + 1;

  -- 11. A reissue is the customer's to ask for once issued, and goes through the queue.
  begin
    perform public.request_ssl_reissue(v_other, v_cert.id);
    v_refused := false;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 11: another account reissued this certificate';
  end if;
  v_job := public.request_ssl_reissue(v_user, v_cert.id);
  perform public.claim_ssl_job('m39-check', true, 300, v_job);
  perform public.note_ssl_job_sent(v_job);
  perform public.record_ssl_reissue(v_job, 'WaitingForValidation', 'awaiting_validation', false);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_cert.status <> 'awaiting_validation' or v_cert.reissue_count <> 1 then
    raise exception 'FAILED 11: the reissue was not recorded';
  end if;
  -- Issued again with no text yet: the old certificate is not passed off as
  -- the new one, so the poller keeps asking; and the customer is told again.
  perform public.record_ssl_status(v_cert.id, 'Active', 'issued', null, null, '', '', 3600);
  select * into v_cert from public.ssl_certificates where id = v_cert.id;
  if v_cert.status <> 'issued' or v_cert.certificate_pem is not null then
    raise exception 'FAILED 11: a reissued certificate kept its old text';
  end if;
  if (select count(*) from public.email_outbox where kind = 'ssl_issued' and user_id = v_user) <> 2 then
    raise exception 'FAILED 11: the reissued certificate was not announced';
  end if;
  v_passed := v_passed + 1;

  -- 12. A second certificate for a name we hold is refused before anything is
  --     bought; checkout's own test agrees.
  if not public.ssl_name_in_use(upper(v_name), true) or public.ssl_name_in_use(v_name, false)
     or public.ssl_name_in_use('free-' || v_name, true) then
    raise exception 'FAILED 12: ssl_name_in_use is wrong';
  end if;
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_other, 1350000, 7.5, 101250, 1451250, v_rate, 'MDH-m39b-' || v_tag, v_contact, 'covered', true)
  returning id into v_order2;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo,
                                  privacy, auto_renew, ssl_product_code)
  values (v_order2, v_name, 'com', 'ssl', 1, 1350000, 1350000, false, false, '351');
  perform public.record_order_payment(v_order2, 'm39b-' || v_tag, 1451250, 'NGN', 'card', '{}'::jsonb);
  select c.id into v_cert2 from public.ssl_certificates c
    join public.order_items oi on oi.id = c.order_item_id where oi.order_id = v_order2;
  v_claim := public.claim_ssl_job('m39-check', true, 300,
               (select id from public.ssl_jobs where certificate_id = v_cert2));
  if not (v_claim ->> 'name_taken')::boolean then
    raise exception 'FAILED 12: a held name was not reported as taken';
  end if;
  v_job := (v_claim ->> 'id')::uuid;
  -- Bought anyway, it could not be recorded beside the first.
  begin
    perform public.complete_ssl_initialize(v_job, null, 'WaitingForInstall', now(), null, false);
    v_refused := false;
  exception when unique_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 12: two bought certificates for one name';
  end if;
  v_passed := v_passed + 1;

  -- 13. Held for a person: no refund, no change to the line; and the alert says so.
  perform public.fail_ssl_job(v_job, 'UNKNOWN_OUTCOME', 'e2e', true);
  if (select status from public.ssl_jobs where id = v_job) <> 'needs_attention'
     or (select status from public.order_items where order_id = v_order2) <> 'provisioning'
     or exists (select 1 from public.refunds where order_id = v_order2)
     or not exists (select 1 from public.current_alert_conditions(true) a
                     where a.key = 'ssl_job:' || v_job and a.kind = 'ssl_job_needs_attention') then
    raise exception 'FAILED 13: a held job was not held, or not raised';
  end if;
  v_passed := v_passed + 1;

  -- 14. Refused: the line fails, the customer is told, and the refund is
  --     queued as ssl_failed. That needs migration 38 committed: checked
  --     before 38 is applied, this step reports itself skipped.
  begin
    perform public.retry_ssl_job(v_job);
    perform public.claim_ssl_job('m39-check', true, 300, v_job);
    perform public.fail_ssl_job(v_job, 'NAME_HAS_CERTIFICATE', 'e2e', false);
    if (select status from public.ssl_certificates where id = v_cert2) <> 'failed'
       or (select status from public.order_items where order_id = v_order2) <> 'failed'
       or (select status from public.orders where id = v_order2) <> 'failed'
       or (select reason::text from public.refunds where order_id = v_order2) <> 'ssl_failed'
       or (select amount_kobo from public.refunds where order_id = v_order2) <> 1451250
       or not exists (select 1 from public.email_outbox
                       where kind = 'order_line_failed' and user_id = v_other
                         and data ->> 'action' = 'certificate') then
      raise exception 'FAILED 14: a refused order was not failed and refunded';
    end if;
    -- A person retrying it stops the refund that has not left yet.
    perform public.retry_ssl_job(v_job);
    if (select status from public.refunds where order_id = v_order2) <> 'cancelled'
       or (select status from public.ssl_certificates where id = v_cert2) <> 'pending'
       or (select status from public.ssl_jobs where id = v_job) <> 'queued' then
      raise exception 'FAILED 14: retrying did not stop the refund';
    end if;
    v_passed := v_passed + 1;
  exception when sqlstate '55P04' then
    raise notice 'check 14 skipped: refund reason ssl_failed (migration 38) is not committed yet';
  end;

  -- 15. People read their own certificates, and nothing of the queue.
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.ssl_certificates;
  if v_count <> 1 or not exists (select 1 from public.ssl_certificates where id = v_cert2) then
    execute 'reset role';
    raise exception 'FAILED 15: another account''s certificates are visible (%)', v_count;
  end if;
  begin
    update public.ssl_certificates set status = 'issued' where id = v_cert2;
    v_refused := false;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  begin
    perform 1 from public.ssl_jobs limit 1;
    execute 'reset role';
    raise exception 'FAILED 15: the queue is readable';
  exception when insufficient_privilege then
    null;
  end;
  execute 'reset role';
  if not v_refused then
    raise exception 'FAILED 15: a certificate was writable by its owner';
  end if;
  v_passed := v_passed + 1;

  -- 16. Signing in brings an anonymous cart's certificates across.
  insert into public.carts (anon_token_hash) values (repeat('a', 63) || '9') returning id into v_cart;
  insert into public.cart_ssl_items (cart_id, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id)
  values (v_cart, '351', 'anon-' || v_name, 1350000, v_rate);
  perform public.merge_anonymous_cart(repeat('a', 63) || '9', v_other);
  if not exists (select 1 from public.cart_ssl_items ci join public.carts c on c.id = ci.cart_id
                  where c.user_id = v_other and ci.common_name = 'anon-' || v_name) then
    raise exception 'FAILED 16: the certificate stayed in the anonymous cart';
  end if;
  v_passed := v_passed + 1;

  -- 17. The queue's functions are the service's alone.
  if has_function_privilege('authenticated', 'public.claim_ssl_job(text, boolean, integer, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.request_ssl_setup(uuid, uuid, text, text, text, text[], jsonb)', 'execute')
     or has_function_privilege('anon', 'public.ssl_name_in_use(text, boolean)', 'execute')
     or has_function_privilege('authenticated',
          'public.record_ssl_status(uuid, text, text, timestamptz, timestamptz, text, text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.fail_ssl_job(uuid, text, text, boolean)', 'execute') then
    raise exception 'FAILED 17: an SSL function is open to the wrong role';
  end if;
  v_passed := v_passed + 1;

  raise notice 'ssl certificates: % checks passed', v_passed;
end;
$$;

select 'ssl certificates hold' as result;
rollback;
