-- ─────────────────────────────────────────────────────────────────────────────
-- Launch hardening and portfolio tools (24 Sept 2026):
--
--  1. SEC-11 velocity limits, tiered: a new account may order fewer domains a
--     day than an established one, and the cap rises by itself with account
--     age and paid orders. Registrations and transfers count; renewals of the
--     account's own domains do not. Live orders only — a test order moves no
--     money, so it gets the top tier.
--  2. FR-D2: host presets are checked in DNS by the gateway. One whose
--     nameservers stop resolving for a day is hidden from customers and
--     raises an alert; it comes back by itself when they resolve again. One
--     not re-verified against its provider's documentation for 90 days is an
--     alert too (the quarterly re-verification).
--  3. §13.5 domain deep sync: each live domain is read from the supplier
--     once a day, and straight after anything changes it, applying the same
--     corrections as the hourly portfolio reconcile.
--  4. FR-P3 labels: the account's own, coloured, many per domain.
--  5. FR-P4 / FR-N2 bulk actions: one request, a queued job per domain, and
--     a result for each (`bulk_operation_items`).
--  6. FR-N5 nameserver history: before and after for every change, and the
--     set to revert to.
--  7. supplier_calls kept 13 months.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Velocity (SEC-11) ────────────────────────────────────────────────────

alter table public.ops_settings
  add column velocity_new_max integer not null default 5
    check (velocity_new_max between 1 and 1000),
  add column velocity_trusted_max integer not null default 100
    check (velocity_trusted_max between 1 and 5000),
  add column velocity_standard_after_days integer not null default 7
    check (velocity_standard_after_days between 0 and 365),
  add column velocity_trusted_after_days integer not null default 30
    check (velocity_trusted_after_days between 0 and 3650),
  add column velocity_trusted_after_paid_orders integer not null default 3
    check (velocity_trusted_after_paid_orders between 0 and 1000);

comment on column public.ops_settings.max_domains_per_account_day is
  'SEC-11: the standard tier — an account a week old, or with a paid order.';
comment on column public.ops_settings.velocity_new_max is
  'SEC-11: a new account with no paid order yet.';
comment on column public.ops_settings.velocity_trusted_max is
  'SEC-11: an account past velocity_trusted_after_days with velocity_trusted_after_paid_orders paid orders.';

drop function if exists public.account_domain_allowance(uuid);

-- Domains this account has ordered on this side in the last 24 hours, its
-- cap, and which tier it is on.
create or replace function public.account_domain_allowance(p_user_id uuid, p_test_mode boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select p.created_at from public.profiles p where p.id = p_user_id
  ), paid as (
    select count(*)::integer as n
      from public.orders o
     where o.user_id = p_user_id and o.test_mode = false and o.paid_at is not null
  ), used as (
    select count(*)::integer as n
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.user_id = p_user_id
       and o.test_mode = coalesce(p_test_mode, false)
       and o.status <> 'cancelled'
       and o.created_at > now() - interval '24 hours'
       and oi.item_type in ('register', 'transfer')
  ), tier as (
    select case
             when coalesce(p_test_mode, false) then 'trusted'
             when (select created_at from me) <= now() - make_interval(days => s.velocity_trusted_after_days)
              and (select n from paid) >= s.velocity_trusted_after_paid_orders then 'trusted'
             when (select created_at from me) <= now() - make_interval(days => s.velocity_standard_after_days)
               or (select n from paid) >= 1 then 'standard'
             else 'new'
           end as name,
           s.*
      from public.ops_settings s
  )
  select jsonb_build_object(
           'ordered', (select n from used),
           'max', case t.name when 'trusted' then t.velocity_trusted_max
                              when 'standard' then t.max_domains_per_account_day
                              else t.velocity_new_max end,
           'tier', t.name,
           'paid_orders', (select n from paid),
           'account_days', coalesce(floor(extract(epoch from now() - (select created_at from me)) / 86400)::integer, 0),
           'standard_after_days', t.velocity_standard_after_days,
           'trusted_after_days', t.velocity_trusted_after_days,
           'trusted_after_paid_orders', t.velocity_trusted_after_paid_orders)
    from tier t
