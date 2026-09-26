-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 35: the registrar's default nameservers, as data (FR-D1, N11).
--
-- The Nameservers tab offers "Use default DNS": it fills the form with the
-- nameservers the supplier gives a domain registered without any of its own.
-- N11 keeps nameservers out of code, so they are presets like any host's, with
-- a source and a verification date — one per side, because the sandbox and the
-- live registry hand out different ones.
--
-- `registrar_default_for` marks those rows: null for a host preset, 'live' or
-- 'sandbox' for the registrar's default on that side, at most one each. The
-- web leaves them out of every host list and offers only the domain's own
-- side. They stay visible to the RLS policy (verified, not hidden) so the web
-- can read them, and in `presets_for_check()`, so the gateway looks them up in
-- public DNS like any preset (FR-D2).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.nameserver_presets
  add column registrar_default_for text
    constraint nameserver_presets_registrar_default_for_check
      check (registrar_default_for in ('live', 'sandbox')),
  -- The registrar's default is a fixed pair, never "your provider assigns them".
  add constraint nameserver_presets_registrar_default_fixed_check
    check (registrar_default_for is null or not assigns_per_zone);

create unique index nameserver_presets_registrar_default_for_key
  on public.nameserver_presets (registrar_default_for)
  where registrar_default_for is not null;

comment on column public.nameserver_presets.registrar_default_for is
  'Null for a host preset. ''live'' or ''sandbox'': the supplier''s default nameservers on that side, offered as "Use default DNS" and never listed as a host (migration 35).';

insert into public.nameserver_presets
  (provider, nameservers, assigns_per_zone, notes, source_url, verified_at, is_hidden, registrar_default_for)
values
  ('Registrar default (live)', array['ns1.domainnameapi.com', 'ns2.domainnameapi.com'], false,
   'Not a host: the nameservers DomainNameAPI gives a domain registered without any of its own. '
   'Verisign''s registry shows these for goldenheightsfinplc.com, which we registered on 26 Sept 2026 '
   'on the supplier''s defaults.',
   'https://rdap.verisign.com/com/v1/domain/goldenheightsfinplc.com', now(), false, 'live'),
  ('Registrar default (sandbox)', array['tr.apiname.com', 'eu.apiname.com'], false,
   'Not a host: the nameservers DomainNameAPI''s test environment (OTE) holds. Its support gave them '
   'in a reply on 25 Sept 2026; the sandbox cannot point a domain at a real host.',
   'https://www.domainnameapi.com', now(), false, 'sandbox');
