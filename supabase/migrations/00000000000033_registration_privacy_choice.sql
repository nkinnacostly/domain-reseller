-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 33: a new registration keeps the customer's privacy choice.
--
-- DomainNameAPI turns WHOIS privacy on for every new registration, whatever
-- the register call asks (its support, 25 Sept 2026; the sandbox showed it
-- first: a domain registered without privacy came back with it on). Checkout
-- lets a customer untick privacy on a generic extension (FR-C3), so when a
-- registration is recorded with privacy on against that choice, the domain
-- gets the same pending value and `set_privacy` job the Security page queues:
-- the worker reads the registry first, writes, and records only what reads
-- back (migration 26). The activity log shows the request as the system's.
--
-- Only a first registration counts — pending to active, from a registration
-- line. A renewal bringing an expired domain back is not one, and a choice
-- made on the Security page since checkout is never undone. Country-code
-- lines are not offered privacy (stored as false), so they are left as the
-- registry has them.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.apply_registration_privacy_choice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chosen boolean;
begin
  if new.source <> 'registration'
     or new.order_item_id is null
     or new.privacy_enabled is not true
     or new.pending_privacy is not null
     or char_length(split_part(new.tld, '.', -1)) = 2 then
    return null;
  end if;

  select oi.privacy into v_chosen from public.order_items oi where oi.id = new.order_item_id;
  if coalesce(v_chosen, true) then
    return null;
  end if;

  update public.domains set pending_privacy = false where id = new.id;
  insert into public.domain_events (domain_id, event_type, actor_type, payload)
  values (new.id, 'privacy_requested', 'system',
          jsonb_build_object('to', false, 'why', 'registered_with_privacy_on'));
  perform public.enqueue_domain_change(new.id, 'set_privacy');
  return null;
end;
$$;

revoke execute on function public.apply_registration_privacy_choice() from public, anon, authenticated;

create trigger domains_registration_privacy_choice
  after update of local_status on public.domains
  for each row
  when (old.local_status = 'pending' and new.local_status = 'active')
  execute function public.apply_registration_privacy_choice();
