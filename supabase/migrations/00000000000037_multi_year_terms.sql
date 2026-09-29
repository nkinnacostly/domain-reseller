-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 37: extensions sold in multi-year blocks.
--
-- The catalogue sync kept only extensions with a one-year register price, so
-- .ai — which its registry sells in blocks of 2, 4, 6, 8 or 10 years — never
-- reached the storefront. The sync now stores each extension's cost per year
-- (register_usd, renew_usd: the shortest term's price over its years) and the
-- periods it sells, and offers a period only where the supplier's listed price
-- for it is that cost times its years, to the cent (apps/gateway/src/catalogue).
--
-- Null means what every row meant before this migration: every year from
-- min_period to max_period. So no row changes meaning until the sync writes
-- it, and the storefront prices exactly as before until then. When the
-- periods are set, min_period and max_period are their first and last.
-- Order lines record the term their renewal price is for (below).
-- RLS is unchanged: the new columns are read under the existing policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- True for null, and for a list of years a registry can sell: one to ten,
-- each at most once, in ascending order, at least one.
create or replace function public.are_sold_periods(p_periods smallint[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_periods is null or (
    array_ndims(p_periods) = 1
    and array_lower(p_periods, 1) = 1
    and cardinality(p_periods) between 1 and 10
    and not exists (
      select 1
        from unnest(p_periods) with ordinality as p(years, at)
       where p.years is null
          or p.years < 1
          or p.years > 10
          or (p.at > 1 and p.years <= p_periods[p.at - 1])
    )
  )
$$;

alter table public.tlds
  add column register_periods smallint[],
  add column renew_periods smallint[];

comment on column public.tlds.register_periods is
  'Years a registration can be bought for, ascending (e.g. .ai: {2,4,6,8,10}). From the supplier catalogue. Null: every year from min_period to max_period.';
comment on column public.tlds.renew_periods is
  'Years a renewal can be bought for, ascending. From the supplier catalogue. Null: every year from min_period to max_period.';
comment on column public.tlds.register_usd is
  'Registration cost per year, USD: the shortest registration term''s price over its years.';
comment on column public.tlds.renew_usd is
  'Renewal cost per year, USD: the shortest renewal term''s price over its years.';

alter table public.tlds
  add constraint tlds_register_periods_sold check (public.are_sold_periods(register_periods)),
  add constraint tlds_renew_periods_sold check (public.are_sold_periods(renew_periods)),
  -- Pages and the renewal rules read min_period and max_period: they must agree.
  add constraint tlds_periods_bound check (
    register_periods is null
    or (min_period = register_periods[1]
        and max_period = register_periods[cardinality(register_periods)])
  );

-- N8: every order line shows its renewal price. `renewal_kobo` has always
-- been one year's; the line now also records the term it renews in — the
-- extension's shortest renewal when the order was placed — so a renewal
-- sold only in blocks reads "₦273,000 every 2 years" on the order page, the
-- receipt and its email, never a per-year price nobody can buy. Every line
-- placed before this migration renewed a year at a time.
alter table public.order_items
  add column renewal_years smallint not null default 1
    check (renewal_years between 1 and 10);

comment on column public.order_items.renewal_years is
  'The term renewal_kobo (one year''s price) renews in, in years: 1 for most extensions, 2 for .ai.';

-- FR-C5 / FR-W4: the receipt email carries each line's renewal term
-- (order_receipt template 2, @dr/shared/email). Otherwise unchanged from
-- migration 31.
create or replace function public.email_for_paid_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_email(
    'order_receipt', 'transactional', new.user_id, 'order_receipt:' || new.id,
    jsonb_build_object(
      'order_id', new.id,
      'order_number', new.order_number,
      'invoice_number', new.invoice_number,
      'paid_at', new.paid_at,
      'subtotal_kobo', new.subtotal_kobo,
      'vat_pct', new.vat_pct,
      'vat_kobo', new.vat_kobo,
      'total_kobo', new.total_kobo,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'domain', oi.domain,
                 'kind', oi.item_type,
                 'years', oi.period_years,
                 'price_kobo', oi.price_kobo,
                 'renewal_kobo', oi.renewal_kobo,
                 'renewal_years', oi.renewal_years)
               order by oi.created_at, oi.domain)
          from public.order_items oi
         where oi.order_id = new.id), '[]'::jsonb)),
    null, new.id, new.test_mode);
  return null;
end;
$$;

revoke all on function public.email_for_paid_order() from public, anon, authenticated, service_role;
