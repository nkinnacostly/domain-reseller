-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 68: import_suppressions. Owners and admins add a list to their
-- own account's suppressions: valid addresses once each, lower-cased, as
-- source `customer`; one already listed keeps its reason; invalid ones only
-- counted; bounded per call, per Lagos day and in all; one audit row a call
-- with counts and no address. People are made up (e2e-*@example.com).
-- Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_suppression_import.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.si_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_dev    uuid := gen_random_uuid();
  u_out    uuid := gen_random_uuid();
  a_acc    uuid;
  v_j      jsonb;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', 'e2e-si-o-' || v_tag || '@example.com', now(), now(), now()),
    (u_dev, 'authenticated', 'authenticated', 'e2e-si-d-' || v_tag || '@example.com', now(), now(), now()),
    (u_out, 'authenticated', 'authenticated', 'e2e-si-x-' || v_tag || '@example.com', now(), now(), now());
  perform pg_temp.si_as(u_o);
  a_acc := (mail.create_account('m68 ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  insert into mail.members (account_id, user_id, role) values (a_acc, u_dev, 'developer');
  -- One SES had already suppressed: an import must not change it.
  insert into mail.suppressions (account_id, address, reason, source)
  values (a_acc, 'old@example.com', 'complaint', 'ses');

  -- ── 1. Valid ones once each, lower-cased; the listed one kept; the rest counted.
  perform pg_temp.si_as(u_o);
  v_j := mail.import_suppressions(a_acc,
           array['Ada@Example.com', ' ada@example.com ', 'bola@example.com', 'old@example.com',
                 'not an address', '', null, '<x@example.com>'], 'bounce');
  execute 'reset role';
  if v_j is distinct from jsonb_build_object('ok', true, 'added', 2, 'already', 1, 'invalid', 4) then
    raise exception 'FAILED 1: the import answered %', v_j;
  end if;
  if (select array_agg(address || '/' || reason || '/' || source order by address)
        from mail.suppressions where account_id = a_acc)
     is distinct from array['ada@example.com/bounce/customer', 'bola@example.com/bounce/customer',
                            'old@example.com/complaint/ses'] then
    raise exception 'FAILED 1: the list is not what was imported';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Developers, strangers and nobody are refused; nothing is added.
  perform pg_temp.si_as(u_dev);
  v_j := mail.import_suppressions(a_acc, array['c@example.com'], 'manual');
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'forbidden' then
    raise exception 'FAILED 2: a developer imported: %', v_j;
  end if;
  perform pg_temp.si_as(u_out);
  v_j := mail.import_suppressions(a_acc, array['c@example.com'], 'manual');
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'not_found' then
    raise exception 'FAILED 2: a stranger imported: %', v_j;
  end if;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if mail.import_suppressions(a_acc, array['c@example.com'], 'manual') ->> 'code' is distinct from 'unauthorized' then
    raise exception 'FAILED 2: nobody imported';
  end if;
  if exists (select 1 from mail.suppressions where account_id = a_acc and address = 'c@example.com') then
    raise exception 'FAILED 2: a refused import added an address';
  end if;
  v_passed := v_passed + 1;

  -- ── 3. A reason we do not have, nothing, or over 5,000 at once: refused.
  perform pg_temp.si_as(u_o);
  if mail.import_suppressions(a_acc, array['c@example.com'], 'unsubscribe') ->> 'field' is distinct from 'reason'
     or mail.import_suppressions(a_acc, '{}', 'manual') ->> 'field' is distinct from 'addresses'
     or mail.import_suppressions(a_acc, null, 'manual') ->> 'field' is distinct from 'addresses'
     or mail.import_suppressions(a_acc, array(select 'n' || i || '@example.com' from generate_series(1, 5001) i),
                                 'manual') ->> 'field' is distinct from 'addresses' then
    raise exception 'FAILED 3: a malformed import was not refused';
  end if;
  execute 'reset role';
  v_passed := v_passed + 1;

  -- ── 4. The day's cap counts what was added today; the list's cap counts the list.
  update mail.settings set suppression_import_daily_cap = 3 where id;
  perform pg_temp.si_as(u_o);
  v_j := mail.import_suppressions(a_acc, array['c@example.com', 'd@example.com'], 'manual');
  execute 'reset role';
  if v_j is distinct from jsonb_build_object('ok', false, 'code', 'import_limit', 'per', 'day', 'max', 3, 'added', 2) then
    raise exception 'FAILED 4: past the day''s cap: %', v_j;
  end if;
  update mail.settings set suppression_import_daily_cap = 100000, suppression_list_max = 4 where id;
  perform pg_temp.si_as(u_o);
  v_j := mail.import_suppressions(a_acc, array['c@example.com', 'd@example.com'], 'manual');
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'import_limit' or v_j ->> 'per' <> 'list' then
    raise exception 'FAILED 4: past the list''s cap: %', v_j;
  end if;
  perform pg_temp.si_as(u_o);
  v_j := mail.import_suppressions(a_acc, array['c@example.com'], 'manual');
  execute 'reset role';
  if (v_j ->> 'added')::int is distinct from 1 then
    raise exception 'FAILED 4: an import inside both caps was refused: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 5. One audit row a call, with counts and no address.
  if (select count(*) from mail.account_audit_log
       where account_id = a_acc and action = 'suppressions.imported') <> 2
     or exists (select 1 from mail.account_audit_log
                 where account_id = a_acc and action = 'suppressions.imported'
                   and (detail::text like '%@%' or target is not null))
     or (select detail from mail.account_audit_log
          where account_id = a_acc and action = 'suppressions.imported' order by id limit 1)
        is distinct from jsonb_build_object('reason', 'bounce', 'added', 2, 'already', 1, 'invalid', 4) then
    raise exception 'FAILED 5: the audit rows are wrong';
  end if;
  v_passed := v_passed + 1;

  -- ── 6. People call it as themselves; nobody else can.
  if not has_function_privilege('authenticated', 'mail.import_suppressions(uuid, text[], text)', 'execute')
     or has_function_privilege('anon', 'mail.import_suppressions(uuid, text[], text)', 'execute')
     or has_function_privilege('service_role', 'mail.import_suppressions(uuid, text[], text)', 'execute') then
    raise exception 'FAILED 6: migration 68 has the wrong grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 68, suppression import: % checks passed', v_passed;
end;
$$;

rollback;
