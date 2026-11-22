-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 71, tried as the database owner on the test side: a domain whose
-- registry checks are paused records nothing from the hourly reconcile or the
-- deep sync — no update, no event, no drift — while an unpaused one does, and
-- the registry's entry for a paused name is never an unknown domain. Each
-- check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/registry_checks_paused.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_owner  uuid := gen_random_uuid();
  d_paused uuid;
  d_live   uuid;
  n_paused text := 'm71-p-' || v_tag || '.com';
  n_live   text := 'm71-l-' || v_tag || '.com';
  v_run    uuid;
  v_d      public.domains;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (u_owner, 'authenticated', 'authenticated', 'e2e-m71-' || v_tag || '@example.com', now(), now());
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, expires_at,
                              registry_status, registry_checks_paused_at, registry_checks_paused_note)
  values (u_owner, n_paused, 'com', 'registration', true, 'active', '2027-01-01', 'PendingHold',
          now(), 'm71: on hold at the registry, paused')
  returning id into d_paused;
  insert into public.domains (user_id, domain_name, tld, source, test_mode, local_status, expires_at, registry_status)
  values (u_owner, n_live, 'com', 'registration', true, 'active', '2027-01-01', 'Active')
  returning id into d_live;

  -- ── 1. A note without a time, or a time without a note, is refused.
  begin
    update public.domains set registry_checks_paused_note = null where id = d_paused;
    raise exception 'FAILED 1: a pause without its note';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 2. The reconcile: the paused domain keeps its facts and gets no event or drift; the other is recorded.
  -- A run of our own, the test side's open runs closed first (rolled back).
  update public.reconcile_runs set finished_at = now() where test_mode and finished_at is null;
  insert into public.reconcile_runs (test_mode) values (true) returning id into v_run;
  perform public.record_reconciliation(v_run,
    jsonb_build_array(
      jsonb_build_object('domain_id', d_paused, 'registry_status', 'Active', 'renewal_mode', 'AutoRenew',
                         'expires_at', '2028-01-01T00:00:00Z',
                         'events', jsonb_build_array(jsonb_build_object('type', 'registry_expiry_changed'))),
      jsonb_build_object('domain_id', d_live, 'registry_status', 'PendingHold', 'renewal_mode', 'AutoRenew',
                         'expires_at', '2028-01-01T00:00:00Z', 'events', '[]'::jsonb)),
    jsonb_build_array(
      jsonb_build_object('domain_id', d_paused, 'domain_name', n_paused, 'kind', 'status_mismatch', 'detail', '{}'::jsonb),
      jsonb_build_object('domain_id', null, 'domain_name', upper(n_paused), 'kind', 'missing_at_registry', 'detail', '{}'::jsonb),
      jsonb_build_object('domain_id', d_live, 'domain_name', n_live, 'kind', 'status_mismatch', 'detail', '{}'::jsonb)),
    true, 2);
  select * into v_d from public.domains where id = d_paused;
  if v_d.registry_status is distinct from 'PendingHold' or v_d.expires_at is distinct from '2027-01-01'::timestamptz
     or v_d.registry_checked_at is not null
     or exists (select 1 from public.domain_events e where e.domain_id = d_paused)
     or exists (select 1 from public.registry_drift r where r.test_mode and lower(r.domain_name) = n_paused) then
    raise exception 'FAILED 2: the reconcile recorded something for a paused domain';
  end if;
  select * into v_d from public.domains where id = d_live;
  if v_d.registry_status is distinct from 'PendingHold' or v_d.expires_at is distinct from '2028-01-01T00:00:00Z'::timestamptz
     or not exists (select 1 from public.registry_drift r
                     where r.test_mode and r.domain_name = n_live and r.resolved_at is null) then
    raise exception 'FAILED 2: the reconcile skipped a domain that is not paused';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. The deep sync: a paused domain is never due, and a write for it records nothing.
  update public.domains set deep_checked_at = null where id in (d_paused, d_live);
  if exists (select 1 from public.domains_for_deep_sync(true, 200) s where s.domain_id = d_paused) then
    raise exception 'FAILED 3: a paused domain was due for a deep sync';
  end if;
  perform public.record_deep_sync(d_paused, true,
    jsonb_build_object('registry_status', 'Active', 'expires_at', '2029-01-01T00:00:00Z'),
    jsonb_build_array(jsonb_build_object('kind', 'status_mismatch', 'detail', '{}'::jsonb)));
  select * into v_d from public.domains where id = d_paused;
  if v_d.registry_status is distinct from 'PendingHold' or v_d.deep_checked_at is not null
     or exists (select 1 from public.registry_drift r where r.test_mode and r.domain_name = n_paused) then
    raise exception 'FAILED 3: the deep sync recorded something for a paused domain';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Cleared, it is checked again.
  update public.domains set registry_checks_paused_at = null, registry_checks_paused_note = null where id = d_paused;
  if not exists (select 1 from public.domains_for_deep_sync(true, 200) s where s.domain_id = d_paused) then
    raise exception 'FAILED 4: a cleared pause was not due for a deep sync';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 71: % checks passed', v_passed;
end;
$$;

rollback;