$$;

revoke all on function public.account_domain_allowance(uuid, boolean) from public, anon, authenticated;
grant execute on function public.account_domain_allowance(uuid, boolean) to service_role;

-- ── 2. Host presets checked in DNS (FR-D2) ──────────────────────────────────

alter table public.nameserver_presets
  add column last_checked_at    timestamptz,
  add column check_failed_since timestamptz,
  -- Set when the check hid it; a preset hidden by a person has none, and a
  -- check never shows it again.
  add column auto_hidden_at     timestamptz,
  add column last_check         jsonb;

-- Presets with nameservers of their own to check: the ones customers can
-- see, and the ones the check itself hid.
create or replace function public.presets_for_check()
returns table (preset_id uuid, provider text, nameservers text[])
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.provider, p.nameservers
    from public.nameserver_presets p
   where p.verified_at is not null
     and not p.assigns_per_zone
     and cardinality(p.nameservers) > 0
     and (not p.is_hidden or p.auto_hidden_at is not null)
   order by p.last_checked_at nulls first, p.provider
$$;

-- One check's verdict. A day of failing checks hides the preset; one good
-- check shows a preset the check hid. Returns what happened:
-- 'ok', 'failing', 'hidden' or 'restored'.
create or replace function public.record_preset_check(p_preset_id uuid, p_ok boolean, p_detail jsonb default '{}')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_preset public.nameserver_presets;
begin
  select * into v_preset from public.nameserver_presets where id = p_preset_id for update;
  if v_preset.id is null then
    raise exception 'no such preset %', p_preset_id using errcode = '22023';
  end if;

  if coalesce(p_ok, false) then
    update public.nameserver_presets
       set last_checked_at = now(), check_failed_since = null, last_check = coalesce(p_detail, '{}'),
           is_hidden = case when auto_hidden_at is not null then false else is_hidden end,
           auto_hidden_at = null
     where id = p_preset_id;
    return case when v_preset.auto_hidden_at is not null then 'restored' else 'ok' end;
  end if;

  update public.nameserver_presets
     set last_checked_at = now(),
         check_failed_since = coalesce(check_failed_since, now()),
         last_check = coalesce(p_detail, '{}')
   where id = p_preset_id
  returning * into v_preset;

  if not v_preset.is_hidden and v_preset.check_failed_since <= now() - interval '24 hours' then
    update public.nameserver_presets
       set is_hidden = true, auto_hidden_at = now()
     where id = p_preset_id;
    return 'hidden';
  end if;
  return 'failing';
end;
$$;

