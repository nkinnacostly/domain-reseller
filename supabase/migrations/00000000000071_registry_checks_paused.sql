-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 71: registry checks paused for a domain, by the owner's choice.
--
-- thenewcapitalvine.com and renewedabgglobal.org are on hold at the registry
-- (client hold, `PendingHold`), and the hourly reconcile kept their
-- `status_mismatch` drift open — a critical alert every two hours since
-- 6 Oct and 10 Nov. The owner chose to stop checking them entirely (22 Nov
-- 2026): a paused domain is still loaded, so the registry's entry is known and
-- never `unknown_domain`, but nothing read for it is recorded — no update, no
-- event, no finding — and the deep sync leaves it out. Its facts stay as last
-- read; a hold lifted, a new expiry or nameservers are not seen until the
-- pause is cleared:
--   update public.domains set registry_checks_paused_at = null,
--          registry_checks_paused_note = null where domain_name = '…' and not test_mode;
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.domains
  add column registry_checks_paused_at   timestamptz,
  add column registry_checks_paused_note text
    check (registry_checks_paused_note is null or char_length(registry_checks_paused_note) between 10 and 300),
  add constraint domains_registry_checks_paused_whole
    check ((registry_checks_paused_at is null) = (registry_checks_paused_note is null));

CREATE OR REPLACE FUNCTION public.record_reconciliation(p_run_id uuid, p_updates jsonb, p_findings jsonb, p_complete boolean, p_domains_seen integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run      public.reconcile_runs%rowtype;
  v_findings integer;
begin
  select * into v_run from public.reconcile_runs where id = p_run_id for update;
  if not found or v_run.finished_at is not null then
    raise exception 'reconcile run % is not open', p_run_id;
  end if;

  update public.domains d
     set registry_status       = u.registry_status,
         registry_renewal_mode = u.renewal_mode,
         registry_checked_at   = now(),
         expires_at            = coalesce(u.expires_at, d.expires_at),
         nameservers           = coalesce(u.nameservers, d.nameservers),
         transfer_lock         = coalesce(u.transfer_lock, d.transfer_lock),
         privacy_enabled       = coalesce(u.privacy, d.privacy_enabled)
    from jsonb_to_recordset(p_updates) as u(
           domain_id uuid, registry_status text, renewal_mode text, expires_at timestamptz,
           nameservers text[], transfer_lock boolean, privacy boolean)
   where d.id = u.domain_id
     and d.test_mode = v_run.test_mode
     and d.source <> 'demo'
     and d.registry_checks_paused_at is null;

  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  select (u ->> 'domain_id')::uuid, e ->> 'type', 'system', coalesce(e -> 'payload', '{}'::jsonb)
    from jsonb_array_elements(p_updates) as u
    cross join lateral jsonb_array_elements(coalesce(u -> 'events', '[]'::jsonb)) as e
    join public.domains d on d.id = (u ->> 'domain_id')::uuid
   where d.test_mode = v_run.test_mode and d.source <> 'demo' and d.registry_checks_paused_at is null;

  insert into public.registry_drift (test_mode, domain_id, domain_name, kind, detail, last_run_id)
  select v_run.test_mode, f.domain_id, f.domain_name, f.kind, coalesce(f.detail, '{}'), p_run_id
    from jsonb_to_recordset(p_findings) as f(domain_id uuid, domain_name text, kind text, detail jsonb)
   where not exists (select 1 from public.domains p
                      where p.test_mode = v_run.test_mode and p.registry_checks_paused_at is not null
                        and (p.id = f.domain_id or lower(p.domain_name::text) = lower(f.domain_name)))
  on conflict (test_mode, domain_name, kind) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail,
                domain_id = coalesce(excluded.domain_id, public.registry_drift.domain_id),
                last_run_id = p_run_id;
  get diagnostics v_findings = row_count;

  if p_complete then
    update public.registry_drift
       set resolved_at = now()
     where test_mode = v_run.test_mode
       and resolved_at is null
       and last_run_id is distinct from p_run_id;
  end if;

  update public.reconcile_runs
     set finished_at = now(), domains_seen = p_domains_seen, findings = v_findings
   where id = p_run_id;

  return v_findings;
end;
$function$;

CREATE OR REPLACE FUNCTION public.domains_for_deep_sync(p_test_mode boolean, p_limit integer DEFAULT 25)
 RETURNS TABLE(domain_id uuid, domain_name text, local_status text, expires_at timestamp with time zone, nameservers text[], pending_nameservers text[], auto_renew boolean, transfer_lock boolean, privacy boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select d.id, d.domain_name::text, d.local_status::text, d.expires_at, d.nameservers,
         d.pending_nameservers, d.auto_renew, d.transfer_lock, d.privacy_enabled
    from public.domains d
   where d.test_mode = p_test_mode
     and d.source <> 'demo'
     and d.registry_checks_paused_at is null
     and d.local_status in ('active', 'expired_grace', 'redemption')
     and (d.deep_checked_at is null
          or d.deep_checked_at < now() - interval '24 hours'
          or exists (
               select 1 from public.domain_events e
                where e.domain_id = d.id
                  and e.created_at > d.deep_checked_at
                  and e.event_type in ('registered', 'renewed', 'transferred_in', 'nameservers_applied',
                                       'transfer_lock_applied', 'privacy_applied', 'contacts_applied')))
   order by d.deep_checked_at nulls first, d.id
   limit greatest(1, least(p_limit, 200))
$function$;

CREATE OR REPLACE FUNCTION public.record_deep_sync(p_domain_id uuid, p_test_mode boolean, p_update jsonb, p_findings jsonb DEFAULT '[]'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_domain public.domains;
begin
  select * into v_domain from public.domains
   where id = p_domain_id and test_mode = p_test_mode and source <> 'demo'
   for update;
  -- Paused by the owner (migration 71): nothing read is recorded.
  if v_domain.id is null or v_domain.registry_checks_paused_at is not null then
    return;
  end if;

  if p_update is not null then
    update public.domains d
       set registry_status       = coalesce(u.registry_status, d.registry_status),
           registry_renewal_mode = coalesce(u.renewal_mode, d.registry_renewal_mode),
           registry_checked_at   = now(),
           expires_at            = coalesce(u.expires_at, d.expires_at),
           nameservers           = coalesce(u.nameservers, d.nameservers),
           transfer_lock         = coalesce(u.transfer_lock, d.transfer_lock),
           privacy_enabled       = coalesce(u.privacy, d.privacy_enabled)
      from jsonb_to_record(p_update) as u(
             registry_status text, renewal_mode text, expires_at timestamptz,
             nameservers text[], transfer_lock boolean, privacy boolean)
     where d.id = p_domain_id;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select p_domain_id, e ->> 'type', 'system', coalesce(e -> 'payload', '{}'::jsonb)
      from jsonb_array_elements(coalesce(p_update -> 'events', '[]'::jsonb)) as e;
  end if;

  insert into public.registry_drift (test_mode, domain_id, domain_name, kind, detail)
  select p_test_mode, p_domain_id, v_domain.domain_name, f.kind, coalesce(f.detail, '{}')
    from jsonb_to_recordset(coalesce(p_findings, '[]'::jsonb)) as f(kind text, detail jsonb)
  on conflict (test_mode, domain_name, kind) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail;

  update public.domains set deep_checked_at = now() where id = p_domain_id;
end;
$function$;

-- The owner's two (live side), and their open drift closed now rather than at
-- the next complete run.
update public.domains
   set registry_checks_paused_at = now(),
       registry_checks_paused_note = 'Owner, 22 Nov 2026: on hold at the registry; checks paused until cleared'
 where not test_mode and domain_name in ('thenewcapitalvine.com', 'renewedabgglobal.org');

update public.registry_drift r
   set resolved_at = now()
  from public.domains d
 where r.resolved_at is null and r.test_mode = d.test_mode
   and (r.domain_id = d.id or lower(r.domain_name) = lower(d.domain_name::text))
   and d.registry_checks_paused_at is not null;
