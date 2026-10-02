-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 41: what the admin dashboard reads (docs/ADMIN-SPEC.md §3.2, §6,
-- §7).
--
-- (a) The supplier's statement (`deposit/transactions`), mirrored hourly by
--     the gateway in integer cents and matched to the provisioning call that
--     spent each debit. Spend is `balance − oldBalance`, never `amount`
--     (always 0); trace ids are GUIDs, stored lower-case (§7).
-- (b) What each float top-up cost in naira, entered by the owner.
-- (c) The supplier cost of each order line, recorded at checkout (B15), in a
--     table customers cannot read — they can read `order_items` (D13).
-- (d) Cart adds per day, for the funnel. No search counts (FR-S7).
-- (e) A daily rollup, so trends outlive the 90-day purges.
-- (f) Indexes for the dashboard's reads.
-- (g) New alerts: the ledger's exceptions, admin changes, and pg_cron.
-- (h) The dashboard's read functions: aggregates, anything from auth.*, and
--     anything a test admin must not see in full (D4).
-- (i) Masked views of the tables that hold personal data.
-- (j) Helpers for e2e, each refusing anything not tied to an e2e user or a
--     test-mode row.
--
-- Every function and view here is revoked from public, anon, authenticated
-- and service_role, then granted to at most one role (§3.0);
-- supabase/tests/admin_data.sql checks it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── (a) The supplier ledger mirror ──────────────────────────────────────────

create table public.supplier_ledger_entries (
  test_mode           boolean not null,
  trace_id            uuid not null,                  -- stored lower-case; the supplier's GUIDs need not be RFC 9562
  occurred_at         timestamptz not null,           -- supplierDate(creationTime): zoneless = UTC+3
  type                smallint not null,
  status              smallint not null,              -- may change on re-read; every change is a revision row
  charge_type         smallint not null,
  product_type        smallint not null,
  product_id          uuid,
  description         text not null default '' check (char_length(description) <= 300),
  period              smallint,
  old_balance_cents   bigint not null,
  balance_cents       bigint not null,
  delta_cents         bigint generated always as (balance_cents - old_balance_cents) stored,
  recorded_at         timestamptz not null default now(),
  match_state         text not null default 'pending'
                      check (match_state in ('pending', 'matched', 'topup', 'unexplained', 'unclassified')),
  match_call_id       bigint,
  match_operation     text,
  match_order_item_id uuid,
  matched_at          timestamptz,
  primary key (test_mode, trace_id)
);
alter table public.supplier_ledger_entries enable row level security;
revoke all on public.supplier_ledger_entries from public, anon, authenticated, service_role;
grant select on public.supplier_ledger_entries to service_role;

create table public.supplier_ledger_revisions (
  id        bigint generated always as identity primary key,
  test_mode boolean not null,
  trace_id  uuid not null,
  seen_at   timestamptz not null default now(),
  changes   jsonb not null,                           -- {field: {stored, read}} for each differing fact
  applied   boolean not null                          -- true only for a status change
);
create index supplier_ledger_revisions_trace on public.supplier_ledger_revisions (test_mode, trace_id, seen_at desc);
alter table public.supplier_ledger_revisions enable row level security;
revoke all on public.supplier_ledger_revisions from public, anon, authenticated, service_role;
grant select on public.supplier_ledger_revisions to service_role;

-- The supplier's facts are never rewritten: a re-read that differs is kept as
-- a revision. Only the match columns move — and the status, inside
-- record_supplier_ledger. Deleting is for e2e rows only.
create function public.supplier_ledger_is_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if tg_op = 'DELETE' then
    if old.test_mode and old.description like 'e2e-%' then
      return old;
    end if;
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if (new.test_mode, new.trace_id, new.occurred_at, new.type, new.charge_type, new.product_type,
      new.product_id, new.description, new.period, new.old_balance_cents, new.balance_cents, new.recorded_at)
     is distinct from
     (old.test_mode, old.trace_id, old.occurred_at, old.type, old.charge_type, old.product_type,
      old.product_id, old.description, old.period, old.old_balance_cents, old.balance_cents, old.recorded_at) then
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if new.status is distinct from old.status
     and coalesce(current_setting('app.ledger_writer', true), '') <> 'on' then
    raise exception 'a ledger status changes only through record_supplier_ledger';
  end if;
  return new;
end;
$$;

create trigger supplier_ledger_is_final
  before update or delete on public.supplier_ledger_entries
  for each row execute function public.supplier_ledger_is_final();
create trigger supplier_ledger_no_truncate
  before truncate on public.supplier_ledger_entries
  for each statement execute function public.supplier_ledger_is_final();
create trigger supplier_ledger_revisions_final
  before update or delete on public.supplier_ledger_revisions
  for each row execute function public.append_only_final();
create trigger supplier_ledger_revisions_no_truncate
  before truncate on public.supplier_ledger_revisions
  for each statement execute function public.append_only_final();

