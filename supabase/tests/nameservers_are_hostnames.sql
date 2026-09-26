-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 36, tried as the database owner: nothing but lower-case
-- hostnames can be stored as nameservers, in any column. Each check fails the
-- script if it does not hold. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/nameservers_are_hostnames.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user   uuid := extensions.gen_random_uuid();
  v_tag    text := left(extensions.gen_random_uuid()::text, 8);
  v_domain uuid;
  v_passed integer := 0;
  v_refused boolean;
begin
  -- 1. The function: hostnames and null pass; everything the bug wrote does not.
  if not public.are_hostnames(array['ns1.example.com', 'kelly.ns.cloudflare.com'])
     or not public.are_hostnames(null)
     or public.are_hostnames(array['[object object]', '[object object]'])
     or public.are_hostnames(array['NS1.EXAMPLE.COM'])
     or public.are_hostnames(array['ns1.example.com.'])
     or public.are_hostnames(array['localhost'])
     or public.are_hostnames(array['ns1.example.com', null])
     or public.are_hostnames(array['-ns.example.com']) then
    raise exception 'FAILED 1: are_hostnames judged wrongly';
  end if;
  v_passed := v_passed + 1;

  -- 2. Nothing stored anywhere breaks the rule now.
  if exists (select 1 from public.domains
              where not public.are_hostnames(nameservers)
                 or not public.are_hostnames(pending_nameservers)
                 or not public.are_hostnames(previous_nameservers)) then
    raise exception 'FAILED 2: a domain still holds a non-hostname';
  end if;
  v_passed := v_passed + 1;

  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'e2e-sql-m36-' || v_user || '@example.com', now(), now());
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, nameservers)
  values (v_user, 'm36-' || v_tag || '.com', 'com', 'demo', true, 'active', array['ns1.example.com', 'ns2.example.com'])
  returning id into v_domain;

  -- 3. Each nameserver column of domains refuses "[object object]".
  foreach v_tag in array array['nameservers', 'pending_nameservers', 'previous_nameservers'] loop
    begin
      execute format('update public.domains set %I = %L where id = %L',
                     v_tag, array['[object object]', '[object object]'], v_domain);
      v_refused := false;
    exception when check_violation then
      v_refused := true;
    end;
    if not v_refused then
      raise exception 'FAILED 3: domains.% took "[object object]"', v_tag;
    end if;
  end loop;
  v_passed := v_passed + 1;

  -- 4. A real change still goes through, and its history row with it.
  update public.domains set nameservers = array['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] where id = v_domain;
  if (select previous_nameservers from public.domains where id = v_domain)
     is distinct from array['ns1.example.com', 'ns2.example.com'] then
    raise exception 'FAILED 4: a valid change did not record its previous set';
  end if;
  v_passed := v_passed + 1;

  -- 5. The history, orders, order lines and presets refuse it too.
  begin
    insert into public.domain_nameserver_history (domain_id, before, after)
    values (v_domain, array['ns1.example.com'], array['[object object]']);
    raise exception 'FAILED 5: history took "[object object]"';
  exception when check_violation then null;
  end;
  begin
    update public.nameserver_presets set nameservers = array['[object object]', 'x.example.com']
     where id = (select id from public.nameserver_presets where not assigns_per_zone limit 1);
    raise exception 'FAILED 5: a preset took "[object object]"';
  exception when check_violation then null;
  end;
  if not exists (select 1 from pg_constraint where conname = 'orders_nameservers_are_hostnames')
     or not exists (select 1 from pg_constraint where conname = 'order_items_nameservers_are_hostnames') then
    raise exception 'FAILED 5: orders or order lines are not guarded';
  end if;
  v_passed := v_passed + 1;

  raise notice 'nameservers are hostnames: % checks passed', v_passed;
end;
$$;

rollback;
