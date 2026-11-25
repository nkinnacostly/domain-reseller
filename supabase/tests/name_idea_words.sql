-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 72, tried as the database owner: pre-built name ideas are read by
-- anyone, written only with the service key, and hold only a word's labels.
-- Each check raises on failure. Everything is rolled back.
--
--   supabase db query --linked -f supabase/tests/name_idea_words.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_passed integer := 0;
begin
  -- ── 1. Grants: read for everyone, write for the service key only.
  if not has_table_privilege('anon', 'public.name_idea_words', 'select')
     or not has_table_privilege('authenticated', 'public.name_idea_words', 'select')
     or has_table_privilege('anon', 'public.name_idea_words', 'insert')
     or has_table_privilege('authenticated', 'public.name_idea_words', 'update')
     or has_table_privilege('authenticated', 'public.name_idea_words', 'delete')
     or not has_table_privilege('service_role', 'public.name_idea_words', 'insert')
     or has_table_privilege('service_role', 'public.name_idea_words', 'delete') then
    raise exception 'FAILED 1: name_idea_words has the wrong grants';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.name_idea_words'::regclass) then
    raise exception 'FAILED 1: name_idea_words has no RLS';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A word is a curated word, and its ideas a short list.
  insert into public.name_idea_words (word, ideas, model)
  values ('m72farm', '[{"label":"farmhub","why":"Short"}]', 'deepseek-v4-pro');
  begin
    insert into public.name_idea_words (word, ideas, model) values ('Bad Word', '[]', 'x');
    raise exception 'FAILED 2: a word with a space and capitals';
  exception when check_violation then null;
  end;
  begin
    insert into public.name_idea_words (word, ideas, model) values ('m72obj', '{}', 'x');
    raise exception 'FAILED 2: ideas that are not a list';
  exception when check_violation then null;
  end;
  begin
    insert into public.name_idea_words (word, ideas, model)
    values ('m72long', (select jsonb_agg(i) from generate_series(1, 31) i), 'x');
    raise exception 'FAILED 2: more than 30 ideas';
  exception when check_violation then null;
  end;
  v_passed := v_passed + 1;

  -- ── 3. Read as a visitor, through RLS.
  perform set_config('role', 'anon', true);
  if not exists (select 1 from public.name_idea_words where word = 'm72farm') then
    raise exception 'FAILED 3: a visitor cannot read the ideas';
  end if;
  perform set_config('role', 'postgres', true);
  v_passed := v_passed + 1;

  raise notice 'migration 72: % checks passed', v_passed;
end;
$$;

rollback;
