-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 70: a price difference explained by hand (docs/ADMIN-SPEC.md §7.3).
--
-- `supplier_price_drift` warns when the supplier charged a matched order line
-- a different price from the cost recorded at checkout — DomainNameAPI raised
-- .com from $11.31 to $11.99 before the catalogue sync caught it (2 and 4 Nov
-- 2026). Like an unexplained charge (migration 69), it could never close. Now
-- the same owner action explains it: the entry stays `matched` — its match is
-- right, only the price moved — and the words, who and when go beside it, so
-- the warning stops. Final once given, like an explanation.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.supplier_ledger_entries
  add column price_note      text check (price_note is null or char_length(price_note) between 10 and 500),
  add column price_noted_by  text check (price_noted_by is null or char_length(price_noted_by) between 1 and 80),
  add column price_noted_at  timestamptz,
  -- All three or none, and only on a matched entry.
  add constraint supplier_ledger_entries_price_noted_whole
    check ((price_noted_at is null) = (price_note is null)
           and (price_noted_at is null) = (price_noted_by is null)
           and (price_noted_at is null or match_state = 'matched'));

-- As migration 69's, plus the same two rules for a price note.
create or replace function public.supplier_ledger_is_final()
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
  if old.explained_at is not null
     and (new.match_state, new.explained_note, new.explained_by, new.explained_at)
         is distinct from (old.match_state, old.explained_note, old.explained_by, old.explained_at) then
    raise exception 'an explained supplier charge is never rewritten';
  end if;
  if new.explained_at is distinct from old.explained_at
     and coalesce(current_setting('app.ledger_explainer', true), '') <> 'on' then
    raise exception 'a supplier charge is explained only through admin_explain_supplier_charge';
  end if;
  if old.price_noted_at is not null
     and (new.price_note, new.price_noted_by, new.price_noted_at)
         is distinct from (old.price_note, old.price_noted_by, old.price_noted_at) then
    raise exception 'an explained supplier charge is never rewritten';
  end if;
  if new.price_noted_at is distinct from old.price_noted_at
     and coalesce(current_setting('app.ledger_explainer', true), '') <> 'on' then
    raise exception 'a supplier charge is explained only through admin_explain_supplier_charge';
  end if;
  return new;
end;
$$;

-- As migration 41's, but a price difference an owner explained no longer warns.
create or replace function public.ledger_alert_conditions(p_test_mode boolean)
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
     where x.test_mode = p_test_mode and exists (select 1 from hb)
       -- e2e's seeded rows exist on the test side only; a live e2e-* name is a real one.
       and (not p_test_mode or x.description not like 'e2e-%')
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
     and e.price_noted_at is null

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

-- Migration 69's wrapper, now for either kind: an unexplained debit becomes
-- `explained`; a matched debit charged unlike its recorded cost keeps its
-- match and gets a price note. Anything else has nothing to explain.
create or replace function public.admin_explain_supplier_charge(p_test_mode boolean, p_trace_id uuid, p_reason text,
                                                                p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'supplier.explain_charge';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_test   boolean := coalesce(p_test_mode, false);
  v_side   text := case when coalesce(p_test_mode, false) then 'test' else 'live' end;
  v_prior  jsonb;
  v_entry  public.supplier_ledger_entries;
  v_cost   bigint;
  v_kind   text;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_trace_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_entry from public.supplier_ledger_entries
   where test_mode = v_test and trace_id = p_trace_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  select c.supplier_cost_cents into v_cost
    from public.order_item_costs c where c.order_item_id = v_entry.match_order_item_id;
  v_kind := case
    when v_entry.match_state = 'unexplained' then 'unexplained'
    when v_entry.match_state = 'matched' and v_entry.delta_cents < 0 and v_entry.price_noted_at is null
         and v_cost is not null and abs(-v_entry.delta_cents - v_cost) > 1 then 'price'
  end;
  v_detail := jsonb_build_object('usd_cents', -v_entry.delta_cents, 'description', left(v_entry.description, 80),
                                 'kind', v_kind, 'recorded_cost_cents', v_cost,
                                 'before', jsonb_build_object('match_state', v_entry.match_state));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_test), public.admin_reason_problem(p_reason));
  if v_code is null and v_kind is null then v_code := 'NOT_UNEXPLAINED'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  perform set_config('app.ledger_explainer', 'on', true);
  if v_kind = 'unexplained' then
    update public.supplier_ledger_entries
       set match_state = 'explained', explained_note = trim(p_reason), explained_by = v_admin.label,
           explained_at = now()
     where test_mode = v_entry.test_mode and trace_id = v_entry.trace_id;
  else
    update public.supplier_ledger_entries
       set price_note = trim(p_reason), price_noted_by = v_admin.label, price_noted_at = now()
     where test_mode = v_entry.test_mode and trace_id = v_entry.trace_id;
  end if;
  perform set_config('app.ledger_explainer', '', true);
  return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', case when v_kind = 'unexplained'
                                              then jsonb_build_object('match_state', 'explained')
                                              else jsonb_build_object('price_noted', true) end));
end $$;