-- A whole number from a JSON field within bounds, or an error naming it.
create function public.ledger_int(p_row jsonb, p_key text, p_min bigint, p_max bigint, p_nullable boolean)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_row -> p_key;
  v_num   numeric;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    if p_nullable then return null; end if;
    raise exception 'ledger row: % is missing', p_key using errcode = '22023';
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    raise exception 'ledger row: % is not a number', p_key using errcode = '22023';
  end if;
  v_num := (v_value #>> '{}')::numeric;
  if v_num <> trunc(v_num) or v_num < p_min or v_num > p_max then
    raise exception 'ledger row: % is not a whole number in range', p_key using errcode = '22023';
  end if;
  return v_num::bigint;
end;
$$;

-- An 8-4-4-4-12 hex GUID in either case — not RFC 9562: a live top-up has
-- version nibble `b` and variant `7` (§7) — as a lower-case uuid.
create function public.ledger_guid(p_value text, p_nullable boolean)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value = '' then
    if p_nullable then return null; end if;
    raise exception 'ledger row: no trace id' using errcode = '22023';
  end if;
  if p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'ledger row: not a GUID' using errcode = '22023';
  end if;
  return lower(p_value)::uuid;
end;
$$;

-- Ties each settled debit to the nearest money-spending call on its side
-- (§7.3), then through the job to the order line.
create function public.match_supplier_ledger(p_test_mode boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env     text := case when p_test_mode then 'ote' else 'production' end;
  v_entry   public.supplier_ledger_entries;
  v_state   text;
  v_call    bigint;
  v_op      text;
  v_item    uuid;
  v_count   integer := 0;
begin
  for v_entry in
    select * from public.supplier_ledger_entries e
     where e.test_mode = p_test_mode
       and e.match_state in ('pending', 'unexplained', 'unclassified')
       and e.occurred_at > now() - interval '30 days'
     for update
  loop
    v_call := null; v_op := null; v_item := null;
    if v_entry.status <> 1 then
      v_state := 'unclassified';
    elsif v_entry.delta_cents > 0 then
      v_state := case when v_entry.charge_type = 0 and v_entry.product_type = 3 and v_entry.type = 5
                      then 'topup' else 'unclassified' end;
    elsif v_entry.delta_cents < 0 and v_entry.product_type = 1 then
      select c.id, c.operation, j.order_item_id into v_call, v_op, v_item
        from public.supplier_calls c
        left join public.jobs j on j.id = c.job_id
       where c.environment = v_env
         and c.operation in ('RegisterWithContactInfo', 'Renew', 'Transfer')
         and c.outcome in ('ok', 'unknown')
         and c.domain_name is not null
         and (lower(c.domain_name::text) = lower(trim(v_entry.description))
              or position(lower(c.domain_name::text) in lower(v_entry.description)) > 0)
         and v_entry.occurred_at between c.created_at - make_interval(secs => c.duration_ms::double precision / 1000) - interval '120 seconds'
                                     and c.created_at + interval '120 seconds'
       order by abs(extract(epoch from (v_entry.occurred_at - c.created_at)))
       limit 1;
      v_state := case when v_call is not null then 'matched' end;
    elsif v_entry.delta_cents < 0 and v_entry.product_type = 2 then
      select c.id, c.operation, sc.order_item_id into v_call, v_op, v_item
        from public.supplier_calls c
        left join public.ssl_jobs sj on sj.id = c.ssl_job_id
        left join public.ssl_certificates sc on sc.id = sj.certificate_id
       where c.environment = v_env
         and c.operation in ('SslInitialize', 'SslReissue')
         and c.outcome in ('ok', 'unknown')
         and c.domain_name is not null
         and (lower(c.domain_name::text) = lower(trim(v_entry.description))
              or position(lower(c.domain_name::text) in lower(v_entry.description)) > 0)
         and v_entry.occurred_at between c.created_at - make_interval(secs => c.duration_ms::double precision / 1000) - interval '120 seconds'
                                     and c.created_at + interval '120 seconds'
       order by abs(extract(epoch from (v_entry.occurred_at - c.created_at)))
       limit 1;
      v_state := case when v_call is not null then 'matched' end;
    else
      v_state := 'unclassified';
    end if;

    if v_state is null then
      -- No call yet. After two hours a registration-shaped debit (a bare
      -- name, as seen live) is unexplained; other shapes stay unclassified
      -- until a renewal or transfer debit has been seen (§7.3).
      if v_entry.occurred_at < now() - interval '2 hours' then
        v_state := case when lower(trim(v_entry.description)) ~ '^[a-z0-9.-]+\.[a-z0-9-]+$'
                        then 'unexplained' else 'unclassified' end;
      else
        v_state := 'pending';
      end if;
    end if;

    if v_state is distinct from v_entry.match_state or v_call is distinct from v_entry.match_call_id then
      update public.supplier_ledger_entries
         set match_state = v_state,
             match_call_id = v_call,
             match_operation = v_op,
             match_order_item_id = v_item,
             matched_at = case when v_state = 'matched' then now() end
       where test_mode = v_entry.test_mode and trace_id = v_entry.trace_id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- The gateway's sync writes here (§4.4). New rows are inserted; a re-read
-- that changes the status updates it and re-classifies; any other changed
-- fact is kept as a revision and alerted, the stored facts unchanged.
create function public.record_supplier_ledger(p_test_mode boolean, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_el       jsonb;
  v_trace    uuid;
  v_new      public.supplier_ledger_entries;
  v_old      public.supplier_ledger_entries;
  v_changes  jsonb;
  v_at       text;
  v_inserted integer := 0;
  v_status   integer := 0;
  v_revised  integer := 0;
begin
  if p_test_mode is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_supplier_ledger: a side and an array of rows' using errcode = '22023';
  end if;
  for v_el in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'ledger row: not an object' using errcode = '22023';
    end if;
    v_at := v_el ->> 'occurredAt';
    if v_at is null or v_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$' then
      raise exception 'ledger row: occurredAt must be an instant with its zone' using errcode = '22023';
    end if;
    v_new := null;
    v_new.test_mode := p_test_mode;
    v_new.trace_id := public.ledger_guid(v_el ->> 'traceId', false);
    v_new.occurred_at := v_at::timestamptz;
    v_new.type := public.ledger_int(v_el, 'type', -32768, 32767, false);
    v_new.status := public.ledger_int(v_el, 'status', -32768, 32767, false);
    v_new.charge_type := public.ledger_int(v_el, 'chargeType', -32768, 32767, false);
    v_new.product_type := public.ledger_int(v_el, 'productType', -32768, 32767, false);
    v_new.product_id := public.ledger_guid(v_el ->> 'productId', true);
    v_new.description := left(coalesce(v_el ->> 'description', ''), 300);
    v_new.period := public.ledger_int(v_el, 'period', -32768, 32767, true);
    v_new.old_balance_cents := public.ledger_int(v_el, 'oldBalanceCents', -1000000000000, 1000000000000, false);
    v_new.balance_cents := public.ledger_int(v_el, 'balanceCents', -1000000000000, 1000000000000, false);

    select * into v_old from public.supplier_ledger_entries
     where test_mode = p_test_mode and trace_id = v_new.trace_id
     for update;
    if not found then
      insert into public.supplier_ledger_entries (test_mode, trace_id, occurred_at, type, status, charge_type,
                                                  product_type, product_id, description, period,
                                                  old_balance_cents, balance_cents)
      values (p_test_mode, v_new.trace_id, v_new.occurred_at, v_new.type, v_new.status, v_new.charge_type,
              v_new.product_type, v_new.product_id, v_new.description, v_new.period,
              v_new.old_balance_cents, v_new.balance_cents);
      v_inserted := v_inserted + 1;
      continue;
    end if;

    if v_new.status <> v_old.status then
      perform set_config('app.ledger_writer', 'on', true);
      update public.supplier_ledger_entries
         set status = v_new.status, match_state = 'pending', match_call_id = null,
             match_operation = null, match_order_item_id = null, matched_at = null
       where test_mode = p_test_mode and trace_id = v_new.trace_id;
      perform set_config('app.ledger_writer', '', true);
      insert into public.supplier_ledger_revisions (test_mode, trace_id, changes, applied)
      values (p_test_mode, v_new.trace_id,
              jsonb_build_object('status', jsonb_build_object('stored', v_old.status, 'read', v_new.status)), true);
      v_status := v_status + 1;
    end if;

    v_changes := '{}'::jsonb;
    if v_new.occurred_at is distinct from v_old.occurred_at then
      v_changes := v_changes || jsonb_build_object('occurred_at', jsonb_build_object('stored', v_old.occurred_at, 'read', v_new.occurred_at));
    end if;
    if v_new.type is distinct from v_old.type then
      v_changes := v_changes || jsonb_build_object('type', jsonb_build_object('stored', v_old.type, 'read', v_new.type));
    end if;
    if v_new.charge_type is distinct from v_old.charge_type then
      v_changes := v_changes || jsonb_build_object('charge_type', jsonb_build_object('stored', v_old.charge_type, 'read', v_new.charge_type));
    end if;
    if v_new.product_type is distinct from v_old.product_type then
      v_changes := v_changes || jsonb_build_object('product_type', jsonb_build_object('stored', v_old.product_type, 'read', v_new.product_type));
    end if;
    if v_new.product_id is distinct from v_old.product_id then
      v_changes := v_changes || jsonb_build_object('product_id', jsonb_build_object('stored', v_old.product_id, 'read', v_new.product_id));
    end if;
    if v_new.description is distinct from v_old.description then
      v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('stored', v_old.description, 'read', v_new.description));
    end if;
    if v_new.period is distinct from v_old.period then
      v_changes := v_changes || jsonb_build_object('period', jsonb_build_object('stored', v_old.period, 'read', v_new.period));
    end if;
    if v_new.old_balance_cents is distinct from v_old.old_balance_cents then
      v_changes := v_changes || jsonb_build_object('old_balance_cents', jsonb_build_object('stored', v_old.old_balance_cents, 'read', v_new.old_balance_cents));
    end if;
    if v_new.balance_cents is distinct from v_old.balance_cents then
      v_changes := v_changes || jsonb_build_object('balance_cents', jsonb_build_object('stored', v_old.balance_cents, 'read', v_new.balance_cents));
    end if;
    -- The same difference read again every hour is one revision, not many.
    if v_changes <> '{}'::jsonb and not exists (
         select 1 from public.supplier_ledger_revisions r
          where r.test_mode = p_test_mode and r.trace_id = v_new.trace_id
            and not r.applied and r.changes = v_changes) then
      insert into public.supplier_ledger_revisions (test_mode, trace_id, changes, applied)
      values (p_test_mode, v_new.trace_id, v_changes, false);
      v_revised := v_revised + 1;
    end if;
  end loop;

  perform public.match_supplier_ledger(p_test_mode);
  return jsonb_build_object('inserted', v_inserted, 'statusChanged', v_status, 'revised', v_revised);
end;
$$;

-- ── (b) Top-up costs ────────────────────────────────────────────────────────

create table public.float_topups (
  id             bigint generated always as identity primary key,
  trace_id       uuid not null,             -- the ledger credit (test_mode = false only)
  usd_cents      bigint not null check (usd_cents > 0),
  ngn_paid_kobo  bigint not null check (ngn_paid_kobo > 0),
  reference      text not null check (char_length(reference) between 1 and 80),
  supersedes_id  bigint unique,             -- a correction points at the row it replaces
  recorded_by    text not null,
  recorded_at    timestamptz not null default now()
);
create unique index float_topups_one_original on public.float_topups (trace_id) where supersedes_id is null;
alter table public.float_topups enable row level security;
revoke all on public.float_topups from public, anon, authenticated, service_role;
grant select on public.float_topups to service_role;
create trigger float_topups_final
  before update or delete on public.float_topups
  for each row execute function public.append_only_final();
create trigger float_topups_no_truncate
  before truncate on public.float_topups
  for each statement execute function public.append_only_final();

create function public.admin_record_float_topup(p_trace_id uuid, p_ngn_paid_kobo bigint, p_reference text,
                                                p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'topup.record';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_entry  public.supplier_ledger_entries;
  v_code   text;
  v_detail jsonb;
  v_id     bigint;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_trace_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_entry from public.supplier_ledger_entries
   where test_mode = false and trace_id = p_trace_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'live', 'ledger', p_trace_id::text, false, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('usd_cents', v_entry.delta_cents, 'ngn_paid_kobo', p_ngn_paid_kobo,
    'rate_kobo_per_cent', case when v_entry.delta_cents > 0 and p_ngn_paid_kobo > 0
                               then round(p_ngn_paid_kobo::numeric / v_entry.delta_cents, 4) end);
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and (v_entry.match_state <> 'topup' or v_entry.delta_cents <= 0) then v_code := 'NOT_TOPUP'; end if;
  if v_code is null and exists (select 1 from public.float_topups t where t.trace_id = p_trace_id) then
    v_code := 'ALREADY_RECORDED';
  end if;
  if v_code is null and coalesce(p_ngn_paid_kobo, 0) <= 0 then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is null and char_length(trim(coalesce(p_reference, ''))) not between 1 and 80 then
    v_code := 'BAD_REFERENCE';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'live', 'ledger', p_trace_id::text, false,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  insert into public.float_topups (trace_id, usd_cents, ngn_paid_kobo, reference, recorded_by)
  values (p_trace_id, v_entry.delta_cents, p_ngn_paid_kobo, trim(p_reference), v_admin.label)
  returning id into v_id;
  return public.admin_record(v_admin, c_action, 'live', 'ledger', p_trace_id::text, false,
    p_reason, p_request_key, 'ok', null, null, v_detail || jsonb_build_object('after', jsonb_build_object('topup_id', v_id)));
end $$;

create function public.admin_correct_float_topup(p_topup_id bigint, p_ngn_paid_kobo bigint, p_reference text,
                                                 p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'topup.correct';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_topup  public.float_topups;
  v_code   text;
  v_detail jsonb;
  v_id     bigint;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_topup_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_topup from public.float_topups where id = p_topup_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'live', 'topup', p_topup_id::text, false, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('ngn_paid_kobo', v_topup.ngn_paid_kobo, 'reference', v_topup.reference),
    'after', jsonb_build_object('ngn_paid_kobo', p_ngn_paid_kobo, 'reference', trim(coalesce(p_reference, ''))),
    'usd_cents', v_topup.usd_cents);
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and exists (select 1 from public.float_topups t where t.supersedes_id = p_topup_id) then
    v_code := 'NOT_CURRENT';
  end if;
  if v_code is null and coalesce(p_ngn_paid_kobo, 0) <= 0 then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is null and char_length(trim(coalesce(p_reference, ''))) not between 1 and 80 then
    v_code := 'BAD_REFERENCE';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'live', 'topup', p_topup_id::text, false,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  insert into public.float_topups (trace_id, usd_cents, ngn_paid_kobo, reference, supersedes_id, recorded_by)
  values (v_topup.trace_id, v_topup.usd_cents, p_ngn_paid_kobo, trim(p_reference), p_topup_id, v_admin.label)
  returning id into v_id;
  return public.admin_record(v_admin, c_action, 'live', 'topup', p_topup_id::text, false,
    p_reason, p_request_key, 'ok', null, null, v_detail || jsonb_build_object('topup_id', v_id));
end $$;

-- ── (c) Supplier cost per order line, service-only ──────────────────────────

create table public.order_item_costs (
  order_item_id       uuid primary key references public.order_items (id) on delete cascade,  -- purge_test_orders
  supplier_cost_cents bigint not null check (supplier_cost_cents >= 0),   -- supplier price for the line, ICANN excluded
  icann_fee_cents     bigint not null check (icann_fee_cents >= 0),       -- ICANN fee modelled for the line
  recorded_at         timestamptz not null default now()
);
alter table public.order_item_costs enable row level security;            -- no policies
revoke all on public.order_item_costs from public, anon, authenticated, service_role;
grant select, insert on public.order_item_costs to service_role;

create function public.order_item_costs_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a recorded line cost is never rewritten';
end;
$$;
create trigger order_item_costs_final
  before update on public.order_item_costs
  for each row execute function public.order_item_costs_final();
create trigger order_item_costs_no_truncate
  before truncate on public.order_item_costs
  for each statement execute function public.order_item_costs_final();

-- ── (d) Funnel counter ──────────────────────────────────────────────────────

create table public.funnel_daily (
  day       date not null,
  test_mode boolean not null,
  event     text not null check (event in ('cart_add')),
  count     integer not null default 0 check (count >= 0),
  primary key (day, test_mode, event)
);
alter table public.funnel_daily enable row level security;
revoke all on public.funnel_daily from public, anon, authenticated, service_role;
grant select on public.funnel_daily to service_role;

create function public.bump_funnel(p_event text, p_test_mode boolean) returns void
  language sql security definer set search_path = '' as $$
  insert into public.funnel_daily (day, test_mode, event, count)
  values ((now() at time zone 'Africa/Lagos')::date, p_test_mode, p_event, 1)
  on conflict (day, test_mode, event) do update set count = public.funnel_daily.count + 1 $$;

-- ── (e) The daily rollup ────────────────────────────────────────────────────

create table public.metrics_daily (
  day       date not null,
  test_mode boolean not null,
  metric    text not null,
  value     bigint not null,
  primary key (day, test_mode, metric)
);
alter table public.metrics_daily enable row level security;
revoke all on public.metrics_daily from public, anon, authenticated, service_role;
grant select on public.metrics_daily to service_role;

-- One Lagos day, both sides. Ledger series are not rolled up: the mirror is
-- never purged, so they are charted from it directly.
create function public.record_metrics_daily(p_day date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_side   boolean;
  v_from   timestamptz := (p_day::timestamp at time zone 'Africa/Lagos');
  v_to     timestamptz := ((p_day + 1)::timestamp at time zone 'Africa/Lagos');
  v_values jsonb;
  v_bal    record;
begin
  if p_day is null then
    raise exception 'record_metrics_daily: a day' using errcode = '22023';
  end if;
  foreach v_side in array array[false, true] loop
    v_values := jsonb_build_object(
      'net_sales_kobo', (select coalesce(sum(o.subtotal_kobo), 0) from public.orders o
                          where o.test_mode = v_side and o.payment_id is not null and o.paid_at >= v_from and o.paid_at < v_to),
      'vat_kobo', (select coalesce(sum(o.vat_kobo), 0) from public.orders o
                    where o.test_mode = v_side and o.payment_id is not null and o.paid_at >= v_from and o.paid_at < v_to),
      'orders_paid', (select count(*) from public.orders o
                       where o.test_mode = v_side and o.payment_id is not null and o.paid_at >= v_from and o.paid_at < v_to),
      'cash_in_kobo', (select coalesce(sum(p.amount_kobo), 0) from public.payments p join public.orders o on o.id = p.order_id
                        where o.test_mode = v_side and p.created_at >= v_from and p.created_at < v_to),
      'line_refunded_kobo', (select coalesce(sum(oi.price_kobo), 0) from public.refunds r
                              join public.order_items oi on oi.id = r.order_item_id
                             where r.test_mode = v_side and r.status = 'completed' and r.completed_at >= v_from and r.completed_at < v_to),
      'line_refunded_vat_kobo', (select coalesce(sum(r.amount_kobo - oi.price_kobo), 0) from public.refunds r
                                  join public.order_items oi on oi.id = r.order_item_id
                                 where r.test_mode = v_side and r.status = 'completed' and r.completed_at >= v_from and r.completed_at < v_to),
      'charge_refunded_kobo', (select coalesce(sum(r.amount_kobo), 0) from public.refunds r
                                where r.test_mode = v_side and r.status = 'completed' and r.order_item_id is null
                                  and r.completed_at >= v_from and r.completed_at < v_to),
      -- Accounts are not on a side: reserved (e2e and example) addresses count as test.
      'signups', (select count(*) from public.profiles p
                   where public.is_reserved_email(p.email::text) = v_side and p.created_at >= v_from and p.created_at < v_to),
      'emails_sent', (select count(*) from public.email_outbox e
                       where e.test_mode = v_side and e.sent_at >= v_from and e.sent_at < v_to),
      'emails_failed', (select count(*) from public.email_outbox e
                         where e.test_mode = v_side and e.status = 'failed' and e.updated_at >= v_from and e.updated_at < v_to),
      'emails_skipped', (select count(*) from public.email_outbox e
                          where e.test_mode = v_side and e.status = 'skipped' and e.created_at >= v_from and e.created_at < v_to),
      'emails_delivered', (select count(*) from public.email_outbox e
                            where e.test_mode = v_side and e.delivery_status = 'delivered' and e.sent_at >= v_from and e.sent_at < v_to),
      'emails_bounced', (select count(*) from public.email_outbox e
                          where e.test_mode = v_side and e.delivery_status = 'bounced' and e.sent_at >= v_from and e.sent_at < v_to),
      'alerts_opened', (select count(*) from public.ops_alerts a
                         where a.test_mode = v_side and a.first_seen_at >= v_from and a.first_seen_at < v_to),
      'alerts_resolved', (select count(*) from public.ops_alerts a
                           where a.test_mode = v_side and a.resolved_at >= v_from and a.resolved_at < v_to));
    select (array_agg(round(s.balance_usd * 100)::bigint order by s.taken_at))[1] as opening,
           (array_agg(round(s.balance_usd * 100)::bigint order by s.taken_at desc))[1] as closing,
           min(round(s.balance_usd * 100)::bigint) as lowest
      into v_bal
      from public.supplier_balance_snapshots s
     where s.test_mode = v_side and s.taken_at >= v_from and s.taken_at < v_to;
    if v_bal.closing is not null then
      v_values := v_values || jsonb_build_object('balance_open_cents', v_bal.opening,
                                                 'balance_close_cents', v_bal.closing,
                                                 'balance_min_cents', v_bal.lowest);
    end if;
    insert into public.metrics_daily (day, test_mode, metric, value)
    select p_day, v_side, m.key, (m.value #>> '{}')::bigint from jsonb_each(v_values) m
    on conflict (day, test_mode, metric) do update set value = excluded.value;
  end loop;
end;
$$;

-- ── (f) Indexes ─────────────────────────────────────────────────────────────

create index if not exists orders_side_paid on public.orders (test_mode, paid_at) where payment_id is not null;
create index if not exists domains_side_expiry on public.domains (test_mode, expires_at) where source <> 'demo';
create index if not exists refunds_side_status on public.refunds (test_mode, status, created_at);
create index if not exists email_outbox_side_created on public.email_outbox (test_mode, created_at);
create index if not exists supplier_calls_env_domain on public.supplier_calls (environment, domain_name, created_at);
create index if not exists supplier_ledger_side_time on public.supplier_ledger_entries (test_mode, occurred_at);

-- A timestamp from heartbeat JSON, or null: a malformed value must never
-- break the alert run.
create function public.try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

-- ── The float, for the dashboard and the cover alert ────────────────────────
-- FR-FLOAT-1/2/4 (§6): balance, what is already committed, the last 7 and 30
-- days' settled spend from the mirror, and the runway on the 7-day pace.
-- Integer cents throughout; no fallback to line costs when burn is unknown.
create function public.float_runway(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_env        text := case when p_test_mode then 'ote' else 'production' end;
  v_hb         public.service_heartbeats;
  v_read_at    timestamptz;
  v_balance    bigint;
  v_taken      timestamptz;
  v_alert      bigint;
  v_committed  bigint;
  v_uncosted   integer;
  v_burn7      bigint;
  v_burn30     bigint;
  v_first      timestamptz;
  v_state      text;
  v_runway     numeric;
  v_last       jsonb;
  v_last_burn  bigint;
  v_short      bigint;
  v_target     bigint;
  v_topups     jsonb;
begin
  select * into v_hb from public.service_heartbeats where name = 'supplier_ledger:' || v_env;
  v_read_at := public.try_timestamptz(case when v_hb.detail ->> 'outcome' = 'ok' then v_hb.detail ->> 'readAt'
                                           else v_hb.detail ->> 'lastOkReadAt' end);
  select round(s.balance_usd * 100)::bigint, s.taken_at into v_balance, v_taken
    from public.supplier_balance_snapshots s
   where s.test_mode = p_test_mode order by s.taken_at desc limit 1;
  select round(o.float_alert_usd * 100)::bigint into v_alert from public.ops_settings o where o.id;

  -- Committed: open registrations, renewals and transfers not yet submitted,
  -- and certificates not yet ordered — at the cost recorded at checkout, or
  -- today's price by the checkout's own rules where none was recorded.
  with lines as (
    select oi.item_type, oi.tld, oi.period_years, oi.ssl_product_code,
           c.supplier_cost_cents, c.icann_fee_cents
      from public.jobs j
      join public.order_items oi on oi.id = j.order_item_id
      left join public.order_item_costs c on c.order_item_id = oi.id
     where j.test_mode = p_test_mode
       and j.kind in ('register_domain', 'renew_domain', 'transfer_domain')
       and j.status in ('queued', 'running', 'needs_attention')
       and (j.kind <> 'transfer_domain' or j.submitted_at is null)
    union all
    select oi.item_type, oi.tld, oi.period_years, oi.ssl_product_code,
           c.supplier_cost_cents, c.icann_fee_cents
      from public.ssl_jobs sj
      join public.ssl_certificates sc on sc.id = sj.certificate_id
      join public.order_items oi on oi.id = sc.order_item_id
      left join public.order_item_costs c on c.order_item_id = oi.id
     where sj.test_mode = p_test_mode and sj.kind = 'ssl_initialize' and sj.sent_at is null
       and sj.status in ('queued', 'running', 'needs_attention')
  ), priced as (
    select l.supplier_cost_cents is null as uncosted,
           case
             when l.supplier_cost_cents is not null then l.supplier_cost_cents + l.icann_fee_cents
             when l.item_type = 'register' then round((
                 t.register_usd * least(coalesce(t.register_periods[1], t.min_period, 1), l.period_years)
               + t.renew_usd * greatest(l.period_years - coalesce(t.register_periods[1], t.min_period, 1), 0)
               + (case when t.is_country_code then 0 else ps.icann_fee_usd end) * l.period_years) * 100)::bigint
             when l.item_type = 'renew' then round(
                 (t.renew_usd + case when t.is_country_code then 0 else ps.icann_fee_usd end) * l.period_years * 100)::bigint
             when l.item_type = 'transfer' then round(
                 (coalesce(t.transfer_usd, 0) + case when t.is_country_code then 0 else ps.icann_fee_usd end) * 100)::bigint
             when l.item_type = 'ssl' then round(coalesce(sp.create_usd, 0) * 100)::bigint
             else 0
           end as cents
      from lines l
      left join public.tlds t on t.name = l.tld
      left join public.ssl_products sp on sp.product_code = l.ssl_product_code
      cross join public.pricing_settings ps
  )
  select coalesce(sum(cents), 0), count(*) filter (where uncosted) into v_committed, v_uncosted from priced;

  select coalesce(sum(-e.delta_cents) filter (where e.occurred_at > now() - interval '7 days'), 0),
         coalesce(sum(-e.delta_cents) filter (where e.occurred_at > now() - interval '30 days'), 0)
    into v_burn7, v_burn30
    from public.supplier_ledger_entries e
   where e.test_mode = p_test_mode and e.status = 1 and e.delta_cents < 0 and e.description not like 'e2e-%';
  select min(e.occurred_at) into v_first from public.supplier_ledger_entries e
   where e.test_mode = p_test_mode and e.description not like 'e2e-%';

  v_state := case
               when v_hb.name is null or v_hb.beat_at < now() - interval '3 hours'
                    or coalesce(v_hb.detail ->> 'outcome', '') = 'failed' then 'stale'
               when v_first is null or v_first > now() - interval '7 days' then 'short_history'
               else 'known'
             end;
  if v_balance is not null and v_balance < v_committed then
    v_short := v_committed - v_balance;
  end if;
  if v_state = 'known' and v_burn7 > 0 and v_balance is not null then
    v_runway := greatest(round((v_balance - v_committed)::numeric / (v_burn7::numeric / 7), 1), 0);
  end if;
  if v_state = 'stale' and v_read_at is not null and v_balance is not null then
    select coalesce(sum(-e.delta_cents), 0) into v_last_burn
      from public.supplier_ledger_entries e
     where e.test_mode = p_test_mode and e.status = 1 and e.delta_cents < 0 and e.description not like 'e2e-%'
       and e.occurred_at > v_read_at - interval '7 days' and e.occurred_at <= v_read_at;
    if v_last_burn > 0 then
      v_last := jsonb_build_object('days', greatest(round((v_balance - v_committed)::numeric / (v_last_burn::numeric / 7), 1), 0),
                                   'at', v_read_at);
    end if;
  end if;
  v_target := 3 * v_burn7 + v_committed;   -- 21 days of the 7-day pace, plus what is committed

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'traceId', e.trace_id, 'occurredAt', e.occurred_at, 'usdCents', e.delta_cents,
           'ngnPaidKobo', t.ngn_paid_kobo,
           'rateKoboPerCent', case when t.id is not null then round(t.ngn_paid_kobo::numeric / t.usd_cents, 4) end,
           'reference', t.reference, 'supersedesId', t.supersedes_id, 'recordedBy', t.recorded_by)
           order by e.occurred_at desc), '[]'::jsonb)
    into v_topups
    from (select * from public.supplier_ledger_entries x
           where x.test_mode = p_test_mode and x.match_state = 'topup' and x.description not like 'e2e-%'
           order by x.occurred_at desc limit 20) e
    left join public.float_topups t
      on not p_test_mode and t.trace_id = e.trace_id
     and not exists (select 1 from public.float_topups n where n.supersedes_id = t.id);

  return jsonb_build_object(
    'side', case when p_test_mode then 'test' else 'live' end,
    'balanceCents', v_balance, 'takenAt', v_taken, 'alertCents', v_alert,
    'committedCents', v_committed, 'uncostedLines', v_uncosted,
    'burn7dCents', v_burn7, 'burn30dCents', v_burn30, 'burnState', v_state,
    'runwayDays', v_runway, 'lastKnownRunway', v_last, 'shortByCents', v_short,
    'target21dCents', v_target,
    'topUpToTargetCents', case when v_balance is null then null else greatest(v_target - v_balance, 0) end,
    'topups', v_topups,
    'ledgerSyncedAt', v_hb.beat_at, 'ledgerReadAt', v_read_at);
end;
$$;

-- ── (g) Alert conditions ────────────────────────────────────────────────────

create function public.ledger_alert_conditions(p_test_mode boolean)
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  with hb as (
    select h.*,
           public.try_timestamptz(case when h.detail ->> 'outcome' = 'ok' then h.detail ->> 'readAt'
                                       else h.detail ->> 'lastOkReadAt' end) as read_at
      from public.service_heartbeats h
     where h.name = 'supplier_ledger:' || case when p_test_mode then 'ote' else 'production' end
       and h.test_mode = p_test_mode
  ), e as (
    select x.* from public.supplier_ledger_entries x
     where x.test_mode = p_test_mode and x.description not like 'e2e-%' and exists (select 1 from hb)
  ), side as (
    select case when p_test_mode then 'test' else 'live' end as name
  )
  select 'ledger_unexplained:' || e.trace_id, 'critical', 'supplier_unexplained_charge',
         format('A supplier charge of $%s (%s) with no matching provisioning call: supplier panel use, a leaked key, or a supplier-side change (automatic renewal is off for our account per BACKLOG L18; verify).',
                to_char(-e.delta_cents / 100.0, 'FM999,999,990.00'), left(e.description, 80))
    from e
   where e.match_state = 'unexplained' and e.occurred_at > now() - interval '90 days'

  union all
  select 'ledger_double:' || e.trace_id, 'critical', 'supplier_double_charge',
         format('The supplier charged twice for one provisioning call or order line: $%s (%s)',
                to_char(-e.delta_cents / 100.0, 'FM999,999,990.00'), left(e.description, 80))
    from e
   where e.delta_cents < 0 and e.occurred_at > now() - interval '90 days'
     and exists (select 1 from e o
                  where o.trace_id <> e.trace_id and o.delta_cents < 0
                    and ((o.match_call_id is not null and o.match_call_id = e.match_call_id)
                         or (o.match_order_item_id is not null and o.match_order_item_id = e.match_order_item_id)))

  union all
  select 'ledger_refunded_line:' || e.trace_id, 'critical', 'supplier_charge_on_refunded_line',
         format('The supplier charged $%s for %s, a line we failed or refunded',
                to_char(-e.delta_cents / 100.0, 'FM999,999,990.00'), oi.domain)
    from e
    join public.order_items oi on oi.id = e.match_order_item_id
   where e.delta_cents < 0 and e.occurred_at > now() - interval '90 days'
     and oi.status in ('failed', 'refunded')

  union all
  select 'ledger_missing:' || oi.id, 'warning', 'supplier_missing_charge',
         format('No supplier charge matched for %s (%s, order %s) six hours after it completed',
                oi.domain, oi.item_type, o.order_number)
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.jobs j on j.order_item_id = oi.id
   where not p_test_mode and exists (select 1 from hb)
     and o.test_mode = false
     and oi.status = 'completed' and oi.item_type in ('register', 'renew', 'transfer')
     and j.kind in ('register_domain', 'renew_domain', 'transfer_domain') and j.status = 'succeeded'
     and j.finished_at < now() - interval '6 hours'
     and j.finished_at > now() - interval '30 days'
     and j.finished_at > (select min(x.occurred_at) from e x)
     and not exists (select 1 from e x where x.match_order_item_id = oi.id and x.delta_cents < 0)

  union all
  select 'ledger_price:' || e.trace_id, 'warning', 'supplier_price_drift',
         format('The supplier charged $%s for %s, recorded at checkout as $%s',
                to_char(-e.delta_cents / 100.0, 'FM999,999,990.00'), oi.domain,
                to_char(c.supplier_cost_cents / 100.0, 'FM999,999,990.00'))
    from e
    join public.order_item_costs c on c.order_item_id = e.match_order_item_id
    join public.order_items oi on oi.id = e.match_order_item_id
   where e.match_state = 'matched' and e.delta_cents < 0 and e.occurred_at > now() - interval '90 days'
     and abs(-e.delta_cents - c.supplier_cost_cents) > 1

  union all
  select 'ledger_unclassified:' || e.trace_id, 'warning', 'supplier_ledger_unclassified',
         format('A supplier ledger entry we cannot classify or that is not settled: type %s, status %s, charge %s, product %s, %s$%s',
                e.type, e.status, e.charge_type, e.product_type,
                case when e.delta_cents < 0 then '-' else '+' end,
                to_char(abs(e.delta_cents) / 100.0, 'FM999,999,990.00'))
    from e
   where e.match_state = 'unclassified' and e.occurred_at > now() - interval '90 days'

  union all
  select distinct on (r.trace_id) 'ledger_changed:' || r.trace_id, 'warning', 'supplier_ledger_changed',
         'The supplier changed a past ledger entry''s facts — compare the revision with what we stored'
    from public.supplier_ledger_revisions r
    join e on e.trace_id = r.trace_id
   where r.test_mode = p_test_mode and not r.applied and r.seen_at > now() - interval '7 days'

  union all
  select 'ledger_gap:' || s.name, 'warning', 'supplier_ledger_gap',
         'The supplier ledger''s running balance does not add up: an entry is missing, or a balance snapshot between the last entry and the last complete read disagrees with it'
    from side s
   where exists (
           select 1 from (
             select x.old_balance_cents,
                    lag(x.balance_cents) over (order by x.occurred_at, x.trace_id) as previous
               from e x) chain
            where chain.previous is not null and chain.old_balance_cents <> chain.previous)
      or exists (
           select 1
             from (select x.* from e x order by x.occurred_at desc, x.trace_id desc limit 1) last
             cross join hb
             join public.supplier_balance_snapshots b
               on b.test_mode = p_test_mode
              and b.taken_at > last.occurred_at + interval '5 minutes'
              and hb.read_at is not null
              and b.taken_at < hb.read_at
            where abs(round(b.balance_usd * 100)::bigint - last.balance_cents) > 1)

  union all
  select 'ledger_stale:' || s.name, 'warning', 'supplier_ledger_stale',
         format('The supplier ledger has not been read successfully since %s',
                coalesce(to_char(hb.read_at, 'DD Mon HH24:MI'), 'it started'))
    from side s cross join hb
   where hb.beat_at < now() - interval '3 hours' or coalesce(hb.detail ->> 'outcome', '') = 'failed'

  union all
  select 'float_cover:' || s.name,
         case when (f.v ->> 'runwayDays')::numeric < 3 then 'critical' else 'warning' end,
         'float_low_cover',
         format('The supplier float covers about %s days at the last 7 days'' spend — top up (FR-FLOAT-2)',
                f.v ->> 'runwayDays')
    from side s
    cross join (select public.float_runway(p_test_mode) as v) f
   where exists (select 1 from hb)
     and f.v ->> 'burnState' = 'known'
     and f.v ->> 'runwayDays' is not null
     and (f.v ->> 'runwayDays')::numeric < 10
$$;

-- Changes to admin access and unusual admin activity — live side only.
create function public.admin_alert_conditions(p_test_mode boolean)
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'admin_changed:' || c.id, 'critical', 'admin_changed',
         format('Admin access changed in the database: %s of %s (%s, %s linked devices%s) by %s. If you did not do this, revoke it now (DEPLOY.md §6b).',
                lower(c.op), c.label, coalesce(c.role, 'no role'), coalesce(c.factor_count, 0),
                case when c.revoked then ', revoked' else '' end, c.db_user)
    from public.admin_changes c
   where not p_test_mode and not c.test_only and c.at > now() - interval '24 hours'

  union all
  select 'admin_factor_missing:' || a.label,
         case when v.still = 0 then 'critical' else 'warning' end,
         'admin_factor_missing',
         format('Admin %s: %s of %s linked authenticators are no longer verified — re-link the devices (DEPLOY.md §6b)',
                a.label, cardinality(a.mfa_factor_ids) - v.still, cardinality(a.mfa_factor_ids))
    from public.admins a
    cross join lateral (
      select count(*)::integer as still from auth.mfa_factors f
       where f.id = any (a.mfa_factor_ids) and f.user_id = a.user_id
         and f.status = 'verified' and f.factor_type = 'totp') v
   where not p_test_mode and a.revoked_at is null and not a.test_only
     and v.still < cardinality(a.mfa_factor_ids)

  union all
  select 'admin_burst:' || l.admin_label, 'warning', 'admin_burst',
         format('Admin %s looked up %s customers or registrants in the last hour', l.admin_label, count(*))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action in ('customer.search', 'customer.reveal', 'domain.reveal_contacts')
     and l.created_at > now() - interval '1 hour'
   group by l.admin_label
  having count(*) >= 20

  union all
  select 'admin_limit_raised:' || l.id, 'warning', 'admin_limit_raised',
         format('Admin %s raised a refund limit or shortened the refund delay: %s',
                l.admin_label, left(coalesce((l.detail -> 'after')::text, ''), 200))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action = 'settings.refund_limit_raise' and l.outcome = 'ok'
     and l.created_at > now() - interval '24 hours'

  union all
  select 'admin_preset_changed:' || l.id, 'warning', 'admin_preset_changed',
         format('Admin %s: %s for %s — nameservers %s → %s',
                l.admin_label, replace(l.action, 'preset.', 'preset '), coalesce(l.detail ->> 'provider', 'a preset'),
                coalesce(array_to_string(array(select jsonb_array_elements_text(
                  case when jsonb_typeof(l.detail #> '{before,nameservers}') = 'array'
                       then l.detail #> '{before,nameservers}' else '[]'::jsonb end)), ', '), 'none'),
                coalesce(array_to_string(array(select jsonb_array_elements_text(
                  case when jsonb_typeof(l.detail #> '{after,nameservers}') = 'array'
                       then l.detail #> '{after,nameservers}' else '[]'::jsonb end)), ', '), 'none'))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action in ('preset.draft_save', 'preset.publish', 'preset.show', 'preset.hide') and l.outcome = 'ok'
     and l.created_at > now() - interval '24 hours'
$$;

-- pg_cron, read as the definer (service_role cannot read the cron schema).
create function public.cron_alert_conditions(p_test_mode boolean)
returns table (key text, severity text, kind text, summary text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'cron_stale:email-notices', 'critical', 'cron_stale',
         'The daily expiry-notice job (email-notices) has not succeeded for over 26 hours — ERRP notices are not being queued'
   where not p_test_mode
     and exists (select 1 from cron.job j where j.jobname = 'email-notices')
     and not exists (
       select 1 from cron.job j
         join cron.job_run_details d on d.jobid = j.jobid
        where j.jobname = 'email-notices' and d.status = 'succeeded'
          and coalesce(d.end_time, d.start_time) > now() - interval '26 hours')

  union all
  select 'cron_failed:' || j.jobname, 'warning', 'cron_failed',
         format('The scheduled job %s failed on its last run (%s UTC)', j.jobname,
                to_char(last.start_time at time zone 'UTC', 'DD Mon HH24:MI'))
    from cron.job j
    cross join lateral (
      select d.status, d.start_time from cron.job_run_details d
       where d.jobid = j.jobid
       order by d.start_time desc nulls last, d.runid desc
       limit 1) last
   where not p_test_mode and last.status = 'failed'
$$;

-- current_alert_conditions, re-created from the live definition
-- (pg_get_functiondef, 2 Oct 2026) with the three new families appended.
-- `create or replace` keeps its grants; admin_data.sql asserts them.
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
  -- The same for certificates (migration 39): never refunded or re-sent by itself.
  select 'ssl_job:' || j.id,
         'critical',
         'ssl_job_needs_attention',
         format('%s of the SSL certificate for %s%s needs a person (%s)',
                case j.kind
                  when 'ssl_initialize' then 'The order'
                  when 'ssl_configure' then 'The set-up'
                  when 'ssl_reissue' then 'The reissue'
                  else 'A job'
                end,
                c.common_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.ssl_jobs j
    join public.ssl_certificates c on c.id = j.certificate_id
    left join public.order_items oi on oi.id = c.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- A status word from the supplier we do not know, for a day.
  select 'ssl_status:' || c.id,
         'warning',
         'ssl_status_unrecognised',
         format('The supplier calls the SSL certificate for %s "%s", which we do not recognise — check it and teach the gateway the word',
                c.common_name, coalesce(c.supplier_status, ''))
    from public.ssl_certificates c
   where c.test_mode = p_test_mode
     and c.status_unrecognised_since < now() - interval '1 day'

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
  -- The weekly catalogue syncs inside the gateway (migrations 27 and 39): the
  -- last run failed or was refused, or nothing has succeeded for eight days.
  -- Prices then drift from the supplier's.
  select 'catalogue_sync:' || h.name,
         'warning',
         'catalogue_sync',
         case
           when h.detail ->> 'outcome' in ('failed', 'refused')
             then format('The supplier %s sync %s on %s — prices are not being updated',
                         case when h.name like 'ssl%' then 'SSL product' else 'catalogue' end,
                         h.detail ->> 'outcome', to_char(h.beat_at, 'DD Mon HH24:MI'))
           else format('The supplier %s has not synced for over eight days — prices are not being updated',
                       case when h.name like 'ssl%' then 'SSL product list' else 'catalogue' end)
         end
    from public.service_heartbeats h
   where p_test_mode = false
     and h.name in ('catalogue:production', 'ssl_catalogue:production')
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
  -- has no credentials for its provider (EMAIL_PROVIDER), or the provider is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and its provider''s credentials (EMAIL_PROVIDER)',
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

  union all
  -- FR-NT3: an ERRP or security email with no final delivery report a day
  -- after sending. SES pushes its reports (migration 34) and Brevo is read
  -- back; either way a missing one is not a delivery. Raised for three days.
  select 'email_unconfirmed:' || e.id,
         case when e.category = 'compliance' then 'critical' else 'warning' end,
         'email_unconfirmed',
         format('A %s email (%s%s) sent %s UTC has no delivery report — check the email provider''s log; it is not counted as delivered',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                to_char(e.sent_at at time zone 'UTC', 'DD Mon HH24:MI'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'sent'
     and e.category in ('compliance', 'security')
     and coalesce(e.delivery_status, 'deferred') = 'deferred'
     and e.sent_at < now() - interval '24 hours'
     and e.sent_at > now() - interval '4 days'

  union all
  -- A recipient reported one of our emails as spam (SES, migration 34).
  -- Complaints cost the sending domain its reputation, and SES now
  -- suppresses the address. Raised for three days.
  select 'email_complaint:' || e.id,
         'warning',
         'email_complaint',
         format('A %s email (%s%s) was reported as spam by its recipient — SES will not send to that address again until it leaves the account''s suppression list',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.complained_at > now() - interval '3 days'

  union all
  -- Migration 41: the supplier ledger's exceptions (§7.4).
  select l.key, l.severity, l.kind, l.summary from public.ledger_alert_conditions(p_test_mode) l

  union all
  -- Migration 41: changes to admin access and unusual admin activity (live only).
  select a.key, a.severity, a.kind, a.summary from public.admin_alert_conditions(p_test_mode) a

  union all
  -- Migration 41: pg_cron housekeeping and the ERRP notice job (live only).
  select c.key, c.severity, c.kind, c.summary from public.cron_alert_conditions(p_test_mode) c
$function$
;

-- ── (h) Admin read functions ────────────────────────────────────────────────
-- Each asserts an admin session; a test admin asking for the live side gets
-- admin:test_admin. Money is kobo or integer cents (D24); dates are Lagos
-- days; demo domains never count.

create function public.admin_read_gate(p_test_mode boolean)
returns public.admins
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
begin
  if v_admin.test_only and not coalesce(p_test_mode, false) then
    raise exception using errcode = '42501', message = 'admin:test_admin';
  end if;
  return v_admin;
end;
$$;

-- Sales over a window, for the overview's KPI row (§6).
create function public.admin_sales_since(p_test_mode boolean, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'netKobo', (select coalesce(sum(o.subtotal_kobo), 0) from public.orders o
                 where o.test_mode = p_test_mode and o.payment_id is not null and o.paid_at > p_since),
    'vatKobo', (select coalesce(sum(o.vat_kobo), 0) from public.orders o
                 where o.test_mode = p_test_mode and o.payment_id is not null and o.paid_at > p_since),
    'cashKobo', (select coalesce(sum(p.amount_kobo), 0) from public.payments p join public.orders o on o.id = p.order_id
                  where o.test_mode = p_test_mode and p.created_at > p_since),
    'ordersPaid', (select count(*) from public.orders o
                    where o.test_mode = p_test_mode and o.payment_id is not null and o.paid_at > p_since),
    'lineRefundedKobo', (select coalesce(sum(oi.price_kobo), 0) from public.refunds r
                          join public.order_items oi on oi.id = r.order_item_id
                         where r.test_mode = p_test_mode and r.status = 'completed' and r.completed_at > p_since),
    'chargeRefundedKobo', (select coalesce(sum(r.amount_kobo), 0) from public.refunds r
                            where r.test_mode = p_test_mode and r.status = 'completed'
                              and r.order_item_id is null and r.completed_at > p_since))
$$;

create function public.admin_attention_counts(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return jsonb_build_object(
    'refunds', (select count(*) from public.refunds r
                 where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')),
    'jobs', (select count(*) from public.jobs j where j.test_mode = p_test_mode and j.status = 'needs_attention')
            + (select count(*) from public.ssl_jobs j where j.test_mode = p_test_mode and j.status = 'needs_attention'),
    'incidents', (select count(*) from public.payment_incidents i
                   where i.test_mode = p_test_mode and i.resolved_at is null),
    'alertsCritical', (select count(*) from public.ops_alerts a
                        where a.test_mode = p_test_mode and a.resolved_at is null and a.severity = 'critical'),
    'alertsWarning', (select count(*) from public.ops_alerts a
                       where a.test_mode = p_test_mode and a.resolved_at is null and a.severity = 'warning'),
    'drift', (select count(*) from public.registry_drift g where g.test_mode = p_test_mode and g.resolved_at is null),
    'stuckOrders', (select count(*) from public.orders o cross join public.ops_settings s
                     where o.test_mode = p_test_mode and o.status in ('paid', 'provisioning')
                       and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
                       and exists (select 1 from public.order_items oi
                                    where oi.order_id = o.id and oi.status in ('pending', 'provisioning')
                                      and not (oi.item_type = 'transfer' and exists (
                                        select 1 from public.domains d
                                         where d.order_item_id = oi.id and d.local_status = 'transfer_pending')))),
    'pendingWithoutJob', (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id
                           where o.test_mode = p_test_mode and o.payment_id is not null
                             and o.paid_at < now() - interval '5 minutes'
                             and oi.status = 'pending'
                             and ((oi.item_type in ('register', 'renew', 'transfer')
                                   and not exists (select 1 from public.jobs j where j.order_item_id = oi.id))
                                  or (oi.item_type = 'ssl'
                                      and not exists (select 1 from public.ssl_certificates c where c.order_item_id = oi.id)))),
    'emailsFailed', (select count(*) from public.email_outbox e where e.test_mode = p_test_mode and e.status = 'failed'),
    'ledgerUnexplained', (select count(*) from public.ledger_alert_conditions(p_test_mode) c
                           where c.kind in ('supplier_unexplained_charge', 'supplier_double_charge',
                                            'supplier_charge_on_refunded_line')),
    'presetDrafts', (select count(*) from public.nameserver_preset_drafts d
                      where d.published_at is null and d.discarded_at is null));
end;
$$;

create function public.admin_overview(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_read_gate(p_test_mode);
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_out   jsonb;
  v_cron  jsonb;
begin
  v_out := jsonb_build_object(
    'sales', jsonb_build_object(
      'd1', public.admin_sales_since(p_test_mode, now() - interval '1 day'),
      'd7', public.admin_sales_since(p_test_mode, now() - interval '7 days'),
      'd30', public.admin_sales_since(p_test_mode, now() - interval '30 days'),
      'd90', public.admin_sales_since(p_test_mode, now() - interval '90 days')),
    'lines', jsonb_build_object('d30', (
      select jsonb_build_object(
               'register', count(*) filter (where oi.item_type = 'register'),
               'renew', count(*) filter (where oi.item_type = 'renew'),
               'transfer', count(*) filter (where oi.item_type = 'transfer'),
               'ssl', count(*) filter (where oi.item_type = 'ssl'))
        from public.order_items oi join public.orders o on o.id = oi.order_id
       where o.test_mode = p_test_mode and o.payment_id is not null and o.paid_at > now() - interval '30 days')),
    'float', public.float_runway(p_test_mode),
    'health', jsonb_build_object(
      'heartbeats', (select coalesce(jsonb_agg(jsonb_build_object('name', h.name, 'beatAt', h.beat_at,
                                                                  'outcome', h.detail ->> 'outcome') order by h.name), '[]'::jsonb)
                       from public.service_heartbeats h where h.test_mode = p_test_mode),
      'reconcile', (select jsonb_build_object('finishedAt', r.finished_at, 'error', left(r.error, 200))
                      from public.reconcile_runs r where r.test_mode = p_test_mode and r.finished_at is not null
                     order by r.finished_at desc limit 1),
      'fx', (select jsonb_build_object(
                      'activeFrom', a.effective_from, 'costingRate', a.costing_rate,
                      'pendingCount', (select count(*) from public.fx_rates p where p.status = 'pending_review'),
                      'pendingOldestAt', (select min(p.quoted_at) from public.fx_rates p where p.status = 'pending_review'))
               from (select 1) one
               left join lateral (select * from public.fx_rates f where f.status = 'active'
                                   order by f.effective_from desc nulls last limit 1) a on true),
      'snapshotAt', (select max(s.taken_at) from public.supplier_balance_snapshots s where s.test_mode = p_test_mode)),
    'signups7d', (select count(*) from public.profiles p
                   where public.is_reserved_email(p.email::text) = p_test_mode and p.created_at > now() - interval '7 days'),
    'expiries30d', (select count(*) from public.domains d
                     where d.test_mode = p_test_mode and d.source <> 'demo'
                       and d.local_status in ('active', 'expired_grace', 'redemption')
                       and d.expires_at between now() and now() + interval '30 days'),
    'revenueByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'netKobo', coalesce(s.net, 0)) order by g.day), '[]'::jsonb)
                       from generate_series((v_today - 29)::timestamp, v_today::timestamp, interval '1 day') as g(day)
                       left join (select (o.paid_at at time zone 'Africa/Lagos')::date as day, sum(o.subtotal_kobo) as net
                                    from public.orders o
                                   where o.test_mode = p_test_mode and o.payment_id is not null
                                     and o.paid_at > now() - interval '31 days'
                                   group by 1) s on s.day = g.day::date),
    'balanceByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'closeCents', s.close) order by g.day), '[]'::jsonb)
                       from generate_series((v_today - 29)::timestamp, v_today::timestamp, interval '1 day') as g(day)
                       left join (select distinct on ((b.taken_at at time zone 'Africa/Lagos')::date)
                                         (b.taken_at at time zone 'Africa/Lagos')::date as day,
                                         round(b.balance_usd * 100)::bigint as close
                                    from public.supplier_balance_snapshots b
                                   where b.test_mode = p_test_mode and b.taken_at > now() - interval '31 days'
                                   order by (b.taken_at at time zone 'Africa/Lagos')::date, b.taken_at desc) s
                         on s.day = g.day::date),
    'renewalsByMonth', (select coalesce(jsonb_agg(jsonb_build_object('month', g.month::date, 'count', coalesce(s.n, 0)) order by g.month), '[]'::jsonb)
                          from generate_series(date_trunc('month', v_today::timestamp),
                                               date_trunc('month', v_today::timestamp) + interval '5 months',
                                               interval '1 month') as g(month)
                          left join (select date_trunc('month', (d.expires_at at time zone 'Africa/Lagos')) as month, count(*) as n
                                       from public.domains d
                                      where d.test_mode = p_test_mode and d.source <> 'demo'
                                        and d.local_status in ('active', 'expired_grace', 'redemption')
                                        and d.expires_at >= now() and d.expires_at < now() + interval '6 months'
                                      group by 1) s on s.month = g.month),
    'domainsByStatus', (select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n) order by s.n desc), '[]'::jsonb)
                          from (select d.local_status::text as status, count(*) as n from public.domains d
                                 where d.test_mode = p_test_mode and d.source <> 'demo' group by 1) s));
  if not v_admin.test_only then
    select coalesce(jsonb_agg(jsonb_build_object(
             'job', j.jobname, 'schedule', j.schedule, 'lastRunAt', last.start_time, 'lastStatus', last.status,
             'lastSuccessAt', (select max(coalesce(d.end_time, d.start_time)) from cron.job_run_details d
                                where d.jobid = j.jobid and d.status = 'succeeded')) order by j.jobname), '[]'::jsonb)
      into v_cron
      from cron.job j
      left join lateral (select d.status, d.start_time from cron.job_run_details d
                          where d.jobid = j.jobid order by d.start_time desc nulls last, d.runid desc limit 1) last on true;
    v_out := jsonb_set(v_out, '{health,cron}', v_cron);
  end if;
  return v_out;
end;
$$;

create function public.admin_revenue(p_test_mode boolean, p_grain text, p_from date, p_to date)
returns table (bucket date, orders bigint, net_kobo bigint, vat_kobo bigint, cash_kobo bigint,
               line_refunded_kobo bigint, line_refunded_vat_kobo bigint, charge_refunded_kobo bigint,
               fee_kobo bigint, fee_absorbed_kobo bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_grain text := case when p_grain in ('day', 'week', 'month') then p_grain else 'day' end;
begin
  perform public.admin_read_gate(p_test_mode);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;
  return query
  with buckets as (
    select date_trunc(v_grain, g)::date as bucket
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
     group by 1
  ), paid as (
    select date_trunc(v_grain, (o.paid_at at time zone 'Africa/Lagos'))::date as bucket,
           count(*) as orders, sum(o.subtotal_kobo) as net, sum(o.vat_kobo) as vat
      from public.orders o
     where o.test_mode = p_test_mode and o.payment_id is not null
       and (o.paid_at at time zone 'Africa/Lagos')::date between p_from and p_to
     group by 1
  ), cash as (
    select date_trunc(v_grain, (p.created_at at time zone 'Africa/Lagos'))::date as bucket,
           sum(p.amount_kobo) as cash,
           sum(case when coalesce(p.raw ->> 'app_fee', '') ~ '^-?\d+(\.\d+)?$'
                    then round((p.raw ->> 'app_fee')::numeric * 100)::bigint else 0 end) as fee,
           sum(case when coalesce(p.raw ->> 'app_fee', '') ~ '^-?\d+(\.\d+)?$'
                     and coalesce(p.raw ->> 'charged_amount', '') ~ '^-?\d+(\.\d+)?$'
                     and round((p.raw ->> 'charged_amount')::numeric * 100)::bigint = p.amount_kobo
                    then round((p.raw ->> 'app_fee')::numeric * 100)::bigint else 0 end) as absorbed
      from public.payments p join public.orders o on o.id = p.order_id
     where o.test_mode = p_test_mode
       and (p.created_at at time zone 'Africa/Lagos')::date between p_from and p_to
     group by 1
  ), refunded as (
    select date_trunc(v_grain, (r.completed_at at time zone 'Africa/Lagos'))::date as bucket,
           sum(oi.price_kobo) filter (where r.order_item_id is not null) as line,
           sum(r.amount_kobo - oi.price_kobo) filter (where r.order_item_id is not null) as line_vat,
           sum(r.amount_kobo) filter (where r.order_item_id is null) as charge
      from public.refunds r left join public.order_items oi on oi.id = r.order_item_id
     where r.test_mode = p_test_mode and r.status = 'completed'
       and (r.completed_at at time zone 'Africa/Lagos')::date between p_from and p_to
     group by 1
  )
  select b.bucket, coalesce(paid.orders, 0)::bigint, coalesce(paid.net, 0)::bigint, coalesce(paid.vat, 0)::bigint,
         coalesce(cash.cash, 0)::bigint, coalesce(refunded.line, 0)::bigint, coalesce(refunded.line_vat, 0)::bigint,
         coalesce(refunded.charge, 0)::bigint, coalesce(cash.fee, 0)::bigint, coalesce(cash.absorbed, 0)::bigint
    from buckets b
    left join paid on paid.bucket = b.bucket
    left join cash on cash.bucket = b.bucket
    left join refunded on refunded.bucket = b.bucket
   order by b.bucket;
end;
$$;

-- D13: margin only from real cost, at the rate charged. Matched ledger debit
-- first, then the cost recorded at checkout; uncosted lines are counted and
-- left out of the margin. A matched debit on a failed or refunded line is
-- shown as `lost`.
create function public.admin_margin(p_test_mode boolean, p_from date, p_to date)
returns table (month date, row_kind text, item_type text, lines bigint, costed_lines bigint, revenue_kobo bigint,
               cost_kobo bigint, margin_kobo bigint, cost_topup_kobo bigint, cost_source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_topup_rate numeric;
begin
  perform public.admin_read_gate(p_test_mode);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;
  -- The latest current top-up's effective kobo per cent (live only).
  select t.ngn_paid_kobo::numeric / t.usd_cents into v_topup_rate
    from public.float_topups t
    join public.supplier_ledger_entries e on e.test_mode = false and e.trace_id = t.trace_id
   where not p_test_mode and not exists (select 1 from public.float_topups n where n.supersedes_id = t.id)
   order by e.occurred_at desc limit 1;
  return query
  with lined as (
    select date_trunc('month', (o.paid_at at time zone 'Africa/Lagos'))::date as month,
           case when oi.status in ('failed', 'refunded') then 'lost' else 'sold' end as row_kind,
           oi.item_type, oi.price_kobo, f.costing_rate,
           (select sum(-e.delta_cents) from public.supplier_ledger_entries e
             where e.test_mode = p_test_mode and e.match_order_item_id = oi.id and e.delta_cents < 0
               and e.status = 1) as ledger_cents,
           c.supplier_cost_cents + c.icann_fee_cents as checkout_cents
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.fx_rates f on f.id = o.fx_rate_id
      left join public.order_item_costs c on c.order_item_id = oi.id
     where o.test_mode = p_test_mode and o.payment_id is not null
       and (o.paid_at at time zone 'Africa/Lagos')::date between p_from and p_to
       and oi.status in ('completed', 'failed', 'refunded')
  ), costed as (
    select l.month, l.row_kind, l.item_type, l.price_kobo, l.costing_rate,
           case when l.ledger_cents is not null then 'ledger'
                when l.row_kind = 'sold' and l.checkout_cents is not null then 'checkout'
                else 'none' end as cost_source,
           case when l.ledger_cents is not null then l.ledger_cents
                when l.row_kind = 'sold' then l.checkout_cents end as cost_cents
      from lined l
     -- A failed or refunded line matters here only if the supplier charged for it.
     where l.row_kind = 'sold' or l.ledger_cents is not null
  )
  select c.month, c.row_kind, c.item_type, count(*)::bigint,
         count(c.cost_cents)::bigint,
         case when c.row_kind = 'lost' then 0 else sum(c.price_kobo) end::bigint,
         case when c.cost_source = 'none' then null else sum(round(c.cost_cents * c.costing_rate))::bigint end,
         case when c.cost_source = 'none' then null
              when c.row_kind = 'lost' then -sum(round(c.cost_cents * c.costing_rate))::bigint
              else (sum(c.price_kobo) - sum(round(c.cost_cents * c.costing_rate)))::bigint end,
         case when c.cost_source = 'none' or v_topup_rate is null then null
              else sum(round(c.cost_cents * v_topup_rate))::bigint end,
         c.cost_source
    from costed c
   group by c.month, c.row_kind, c.item_type, c.cost_source
   order by c.month, c.row_kind, c.item_type, c.cost_source;
end;
$$;

create function public.admin_funnel(p_test_mode boolean, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;
  return (
    with o as (
      select * from public.orders x
       where x.test_mode = p_test_mode and (x.created_at at time zone 'Africa/Lagos')::date between p_from and p_to
    )
    select jsonb_build_object(
      'cartAdds', (select coalesce(sum(f.count), 0) from public.funnel_daily f
                    where f.test_mode = p_test_mode and f.event = 'cart_add' and f.day between p_from and p_to),
      'cartAddsSince', (select min(f.day) from public.funnel_daily f where f.test_mode = p_test_mode),
      'created', (select count(*) from o),
      'paid', (select count(*) from o where o.paid_at is not null),
      'completed', (select count(*) from o where o.status = 'completed'),
      'partial', (select count(*) from o where o.status = 'partially_failed'),
      'failed', (select count(*) from o where o.status = 'failed'),
      'cancelled', (select count(*) from o where o.status = 'cancelled'),
      'awaiting', (select count(*) from o where o.status = 'awaiting_payment'),
      'inFlight', (select count(*) from o where o.status in ('paid', 'provisioning')),
      'medianSecsToPay', (select round(percentile_cont(0.5) within group (order by extract(epoch from o.paid_at - o.created_at)))
                            from o where o.paid_at is not null),
      'medianSecsToSettle', (select round(percentile_cont(0.5) within group (order by extract(epoch from o.updated_at - o.paid_at)))
                               from o where o.paid_at is not null and o.status in ('completed', 'partially_failed', 'failed'))));
end;
$$;

create function public.admin_provisioning(p_test_mode boolean, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'Africa/Lagos');
  v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Africa/Lagos');
begin
  perform public.admin_read_gate(p_test_mode);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;
  return jsonb_build_object(
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'status', s.status, 'count', s.n)), '[]'::jsonb)
               from (select j.kind::text as kind, j.status::text as status, count(*) as n from public.jobs j
                      where j.test_mode = p_test_mode and j.created_at >= v_from and j.created_at < v_to
                      group by 1, 2) s),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('itemType', s.item_type, 'status', s.status, 'count', s.n)), '[]'::jsonb)
                from (select oi.item_type, oi.status::text as status, count(*) as n
                        from public.order_items oi join public.orders o on o.id = oi.order_id
                       where o.test_mode = p_test_mode and o.payment_id is not null
                         and o.paid_at >= v_from and o.paid_at < v_to
                       group by 1, 2) s),
    'ssl', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'status', s.status, 'count', s.n)), '[]'::jsonb)
              from (select j.kind, j.status::text as status, count(*) as n from public.ssl_jobs j
                     where j.test_mode = p_test_mode and j.created_at >= v_from and j.created_at < v_to
                     group by 1, 2) s),
    'calls', (select coalesce(jsonb_agg(jsonb_build_object('operation', s.operation, 'outcome', s.outcome,
                                                           'count', s.n, 'p50Ms', s.p50, 'p95Ms', s.p95)), '[]'::jsonb)
                from (select c.operation, c.outcome, count(*) as n,
                             round(percentile_cont(0.5) within group (order by c.duration_ms)) as p50,
                             round(percentile_cont(0.95) within group (order by c.duration_ms)) as p95
                        from public.supplier_calls c
                       where c.environment = case when p_test_mode then 'ote' else 'production' end
                         and c.created_at >= v_from and c.created_at < v_to
                       group by 1, 2) s));
end;
$$;

create function public.admin_refund_stats(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return jsonb_build_object(
    'byReasonStatus', (select coalesce(jsonb_agg(jsonb_build_object('reason', s.reason, 'status', s.status,
                                                                     'count', s.n, 'amountKobo', s.amount)), '[]'::jsonb)
                         from (select r.reason::text as reason, r.status::text as status, count(*) as n,
                                      sum(r.amount_kobo) as amount
                                 from public.refunds r where r.test_mode = p_test_mode group by 1, 2) s),
    'openOldestAt', (select min(r.created_at) from public.refunds r
                      where r.test_mode = p_test_mode
                        and r.status in ('queued', 'held', 'sending', 'submitted', 'failed', 'needs_attention')),
    'medianHoursToComplete', (select round((percentile_cont(0.5) within group (
                                              order by extract(epoch from r.completed_at - r.created_at)) / 3600)::numeric, 1)
                                from public.refunds r
                               where r.test_mode = p_test_mode and r.status = 'completed'
                                 and r.completed_at > now() - interval '90 days'),
    'sent24hKobo', (select coalesce(sum(r.amount_kobo), 0) from public.refunds r
                     where r.test_mode = p_test_mode and r.status in ('sending', 'submitted', 'completed')
                       and coalesce(r.submitted_at, r.updated_at) > now() - interval '24 hours'),
    'limits', (select jsonb_build_object('singleKobo', s.auto_refund_max_kobo, 'dailyKobo', s.auto_refund_daily_max_kobo,
                                         'delayMinutes', s.refund_delay_minutes)
                 from public.ops_settings s where s.id));
end;
$$;

create function public.admin_float(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return public.float_runway(p_test_mode);
end;
$$;

create function public.admin_ledger_daily(p_test_mode boolean, p_from date, p_to date)
returns table (day date, debit_cents bigint, credit_cents bigint, close_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;
  return query
  select x.lagos_day,
         coalesce(sum(-x.delta_cents) filter (where x.status = 1 and x.delta_cents < 0), 0)::bigint,
         coalesce(sum(x.delta_cents) filter (where x.status = 1 and x.delta_cents > 0), 0)::bigint,
         (array_agg(x.balance_cents order by x.occurred_at desc, x.trace_id desc))[1]
    from (select (e.occurred_at at time zone 'Africa/Lagos')::date as lagos_day, e.status, e.delta_cents,
                 e.balance_cents, e.occurred_at, e.trace_id
            from public.supplier_ledger_entries e
           where e.test_mode = p_test_mode) x
   where x.lagos_day between p_from and p_to
   group by x.lagos_day
   order by x.lagos_day;
end;
$$;

create function public.admin_customer_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(false);
  return (
    with customers as (
      select p.id, p.created_at from public.profiles p where not public.is_reserved_email(p.email::text)
    ), held as (
      select d.user_id, count(*) as n from public.domains d
       where d.test_mode = false and d.source <> 'demo'
         and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')
       group by 1
    ), mfa as (
      select distinct f.user_id from auth.mfa_factors f where f.status = 'verified' and f.factor_type = 'totp'
    )
    select jsonb_build_object(
      'profiles', (select count(*) from customers),
      'confirmed', (select count(*) from customers c join auth.users u on u.id = c.id where u.email_confirmed_at is not null),
      'liveBuyers', (select count(distinct o.user_id) from public.orders o join customers c on c.id = o.user_id
                      where o.test_mode = false and o.paid_at is not null),
      'mfaUsers', (select count(*) from customers c join mfa m on m.user_id = c.id),
      'holders', (select count(*) from customers c join held h on h.user_id = c.id),
      'active30d', (select count(*) from customers c join auth.users u on u.id = c.id
                     where u.last_sign_in_at > now() - interval '30 days'),
      'signupsByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'count', coalesce(s.n, 0)) order by g.day), '[]'::jsonb)
                         from generate_series(((now() at time zone 'Africa/Lagos')::date - 29)::timestamp,
                                              (now() at time zone 'Africa/Lagos')::date::timestamp, interval '1 day') g(day)
                         left join (select (c.created_at at time zone 'Africa/Lagos')::date as day, count(*) as n
                                      from customers c group by 1) s on s.day = g.day::date),
      'over10NoMfa', (select count(*) from customers c join held h on h.user_id = c.id
                       where h.n > 10 and not exists (select 1 from mfa m where m.user_id = c.id))));
end;
$$;

create function public.admin_customers(p_test_mode boolean, p_sort text, p_dir text, p_offset integer,
                                       p_limit integer, p_filter jsonb)
returns table (user_id uuid, account_type text, masked_email text, joined_at timestamptz, domains_held bigint,
               orders_paid bigint, total_paid_kobo bigint, has_totp boolean, email_confirmed boolean,
               last_sign_in_at timestamptz, is_admin boolean, total_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
  v_sort  text := case when p_sort in ('joined', 'domains', 'orders', 'paid', 'last_sign_in') then p_sort else 'joined' end;
  v_asc   boolean := lower(coalesce(p_dir, 'desc')) = 'asc';
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_f     jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
begin
  return query
  with base as (
    select p.id, p.account_type::text as account_type, public.admin_mask_email(p.email::text) as masked_email,
           p.created_at as joined_at,
           (select count(*) from public.domains d
             where d.user_id = p.id and d.test_mode = p_test_mode and d.source <> 'demo'
               and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')) as domains_held,
           (select count(*) from public.orders o where o.user_id = p.id and o.test_mode = p_test_mode and o.paid_at is not null) as orders_paid,
           (select coalesce(sum(o.total_kobo), 0) from public.orders o
             where o.user_id = p.id and o.test_mode = p_test_mode and o.paid_at is not null)::bigint as total_paid_kobo,
           exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified' and f.factor_type = 'totp') as has_totp,
           u.email_confirmed_at is not null as email_confirmed,
           u.last_sign_in_at,
           exists (select 1 from public.admins a where a.user_id = p.id and a.revoked_at is null) as is_admin
      from public.profiles p
      left join auth.users u on u.id = p.id
     -- D15: a test admin sees reserved-email profiles only.
     where (not v_admin.test_only or public.is_reserved_email(p.email::text))
       and (v_f ->> 'accountType' is null or p.account_type::text = v_f ->> 'accountType')
  ), filtered as (
    select b.* from base b
     where (v_f ->> 'hasTotp' is null or b.has_totp = (v_f ->> 'hasTotp')::boolean)
       and (v_f ->> 'holders' is null or (b.domains_held > 0) = (v_f ->> 'holders')::boolean)
  )
  select f.id, f.account_type, f.masked_email, f.joined_at, f.domains_held, f.orders_paid, f.total_paid_kobo,
         f.has_totp, f.email_confirmed, f.last_sign_in_at, f.is_admin, count(*) over ()
    from filtered f
   order by
     case when v_sort = 'joined' and v_asc then f.joined_at end asc nulls last,
     case when v_sort = 'joined' and not v_asc then f.joined_at end desc nulls last,
     case when v_sort = 'domains' and v_asc then f.domains_held end asc nulls last,
     case when v_sort = 'domains' and not v_asc then f.domains_held end desc nulls last,
     case when v_sort = 'orders' and v_asc then f.orders_paid end asc nulls last,
     case when v_sort = 'orders' and not v_asc then f.orders_paid end desc nulls last,
     case when v_sort = 'paid' and v_asc then f.total_paid_kobo end asc nulls last,
     case when v_sort = 'paid' and not v_asc then f.total_paid_kobo end desc nulls last,
     case when v_sort = 'last_sign_in' and v_asc then f.last_sign_in_at end asc nulls last,
     case when v_sort = 'last_sign_in' and not v_asc then f.last_sign_in_at end desc nulls last,
     f.id
   offset v_off limit v_limit;
end;
$$;

create function public.admin_customer(p_user_id uuid, p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin   public.admins := public.admin_session('viewer', null, false);
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return null;
  end if;
  if v_admin.test_only and not public.is_reserved_email(v_profile.email::text) then
    raise exception using errcode = '42501', message = 'admin:test_admin';
  end if;
  return jsonb_build_object(
    'userId', v_profile.id,
    'maskedEmail', public.admin_mask_email(v_profile.email::text),
    'accountType', v_profile.account_type,
    'joinedAt', v_profile.created_at,
    'emailConfirmed', (select u.email_confirmed_at is not null from auth.users u where u.id = p_user_id),
    'hasTotp', exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified' and f.factor_type = 'totp'),
    'lastSignInAt', (select u.last_sign_in_at from auth.users u where u.id = p_user_id),
    'isAdmin', exists (select 1 from public.admins a where a.user_id = p_user_id and a.revoked_at is null),
    'counts', jsonb_build_object(
      'domains', (select count(*) from public.domains d
                   where d.user_id = p_user_id and d.test_mode = p_test_mode and d.source <> 'demo'),
      'orders', (select count(*) from public.orders o where o.user_id = p_user_id and o.test_mode = p_test_mode),
      'spentKobo', (select coalesce(sum(o.total_kobo), 0) from public.orders o
                     where o.user_id = p_user_id and o.test_mode = p_test_mode and o.paid_at is not null),
      'refunds', (select count(*) from public.refunds r where r.user_id = p_user_id and r.test_mode = p_test_mode)),
    'allowance', public.account_domain_allowance(p_user_id, p_test_mode));
end;
$$;

create function public.admin_domain_stats(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return (
    with d as (
      select * from public.domains x where x.test_mode = p_test_mode and x.source <> 'demo'
    ), live as (
      select * from d where d.local_status in ('active', 'expired_grace', 'redemption')
    )
    select jsonb_build_object(
      'byTldStatus', (select coalesce(jsonb_agg(jsonb_build_object('tld', s.tld, 'status', s.status, 'count', s.n)
                                                order by s.n desc), '[]'::jsonb)
                        from (select d.tld, d.local_status::text as status, count(*) as n from d group by 1, 2) s),
      'expiries', jsonb_build_object(
        'expired', (select count(*) from live where live.expires_at < now()),
        'd30', (select count(*) from live where live.expires_at between now() and now() + interval '30 days'),
        'd60', (select count(*) from live where live.expires_at between now() and now() + interval '60 days'),
        'd90', (select count(*) from live where live.expires_at between now() and now() + interval '90 days'),
        'autoOn90', (select count(*) from live where live.auto_renew and live.expires_at between now() and now() + interval '90 days'),
        'autoOff90', (select count(*) from live where not live.auto_renew and live.expires_at between now() and now() + interval '90 days'),
        'next', (select min(live.expires_at) from live where live.expires_at >= now())),
      'delegation', (select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n)), '[]'::jsonb)
                       from (select live.delegation_status::text as status, count(*) as n from live group by 1) s),
      'registryAutoRenewLabel', (select coalesce(jsonb_agg(jsonb_build_object('mode', s.mode, 'count', s.n)), '[]'::jsonb)
                                   from (select coalesce(live.registry_renewal_mode, 'unknown') as mode, count(*) as n
                                           from live group by 1) s)));
end;
$$;

create function public.admin_tld_held_counts(p_test_mode boolean)
returns table (tld text, held bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return query
  select d.tld, count(*)::bigint from public.domains d
   where d.test_mode = p_test_mode and d.source <> 'demo'
     and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')
   group by d.tld;
end;
$$;

create function public.admin_preset_usage(p_test_mode boolean)
returns table (preset_id uuid, domains bigint, orders bigint, lines bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return query
  select p.id,
         (select count(*) from public.domains d where d.nameserver_preset_id = p.id and d.test_mode = p_test_mode and d.source <> 'demo'),
         (select count(*) from public.orders o where o.nameserver_preset_id = p.id and o.test_mode = p_test_mode),
         (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id
           where oi.nameserver_preset_id = p.id and o.test_mode = p_test_mode)
    from public.nameserver_presets p;
end;
$$;

create function public.admin_email_stats(p_test_mode boolean, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 400));
begin
  perform public.admin_read_gate(p_test_mode);
  return jsonb_build_object(
    'byKind', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'category', s.category,
                                                            'status', s.status, 'deliveryStatus', s.delivery, 'count', s.n)), '[]'::jsonb)
                 from (select e.kind, e.category, e.status, e.delivery_status as delivery, count(*) as n
                         from public.email_outbox e
                        where e.test_mode = p_test_mode and e.created_at > v_since
                        group by 1, 2, 3, 4) s),
    'notices', (select coalesce(jsonb_agg(jsonb_build_object('noticeType', s.notice_type,
                                                             'deliveryStatus', s.delivery_status, 'count', s.n)), '[]'::jsonb)
                  from (select c.notice_type, c.delivery_status, count(*) as n
                          from public.compliance_notices c
                          left join public.email_outbox e on e.id = c.email_id
                         where coalesce(e.test_mode, false) = p_test_mode and c.sent_at > v_since
                         group by 1, 2) s));
end;
$$;

create function public.admin_alert_stats(p_test_mode boolean, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90));
begin
  perform public.admin_read_gate(p_test_mode);
  return jsonb_build_object(
    'byKind', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'severity', s.severity,
                                                            'open', s.open, 'resolved', s.resolved)), '[]'::jsonb)
                 from (select a.kind, a.severity,
                              count(*) filter (where a.resolved_at is null) as open,
                              count(*) filter (where a.resolved_at is not null) as resolved
                         from public.ops_alerts a
                        where a.test_mode = p_test_mode and (a.resolved_at is null or a.first_seen_at > v_since)
                        group by 1, 2) s),
    'reconcile', (select jsonb_build_object('runs', count(*), 'failed', count(*) filter (where r.error is not null),
                                            'lastFinishedAt', max(r.finished_at))
                    from public.reconcile_runs r where r.test_mode = p_test_mode and r.started_at > v_since),
    'drift', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'open', s.n)), '[]'::jsonb)
                from (select g.kind, count(*) as n from public.registry_drift g
                       where g.test_mode = p_test_mode and g.resolved_at is null group by 1) s),
    'presets', jsonb_build_object(
      'hidden', (select count(*) from public.nameserver_presets p where p.is_hidden),
      'failing', (select count(*) from public.nameserver_presets p where p.check_failed_since is not null and not p.is_hidden),
      'stale', (select count(*) from public.nameserver_presets p where not p.is_hidden and p.verified_at < now() - interval '90 days'),
      'drafts', (select count(*) from public.nameserver_preset_drafts d where d.published_at is null and d.discarded_at is null)));
