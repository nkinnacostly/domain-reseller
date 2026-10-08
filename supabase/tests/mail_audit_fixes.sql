-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 64 (security audit, 8 Oct 2026): the monthly cap counts the whole
-- month of the send day; webhook deliveries are claimed two per endpoint at a
-- time; resends are capped and resolve to the original; public suffixes are
-- not domains. Made-up people (e2e-*@example.com) and .example domains.
-- Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_audit_fixes.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.af_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  a_acc    uuid;
  v_name   text;
  v_today  date := mail.lagos_day(now());
  v_later  date;
  w_a      uuid;
  v_id     bigint;
  v_j      jsonb;
  v_n      integer;
  v_passed integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', 'e2e-af-o-' || v_tag || '@example.com', now(), now(), now());
  perform pg_temp.af_as(u_o);
  a_acc := (mail.create_account('m64 ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  v_name := 'af-' || v_tag || '.example';
  update mail.accounts
     set state = 'active', tenant_ready_at = now(), ses_status = 'enabled',
         daily_cap_override = 100, monthly_cap_override = 10
   where id = a_acc;
  insert into mail.domains (account_id, name, status, verified_at) values (a_acc, v_name, 'verified', now());

  -- ── 1. A later day of this month already holds 9 of the 10: two more now
  -- would make 11, so they are refused as the month's cap.
  v_later := v_today + 1;
  if date_trunc('month', v_later) = date_trunc('month', v_today) then
    insert into mail.usage_daily (account_id, day, queued) values (a_acc, v_later, 9);
    v_j := mail.reserve_send(a_acc, null, 'hello@' || v_name,
                             array['a@one.example', 'b@two.example'], null);
    if v_j ->> 'code' is distinct from 'quota_exceeded' or v_j ->> 'scope' is distinct from 'month' then
      raise exception 'FAILED 1: a later day''s reservations were not counted in the month: %', v_j;
    end if;
  end if;
  v_passed := v_passed + 1;

  -- ── 2. Five deliveries due to one endpoint: two are claimed, then none
  -- until those two have an answer.
  insert into mail.webhooks (account_id, url, events, secret_sealed, secret_hint)
  values (a_acc, 'https://hooks.af.example/in', array['email.delivered'],
          'v1.' || repeat('a', 16) || '.' || repeat('b', 40), 'whsec_abcd')
  returning id into w_a;
  for i in 1..5 loop
    insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, give_up_at, next_attempt_at)
    values (w_a, a_acc, 'msg_' || replace(gen_random_uuid()::text, '-', ''), 'email.delivered', '{"type":"email.delivered"}',
            now() + interval '1 day', now() - make_interval(mins => i));
  end loop;
  v_n := jsonb_array_length(mail.claim_webhook_deliveries('m64-worker', 10, a_acc));
  if v_n <> 2 then
    raise exception 'FAILED 2: % deliveries to one endpoint were claimed at once', v_n;
  end if;
  v_n := jsonb_array_length(mail.claim_webhook_deliveries('m64-worker', 10, a_acc));
  if v_n <> 0 then
    raise exception 'FAILED 2: more were claimed while two were in flight (%)', v_n;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. Resends: a resend of a resend is the original's; one an hour here.
  update mail.webhook_deliveries set status = 'delivered', delivered_at = now(), claimed_by = null
   where webhook_id = w_a;
  update mail.settings set webhook_resend_hourly_cap = 1 where id;
  select id into v_id from mail.webhook_deliveries where webhook_id = w_a order by id limit 1;
  perform pg_temp.af_as(u_o);
  v_j := mail.resend_webhook_delivery(a_acc, v_id);
  if (v_j ->> 'ok')::boolean is not true then
    raise exception 'FAILED 3: the first resend was refused: %', v_j;
  end if;
  v_j := mail.resend_webhook_delivery(a_acc, (select max(id) from mail.webhook_deliveries where webhook_id = w_a and resend_of is null and id <> v_id));
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'too_many_resends' then
    raise exception 'FAILED 3: the hour''s second resend was not refused: %', v_j;
  end if;
  if (select resend_of from mail.webhook_deliveries where resend_of is not null and webhook_id = w_a limit 1) <> v_id then
    raise exception 'FAILED 3: a resend does not point at its original';
  end if;
  v_passed := v_passed + 1;

  -- ── 4. Public suffixes are not domains; names under them are.
  if mail.domain_name_ok('com.ng') or mail.domain_name_ok('co.uk') or mail.domain_name_ok('vercel.app')
     or not mail.domain_name_ok('acme.com.ng') or not mail.domain_name_ok('mail.acme.co.uk') then
    raise exception 'FAILED 4: public suffixes and the names under them are judged wrongly';
  end if;
  perform pg_temp.af_as(u_o);
  v_j := mail.add_domain(a_acc, 'com.ng');
  execute 'reset role';
  if v_j ->> 'code' is distinct from 'validation' then
    raise exception 'FAILED 4: com.ng could be claimed: %', v_j;
  end if;
  v_passed := v_passed + 1;

  raise notice 'migration 64, Mail audit fixes: % checks passed', v_passed;
end;
$$;

rollback;
