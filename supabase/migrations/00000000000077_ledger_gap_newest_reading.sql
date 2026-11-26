-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 77 — the ledger gap judges the newest balance reading
--
-- ledger_gap asked whether ANY balance snapshot taken after the last ledger
-- entry (and before the last complete ledger read) disagreed with that
-- entry's running balance. On 18 Nov 2026 the supplier's balance call
-- answered $0.00 three times in half an hour, then $22.14 again; no money
-- moved and the chain adds up. With no ledger entry since 10 Nov, those
-- three readings stayed "after the last entry" and the alert could not
-- close until the next purchase or top-up.
--
-- Now only the newest snapshot in that window is compared. A real missing
-- entry still shows: every reading after it disagrees, the newest included.
-- A wrong reading that later readings correct closes the alert by itself.
-- The chain check (an entry whose old balance is not the one before's new
-- balance) is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

-- As migration 70's, with the snapshot half of ledger_gap reading the newest snapshot only.
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
           -- Migration 77: only the newest reading between the last entry and
           -- the last complete read is judged. A missing entry moves every
           -- reading after it; a reading the supplier got wrong for a while
           -- (it answered $0.00 for half an hour on 18 Nov 2026) is followed
           -- by right ones, and no longer holds the alert open for good.
           select 1
             from (select x.* from e x order by x.occurred_at desc, x.trace_id desc limit 1) last
             cross join hb
             cross join lateral (
               select s.balance_usd
                 from public.supplier_balance_snapshots s
                where s.test_mode = p_test_mode
                  and s.taken_at > last.occurred_at + interval '5 minutes'
                  and hb.read_at is not null
                  and s.taken_at < hb.read_at
                order by s.taken_at desc
                limit 1) b
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