end;
$$;

-- Storefront-public data plus review state: a test admin may read it.
create function public.admin_pricing_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active public.fx_rates;
begin
  perform public.admin_session('viewer', null, false);
  select * into v_active from public.fx_rates where status = 'active' order by effective_from desc nulls last limit 1;
  return jsonb_build_object(
    'tlds', (select jsonb_build_object('total', count(*), 'sellable', count(*) filter (where t.is_sellable),
                                       'paused', count(*) filter (where t.is_paused),
                                       'featured', count(*) filter (where t.featured_rank is not null),
                                       'transferable', count(*) filter (where t.is_transferable))
               from public.tlds t),
    'ssl', (select jsonb_build_object('total', count(*), 'sellable', count(*) filter (where s.is_sellable),
                                      'priced', count(*) filter (where s.create_usd is not null))
              from public.ssl_products s),
    'fx', jsonb_build_object(
      'active', case when v_active.id is null then null else jsonb_build_object(
                  'id', v_active.id, 'costingRate', v_active.costing_rate, 'source', v_active.source,
                  'quotedAt', v_active.quoted_at, 'effectiveFrom', v_active.effective_from) end,
      'pending', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', f.id, 'costingRate', f.costing_rate, 'source', f.source, 'quotedAt', f.quoted_at,
                    'movePct', f.move_pct,
                    'tooOld', f.quoted_at < now() - interval '48 hours',
                    'olderThanActive', v_active.id is not null and f.quoted_at <= v_active.quoted_at)
                    order by f.quoted_at desc), '[]'::jsonb)
                    from public.fx_rates f where f.status = 'pending_review')),
    'settings', (select jsonb_build_object('marginNgn', p.margin_ngn, 'fxBufferPct', p.fx_buffer_pct,
                                           'icannFeeCents', round(p.icann_fee_usd * 100)::bigint,
                                           'fxMoveThresholdPct', p.fx_move_threshold_pct, 'vatPct', p.vat_pct)
                   from public.pricing_settings p where p.id));
