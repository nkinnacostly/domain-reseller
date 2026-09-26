-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 36: every stored nameserver is a hostname.
--
-- The gateway once turned GetList's nameserver objects into strings, and the
-- hourly reconcile stored "[object object]" as domains' nameservers until a
-- deep sync put them back (fixed in the gateway, 26 Sept 2026). The trigger
-- of migration 32 copied the bad set into previous_nameservers, which the
-- Revert button offers. Clear those, then refuse anything that is not a
-- lower-case hostname in every nameserver column, whoever writes it — the
-- web lower-cases through nameserverSchema, and the gateway copies from the
-- registry only sets that pass the same test.
-- ─────────────────────────────────────────────────────────────────────────────

-- True for null and for a set of lower-case hostnames (labels of 1–63
-- letters, digits and inner hyphens, at least two of them, no trailing dot).
create or replace function public.are_hostnames(p_hosts text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_hosts is null or not exists (
    select 1 from unnest(p_hosts) as h
     where h is null
        or char_length(h) > 253
        or h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  )
$$;

-- The only rows it finds (26 Sept 2026): no genuine set before them is on
-- record, so none is offered for a revert.
update public.domains
   set previous_nameservers = null
 where not public.are_hostnames(previous_nameservers);

alter table public.domains
  add constraint domains_nameservers_are_hostnames
    check (public.are_hostnames(nameservers)),
  add constraint domains_pending_nameservers_are_hostnames
    check (public.are_hostnames(pending_nameservers)),
  add constraint domains_previous_nameservers_are_hostnames
    check (public.are_hostnames(previous_nameservers));

alter table public.domain_nameserver_history
  add constraint domain_nameserver_history_before_are_hostnames
    check (public.are_hostnames(before)),
  add constraint domain_nameserver_history_after_are_hostnames
    check (public.are_hostnames(after));

alter table public.orders
  add constraint orders_nameservers_are_hostnames check (public.are_hostnames(nameservers));

alter table public.order_items
  add constraint order_items_nameservers_are_hostnames check (public.are_hostnames(nameservers));

alter table public.nameserver_presets
  add constraint nameserver_presets_nameservers_are_hostnames
    check (public.are_hostnames(nameservers));
