-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 35, tried as the database owner: the registrar's default
-- nameservers are presets marked with their side — one per side, readable the
-- way customers read presets, and checked in DNS like any other. Each check
-- fails the script if it does not hold. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/registrar_default_nameservers.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_live     public.nameserver_presets;
  v_sandbox  public.nameserver_presets;
  v_count    integer;
  v_refused  boolean;
  v_passed   integer := 0;
begin
  -- 1. One default per side, seeded with its nameservers, source and verification date.
  select * into v_live from public.nameserver_presets where registrar_default_for = 'live';
  select * into v_sandbox from public.nameserver_presets where registrar_default_for = 'sandbox';
  if v_live.id is null
     or v_live.nameservers <> array['ns1.domainnameapi.com', 'ns2.domainnameapi.com']
     or v_live.source_url <> 'https://rdap.verisign.com/com/v1/domain/goldenheightsfinplc.com'
     or v_live.verified_at is null or v_live.is_hidden or v_live.assigns_per_zone
     or coalesce(v_live.notes, '') = '' then
    raise exception 'FAILED 1: the live default is %', row_to_json(v_live);
  end if;
  if v_sandbox.id is null
     or v_sandbox.nameservers <> array['tr.apiname.com', 'eu.apiname.com']
     or v_sandbox.source_url <> 'https://www.domainnameapi.com'
     or v_sandbox.verified_at is null or v_sandbox.is_hidden or v_sandbox.assigns_per_zone
     or coalesce(v_sandbox.notes, '') not like '%25 Sept 2026%' then
    raise exception 'FAILED 1: the sandbox default is %', row_to_json(v_sandbox);
  end if;
  v_passed := v_passed + 1;

  -- 2. The host presets are not defaults: every other row is null.
  if (select count(*) from public.nameserver_presets where registrar_default_for is not null) <> 2
     or exists (select 1 from public.nameserver_presets
                 where provider in ('Vercel', 'Hostinger', 'Cloudflare')
                   and registrar_default_for is not null) then
    raise exception 'FAILED 2: a host preset is marked as a registrar default';
  end if;
  v_passed := v_passed + 1;

  -- 3. Only 'live' and 'sandbox' name a side.
  v_refused := false;
  begin
    insert into public.nameserver_presets (provider, nameservers, source_url, verified_at, registrar_default_for)
    values ('M35 Staging', array['ns1.m35.test', 'ns2.m35.test'], 'https://example.com/docs', now(), 'staging');
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 3: a side other than live or sandbox was accepted';
  end if;
  v_passed := v_passed + 1;

  -- 4. At most one default per side.
  v_refused := false;
  begin
    insert into public.nameserver_presets (provider, nameservers, source_url, verified_at, registrar_default_for)
    values ('M35 Second live', array['ns1.m35.test', 'ns2.m35.test'], 'https://example.com/docs', now(), 'live');
  exception when unique_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 4: a second live default was accepted';
  end if;
  v_passed := v_passed + 1;

  -- 5. …while host presets, all null, are not limited by it.
  insert into public.nameserver_presets (provider, nameservers, source_url, verified_at)
  values ('M35 Host A', array['ns1.m35a.test', 'ns2.m35a.test'], 'https://example.com/docs', now()),
         ('M35 Host B', array['ns1.m35b.test', 'ns2.m35b.test'], 'https://example.com/docs', now());
  v_passed := v_passed + 1;

  -- 6. A default is a fixed pair, never "your provider assigns them".
  v_refused := false;
  begin
    update public.nameserver_presets set assigns_per_zone = true where id = v_sandbox.id;
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAILED 6: a registrar default was marked as assigned per zone';
  end if;
  v_passed := v_passed + 1;

  -- 7. Customers read the defaults and the new column the way they read presets —
  --    anon (the cached, cookie-free reads) and signed-in alike.
  if not has_column_privilege('anon', 'public.nameserver_presets', 'registrar_default_for', 'select')
     or not has_column_privilege('authenticated', 'public.nameserver_presets', 'registrar_default_for', 'select')
     or has_table_privilege('anon', 'public.nameserver_presets', 'update')
     or has_table_privilege('authenticated', 'public.nameserver_presets', 'insert') then
    raise exception 'FAILED 7: column or table privileges are wrong';
  end if;
  execute 'set local role anon';
  select count(*) into v_count from public.nameserver_presets where registrar_default_for is not null;
  execute 'reset role';
  if v_count <> 2 then
    raise exception 'FAILED 7: anon sees % registrar defaults', v_count;
  end if;
  execute 'set local role authenticated';
  select count(*) into v_count from public.nameserver_presets where registrar_default_for = 'live';
  execute 'reset role';
  if v_count <> 1 then
    raise exception 'FAILED 7: a signed-in user sees % live defaults', v_count;
  end if;
  v_passed := v_passed + 1;

  -- 8. The same policy hides a hidden one: the form then offers no default.
  update public.nameserver_presets set is_hidden = true where id = v_sandbox.id;
  execute 'set local role anon';
  select count(*) into v_count from public.nameserver_presets where registrar_default_for = 'sandbox';
  execute 'reset role';
  if v_count <> 0 then
    raise exception 'FAILED 8: a hidden registrar default is still readable';
  end if;
  update public.nameserver_presets set is_hidden = false where id = v_sandbox.id;
  v_passed := v_passed + 1;

  -- 9. FR-D2: the gateway looks the defaults up in public DNS like any preset.
  if (select count(*) from public.presets_for_check() p
       where p.preset_id in (v_live.id, v_sandbox.id)) <> 2 then
    raise exception 'FAILED 9: a registrar default is not due a DNS check';
  end if;
  v_passed := v_passed + 1;

  raise notice 'registrar default nameservers: % checks passed', v_passed;
end;
$$;

rollback;