end;
$$;

create function public.admin_ssl_stats(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_read_gate(p_test_mode);
  return jsonb_build_object(
    'byStatus', (select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n)), '[]'::jsonb)
                   from (select c.status, count(*) as n from public.ssl_certificates c
                          where c.test_mode = p_test_mode group by 1) s),
    'unrecognised', (select count(*) from public.ssl_certificates c
                      where c.test_mode = p_test_mode and c.status_unrecognised_since is not null),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'status', s.status, 'count', s.n)), '[]'::jsonb)
               from (select j.kind, j.status::text as status, count(*) as n from public.ssl_jobs j
                      where j.test_mode = p_test_mode group by 1, 2) s));
end;
$$;

-- No ids, no emails. A test admin sees only their own row.
create function public.admin_list_admins()
returns table (label text, role text, test_only boolean, added_at timestamptz, revoked_at timestamptz,
               pinned_factors integer, verified_pinned_factors integer, last_change_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_session('viewer', null, false);
begin
  return query
  select a.label, a.role, a.test_only, a.added_at, a.revoked_at,
         cardinality(a.mfa_factor_ids),
         (select count(*)::integer from auth.mfa_factors f
           where f.id = any (a.mfa_factor_ids) and f.user_id = a.user_id
             and f.status = 'verified' and f.factor_type = 'totp'),
         (select max(c.at) from public.admin_changes c where c.label = a.label)
    from public.admins a
   where not v_admin.test_only or a.user_id = v_admin.user_id
   order by a.revoked_at nulls first, a.added_at;
end;
$$;

-- ── (i) Masked views ────────────────────────────────────────────────────────
-- security_invoker: they read as the caller (the service key, via adminDb),
-- never as their owner. Each carries test_mode for adminDb's side filter.

create view public.admin_payments_v with (security_invoker = true) as
  select p.id, p.order_id, o.test_mode, p.provider_reference, p.amount_kobo, p.status, p.method, p.created_at,
         case when coalesce(p.raw ->> 'app_fee', '') ~ '^-?\d+(\.\d+)?$'
              then round((p.raw ->> 'app_fee')::numeric * 100)::bigint end as fee_kobo,
         case when coalesce(p.raw ->> 'charged_amount', '') ~ '^-?\d+(\.\d+)?$'
              then round((p.raw ->> 'charged_amount')::numeric * 100)::bigint end as charged_kobo,
         case when coalesce(p.raw ->> 'charged_amount', '') ~ '^-?\d+(\.\d+)?$'
              then round((p.raw ->> 'charged_amount')::numeric * 100)::bigint = p.amount_kobo end as absorbed
    from public.payments p
    join public.orders o on o.id = p.order_id;

create view public.admin_email_outbox_v with (security_invoker = true) as
  select e.id, e.test_mode, e.kind, e.category, e.status, e.delivery_status, e.attempts, e.template_version,
         e.created_at, e.sent_at, e.next_attempt_at, e.complained_at, e.skip_reason, e.user_id, e.domain_id,
         e.order_id, public.admin_mask_email(e.to_email) as masked_to,
         regexp_replace(coalesce(e.last_error, ''), '[^[:space:]<>"''(),;]+@[^[:space:]<>"''(),;]+', '[address]', 'g') as last_error_safe
    from public.email_outbox e;

create view public.admin_compliance_notices_v with (security_invoker = true) as
  select c.id, coalesce(e.test_mode, d.test_mode, false) as test_mode, c.domain_id, c.user_id, c.domain_name,
         c.notice_type,
         case c.notice_type when 'errp_pre_35' then '26–35 days before expiry'
                            when 'errp_pre_7' then '4–10 days before expiry'
                            else 'within 5 days after expiry' end as "window",
         c.expires_at, c.channel, public.admin_mask_email(c.recipient) as masked_recipient, c.template_version,
         c.sent_at, c.delivery_status, c.delivery_checked_at as checked_at
    from public.compliance_notices c
    left join public.email_outbox e on e.id = c.email_id
    left join public.domains d on d.id = c.domain_id;

create view public.admin_ssl_certificates_v with (security_invoker = true) as
  select c.id, c.user_id, c.order_item_id, c.product_code, c.product_name, c.is_wildcard, c.included_names,
         c.common_name, c.test_mode, c.status, c.supplier_status, c.status_unrecognised_since,
         c.supplier_certificate_id, c.purchased_at, c.subscription_ends_at, c.validation_method, c.san_names,
         c.web_server, c.configured_at, c.last_error_code, c.issued_at, c.expires_at, c.certificate_pem,
         c.ca_bundle_pem, c.reissue_count, c.last_checked_at, c.next_check_at, c.created_at, c.updated_at,
         public.admin_mask_email(c.approver_email) as approver_masked
    from public.ssl_certificates c;

create view public.admin_domains_v with (security_invoker = true) as
  select d.id, d.user_id, d.domain_name, d.tld, d.source, d.test_mode, d.order_item_id, d.local_status,
         d.registered_at, d.expires_at, d.auto_renew, d.transfer_lock, d.privacy_enabled, d.nameservers,
         d.pending_nameservers, d.nameserver_preset_id, d.delegation_status, d.delegation_checked_at,
         d.created_at, d.updated_at, d.registry_status, d.registry_renewal_mode, d.registry_checked_at,
         d.pending_transfer_lock, d.pending_privacy, d.deep_checked_at, d.previous_nameservers,
         d.registrant ->> 'country' as registrant_country,
         case when d.registrant is null then null
              when coalesce(trim(d.registrant ->> 'company'), '') <> '' then 'organisation'
              else 'individual' end as registrant_type
    from public.domains d;

-- ── (j) Test-only helpers ───────────────────────────────────────────────────

create function public.seed_test_failed_email(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_id    uuid;
begin
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if v_email is null or v_email !~ '^e2e-[^@]+@example\.com$' or not public.is_reserved_email(v_email) then
    raise exception 'seed_test_failed_email: only for an e2e-*@example.com user' using errcode = '42501';
  end if;
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode, status,
                                   attempts, last_error)
  values ('order_receipt', 'transactional', p_user_id, v_email, '{}',
          'e2e-failed:' || gen_random_uuid(), true, 'failed', 3, 'e2e: a seeded failure for ' || v_email)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.hold_test_refund(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds;
  v_email  text;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  select u.email into v_email from auth.users u where u.id = v_refund.user_id;
  if v_refund.id is null or not v_refund.test_mode
     or coalesce(v_email, '') !~ '^e2e-[^@]+@example\.com$' then
    raise exception 'hold_test_refund: only a test refund of an e2e user' using errcode = '42501';
  end if;
  if v_refund.status <> 'queued' then
    raise exception 'hold_test_refund: the refund is %, not queued', v_refund.status using errcode = '22023';
  end if;
  update public.refunds set status = 'held', last_error_code = 'OVER_SINGLE_LIMIT' where id = p_refund_id;
  insert into public.refund_events (refund_id, event, actor, detail)
  values (p_refund_id, 'held', 'e2e', jsonb_build_object('why', 'over_single_limit', 'seeded', true));
end;
$$;

create function public.purge_test_ledger_entries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('app.ledger_purge', 'on', true);
  delete from public.supplier_ledger_revisions r
   using public.supplier_ledger_entries e
   where r.test_mode and e.test_mode and r.trace_id = e.trace_id and e.description like 'e2e-%';
  delete from public.supplier_ledger_entries where test_mode and description like 'e2e-%';
  get diagnostics v_count = row_count;
  perform set_config('app.ledger_purge', '', true);
  return v_count;
end;
$$;

-- ── Grants (§3.0) ───────────────────────────────────────────────────────────

revoke all on function public.supplier_ledger_is_final() from public, anon, authenticated, service_role;
revoke all on function public.ledger_int(jsonb, text, bigint, bigint, boolean) from public, anon, authenticated, service_role;
revoke all on function public.ledger_guid(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.match_supplier_ledger(boolean) from public, anon, authenticated, service_role;
revoke all on function public.record_supplier_ledger(boolean, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_record_float_topup(uuid, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_correct_float_topup(bigint, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.order_item_costs_final() from public, anon, authenticated, service_role;
revoke all on function public.bump_funnel(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.record_metrics_daily(date) from public, anon, authenticated, service_role;
revoke all on function public.float_runway(boolean) from public, anon, authenticated, service_role;
revoke all on function public.try_timestamptz(text) from public, anon, authenticated, service_role;
revoke all on function public.ledger_alert_conditions(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_alert_conditions(boolean) from public, anon, authenticated, service_role;
revoke all on function public.cron_alert_conditions(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_read_gate(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_sales_since(boolean, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_attention_counts(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_overview(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_revenue(boolean, text, date, date) from public, anon, authenticated, service_role;
revoke all on function public.admin_margin(boolean, date, date) from public, anon, authenticated, service_role;
revoke all on function public.admin_funnel(boolean, date, date) from public, anon, authenticated, service_role;
revoke all on function public.admin_provisioning(boolean, date, date) from public, anon, authenticated, service_role;
revoke all on function public.admin_refund_stats(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_float(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_ledger_daily(boolean, date, date) from public, anon, authenticated, service_role;
revoke all on function public.admin_customer_stats() from public, anon, authenticated, service_role;
revoke all on function public.admin_customers(boolean, text, text, integer, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_customer(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_domain_stats(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_tld_held_counts(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_preset_usage(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_email_stats(boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_alert_stats(boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_pricing_status() from public, anon, authenticated, service_role;
revoke all on function public.admin_ssl_stats(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_admins() from public, anon, authenticated, service_role;
revoke all on function public.seed_test_failed_email(uuid) from public, anon, authenticated, service_role;
revoke all on function public.hold_test_refund(uuid) from public, anon, authenticated, service_role;
revoke all on function public.purge_test_ledger_entries() from public, anon, authenticated, service_role;

grant execute on function public.record_supplier_ledger(boolean, jsonb) to service_role;
grant execute on function public.bump_funnel(text, boolean) to service_role;
grant execute on function public.seed_test_failed_email(uuid) to service_role;
grant execute on function public.hold_test_refund(uuid) to service_role;
grant execute on function public.purge_test_ledger_entries() to service_role;

grant execute on function public.admin_record_float_topup(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.admin_correct_float_topup(bigint, bigint, text, text, uuid) to authenticated;
grant execute on function public.admin_attention_counts(boolean) to authenticated;
grant execute on function public.admin_overview(boolean) to authenticated;
grant execute on function public.admin_revenue(boolean, text, date, date) to authenticated;
grant execute on function public.admin_margin(boolean, date, date) to authenticated;
grant execute on function public.admin_funnel(boolean, date, date) to authenticated;
grant execute on function public.admin_provisioning(boolean, date, date) to authenticated;
grant execute on function public.admin_refund_stats(boolean) to authenticated;
grant execute on function public.admin_float(boolean) to authenticated;
grant execute on function public.admin_ledger_daily(boolean, date, date) to authenticated;
grant execute on function public.admin_customer_stats() to authenticated;
grant execute on function public.admin_customers(boolean, text, text, integer, integer, jsonb) to authenticated;
grant execute on function public.admin_customer(uuid, boolean) to authenticated;
grant execute on function public.admin_domain_stats(boolean) to authenticated;
grant execute on function public.admin_tld_held_counts(boolean) to authenticated;
grant execute on function public.admin_preset_usage(boolean) to authenticated;
grant execute on function public.admin_email_stats(boolean, integer) to authenticated;
grant execute on function public.admin_alert_stats(boolean, integer) to authenticated;
grant execute on function public.admin_pricing_status() to authenticated;
grant execute on function public.admin_ssl_stats(boolean) to authenticated;
grant execute on function public.admin_list_admins() to authenticated;

revoke all on public.admin_payments_v, public.admin_email_outbox_v, public.admin_compliance_notices_v,
  public.admin_ssl_certificates_v, public.admin_domains_v from public, anon, authenticated, service_role;
grant select on public.admin_payments_v, public.admin_email_outbox_v, public.admin_compliance_notices_v,
  public.admin_ssl_certificates_v, public.admin_domains_v to service_role;

-- ── Schedules and one-offs ──────────────────────────────────────────────────

select cron.schedule('admin-metrics-daily', '20 23 * * *',
  $cron$select public.record_metrics_daily(((now() at time zone 'Africa/Lagos')::date - 1))$cron$);

do $$
begin
  for i in 0..89 loop
    perform public.record_metrics_daily(((now() at time zone 'Africa/Lagos')::date - i));
  end loop;
end;
$$;

-- The three stale test-side alerts from before the dashboard close here.
select public.sync_alerts(true);
