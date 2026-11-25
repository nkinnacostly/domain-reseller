-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 72: pre-built name ideas for curated words (docs: "Making AI the
-- core of MyDomainsHub", feature 2; ADR-002 v1.1).
--
-- The gateway's overnight job asks a model for name ideas around each word in
-- a list we choose (NAME_IDEA_WORDS in @dr/shared/ai) and keeps them here;
-- a search for exactly that word adds them to its suggestions from this
-- table, so no model sits in the request path. Searches themselves are never
-- recorded (FR-S7): the words are ours, not people's.
--
-- Nothing here is personal, so anyone may read it; only the service key
-- writes. Ideas are labels only — availability and prices come at search
-- time from the supplier and the tables (N5b, N8).
-- ─────────────────────────────────────────────────────────────────────────────

create table public.name_idea_words (
  word         text primary key check (word ~ '^[a-z0-9]{2,20}$'),
  ideas        jsonb not null
               check (jsonb_typeof(ideas) = 'array' and jsonb_array_length(ideas) <= 30),
  model        text not null check (char_length(model) between 1 and 60),
  generated_at timestamptz not null default now()
);

alter table public.name_idea_words enable row level security;
revoke all on public.name_idea_words from public, anon, authenticated, service_role;
grant select on public.name_idea_words to anon, authenticated, service_role;
grant insert, update on public.name_idea_words to service_role;

create policy name_idea_words_read on public.name_idea_words
  for select to anon, authenticated using (true);
