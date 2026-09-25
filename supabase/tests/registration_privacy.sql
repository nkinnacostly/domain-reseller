-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 33, tried as the database owner: a registration recorded with
-- privacy on, against the customer's choice at checkout, queues the change
-- back — and nothing else does. Each check fails the script if it does not
-- hold. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/registration_privacy.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user    uuid := extensions.gen_random_uuid();
  v_rate    uuid := (select id from public.fx_rates limit 1);
  v_tag     text := left(extensions.gen_random_uuid()::text, 8);
  v_order   uuid;
  v_domain  uuid;
  v_passed  integer := 0;
begin
  if v_rate is null then
    raise exception 'needs one fx rate to build test rows';
  end if;
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'e2e-sql-m33-' || v_user || '@example.com', now(), now());
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 100000, 7.5, 7500, 107500, v_rate, 'MDH-m33-' || v_tag, '{}', 'covered', true)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'm33-off-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false),
         (v_order, 'm33-on-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, true, false),
         (v_order, 'm33-cc-' || v_tag || '.co', 'co', 'register', 1, 100000, 100000, false, false),
         (v_order, 'm33-kept-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false),
         (v_order, 'm33-back-' || v_tag || '.com', 'com', 'register', 1, 100000, 100000, false, false);
  insert into public.domains (user_id, domain_name, tld, source, test_mode, order_item_id, local_status, privacy_enabled)
  select v_user, oi.domain, oi.tld, 'registration', true, oi.id, 'pending', oi.privacy
    from public.order_items oi where oi.order_id = v_order;

  -- 1. Privacy unticked at checkout, registered with it on: the change back is queued.
  select id into v_domain from public.domains where domain_name = 'm33-off-' || v_tag || '.com';
  update public.domains set local_status = 'active', privacy_enabled = true where id = v_domain;
  if (select pending_privacy from public.domains where id = v_domain) is distinct from false then
    raise exception 'FAILED 1: pending_privacy is %', (select pending_privacy from public.domains where id = v_domain);
  end if;
  if (select count(*) from public.jobs
       where domain_id = v_domain and kind = 'set_privacy' and status = 'queued' and test_mode) <> 1 then
    raise exception 'FAILED 1: expected one queued set_privacy job';
  end if;
  if not exists (select 1 from public.domain_events
                  where domain_id = v_domain and event_type = 'privacy_requested'
                    and actor_type = 'system' and payload ->> 'to' = 'false') then
    raise exception 'FAILED 1: no system privacy_requested event';
  end if;
  v_passed := v_passed + 1;

  -- 2. Privacy chosen: nothing to change.
  select id into v_domain from public.domains where domain_name = 'm33-on-' || v_tag || '.com';
  update public.domains set local_status = 'active', privacy_enabled = true where id = v_domain;
  if exists (select 1 from public.jobs where domain_id = v_domain and kind = 'set_privacy')
     or (select pending_privacy from public.domains where id = v_domain) is not null then
    raise exception 'FAILED 2: a chosen privacy was changed';
  end if;
  v_passed := v_passed + 1;

  -- 3. A country-code extension is never offered privacy: left as the registry has it.
  select id into v_domain from public.domains where domain_name = 'm33-cc-' || v_tag || '.co';
  update public.domains set local_status = 'active', privacy_enabled = true where id = v_domain;
  if exists (select 1 from public.jobs where domain_id = v_domain and kind = 'set_privacy') then
    raise exception 'FAILED 3: a country-code domain had privacy turned off';
  end if;
  v_passed := v_passed + 1;

  -- 4. The registry already holds privacy off: nothing to change.
  select id into v_domain from public.domains where domain_name = 'm33-kept-' || v_tag || '.com';
  update public.domains set local_status = 'active', privacy_enabled = false where id = v_domain;
  if exists (select 1 from public.jobs where domain_id = v_domain and kind = 'set_privacy') then
    raise exception 'FAILED 4: a job was queued for privacy already off';
  end if;
  v_passed := v_passed + 1;

  -- 5. Not a first registration: a domain back from grace keeps what it has,
  --    including privacy the customer turned on since.
  select id into v_domain from public.domains where domain_name = 'm33-back-' || v_tag || '.com';
  update public.domains set local_status = 'expired_grace', privacy_enabled = true where id = v_domain;
  update public.domains set local_status = 'active' where id = v_domain;
  if exists (select 1 from public.jobs where domain_id = v_domain and kind = 'set_privacy') then
    raise exception 'FAILED 5: a renewal undid privacy';
  end if;
  v_passed := v_passed + 1;

  -- 6. The trigger's function is not callable by users.
  if has_function_privilege('authenticated', 'public.apply_registration_privacy_choice()', 'execute') then
    raise exception 'FAILED 6: users can execute the trigger function';
  end if;
  v_passed := v_passed + 1;

  raise notice 'registration privacy: % checks passed', v_passed;
end;
$$;

rollback;
