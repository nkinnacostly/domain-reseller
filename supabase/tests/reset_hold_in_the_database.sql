-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 63: a password changed within a day of a reset email starts the
-- 24-hour hold (profiles.password_reset_at), however it was changed; one
-- changed with no reset asked for starts nothing. Made-up users. Rolled back.
--
--   supabase db query --linked -f supabase/tests/reset_hold_in_the_database.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_tag  text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_r    uuid := gen_random_uuid();
  u_n    uuid := gen_random_uuid();
  u_old  uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, encrypted_password, recovery_sent_at, created_at, updated_at) values
    (u_r,   'authenticated', 'authenticated', 'e2e-rh-r-' || v_tag || '@example.com', now(), 'x', now() - interval '10 minutes', now(), now()),
    (u_n,   'authenticated', 'authenticated', 'e2e-rh-n-' || v_tag || '@example.com', now(), 'x', null, now(), now()),
    (u_old, 'authenticated', 'authenticated', 'e2e-rh-o-' || v_tag || '@example.com', now(), 'x', now() - interval '3 days', now(), now());

  update auth.users set encrypted_password = 'y' where id in (u_r, u_n, u_old);

  if (select password_reset_at from public.profiles where id = u_r) is null then
    raise exception 'FAILED 1: a password changed after a reset email started no hold';
  end if;
  if (select password_reset_at from public.profiles where id = u_n) is not null
     or (select password_reset_at from public.profiles where id = u_old) is not null then
    raise exception 'FAILED 2: a password changed with no recent reset started a hold';
  end if;
  -- Anything else about the user changing starts nothing.
  update public.profiles set password_reset_at = null where id = u_r;
  update auth.users set email_confirmed_at = now() where id = u_r;
  if (select password_reset_at from public.profiles where id = u_r) is not null then
    raise exception 'FAILED 3: a change other than the password started a hold';
  end if;
  raise notice 'migration 63, reset hold in the database: 3 checks passed';
end;
$$;

rollback;