revoke all on function public.presets_for_check() from public, anon, authenticated;
revoke all on function public.record_preset_check(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.presets_for_check() to service_role;
grant execute on function public.record_preset_check(uuid, boolean, jsonb) to service_role;

-- ── 3. Domain deep sync (§13.5) ─────────────────────────────────────────────

alter table public.domains add column deep_checked_at timestamptz;

-- Live domains due a read of their own: never read, read over a day ago,
-- or changed since the last read. Least recently read first.
create or replace function public.domains_for_deep_sync(p_test_mode boolean, p_limit integer default 25)
returns table (
  domain_id uuid, domain_name text, local_status text, expires_at timestamptz,
  nameservers text[], pending_nameservers text[], auto_renew boolean,
  transfer_lock boolean, privacy boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.domain_name::text, d.local_status::text, d.expires_at, d.nameservers,
         d.pending_nameservers, d.auto_renew, d.transfer_lock, d.privacy_enabled
    from public.domains d
   where d.test_mode = p_test_mode
     and d.source <> 'demo'
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
$$;

-- One domain's reading: the corrections and findings the portfolio
-- reconcile would make for it (same shapes as record_reconciliation), then
-- the stamp. `p_update` null stamps only — the registry agreed.
create or replace function public.record_deep_sync(
  p_domain_id uuid, p_test_mode boolean, p_update jsonb, p_findings jsonb default '[]'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain public.domains;
begin
  select * into v_domain from public.domains
   where id = p_domain_id and test_mode = p_test_mode and source <> 'demo'
   for update;
  if v_domain.id is null then
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
$$;

revoke all on function public.domains_for_deep_sync(boolean, integer) from public, anon, authenticated;
revoke all on function public.record_deep_sync(uuid, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.domains_for_deep_sync(boolean, integer) to service_role;
grant execute on function public.record_deep_sync(uuid, boolean, jsonb, jsonb) to service_role;

-- ── 4. Labels (FR-P3) ───────────────────────────────────────────────────────

create table public.domain_labels (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 30 and name = btrim(name)),
  -- Named colours, drawn from tokens in the app (S2): never a hex from a user.
  color       text not null default 'blue'
              check (color in ('blue', 'green', 'amber', 'red', 'purple', 'slate')),
  created_at  timestamptz not null default now()
);
create unique index domain_labels_user_name_unique on public.domain_labels (user_id, lower(name));

create table public.domain_label_links (
  label_id    uuid not null references public.domain_labels (id) on delete cascade,
  domain_id   uuid not null references public.domains (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (label_id, domain_id)
);
create index domain_label_links_domain_idx on public.domain_label_links (domain_id);

-- 50 labels an account: plenty for an agency, and a bound on what one can store.
create or replace function public.domain_labels_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.domain_labels where user_id = new.user_id) >= 50 then
    raise exception 'An account can have up to 50 labels.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger domain_labels_limit
  before insert on public.domain_labels
  for each row execute function public.domain_labels_limit();

alter table public.domain_labels      enable row level security;
alter table public.domain_label_links enable row level security;

create policy "domain_labels: own"
  on public.domain_labels for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "domain_label_links: read own"
  on public.domain_label_links for select to authenticated
  using (exists (select 1 from public.domain_labels l
                  where l.id = label_id and l.user_id = (select auth.uid())));
create policy "domain_label_links: add own label to own domain"
  on public.domain_label_links for insert to authenticated
  with check (
    exists (select 1 from public.domain_labels l
             where l.id = label_id and l.user_id = (select auth.uid()))
    and exists (select 1 from public.domains d
                 where d.id = domain_id and d.user_id = (select auth.uid())));
create policy "domain_label_links: remove own"
  on public.domain_label_links for delete to authenticated
  using (exists (select 1 from public.domain_labels l
                  where l.id = label_id and l.user_id = (select auth.uid())));

revoke all on public.domain_labels, public.domain_label_links from anon;
grant select, insert, update, delete on public.domain_labels to authenticated;
grant select, insert, delete on public.domain_label_links to authenticated;

-- ── 5. Bulk actions (FR-P4, FR-N2) ──────────────────────────────────────────

create table public.bulk_operations (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('nameservers', 'transfer_lock', 'privacy', 'auto_renew',
                                            'label', 'unlabel')),
  params      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index bulk_operations_user_idx on public.bulk_operations (user_id, created_at desc);

create table public.bulk_operation_items (
  operation_id  uuid not null references public.bulk_operations (id) on delete cascade,
  domain_id     uuid not null references public.domains (id) on delete cascade,
  domain_name   text not null,
  -- 'queued': a job carries it to the registry (its result is the job's);
  -- 'done': applied here (auto-renew, labels); 'skipped': see `reason`.
  outcome       text not null check (outcome in ('queued', 'done', 'skipped')),
  reason        text check (reason in ('demo', 'not_active', 'registering', 'change_waiting',
                                       'unchanged', 'not_offered')),
  job_id        uuid references public.jobs (id) on delete set null,
  primary key (operation_id, domain_id)
);

alter table public.bulk_operations      enable row level security;
alter table public.bulk_operation_items enable row level security;
create policy "bulk_operations: read own"
  on public.bulk_operations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "bulk_operation_items: read own"
  on public.bulk_operation_items for select to authenticated
  using (exists (select 1 from public.bulk_operations o
                  where o.id = operation_id and o.user_id = (select auth.uid())));
revoke all on public.bulk_operations, public.bulk_operation_items from anon;
revoke insert, update, delete on public.bulk_operations, public.bulk_operation_items from authenticated;
grant select on public.bulk_operations, public.bulk_operation_items to authenticated;

-- Two nameserver sets the same, ignoring case, order and a trailing dot.
create or replace function public.same_nameservers(p_a text[], p_b text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select array_agg(distinct lower(rtrim(x, '.')) order by lower(rtrim(x, '.'))) from unnest(p_a) x)
      is not distinct from
    (select array_agg(distinct lower(rtrim(x, '.')) order by lower(rtrim(x, '.'))) from unnest(p_b) x),
    false)
$$;

/*
 * One bulk change across the account's own domains, applied exactly as the
 * one-domain actions apply it (features/domains/actions): a registry change
 * records the requested value and who asked, then queues one job per
 * domain; auto-renew and labels are applied here. Every domain gets a line
 * saying what became of it. The web checks the second factor (SEC-2) and
 * the nameservers' DNS (FR-D4) before calling.
 *
 * p_value: nameservers {"nameservers": [...], "preset_id": uuid|null};
 * transfer_lock {"locked": bool}; privacy {"enabled": bool};
 * auto_renew {"enabled": bool}; label / unlabel {"label_id": uuid}.
 * Domains not on the account are left out. Returns the operation's id.
 */
create or replace function public.start_bulk_change(
  p_user_id uuid, p_domain_ids uuid[], p_kind text, p_value jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op        uuid;
  v_domain    public.domains;
  v_ns        text[];
  v_preset    uuid;
  v_flag      boolean;
  v_label     uuid;
  v_outcome   text;
  v_reason    text;
  v_job       uuid;
  v_changed   integer;
begin
  if p_kind not in ('nameservers', 'transfer_lock', 'privacy', 'auto_renew', 'label', 'unlabel') then
    raise exception 'not a bulk action: %', p_kind using errcode = '22023';
  end if;
  if coalesce(cardinality(p_domain_ids), 0) not between 1 and 500 then
    raise exception 'a bulk action takes 1 to 500 domains' using errcode = '22023';
  end if;

  case p_kind
    when 'nameservers' then
      select array_agg(lower(rtrim(btrim(x), '.')))
        into v_ns from jsonb_array_elements_text(p_value -> 'nameservers') x;
      if coalesce(cardinality(v_ns), 0) not between 2 and 13 then
        raise exception 'between 2 and 13 nameservers' using errcode = '22023';
      end if;
      -- N11: a preset label only for one customers can see.
      select p.id into v_preset from public.nameserver_presets p
       where p.id = nullif(p_value ->> 'preset_id', '')::uuid
         and p.verified_at is not null and not p.is_hidden;
    when 'transfer_lock' then
      v_flag := (p_value ->> 'locked')::boolean;
    when 'privacy', 'auto_renew' then
      v_flag := (p_value ->> 'enabled')::boolean;
    else
      select l.id into v_label from public.domain_labels l
       where l.id = nullif(p_value ->> 'label_id', '')::uuid and l.user_id = p_user_id;
      if v_label is null then
        raise exception 'not one of your labels' using errcode = '22023';
      end if;
  end case;
  if p_kind in ('transfer_lock', 'privacy', 'auto_renew') and v_flag is null then
    raise exception 'a bulk % needs true or false', p_kind using errcode = '22023';
  end if;

  insert into public.bulk_operations (user_id, kind, params)
  values (p_user_id, p_kind, coalesce(p_value, '{}'))
  returning id into v_op;

  for v_domain in
    select d.* from public.domains d
     where d.id = any (p_domain_ids) and d.user_id = p_user_id
     order by d.domain_name
     for update
  loop
    v_outcome := 'skipped';
    v_reason := null;
    v_job := null;

    case p_kind
      when 'nameservers' then
        if v_domain.local_status not in ('active', 'pending') then
          v_reason := 'not_active';
        elsif public.same_nameservers(v_ns, coalesce(v_domain.pending_nameservers, v_domain.nameservers)) then
          v_reason := 'unchanged';
        else
          update public.domains set pending_nameservers = v_ns, nameserver_preset_id = v_preset
           where id = v_domain.id;
          insert into public.domain_events (domain_id, event_type, actor_type, actor_id, payload)
          values (v_domain.id, 'nameservers_requested', 'user', p_user_id,
                  jsonb_build_object('before', coalesce(v_domain.pending_nameservers, v_domain.nameservers),
                                     'after', v_ns, 'bulk_operation', v_op));
          -- A demo domain never reaches a registry; a registering one gets
          -- the set straight after registration (FR-R5).
          if v_domain.source = 'demo' or v_domain.local_status = 'pending' then
            v_outcome := 'done';
          else
            perform public.enqueue_nameserver_change(v_domain.id);
            select j.id into v_job from public.jobs j
             where j.domain_id = v_domain.id and j.kind = 'apply_nameservers'
               and j.status in ('queued', 'running')
             order by j.created_at desc limit 1;
            v_outcome := 'queued';
          end if;
        end if;

      when 'transfer_lock', 'privacy' then
        if v_domain.source = 'demo' then
          v_reason := 'demo';
        elsif v_domain.local_status = 'pending' then
          v_reason := 'registering';
        elsif v_domain.local_status not in ('active', 'expired_grace') then
          v_reason := 'not_active';
        elsif p_kind = 'privacy' and char_length(split_part(v_domain.tld, '.', -1)) = 2 then
          -- FR-DS3: privacy is offered on generic extensions only.
          v_reason := 'not_offered';
        elsif (p_kind = 'transfer_lock' and v_domain.pending_transfer_lock is null
                 and v_domain.transfer_lock = v_flag)
           or (p_kind = 'privacy' and v_domain.pending_privacy is null
                 and v_domain.privacy_enabled = v_flag) then
          v_reason := 'unchanged';
        else
          if p_kind = 'transfer_lock' then
            -- A change on its way the other way is overtaken, as with one domain.
            if v_domain.pending_transfer_lock is distinct from v_flag then
              update public.domains set pending_transfer_lock = v_flag where id = v_domain.id;
              insert into public.domain_events (domain_id, event_type, actor_type, actor_id, payload)
              values (v_domain.id, 'transfer_lock_requested', 'user', p_user_id,
                      jsonb_build_object('to', v_flag, 'bulk_operation', v_op));
            end if;
            perform public.enqueue_domain_change(v_domain.id, 'set_transfer_lock');
          else
            if v_domain.pending_privacy is distinct from v_flag then
              update public.domains set pending_privacy = v_flag where id = v_domain.id;
              insert into public.domain_events (domain_id, event_type, actor_type, actor_id, payload)
              values (v_domain.id, 'privacy_requested', 'user', p_user_id,
                      jsonb_build_object('to', v_flag, 'bulk_operation', v_op));
            end if;
            perform public.enqueue_domain_change(v_domain.id, 'set_privacy');
          end if;
          select j.id into v_job from public.jobs j
           where j.domain_id = v_domain.id
             and j.kind = case p_kind when 'transfer_lock' then 'set_transfer_lock'::public.job_kind
                                      else 'set_privacy'::public.job_kind end
             and j.status in ('queued', 'running', 'needs_attention')
           order by j.created_at desc limit 1;
          v_outcome := 'queued';
        end if;

      when 'auto_renew' then
        if v_domain.auto_renew = v_flag then
          v_reason := 'unchanged';
        else
          update public.domains set auto_renew = v_flag where id = v_domain.id;
          insert into public.domain_events (domain_id, event_type, actor_type, actor_id, payload)
          values (v_domain.id, case when v_flag then 'auto_renew_on' else 'auto_renew_off' end,
                  'user', p_user_id, jsonb_build_object('bulk_operation', v_op));
          v_outcome := 'done';
        end if;

      when 'label' then
        insert into public.domain_label_links (label_id, domain_id) values (v_label, v_domain.id)
        on conflict do nothing;
        get diagnostics v_changed = row_count;
        if v_changed = 0 then v_reason := 'unchanged'; else v_outcome := 'done'; end if;

      else -- 'unlabel'
        delete from public.domain_label_links where label_id = v_label and domain_id = v_domain.id;
        get diagnostics v_changed = row_count;
        if v_changed = 0 then v_reason := 'unchanged'; else v_outcome := 'done'; end if;
    end case;

    insert into public.bulk_operation_items (operation_id, domain_id, domain_name, outcome, reason, job_id)
    values (v_op, v_domain.id, v_domain.domain_name, v_outcome,
            case when v_outcome = 'skipped' then v_reason end, v_job);
  end loop;

  return v_op;
end;
$$;

-- A bulk operation's lines with each job's progress, for its owner (RLS
-- keeps jobs themselves out of reach).
create or replace function public.my_bulk_operation(p_operation_id uuid)
returns table (domain_id uuid, domain_name text, outcome text, reason text,
               job_status text, job_error_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.domain_id, i.domain_name, i.outcome, i.reason, j.status::text, j.last_error_code
    from public.bulk_operation_items i
    join public.bulk_operations o on o.id = i.operation_id
    left join public.jobs j on j.id = i.job_id
   where i.operation_id = p_operation_id
     and o.user_id = (select auth.uid())
   order by i.domain_name
$$;

revoke all on function public.same_nameservers(text[], text[]) from public, anon;
grant execute on function public.same_nameservers(text[], text[]) to authenticated, service_role;
revoke all on function public.start_bulk_change(uuid, uuid[], text, jsonb) from public, anon, authenticated;
grant execute on function public.start_bulk_change(uuid, uuid[], text, jsonb) to service_role;
revoke all on function public.my_bulk_operation(uuid) from public, anon;
grant execute on function public.my_bulk_operation(uuid) to authenticated;

-- ── 6. Nameserver history (FR-N5) ───────────────────────────────────────────

alter table public.domains add column previous_nameservers text[];

create table public.domain_nameserver_history (
  id          bigserial primary key,
  domain_id   uuid not null references public.domains (id) on delete cascade,
  before      text[],
  after       text[] not null,
  changed_at  timestamptz not null default now()
);
create index domain_nameserver_history_domain_idx
  on public.domain_nameserver_history (domain_id, changed_at desc);

-- Every change of the nameservers we hold — applied by a job, copied from
-- the registry, or set at registration — whoever made it. The set it
-- replaced becomes the one to revert to. Only real changes: the same set in
-- another order or case is not one.
create or replace function public.domains_nameserver_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nameservers is null or public.same_nameservers(old.nameservers, new.nameservers) then
    return new;
  end if;
  if coalesce(cardinality(old.nameservers), 0) > 0 then
    new.previous_nameservers := old.nameservers;
  end if;
  insert into public.domain_nameserver_history (domain_id, before, after)
  values (new.id, old.nameservers, new.nameservers);
  return new;
end;
$$;
create trigger domains_nameserver_history
  before update of nameservers on public.domains
  for each row execute function public.domains_nameserver_history();

alter table public.domain_nameserver_history enable row level security;
create policy "domain_nameserver_history: read own"
  on public.domain_nameserver_history for select to authenticated
  using (exists (select 1 from public.domains d
                  where d.id = domain_id and d.user_id = (select auth.uid())));
revoke all on public.domain_nameserver_history from anon;
revoke insert, update, delete on public.domain_nameserver_history from authenticated;
grant select on public.domain_nameserver_history to authenticated;

-- ── 7. supplier_calls kept 13 months ────────────────────────────────────────

-- Long enough to answer a question about any registration or renewal of
-- the past year; a record of calls, not of customers.
create or replace function public.purge_supplier_calls()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.supplier_calls where created_at < now() - interval '13 months'
    returning 1
  )
  select count(*)::integer from gone
$$;
revoke all on function public.purge_supplier_calls() from public, anon, authenticated, service_role;
select cron.schedule('purge-supplier-calls', '23 4 * * 0', 'select public.purge_supplier_calls()');

revoke all on function public.domain_labels_limit() from public, anon, authenticated, service_role;
revoke all on function public.domains_nameserver_history() from public, anon, authenticated, service_role;

-- ── Alerts: host presets (FR-D2) ────────────────────────────────────────────
-- The conditions of migration 31, and three about presets (live side only:
-- presets are the same for both).
CREATE OR REPLACE FUNCTION public.current_alert_conditions(p_test_mode boolean)
 RETURNS TABLE(key text, severity text, kind text, summary text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
                  when 'transfer_domain' then 'Transfer'
                  when 'set_transfer_lock' then 'Transfer lock change'
                  when 'set_privacy' then 'Privacy change'
                  when 'update_contacts' then 'Contact change'
                  else 'Nameserver change'
                end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- I5: paid, and not settled in time.
  select 'order_stuck:' || o.id,
         'critical',
         'order_stuck',
         format('Order %s was paid %s minutes ago and is still %s',
                o.order_number, floor(extract(epoch from now() - o.paid_at) / 60), o.status)
    from public.orders o
    cross join public.ops_settings s
   where o.test_mode = p_test_mode
     and o.status in ('paid', 'provisioning')
     and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
     -- A transfer waits days for the other registrar; only other lines are late (migration 26).
     and exists (
       select 1 from public.order_items oi2
        where oi2.order_id = o.id
          and oi2.status in ('pending', 'provisioning')
          and not (oi2.item_type = 'transfer' and exists (
            select 1 from public.domains d2
             where d2.order_item_id = oi2.id and d2.local_status = 'transfer_pending'))
     )

  union all
  -- Refunds a person must look at, or approve.
  select 'refund:' || r.id,
         case when r.status = 'held' then 'warning' else 'critical' end,
         'refund_' || r.status,
         format('Refund of ₦%s for order %s%s is %s%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number,
                coalesce(' (' || oi.domain || ')', ''),
                replace(r.status::text, '_', ' '),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')

  union all
  -- A refund that should have gone out 30 minutes ago: is the worker running?
  select 'refund_overdue:' || r.id,
         'critical',
         'refund_overdue',
         format('Refund of ₦%s for order %s has waited %s minutes to be sent%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.run_after) / 60),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status in ('queued', 'sending')
     and r.run_after < now() - interval '30 minutes'

  union all
  -- Accepted by Flutterwave but not completed after ten days.
  select 'refund_slow:' || r.id,
         'warning',
         'refund_slow',
         format('Refund of ₦%s for order %s was sent %s days ago and has not completed',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.submitted_at) / 86400))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status = 'submitted'
     and r.submitted_at < now() - interval '10 days'

  union all
  -- Money that arrived but could not be applied, or a refund that could not be queued.
  select 'incident:' || i.id,
         'critical',
         'payment_' || i.kind,
         format('Payment incident: %s%s',
                replace(i.kind, '_', ' '),
                coalesce(', order ' || o.order_number, ''))
    from public.payment_incidents i
    left join public.orders o on o.id = i.order_id
   where i.test_mode = p_test_mode and i.resolved_at is null

  union all
  -- The registry disagrees with us (§13.5).
  select 'drift:' || g.id,
         case when g.kind in ('supplier_may_renew', 'unknown_domain') then 'warning' else 'critical' end,
         'drift_' || g.kind,
         format('Registry check: %s — %s', g.domain_name, replace(g.kind, '_', ' '))
    from public.registry_drift g
   where g.test_mode = p_test_mode and g.resolved_at is null

  union all
  -- The registry has not been read successfully for three hours.
  select 'reconcile_stale:' || p_test_mode::text,
         'warning',
         'reconcile_stale',
         'The registry has not been reconciled successfully for over three hours'
   where exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode and r.started_at > now() - interval '7 days'
         )
     and not exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode
              and r.finished_at > now() - interval '3 hours'
              and r.error is null
         )

  union all
  -- FR-FLOAT-2, simplified: checkout refuses orders the float cannot cover.
  select 'float_low:' || p_test_mode::text,
         'warning',
         'float_low',
         format('Supplier balance is $%s, below the $%s alert level. Checkout refuses orders it cannot cover.',
                to_char(b.balance_usd, 'FM999,999,990.00'), to_char(s.float_alert_usd, 'FM999,990.00'))
    from (
      select balance_usd, taken_at from public.supplier_balance_snapshots
       where test_mode = p_test_mode order by taken_at desc limit 1
    ) b
    cross join public.ops_settings s
   where b.taken_at > now() - interval '2 hours'
     and b.balance_usd < s.float_alert_usd

  union all
  -- The weekly catalogue sync inside the gateway (migration 27): its last run
  -- failed or was refused, or nothing has succeeded for eight days. Prices
  -- then drift from the supplier's.
  select 'catalogue_sync:' || h.name,
         'warning',
         'catalogue_sync',
         case
           when h.detail ->> 'outcome' in ('failed', 'refused')
             then format('The supplier catalogue sync %s on %s — prices are not being updated',
                         h.detail ->> 'outcome', to_char(h.beat_at, 'DD Mon HH24:MI'))
           else 'The supplier catalogue has not synced for over eight days — prices are not being updated'
         end
    from public.service_heartbeats h
   where p_test_mode = false
     and h.name = 'catalogue:production'
     and (
       h.detail ->> 'outcome' in ('failed', 'refused')
       or coalesce((h.detail ->> 'lastSuccessAt')::timestamptz, h.beat_at - interval '9 days')
          < now() - interval '8 days'
     )

  union all
  -- FR-NT3: an ERRP notice that bounced is a compliance failure — the
  -- registrant must be reached another way. Raised for three days.
  select 'notice_bounced:' || c.id,
         'critical',
         'compliance_notice_bounced',
         format('The %s expiry notice for %s bounced — reach the registrant another way',
                case c.notice_type when 'errp_pre_35' then 'one-month'
                                   when 'errp_pre_7' then 'one-week'
                                   else 'after-expiry' end,
                c.domain_name)
    from public.compliance_notices c
    join public.email_outbox e on e.id = c.email_id
   where e.test_mode = p_test_mode
     and c.delivery_status = 'bounced'
     and c.delivery_checked_at > now() - interval '3 days'

  union all
  -- An email that could not be sent at all (migration 31).
  select 'email_failed:' || e.id,
         case when e.category = 'transactional' then 'warning' else 'critical' end,
         'email_failed',
         format('A %s email (%s%s) could not be sent: %s',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                coalesce(e.last_error, 'no reason given'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'failed'
     and e.updated_at > now() - interval '3 days'

  union all
  -- Emails not sent after half an hour: the gateway's sender is not running,
  -- has no Brevo key, or Brevo is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and BREVO_API_KEY',
                count(*))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status in ('pending', 'sending')
     and e.created_at < now() - interval '30 minutes'
  having count(*) > 0

  union all
  -- FR-D2: a preset the DNS check hid — customers no longer see it.
  select 'preset_hidden:' || p.id,
         'critical',
         'preset_hidden',
         format('Host preset %s is hidden: its nameservers stopped resolving on %s. Check the provider''s documentation, fix or retire it.',
                p.provider, to_char(p.check_failed_since, 'DD Mon'))
    from public.nameserver_presets p
   where p_test_mode = false and p.is_hidden and p.auto_hidden_at is not null

  union all
  -- …and one failing, not yet hidden.
  select 'preset_failing:' || p.id,
         'warning',
         'preset_failing',
         format('Host preset %s: its nameservers are not resolving (since %s). It is hidden after a day.',
                p.provider, to_char(p.check_failed_since, 'DD Mon HH24:MI'))
    from public.nameserver_presets p
   where p_test_mode = false and p.check_failed_since is not null and not p.is_hidden

  union all
  -- The quarterly re-verification against the provider's own documentation.
  select 'preset_stale:' || p.id,
         'warning',
         'preset_stale',
         format('Host preset %s was last verified against its documentation on %s — check it again and update verified_at.',
                p.provider, to_char(p.verified_at, 'DD Mon YYYY'))
    from public.nameserver_presets p
   where p_test_mode = false and not p.is_hidden and p.verified_at < now() - interval '90 days'
$function$;
