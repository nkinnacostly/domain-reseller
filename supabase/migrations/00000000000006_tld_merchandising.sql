-- ─────────────────────────────────────────────────────────────────────────────
-- Merchandising controls on the catalogue.
--
-- The catalogue sync owns cost columns; these columns are ours and the sync
-- never writes them. Pausing or featuring an extension is a data change, not a
-- deploy — the .ng family is paused while we find a competitive source.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tlds
  add column is_paused     boolean not null default false,
  add column paused_reason text,
  add column featured_rank smallint check (featured_rank > 0);

create unique index tlds_featured_rank_unique on public.tlds (featured_rank)
  where featured_rank is not null;

-- A paused extension is not public, same as one the supplier stopped selling.
drop policy "tlds: anyone may read sellable extensions" on public.tlds;
create policy "tlds: anyone may read sellable extensions"
  on public.tlds for select to anon, authenticated
  using (is_sellable and not is_paused);

update public.tlds
   set is_paused = true,
       paused_reason = 'Supplier prices the .ng family flat at USD 11.99; market is far lower. Revisit with a NiRA-accredited source (PRD R17).'
 where name in ('ng', 'com.ng', 'net.ng', 'org.ng');

-- Initial merchandising. Ranks 1–3 are the home page cards; 4–6 the side list.
update public.tlds t set featured_rank = v.rank
  from (values ('com',1),('net',2),('org',3),('africa',4),('co',5),('app',6)) as v(name, rank)
 where t.name = v.name;
