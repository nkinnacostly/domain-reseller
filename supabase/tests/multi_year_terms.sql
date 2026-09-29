-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 37, tried as the database owner: the catalogue stores the periods
-- an extension is sold for, refuses a list no registry could sell, keeps
-- min_period and max_period in step with it, reads a row without periods as
-- before, and an order line — and its receipt email — says the term its
-- renewal price is for. Each check fails the script if it does not hold.
-- Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/multi_year_terms.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := extensions.gen_random_uuid();
  v_rate     uuid := (select id from public.fx_rates limit 1);
  v_tag      text := left(extensions.gen_random_uuid()::text, 8);
  v_blocks   text;
  v_yearly   text;
  v_order    uuid;
  v_row      public.email_outbox;
  v_bad      text;
  v_refused  boolean;
  v_seen     integer;
  v_passed   integer := 0;
begin
  if v_rate is null then
    raise exception 'needs one fx rate to build test rows';
  end if;
  v_blocks := 'm37blocks' || v_tag;
  v_yearly := 'm37yearly' || v_tag;

  -- 1. Every stored row is a list a registry can sell, or none — and agrees with min and max.
  if exists (select 1 from public.tlds
              where not public.are_sold_periods(register_periods)
                 or not public.are_sold_periods(renew_periods)
                 or (register_periods is not null
                     and (min_period <> register_periods[1]
                          or max_period <> register_periods[cardinality(register_periods)]))) then
    raise exception 'FAILED 1: a stored row has periods no registry sells';
  end if;
  v_passed := v_passed + 1;

  -- 2. An extension sold in blocks, as the sync writes .ai; and one with no periods, as before.
  insert into public.tlds (name, register_usd, renew_usd, transfer_usd, min_period, max_period,
                           register_periods, renew_periods, redemption_days)
  values (v_blocks, 99.9, 99.9, 99.9, 2, 10, '{2,4,6,8,10}', '{2,4,6,8,10}', 30),
         (v_yearly, 11.31, 11.51, 11.51, 1, 10, null, null, 30);
  if (select register_periods from public.tlds where name = v_blocks) <> '{2,4,6,8,10}'::smallint[]
     or (select register_periods from public.tlds where name = v_yearly) is not null then
    raise exception 'FAILED 2: periods were not stored as written';
  end if;
  v_passed := v_passed + 1;

  -- 3. A list no registry could sell is refused, in either column.
  foreach v_bad in array array['{}', '{0}', '{11}', '{4,2}', '{2,2}', '{2,NULL}', '{{2},{4}}',
                               '[0:1]={2,4}', '{1,2,3,4,5,6,7,8,9,10,10}'] loop
    begin
      update public.tlds set renew_periods = v_bad::smallint[] where name = v_blocks;
      v_refused := false;
    exception when check_violation then
      v_refused := true;
    end;
    if not v_refused then
      raise exception 'FAILED 3: renew_periods took %', v_bad;
    end if;
    begin
      update public.tlds set register_periods = v_bad::smallint[] where name = v_yearly;
      v_refused := false;
    exception when check_violation then
      v_refused := true;
    end;
    if not v_refused then
      raise exception 'FAILED 3: register_periods took %', v_bad;
    end if;
  end loop;
  v_passed := v_passed + 1;

  -- 4. min_period and max_period are the first and last period sold.
  begin
    update public.tlds set min_period = 1 where name = v_blocks;
    raise exception 'FAILED 4: min_period left the periods';
  exception when check_violation then null;
  end;
  begin
    update public.tlds set register_periods = '{2,4,6,8}' where name = v_blocks;
    raise exception 'FAILED 4: max_period left the periods';
  exception when check_violation then null;
  end;
  update public.tlds set register_periods = '{1,2,3}', min_period = 1, max_period = 3
   where name = v_yearly;
  update public.tlds set register_periods = null, max_period = 10 where name = v_yearly;
  v_passed := v_passed + 1;

  -- 5. RLS unchanged: anyone reads a sellable extension's periods, never a paused one's.
  update public.tlds set is_paused = true where name = v_yearly;
  execute 'set local role anon';
  select count(*) into v_seen from public.tlds
   where name in (v_blocks, v_yearly) and register_periods = '{2,4,6,8,10}';
  if v_seen <> 1 or exists (select 1 from public.tlds where name = v_yearly) then
    execute 'reset role';
    raise exception 'FAILED 5: anon saw % rows', v_seen;
  end if;
  execute 'reset role';
  update public.tlds set is_paused = false where name = v_yearly;
  v_passed := v_passed + 1;

  -- 6. An order line records the term its renewal price is for: a year unless
  --    it says otherwise, never none, never beyond ten years.
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'e2e-sql-m37-' || v_user || '@example.com', now(), now());
  insert into public.orders (user_id, subtotal_kobo, vat_pct, vat_kobo, total_kobo, fx_rate_id,
                             tx_ref, registrant, float_check, test_mode)
  values (v_user, 30000000, 7.5, 2250000, 32250000, v_rate, 'MDH-m37-' || v_tag, '{}', 'covered', true)
  returning id into v_order;
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo,
                                  renewal_kobo, renewal_years, privacy, auto_renew)
  values (v_order, 'a-' || v_tag || '.' || v_blocks, v_blocks, 'register', 2, 27300000, 13650000, 2, false, false);
  insert into public.order_items (order_id, domain, tld, item_type, period_years, price_kobo, renewal_kobo, privacy, auto_renew)
  values (v_order, 'b-' || v_tag || '.' || v_yearly, v_yearly, 'register', 1, 1830000, 1860000, false, false);
  if (select renewal_years from public.order_items where order_id = v_order and tld = v_yearly) <> 1 then
    raise exception 'FAILED 6: a line without a term is not a year';
  end if;
  foreach v_seen in array array[0, 11] loop
    begin
      update public.order_items set renewal_years = v_seen where order_id = v_order and tld = v_yearly;
      raise exception 'FAILED 6: renewal_years took %', v_seen;
    exception when check_violation then null;
    end;
  end loop;
  v_passed := v_passed + 1;

  -- 7. The receipt email says each line's renewal term (N8).
  update public.orders set invoice_number = 'TEST-INV-m37-' || v_tag, paid_at = now() where id = v_order;
  select * into v_row from public.email_outbox where order_id = v_order and kind = 'order_receipt';
  if v_row.id is null
     or (select jsonb_object_agg(split_part(l ->> 'domain', '-', 1), (l ->> 'renewal_years')::int)
           from jsonb_array_elements(v_row.data -> 'lines') l)
        <> jsonb_build_object('a', 2, 'b', 1)
     or (v_row.data -> 'lines' -> 0 ->> 'renewal_kobo')::bigint <> 13650000 then
    raise exception 'FAILED 7: receipt lines %', v_row.data -> 'lines';
  end if;
  v_passed := v_passed + 1;

  -- 8. The trigger's function stays out of everyone's reach.
  if has_function_privilege('authenticated', 'public.email_for_paid_order()', 'execute')
     or has_function_privilege('service_role', 'public.email_for_paid_order()', 'execute') then
    raise exception 'FAILED 8: the receipt trigger function is callable';
  end if;
  v_passed := v_passed + 1;

  raise notice 'multi-year terms: % checks passed', v_passed;
end;
$$;

rollback;
