-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 60: invites are capped per account (a day and a month, revoked
-- ones counted), a paused account's invite is not emailed, and the email names
-- the inviter by their sign-in address, never free text. People are made up
-- (e2e-*@example.com). Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_invite_limits.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.il_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.il_hash(p_token text) returns text language sql as $f$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  a_acc    uuid;
  v_j      jsonb;
  v_inv    uuid;
  v_tok    text;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', 'e2e-il-o-' || v_tag || '@example.com', now(), now(), now());
  update public.profiles set full_name = 'Call +1 555 0100 now: your bank account is locked' where id = u_o;
  perform pg_temp.il_as(u_o);
  a_acc := (mail.create_account('m60 ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  update mail.accounts set plan_code = 'pro' where id = a_acc;

  -- ── 1. Ten a day, revoked ones counted; the eleventh is refused.
  perform pg_temp.il_as(u_o);
  for i in 1..10 loop
    v_tok := rpad('t' || i || v_tag, 43, 'q');
    v_j := mail.create_invite(a_acc, 'e2e-il-' || i || '-' || v_tag || '@example.com', 'viewer', pg_temp.il_hash(v_tok));
    if (v_j ->> 'ok')::boolean is not true then
      raise exception 'FAILED 1: invite % was refused: %', i, v_j;
    end if;
    v_inv := (v_j ->> 'inviteId')::uuid;
    if i = 1 then
      -- ── 3 (below) reads this one's email.
      perform mail.email_invite(v_inv, v_tok);
    end if;
    perform mail.revoke_invite(v_inv);
  end loop;
  v_j := mail.create_invite(a_acc, 'e2e-il-11-' || v_tag || '@example.com', 'viewer', pg_temp.il_hash(rpad('x' || v_tag, 43, 'q')));
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'too_many_invites' or v_j ->> 'per' <> 'day' or (v_j ->> 'max')::int <> 10 then
    raise exception 'FAILED 1: the eleventh invite of the day was not refused: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. A paused account's invite is made but not emailed.
  update mail.settings set invite_daily_cap = 20 where id;
  update mail.accounts set state = 'paused' where id = a_acc;
  perform pg_temp.il_as(u_o);
  v_tok := rpad('p' || v_tag, 43, 'q');
  v_j := mail.create_invite(a_acc, 'e2e-il-p-' || v_tag || '@example.com', 'viewer', pg_temp.il_hash(v_tok));
  v_inv := (v_j ->> 'inviteId')::uuid;
  v_j := mail.email_invite(v_inv, v_tok);
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'account_paused' then
    raise exception 'FAILED 2: a paused account''s invite was emailed: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. The email names the inviter by address, never their free-text name.
  if (select o.data ->> 'invitedBy' from public.email_outbox o
       where o.kind = 'mail_invite' and o.data ->> 'accountId' = a_acc::text limit 1)
     is distinct from 'e2e-il-o-' || v_tag || '@example.com' then
    raise exception 'FAILED 3: the invite email does not name the inviter by address';
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 60, invite limits: % checks passed', v_passed;
end;
$$;

rollback;
