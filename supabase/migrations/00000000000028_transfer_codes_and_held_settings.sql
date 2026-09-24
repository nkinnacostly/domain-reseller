-- Follow-ups from building transfers in and the domain controls (24 Sept 2026).
--
-- A transfer code is kept only while its order can still become a transfer.
-- When an unpaid order is closed, the code goes with it: an abandoned transfer
-- checkout no longer leaves someone's code stored. A payment that arrives
-- after that is still applied (migration 21), finds no code, and is refunded.
--
-- A settings change held for a person counts as open: a customer who asks
-- again updates the pending value, and the held job sends the newest value
-- once a person releases it — never two jobs writing the same setting.

create or replace function public.expire_unpaid_orders(p_older_than interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed integer;
begin
  with closed as (
    update public.orders
       set status = 'cancelled'
     where status = 'awaiting_payment'
       and created_at < now() - greatest(p_older_than, interval '1 hour')
    returning id
  )
  select count(*)::integer into v_closed from closed;

  delete from public.transfer_secrets ts
   using public.order_items oi, public.orders o
   where ts.order_item_id = oi.id
     and o.id = oi.order_id
     and o.status = 'cancelled';

  return v_closed;
end;
$$;

revoke all on function public.expire_unpaid_orders(interval) from public, anon, authenticated, service_role;

drop index public.jobs_one_open_setting_change;
create unique index jobs_one_open_setting_change
  on public.jobs (domain_id, kind)
  where kind in ('set_transfer_lock', 'set_privacy', 'update_contacts')
    and status in ('queued', 'running', 'needs_attention');

create or replace function public.enqueue_domain_change(p_domain_id uuid, p_kind public.job_kind)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    raise exception '% is not a domain setting', p_kind;
  end if;

  insert into public.jobs (kind, idempotency_key, domain_id, test_mode)
  select p_kind, p_kind::text || ':' || d.id || ':' || extensions.gen_random_uuid(), d.id, d.test_mode
    from public.domains d
   where d.id = p_domain_id
     and d.source <> 'demo'
     and d.local_status in ('active', 'expired_grace')
     and case p_kind
           when 'set_transfer_lock' then d.pending_transfer_lock is not null
           when 'set_privacy' then d.pending_privacy is not null
           else d.pending_registrant is not null
         end
  on conflict (domain_id, kind)
     where kind in ('set_transfer_lock', 'set_privacy', 'update_contacts')
       and status in ('queued', 'running', 'needs_attention')
  do nothing;
end;
$$;

revoke all on function public.enqueue_domain_change(uuid, public.job_kind) from public, anon, authenticated;
grant execute on function public.enqueue_domain_change(uuid, public.job_kind) to service_role;
