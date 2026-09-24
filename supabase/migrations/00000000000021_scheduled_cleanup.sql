-- ─────────────────────────────────────────────────────────────────────────────
-- Two housekeeping jobs, run by the database itself (pg_cron), so they keep
-- going whether or not the gateway is up.
--
--  1. Unpaid orders close after 24 hours. An order abandoned on Flutterwave's
--     page otherwise sits at "awaiting payment" for ever, and is counted as
--     waiting on the dashboard. Closing it charges nothing and loses nothing:
--     record_order_payment still accepts a payment for a cancelled order, so a
--     late bank transfer — found by the webhook or the gateway's sweeper — is
--     applied as it would have been.
--  2. Anonymous carts are deleted 60 days after their last change. The cookie
--     that finds one lasts 60 days, so after that nobody can open it again.
--     Carts that belong to an account are never touched.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.expire_unpaid_orders(p_older_than interval default interval '24 hours')
returns integer
language sql
security definer
set search_path = ''
as $$
  with closed as (
    update public.orders
       set status = 'cancelled'
     where status = 'awaiting_payment'
       and created_at < now() - greatest(p_older_than, interval '1 hour')
    returning id
  )
  select count(*)::integer from closed
$$;

create or replace function public.purge_stale_carts(p_older_than interval default interval '60 days')
returns integer
language sql
security definer
set search_path = ''
as $$
  with stale as (
    delete from public.carts c
     where c.anon_token_hash is not null
       and c.user_id is null
       and greatest(
             c.updated_at,
             coalesce((select max(greatest(i.created_at, i.quoted_at))
                         from public.cart_items i
                        where i.cart_id = c.id), c.updated_at)
           ) < now() - greatest(p_older_than, interval '60 days')
    returning c.id
  )
  select count(*)::integer from stale
$$;

revoke all on function public.expire_unpaid_orders(interval) from public, anon, authenticated, service_role;
revoke all on function public.purge_stale_carts(interval) from public, anon, authenticated, service_role;

-- cron.schedule replaces a job of the same name, so this is safe to run again.
select cron.schedule('expire-unpaid-orders', '*/15 * * * *', 'select public.expire_unpaid_orders()');
select cron.schedule('purge-stale-carts', '17 3 * * *', 'select public.purge_stale_carts()');
